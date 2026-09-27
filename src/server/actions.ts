import { and, eq, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, depositIntents, ledgerEntries, seats, users } from '../db/schema';
import { conservative } from '../lib/rating';
import { chipsToWei, packageById, weiToChips } from '../lib/economy';
import { chainById } from '../lib/chains';
import { REQUIRED_CONFIRMATIONS, observeDeposit } from './chain';
import { UnknownChain, requireChain, vaultAddress, type DeployedChain } from './chains';
import { bytes32ToIntent, intentToBytes32 } from '../lib/intent';
import type { Session } from './auth';
import { presenceOf } from './presence';
import { onchainRecords } from './attestation';
import type { OnChainRecord } from '../lib/erc8004';

export class ActionError extends Error {}

export interface AgentSummary {
  id: string;
  name: string;
  color: string;
  /** The published rating, which is what the standings sort on. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  matchesPlayed: number;
  handsPlayed: number;
  handsWon: number;
  chipsWon: number;
  biggestPot: number;
  /** The match it is sitting in right now, or null while it waits for one. */
  seat: { matchId: string; seatIndex: number; stack: number } | null;
  /** Whether a socket for it is open on this process. */
  connected: boolean;
  /** Whether it has asked to be queued on that socket. */
  ready: boolean;
  /** Whether its owner lets it be seated. Asking is not enough without this. */
  queueEnabled: boolean;
  lastSeenAt: string | null;
  /** Why its last connection ended, in a sentence an owner can act on. */
  lastCloseReason: string | null;
  /** Its ERC-8004 identity and newest published record, per chain. */
  onchain: OnChainRecord[];
}

export interface Account {
  address: string;
  chips: number;
  agents: AgentSummary[];
}

/**
 * Everything the connection console shows.
 *
 * Presence comes from the socket registry rather than the database, because a
 * connection is a fact about this process and writing it down would leave a
 * stale "connected" behind after any crash.
 */
export async function account(session: Session): Promise<Account> {
  const [owner] = await db
    .select({ address: users.address, chips: users.chips })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!owner) throw new ActionError('That account no longer exists.');

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      color: agents.color,
      ratingMu: agents.ratingMu,
      ratingSigma: agents.ratingSigma,
      matchesPlayed: agents.matchesPlayed,
      handsPlayed: agents.handsPlayed,
      handsWon: agents.handsWon,
      chipsWon: agents.chipsWon,
      biggestPot: agents.biggestPot,
      lastSeenAt: agents.lastSeenAt,
      lastCloseReason: agents.lastCloseReason,
      queueEnabled: agents.queueEnabled,
      matchId: seats.matchId,
      seatIndex: seats.seatIndex,
      stack: seats.stack,
    })
    .from(agents)
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(eq(agents.userId, session.userId))
    .orderBy(agents.createdAt);

  const onchain = await onchainRecords(rows.map((row) => row.id));

  return {
    address: owner.address,
    chips: owner.chips,
    agents: rows.map((row) => {
      const presence = presenceOf(row.id);
      return {
        id: row.id,
        name: row.name,
        color: row.color,
        rating: conservative({ mu: row.ratingMu, sigma: row.ratingSigma }),
        ratingMu: row.ratingMu,
        ratingSigma: row.ratingSigma,
        matchesPlayed: row.matchesPlayed,
        handsPlayed: row.handsPlayed,
        handsWon: row.handsWon,
        chipsWon: row.chipsWon,
        biggestPot: row.biggestPot,
        seat: row.matchId ? { matchId: row.matchId, seatIndex: row.seatIndex!, stack: row.stack! } : null,
        connected: presence.connected,
        ready: presence.ready,
        queueEnabled: row.queueEnabled,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        lastCloseReason: row.lastCloseReason,
        onchain: onchain.get(row.id) ?? [],
      };
    }),
  };
}

/**
 * The chain a request asked to settle on.
 *
 * Every money path resolves the key itself rather than accepting a chain object
 * from the caller, so an unknown or disabled network fails as a bad request
 * instead of reaching the chain layer.
 */
function chainFor(key: string): DeployedChain {
  try {
    return requireChain(key);
  } catch (error) {
    if (error instanceof UnknownChain) throw new ActionError(error.message);
    throw error;
  }
}

export interface DepositQuote {
  intentId: string;
  bytes32: `0x${string}`;
  chips: number;
  valueWei: string;
  vault: `0x${string}`;
  chainKey: string;
  chainId: number;
}

export async function startDeposit(session: Session, packageId: string, chainKey: string): Promise<DepositQuote> {
  const chosen = packageById(packageId);
  if (!chosen) throw new ActionError('That package does not exist.');

  const chain = chainFor(chainKey);

  // Resolved before the row is written. An intent against a chain with no vault
  // is an intent the player can never pay, so it is refused rather than stored.
  let vault: `0x${string}`;
  try {
    vault = vaultAddress(chain);
  } catch {
    throw new ActionError(`Chips cannot be bought on ${chain.name} yet. Switch networks to buy in.`);
  }

  const valueWei = chipsToWei(chosen.chips);
  const [intent] = await db
    .insert(depositIntents)
    .values({
      userId: session.userId,
      chainId: chain.id,
      packageId: chosen.id,
      chips: chosen.chips,
      expectedWei: valueWei.toString(),
    })
    .returning({ id: depositIntents.id });

  return {
    intentId: intent.id,
    bytes32: intentToBytes32(intent.id),
    chips: chosen.chips,
    valueWei: valueWei.toString(),
    vault,
    chainKey: chain.key,
    chainId: chain.id,
  };
}

/**
 * What confirming a deposit came to.
 *
 * Pending is an answer rather than an error. A transaction not mined yet, or
 * mined but short of its confirmations, is a deposit on its way, and the cashier
 * keeps polling on this status instead of on the wording of a message.
 */
export type DepositResult =
  | { status: 'credited'; chips: number; balance: number }
  | { status: 'pending'; confirmations: number; required: number };

/**
 * Notes the transaction a deposit was paid with, before it has confirmed.
 *
 * Without this a player who closes the tab while waiting has no way back to
 * their money: the intent is spent on chain and the row here has nothing
 * pointing at it. Writing the hash the moment the wallet returns it makes the
 * deposit recoverable, by the player on their next visit or by an operator.
 */
export async function noteDepositTx(session: Session, intentId: string, txHash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');
  if (!/^[0-9a-f-]{36}$/i.test(intentId)) throw new ActionError('That is not a deposit.');

  // Several intents may note one hash, because one transaction can pay several
  // of them. The uniqueness that matters is per deposit event and is enforced
  // when the log is known, at confirmation; a noted row has no log yet.
  await db
    .update(depositIntents)
    .set({ txHash })
    .where(
      and(
        eq(depositIntents.id, intentId),
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
      ),
    );
}

/**
 * Deposits this account has paid for but not yet had credited.
 *
 * The chain comes back with each one. A player who bought on one network and
 * returned on another must still be finished on the network they paid.
 */
export async function unsettledDeposits(
  session: Session,
): Promise<Array<{ intentId: string; txHash: string; chainKey: string }>> {
  const rows = await db
    .select({ intentId: depositIntents.id, txHash: depositIntents.txHash, chainId: depositIntents.chainId })
    .from(depositIntents)
    .where(
      and(
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
        isNotNull(depositIntents.txHash),
      ),
    )
    .orderBy(depositIntents.createdAt);

  return rows
    .map((row) => ({ intentId: row.intentId, txHash: row.txHash!, chainKey: chainById(row.chainId)?.key }))
    .filter((row): row is { intentId: string; txHash: string; chainKey: string } => row.chainKey !== undefined);
}

/**
 * Credits a deposit after reading it back from the chain.
 *
 * Every check that matters happens here: the event came from our vault, the
 * payer is the signed-in wallet, the intent belongs to that same wallet, the
 * amount covers what the intent promised, and the transaction has enough
 * confirmations. The intent row is locked for the length of the transaction and
 * the credit only applies to a row that is still pending, so two requests
 * racing on the same hash cannot both pay out.
 *
 * A transaction may carry more than one deposit, from a wallet that batches
 * calls. Every one of them owed to this account is credited in the same call,
 * each against its own log, because nothing else would ever come back for the
 * rest: the cashier stops asking at the first credit, and a batch made outside
 * it was never noted anywhere.
 */
export async function confirmDeposit(
  session: Session,
  txHash: string,
  chainKey: string,
  // The chain read, as a parameter so the ledger half can be tested without a
  // node. Every caller in the app takes the default.
  observe: typeof observeDeposit = observeDeposit,
): Promise<DepositResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');

  const chain = chainFor(chainKey);

  const deposits = await observe(chain, txHash as `0x${string}`);
  const required = Number(REQUIRED_CONFIRMATIONS);

  // Not mined yet, which is what the first ask after a wallet returns a hash
  // nearly always finds. A deposit on its way, not a failure.
  if (deposits === null) return { status: 'pending', confirmations: 0, required };

  if (deposits.length === 0) {
    throw new ActionError(`No deposit to the ${chain.shortName} vault was found in that transaction.`);
  }

  if (deposits[0].confirmations < REQUIRED_CONFIRMATIONS) {
    return { status: 'pending', confirmations: Number(deposits[0].confirmations), required };
  }

  const mine = deposits.filter((row) => row.payer.toLowerCase() === session.address.toLowerCase());
  if (mine.length === 0) throw new ActionError('That deposit was sent from a different wallet.');

  // An identifier the vault accepted need not be one of ours: anyone can call
  // deposit with a bytes32 of their own invention. One that does not decode is
  // simply not a deposit this arena issued.
  const candidates = mine.flatMap((row) => {
    try {
      return [{ ...row, intentId: bytes32ToIntent(row.intentId) }];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) throw new ActionError('That deposit does not match any request from this account.');

  return db.transaction(async (tx) => {
    let credited = 0;
    let already = 0;
    let balance: number | null = null;
    let refusal: string | null = null;

    // In the order the logs appear, so two requests for the same hash take
    // their locks in the same order and wait on each other instead of
    // deadlocking.
    for (const observed of candidates) {
      // Locked for the length of the transaction. A second request for the
      // same hash waits here rather than reading a pending row that is about
      // to be credited out from under it.
      const [intent] = await tx
        .select()
        .from(depositIntents)
        .where(and(eq(depositIntents.id, observed.intentId), eq(depositIntents.userId, session.userId)))
        .limit(1)
        .for('update');

      // Not an intent of this account's, or not one that exists.
      if (!intent) continue;

      // The vault check above proves the log came from a vault of ours; this
      // proves it came from the one the intent was issued against. Without it
      // an intent could be paid on a cheaper chain than the one it was priced
      // on.
      if (intent.chainId !== chain.id) {
        const paid = chainById(intent.chainId);
        throw new ActionError(
          `That deposit belongs to ${paid?.name ?? `chain ${intent.chainId}`}. Switch networks to finish it.`,
        );
      }

      // Asked again about a deposit that has already landed, which is
      // ordinary: a cashier closed mid-wait keeps polling while the reopened
      // one polls the same hash, and whichever asks second must hear the same
      // answer as the first rather than an error about money that arrived. The
      // lock above means the credit itself still happens once.
      if (intent.status === 'credited') {
        if (intent.txHash === txHash) already += intent.chips;
        else refusal ??= 'That deposit has already been credited.';
        continue;
      }

      // One short deposit does not hold up the others the same call paid for.
      if (observed.amountWei < BigInt(intent.expectedWei)) {
        refusal ??= 'That deposit was smaller than the package it was for.';
        continue;
      }

      // Anything sent above the package price still buys chips at the same peg.
      const chips = Math.max(intent.chips, weiToChips(observed.amountWei));

      // The status is part of the condition, not just of the payload, so the
      // credit cannot apply twice even if the lock above is ever lost; and the
      // log is recorded, so one deposit event can never credit two intents.
      const settled = await tx
        .update(depositIntents)
        .set({
          status: 'credited',
          txHash,
          blockNumber: Number(observed.blockNumber),
          logIndex: observed.logIndex,
          chips,
          creditedAt: new Date(),
        })
        .where(and(eq(depositIntents.id, intent.id), eq(depositIntents.status, 'pending')))
        .returning({ id: depositIntents.id });
      if (settled.length === 0) continue;

      const [updated] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${chips}` })
        .where(eq(users.id, session.userId))
        .returning({ chips: users.chips });

      await tx.insert(ledgerEntries).values({
        userId: session.userId,
        delta: chips,
        balanceAfter: updated.chips,
        reason: 'deposit',
        reference: txHash,
      });

      credited += chips;
      balance = updated.chips;
    }

    if (credited === 0 && already === 0) {
      throw new ActionError(refusal ?? 'That deposit does not match any request from this account.');
    }

    if (balance === null) {
      const [owner] = await tx.select({ chips: users.chips }).from(users).where(eq(users.id, session.userId)).limit(1);
      balance = owner.chips;
    }

    return { status: 'credited' as const, chips: credited > 0 ? credited : already, balance };
  });
}

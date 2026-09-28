import { randomUUID } from 'node:crypto';
import {
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  toHex,
  type Account,
  type Hash,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { agentIdentities, agents, attestations } from '../db/schema';
import { envPrefix } from '../lib/chains';
import {
  buildAttestation,
  canonicalise,
  publishPlan,
  REPUTATION_DECIMALS,
  type Attestation,
  type Signer,
} from '../lib/erc8004';
import { chainDefinition, publicClientFor } from './chain';
import type { DeployedChain } from './chains';
import { identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi } from './erc8004-abi';
import { leaderboard } from './metrics';

/**
 * Publishing this arena's records to ERC-8004.
 *
 * Nothing here runs inside the web server. Attestations are posted by an
 * operator running `pnpm attest`, for the same reason the vault has no payout:
 * the process serving pages holds no key and signs nothing, so a bug in a route
 * cannot move anything on chain. It also matches what an attestation is. A win
 * rate is a claim about a body of play, not about the last hand, and republishing
 * it every hand would cost gas to say almost nothing new.
 *
 * The addresses are per-chain and come from the environment the same way vaults
 * do, named after the chain's own key: `MONAD_TESTNET_IDENTITY_REGISTRY` and its
 * reputation sibling, plus a validation one where a chain has such a registry.
 */

export class NotConfigured extends Error {}

type Address = `0x${string}`;

interface Registries {
  identity: Address;
  reputation: Address;
  /** Null on a chain with no Validation Registry, which today is every chain. */
  validation: Address | null;
}

function addressFrom(name: string): Address | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new NotConfigured(`${name} is not an address: ${value}`);
  return value as Address;
}

/** Where the singletons live on this chain, or a refusal naming what is missing. */
function registriesFor(chain: DeployedChain): Registries {
  const prefix = envPrefix(chain.key);
  const identity = addressFrom(`${prefix}_IDENTITY_REGISTRY`);
  const reputation = addressFrom(`${prefix}_REPUTATION_REGISTRY`);

  const missing = [
    identity ? null : `${prefix}_IDENTITY_REGISTRY`,
    reputation ? null : `${prefix}_REPUTATION_REGISTRY`,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new NotConfigured(
      `${chain.name} has no ERC-8004 registries configured. Set ${missing.join(', ')} to the singletons deployed there.`,
    );
  }

  return {
    identity: identity!,
    reputation: reputation!,
    // Optional rather than required: the specification still has this registry
    // under revision and nobody has deployed a canonical one. Requiring it would
    // mean no chain could be published to at all.
    validation: addressFrom(`${prefix}_VALIDATION_REGISTRY`),
  };
}

type Signing = WalletClient & { account: Account };

/**
 * The wallet every identity is handed to once minted, if one is configured.
 *
 * The registrar is a hot key sitting in an environment file, and whoever holds
 * an identity is who can repoint it. Handing each one to an operator's own
 * wallet leaves the registrar nothing worth stealing and nothing lost with it.
 * The price is the validation request, which the standard only takes from the
 * owner or an operator, so a chain with a Validation Registry publishes
 * reputation alone while this is set.
 */
function identityOwner(): Address | null {
  return addressFrom('IDENTITY_OWNER');
}

const KEY_VARS: Record<Signer, string> = {
  registrar: 'REGISTRAR_PRIVATE_KEY',
  attestor: 'ATTESTOR_PRIVATE_KEY',
};

function signerFor(chain: DeployedChain, role: Signer): Signing {
  const name = KEY_VARS[role];
  const key = process.env[name]?.trim();
  if (!key) throw new NotConfigured(`${name} is not set. Attestations are signed, so they need both accounts.`);

  return createWalletClient({
    account: privateKeyToAccount(key as Address),
    chain: chainDefinition(chain),
    transport: http(chain.rpcUrl),
  }) as Signing;
}

/**
 * Both accounts, refused if they are the same one.
 *
 * Both are separate from the treasury on purpose, since they only ever write
 * claims and can be handed to whatever posts them without also handing over the
 * account that owns the vault. They are separate from each other because the
 * registrar owns every identity and the Reputation Registry refuses feedback
 * from an owner. One key doing both would fail on chain, after paying for the
 * mint, so it is refused here instead.
 */
function signers(chain: DeployedChain): Record<Signer, Signing> {
  const registrar = signerFor(chain, 'registrar');
  const attestor = signerFor(chain, 'attestor');
  if (registrar.account.address.toLowerCase() === attestor.account.address.toLowerCase()) {
    throw new NotConfigured(
      'REGISTRAR_PRIVATE_KEY and ATTESTOR_PRIVATE_KEY are the same account. The registrar owns every identity, and the Reputation Registry refuses feedback from an owner.',
    );
  }
  if (identityOwner()?.toLowerCase() === attestor.account.address.toLowerCase()) {
    throw new NotConfigured(
      'IDENTITY_OWNER is the attestor. Identities are handed to that wallet, and the Reputation Registry refuses feedback from an owner.',
    );
  }
  return { registrar, attestor };
}

/** The one identity this agent holds on this chain, if it has been minted. */
async function identityOn(chain: DeployedChain, agentId: string): Promise<{ registryId: string } | undefined> {
  const [row] = await db
    .select({ registryId: agentIdentities.registryId })
    .from(agentIdentities)
    .where(and(eq(agentIdentities.agentId, agentId), eq(agentIdentities.chainId, chain.id)))
    .limit(1);
  return row;
}

/** Waits for a write to be mined, and treats a revert as the failure it is. */
async function mined(chain: DeployedChain, hash: Hash, what: string): Promise<void> {
  const receipt = await publicClientFor(chain).waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
}

export interface Readiness {
  registries: Registries;
  accounts: Record<Signer, { address: Address; balance: bigint }>;
  identityOwner: Address | null;
}

/**
 * What a run on this chain would sign with, and whether either account is
 * empty. Asked before anything is sent, so an unfunded key is one plain line
 * rather than a failure per agent.
 */
export async function readiness(chain: DeployedChain): Promise<Readiness> {
  const registries = registriesFor(chain);
  const keys = signers(chain);
  const client = publicClientFor(chain);

  const [registrar, attestor] = await Promise.all(
    (['registrar', 'attestor'] as const).map(async (role) => {
      const address = keys[role].account.address;
      return { address, balance: await client.getBalance({ address }) };
    }),
  );

  return { registries, accounts: { registrar, attestor }, identityOwner: identityOwner() };
}

/**
 * Mints an ERC-8004 identity for an agent on this chain, if it has none there.
 *
 * The URI is the agent's registration file, which lists its identity on every
 * chain, so all of an agent's mints point at the same document. Returns the
 * existing id unchanged if it already has one here: a second identity on the
 * same chain would split its record in half, which is the shape a Sybil takes.
 */
export async function registerIdentity(
  chain: DeployedChain,
  agentId: string,
  baseUrl: string,
): Promise<{ registryId: string; txHash: Hash | null; transferTx: Hash | null }> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw new NotConfigured(`no agent ${agentId}`);

  const registries = registriesFor(chain);
  const { registrar } = signers(chain);

  const existing = await identityOn(chain, agentId);
  if (existing) {
    // Asked again of an identity already minted, so a run that died between
    // the mint and the handover finishes the handover rather than leaving it.
    const transferTx = await handOver(chain, registries, registrar, existing.registryId);
    return { registryId: existing.registryId, txHash: null, transferTx };
  }

  const txHash = await registrar.writeContract({
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [`${baseUrl}/api/agents/${agentId}/registration`],
    account: registrar.account,
    chain: chainDefinition(chain),
  });

  // The id comes from the receipt rather than the return value, because a
  // write does not hand one back: the mint is only real once it is mined.
  const receipt = await publicClientFor(chain).waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`identity registration reverted: ${txHash}`);

  // Decoded by name, not by position. Identity is an ERC-721, so minting also
  // emits a transfer, and that event's first indexed topic is the sender rather
  // than the token. Reading topics positionally would record every agent as
  // token zero and point every attestation ever posted at the same identity.
  let registryId: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registries.identity.toLowerCase()) continue;

    try {
      const decoded = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Registered') continue;
      registryId = (decoded.args as unknown as { agentId: bigint }).agentId.toString();
      break;
    } catch {
      // Some other event of the registry's, or one this build does not know.
      continue;
    }
  }

  if (registryId === null) throw new Error(`identity registration emitted no Registered event: ${txHash}`);
  await db.insert(agentIdentities).values({
    agentId,
    chainId: chain.id,
    registry: registries.identity,
    registryId,
    registerTx: txHash,
  });

  const transferTx = await handOver(chain, registries, registrar, registryId);
  return { registryId, txHash, transferTx };
}

/**
 * Moves a freshly minted identity from the registrar to `IDENTITY_OWNER`.
 *
 * Read from the chain rather than remembered, so it is safe to call on every
 * run: an identity already handed over costs one read and sends nothing. One
 * held by some third account is refused loudly, since that is not a state this
 * arena can produce by itself.
 */
async function handOver(
  chain: DeployedChain,
  registries: Registries,
  registrar: Signing,
  registryId: string,
): Promise<Hash | null> {
  const owner = identityOwner();
  if (!owner) return null;

  const current = await publicClientFor(chain).readContract({
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: 'ownerOf',
    args: [BigInt(registryId)],
  });
  if (current.toLowerCase() === owner.toLowerCase()) return null;
  if (current.toLowerCase() !== registrar.account.address.toLowerCase()) {
    throw new Error(`identity ${registryId} on ${chain.name} is held by ${current}, neither the registrar nor IDENTITY_OWNER`);
  }

  const hash = await registrar.writeContract({
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: 'transferFrom',
    args: [registrar.account.address, owner, BigInt(registryId)],
    account: registrar.account,
    chain: chainDefinition(chain),
  });
  await mined(chain, hash, 'identity handover');
  return hash;
}

export interface Published {
  agentId: string;
  name: string;
  registryId: string;
  attestation: Attestation;
  attestationId: string;
  evidenceHash: `0x${string}`;
  reputationTx: Hash;
  validationTx: Hash | null;
}

const ABIS = {
  reputation: reputationRegistryAbi,
  validation: validationRegistryAbi,
} as const;

/**
 * Publishes one agent's record on one chain: the rating to Reputation, and how
 * much to believe it to Validation where the chain has that registry.
 *
 * The URI that goes on chain names this attestation's own row, not the agent's
 * latest, so a reader who follows an old record still fetches the bytes its
 * hash was taken over. The row is therefore written before anything is sent.
 */
export async function publishRecord(chain: DeployedChain, agentId: string, baseUrl: string): Promise<Published> {
  const [record] = await leaderboard({ agentId, limit: 1 });
  if (!record) throw new NotConfigured(`no record for agent ${agentId}`);

  const identity = await identityOn(chain, agentId);
  if (!identity) {
    throw new NotConfigured(`agent ${agentId} has no ERC-8004 identity on ${chain.name}. Register it first.`);
  }

  const registries = registriesFor(chain);
  const keys = signers(chain);

  const rating = { mu: record.ratingMu, sigma: record.ratingSigma };
  const attestation = buildAttestation({
    agentId,
    name: record.name,
    rating,
    matches: record.matchesPlayed,
    wins: record.wins,
    hands: record.rate.hands,
    winRateBb100: record.rate.rate,
    earnings: record.earnings,
    measuredAt: new Date(),
  });

  const attestationId = randomUUID();
  const uri = `${baseUrl}/api/attestations/${attestationId}`;
  const evidenceHash = keccak256(toHex(canonicalise(attestation)));

  await db.insert(attestations).values({
    id: attestationId,
    agentId,
    chainId: chain.id,
    registryId: identity.registryId,
    matches: attestation.matches,
    rating: Math.round(attestation.rating * 10 ** REPUTATION_DECIMALS),
    ratingMu: attestation.ratingMu,
    ratingSigma: attestation.ratingSigma,
    confidence: attestation.confidence,
    evidenceHash,
    evidence: attestation,
  });

  const plan = publishPlan({
    registryId: BigInt(identity.registryId),
    attestor: keys.attestor.account.address,
    uri,
    evidenceHash,
    attestation,
    // The request must come from the identity's owner, which is no longer the
    // registrar once identities are handed over.
    validation: registries.validation !== null && identityOwner() === null,
  });

  const sent: Partial<Record<(typeof plan)[number]['column'], Hash>> = {};
  for (const write of plan) {
    const wallet = keys[write.signer];
    const address = write.registry === 'validation' ? registries.validation! : registries.reputation;

    // Awaited one at a time. Two writes from one account sent before the first
    // is mined can be built on the same nonce and quietly replace each other.
    // The cast is the price of choosing the ABI at runtime; the arguments were
    // shaped against the same specification in publishPlan.
    const hash = await wallet.writeContract({
      address,
      abi: ABIS[write.registry],
      functionName: write.functionName,
      args: write.args,
      account: wallet.account,
      chain: chainDefinition(chain),
    } as unknown as Parameters<WalletClient['writeContract']>[0]);
    await mined(chain, hash, write.functionName);

    sent[write.column] = hash;
    await db.update(attestations).set({ [write.column]: hash }).where(eq(attestations.id, attestationId));
  }

  return {
    agentId,
    name: record.name,
    registryId: identity.registryId,
    attestation,
    attestationId,
    evidenceHash,
    reputationTx: sent.reputationTx!,
    validationTx: sent.validationTx ?? null,
  };
}

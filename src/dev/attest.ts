import 'dotenv/config';
import { formatEther } from 'viem';
import { db, sql } from '../db/client';
import { agents } from '../db/schema';
import { NotConfigured, publishRecord, readiness, registerIdentity } from '../server/erc8004';
import { publicBaseUrl } from '../server/attestation';
import { enabledChains, type DeployedChain } from '../server/chains';
import { leaderboard } from '../server/metrics';
import { txUrl } from '../lib/chains';

/**
 * Publishes the arena's records to ERC-8004.
 *
 * Run by an operator, never by the web server. Attesting signs transactions,
 * and the process serving pages deliberately holds no key at all, so this is
 * the only thing here that can write to a chain.
 *
 *   pnpm attest                     every agent with enough hands, on every enabled chain
 *   pnpm attest <chain-key>         the same, on one chain
 *   pnpm attest <chain-key> <id>    one agent, on one chain
 *   pnpm attest all <id>            one agent, on every enabled chain
 *
 * An agent with too few hands is skipped rather than published with a
 * confidence of zero. A registry full of scores that mean nothing is the exact
 * problem this integration exists to be better than.
 */

/** Below this the interval is so wide the score would be zero anyway. */
const MIN_HANDS = 200;

type Leaderboard = Awaited<ReturnType<typeof leaderboard>>;

async function main(): Promise<void> {
  const chainKey = process.argv[2] ?? 'all';
  const only = process.argv[3];

  const enabled = enabledChains();
  const chains = chainKey === 'all' ? enabled : enabled.filter((entry) => entry.key === chainKey);
  if (chains.length === 0) {
    throw new Error(`no such chain: ${chainKey}. Enabled: ${enabled.map((entry) => entry.key).join(', ')}`);
  }

  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'PUBLIC_BASE_URL is not set. The attestation URI has to be somewhere a reader can actually fetch it.',
    );
  }

  const owned = only ? [{ id: only }] : await db.select({ id: agents.id }).from(agents);
  const records = new Map((await leaderboard({ limit: 500 })).map((row) => [row.agentId, row]));

  // Chains are independent. One with a slow endpoint, an empty account or no
  // registries says so and the rest still go out.
  for (const chain of chains) {
    try {
      await attestOn(chain, baseUrl, owned, records);
    } catch (error) {
      console.error(`stop  ${chain.name}: ${error instanceof Error ? error.message : error}\n`);
    }
  }

  await sql.end();
}

async function attestOn(
  chain: DeployedChain,
  baseUrl: string,
  owned: Array<{ id: string }>,
  records: Map<string, Leaderboard[number]>,
): Promise<void> {
  const ready = await readiness(chain);
  console.log(`attesting on ${chain.name} as ${baseUrl}`);
  for (const [role, account] of Object.entries(ready.accounts)) {
    console.log(`      ${role.padEnd(9)} ${account.address}  ${formatEther(account.balance)} ${chain.nativeCurrency.symbol}`);
  }
  if (ready.identityOwner) console.log(`      identities handed to ${ready.identityOwner}`);
  if (!ready.registries.validation) console.log('      no Validation Registry here, publishing reputation only');
  else if (ready.identityOwner) console.log('      the registrar will not own identities, so validation is skipped');

  const empty = Object.entries(ready.accounts).filter(([, account]) => account.balance === 0n);
  if (empty.length > 0) {
    throw new NotConfigured(
      `${empty.map(([role]) => role).join(' and ')} ${empty.length > 1 ? 'have' : 'has'} no ${chain.nativeCurrency.symbol} for gas. Fund from ${chain.faucetUrl}`,
    );
  }

  for (const agent of owned) {
    const record = records.get(agent.id);
    const hands = record?.rate.hands ?? 0;

    if (hands < MIN_HANDS) {
      console.log(`skip  ${record?.name ?? agent.id}: ${hands} hands, below ${MIN_HANDS}`);
      continue;
    }

    try {
      const identity = await registerIdentity(chain, agent.id, baseUrl);
      if (identity.txHash) {
        console.log(`mint  ${record!.name}: agent ${identity.registryId}  ${txUrl(chain, identity.txHash)}`);
      }
      if (identity.transferTx) {
        console.log(`give  ${record!.name}: agent ${identity.registryId} to its owner  ${txUrl(chain, identity.transferTx)}`);
      }

      const published = await publishRecord(chain, agent.id, baseUrl);
      console.log(
        `post  ${published.name}: rating ${published.attestation.rating}, ${published.attestation.winRateBb100} bb/100 over ${published.attestation.hands} hands, confidence ${published.attestation.confidence}`,
      );
      console.log(`      ${txUrl(chain, published.reputationTx)}`);
      console.log(`      evidence ${baseUrl}/api/attestations/${published.attestationId} (${published.evidenceHash})`);
    } catch (error) {
      // One agent that cannot be published does not stop the rest, but a
      // configuration problem would fail every one of them the same way.
      if (error instanceof NotConfigured) throw error;
      console.error(`fail  ${record?.name ?? agent.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

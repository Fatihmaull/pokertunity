import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { agentIdentities, agents, attestations } from '../db/schema';
import { buildAttestation, buildRegistration, type Attestation, type Registration } from '../lib/erc8004';
import { leaderboard } from './metrics';

/**
 * Reading attestations, with nothing here that can sign one.
 *
 * Kept apart from the publishing code on purpose. The route that serves the
 * evidence document is reachable from the web, and the module that posts
 * attestations reads a private key: a route importing that module puts the
 * signing path one mistake away from a request handler, even though the running
 * server has no business ever using it. Publishing lives in `erc8004.ts` and
 * only `pnpm attest` imports it.
 */
/**
 * The document an attestation's hash refers to.
 *
 * Serves the attestation as published where there is one, so a reader
 * re-hashing it gets what is on chain, and the live figures where there is not.
 * A live document is explicitly marked unpublished: it is the same measurement,
 * but nothing has committed to it.
 */
export async function attestationFor(agentId: string): Promise<{ attestation: Attestation; published: boolean } | null> {
  const [latest] = await db
    .select({ evidence: attestations.evidence })
    .from(attestations)
    // A row is written before its transactions are sent, so one without a
    // reputation transaction is a record nothing on chain has committed to yet.
    .where(and(eq(attestations.agentId, agentId), isNotNull(attestations.reputationTx)))
    .orderBy(desc(attestations.createdAt))
    .limit(1);

  if (latest) return { attestation: latest.evidence as Attestation, published: true };

  const [record] = await leaderboard({ agentId, limit: 1 });
  if (!record) return null;

  return {
    attestation: buildAttestation({
      agentId,
      name: record.name,
      rating: { mu: record.ratingMu, sigma: record.ratingSigma },
      matches: record.matchesPlayed,
      wins: record.wins,
      hands: record.rate.hands,
      winRateBb100: record.rate.rate,
      earnings: record.earnings,
      measuredAt: new Date(),
    }),
    published: false,
  };
}

/**
 * One attestation's evidence, exactly as it was hashed.
 *
 * This is what the URI on chain names, so it serves that row and nothing newer:
 * a reader following a record posted months ago re-hashes these bytes and gets
 * the hash beside it, however far the agent's live figures have moved since.
 */
export async function attestationById(
  id: string,
): Promise<{ attestation: Attestation; published: boolean } | null> {
  const [row] = await db
    .select({ evidence: attestations.evidence, reputationTx: attestations.reputationTx })
    .from(attestations)
    .where(eq(attestations.id, id))
    .limit(1);

  if (!row) return null;
  return { attestation: row.evidence as Attestation, published: row.reputationTx !== null };
}

/**
 * The registration file every one of an agent's identities points at.
 *
 * Built from the mints actually recorded, so a chain the agent has not been
 * registered on yet is simply absent rather than listed with a guessed id.
 */
export async function registrationFor(agentId: string, baseUrl: string): Promise<Registration | null> {
  const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return null;

  const identities = await db
    .select({ chainId: agentIdentities.chainId, registry: agentIdentities.registry, registryId: agentIdentities.registryId })
    .from(agentIdentities)
    .where(eq(agentIdentities.agentId, agentId));

  return buildRegistration({ agentId, name: agent.name, baseUrl, identities });
}

/**
 * Where a reader outside reaches this arena, with no trailing slash.
 *
 * `PUBLIC_BASE_URL` wins because it is what `pnpm attest` wrote on chain, and a
 * registration file whose links disagree with the URI that led to it is worse
 * than none. `APP_ORIGIN` is the same domain on a deployment that only set the
 * one sign-in already requires.
 */
export function publicBaseUrl(): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim() || process.env.APP_ORIGIN?.trim();
  return configured ? configured.replace(/\/$/, '') : null;
}

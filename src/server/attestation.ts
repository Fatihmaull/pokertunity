import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { agentIdentities, agents, attestations } from '../db/schema';
import { chainById } from '../lib/chains';
import {
  buildAttestation,
  buildRegistration,
  REPUTATION_DECIMALS,
  type Attestation,
  type OnChainRecord,
  type Registration,
} from '../lib/erc8004';
import { leaderboard } from './metrics';

/**
 * Reading attestations. This module is read-only.
 *
 * Kept apart from the publishing code on purpose. The route that serves the
 * evidence document is reachable from the web, and the module that posts
 * attestations reads a private key, so the signing path stays far from every
 * request handler. Publishing lives in `erc8004.ts`, and `pnpm attest` is its
 * one importer.
 */
/**
 * The document an attestation's hash refers to.
 *
 * Serves the attestation as published where there is one, so a reader
 * re-hashing it gets what is on chain, and the live figures otherwise. A live
 * document is explicitly marked unpublished: it is the same measurement, still
 * waiting for a commitment.
 */
export async function attestationFor(agentId: string): Promise<{ attestation: Attestation; published: boolean } | null> {
  const [latest] = await db
    .select({ evidence: attestations.evidence })
    .from(attestations)
    // A row is written before its transactions are sent, so one whose
    // reputation transaction is still empty is a record waiting for the chain.
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
 * This is what the URI on chain names, so it serves exactly that row:
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
 * Built from the mints actually recorded, so the file lists exactly the chains
 * the agent is registered on, each with its real id.
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
 * Where a reader outside reaches this arena, trailing slash trimmed.
 *
 * `PUBLIC_BASE_URL` wins because it is what `pnpm attest` wrote on chain, and a
 * registration file's links have to agree with the URI that led to it.
 * `APP_ORIGIN` is the same domain on a deployment that set the one variable
 * sign-in already requires.
 */
export function publicBaseUrl(): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim() || process.env.APP_ORIGIN?.trim();
  return configured ? configured.replace(/\/$/, '') : null;
}

/**
 * Each agent's identity and newest published record, on every chain.
 *
 * Every chain at once, so switching networks in the interface is instant and
 * always agrees with a poll still in flight. Two queries for the whole page.
 */
export async function onchainRecords(agentIds: string[]): Promise<Map<string, OnChainRecord[]>> {
  const found = new Map<string, OnChainRecord[]>();
  if (agentIds.length === 0) return found;

  const identities = await db
    .select({
      agentId: agentIdentities.agentId,
      chainId: agentIdentities.chainId,
      registryId: agentIdentities.registryId,
      registerTx: agentIdentities.registerTx,
    })
    .from(agentIdentities)
    .where(inArray(agentIdentities.agentId, agentIds));
  if (identities.length === 0) return found;

  // The newest mined record per agent and chain, which is what DISTINCT ON
  // keeps when the rows are ordered newest first within each pair.
  const latest = await db
    .selectDistinctOn([attestations.agentId, attestations.chainId], {
      id: attestations.id,
      agentId: attestations.agentId,
      chainId: attestations.chainId,
      rating: attestations.rating,
      confidence: attestations.confidence,
      reputationTx: attestations.reputationTx,
      createdAt: attestations.createdAt,
    })
    .from(attestations)
    .where(and(inArray(attestations.agentId, agentIds), isNotNull(attestations.reputationTx)))
    .orderBy(asc(attestations.agentId), asc(attestations.chainId), desc(attestations.createdAt));

  const published = new Map(latest.map((row) => [`${row.agentId}:${row.chainId}`, row]));

  for (const identity of identities) {
    // A chain dropped from the registry since the mint lacks an explorer to
    // link to, so the list shows the chains it can describe in full.
    const chain = chainById(identity.chainId);
    if (!chain) continue;

    const record = published.get(`${identity.agentId}:${identity.chainId}`);
    const list = found.get(identity.agentId) ?? [];
    list.push({
      chain: chain.key,
      registryId: identity.registryId,
      mintTx: identity.registerTx,
      published: record
        ? {
            attestationId: record.id,
            rating: record.rating / 10 ** REPUTATION_DECIMALS,
            confidence: record.confidence,
            tx: record.reputationTx!,
            at: record.createdAt.toISOString(),
          }
        : null,
    });
    found.set(identity.agentId, list);
  }

  return found;
}

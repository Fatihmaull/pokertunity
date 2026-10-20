/**
 * What this arena publishes to ERC-8004, and why anyone should believe it.
 *
 * ERC-8004's own weak point is that reputation is self-reported. An agent, or
 * whoever runs one, posts feedback about itself or about its friends, and the
 * standard leaves that cheap. Published work on the ecosystem says the same: the
 * registries are sound, and the signals going into them are the weak part.
 *
 * A poker record is the opposite kind of signal. It is adversarial, it is
 * measured in money that came from somewhere, and every match costs an entry
 * fee. A rating is Sybil-proof: finishing above somebody means taking chips
 * off them while they tried to keep them, and the arena chose the opponents.
 *
 * So two things go on chain, and they answer different questions.
 *
 *   Reputation says how good the agent is, as its rating. It is signed, because
 *   an agent that keeps finishing last rates below where it started.
 *
 *   Validation says how much that figure is worth believing, as the 0 to 100
 *   the standard asks for, derived from the rating's own uncertainty. That is a
 *   more direct answer than any proxy: the uncertainty term literally means how
 *   sure we are.
 *
 * Canonical Validation Registries are still to come, so on a chain with none
 * configured the reputation goes up alone. The confidence still does, inside
 * the evidence document the reputation's hash commits to.
 *
 * Everything here is pure. The numbers can be checked against the published
 * evidence document by anybody, independently of this server.
 */

import { DEFAULT_RATING, conservative, type Rating } from './rating';

/**
 * Uncertainty this wide carries zero information, so it scores zero.
 *
 * The starting sigma is exactly that: an agent the arena has yet to watch play.
 * A confidence of zero for one is simply the truth.
 */
const USELESS_SIGMA = DEFAULT_RATING.sigma;

/**
 * Hands an agent plays before its record is published.
 *
 * By this point the interval has closed enough for the confidence to mean
 * something, and a registry of meaningful scores is the whole point of this
 * integration.
 */
export const MIN_ATTESTED_HANDS = 200;

/** Two decimals on the reputation value, so a rating of 27.34 survives the trip. */
export const REPUTATION_DECIMALS = 2;

/** Both registries take these, and both are indexed, so they are the query. */
const REPUTATION_TAGS = { game: 'texas-holdem', metric: 'trueskill-rating' } as const;
const VALIDATION_TAG = 'poker-record';

/**
 * How much to believe the rating, as the 0 to 100 the Validation Registry takes.
 *
 * Read straight off the uncertainty, which is the one input an attacker has to
 * earn: it closes by playing matches the arena chose the opponents for,
 * each of which costs an entry fee. A confidently terrible agent scores high
 * here and should, because the arena is sure about it.
 */
export function confidenceIn(rating: Rating): number {
  if (!Number.isFinite(rating.sigma) || rating.sigma >= USELESS_SIGMA) return 0;

  const closed = 1 - rating.sigma / USELESS_SIGMA;
  return Math.max(0, Math.min(100, Math.round(closed * 100)));
}

/**
 * The document a reader fetches to check the claim.
 *
 * Its hash goes on chain beside the score, so an operator that later edits the
 * record visibly breaks its own attestation.
 */
export interface Attestation {
  /** The document format, so a reader knows what it is holding. */
  schema: 'pokertunity/attestation/2';
  agentId: string;
  name: string;
  /** Matches the rating was earned over, and hands played across them. */
  matches: number;
  hands: number;
  /** The published rating: the pessimistic end of the estimate. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  /** Matches won outright. */
  wins: number;
  /** Net chips won at the tables, counted from play alone. */
  earnings: number;
  /** Big blinds per 100 hands, published beside the rating. */
  winRateBb100: number;
  /** The 0 to 100 that went into the Validation Registry, restated here. */
  confidence: number;
  /** When this was measured, so a stale attestation is visible as stale. */
  measuredAt: string;
  method: string;
}

const METHOD =
  'The rating is a TrueSkill-family estimate updated from the finishing order of every match, computed as pairwise comparisons within each one. The published figure is three standard deviations below the estimate, so it climbs with evidence. Opponents are chosen by the arena, and every seat costs a fixed buy-in plus an entry fee. Confidence is how far the uncertainty has closed from where an unseen agent starts.';

export function buildAttestation(input: {
  agentId: string;
  name: string;
  rating: Rating;
  matches: number;
  wins: number;
  hands: number;
  winRateBb100: number;
  earnings: number;
  measuredAt: Date;
}): Attestation {
  return {
    schema: 'pokertunity/attestation/2',
    agentId: input.agentId,
    name: input.name,
    matches: input.matches,
    hands: input.hands,
    rating: round(conservative(input.rating)),
    ratingMu: round(input.rating.mu),
    ratingSigma: round(input.rating.sigma),
    wins: input.wins,
    earnings: input.earnings,
    winRateBb100: round(input.winRateBb100),
    confidence: confidenceIn(input.rating),
    measuredAt: input.measuredAt.toISOString(),
    method: METHOD,
  };
}

/**
 * The exact bytes that get hashed.
 *
 * Keys in a fixed order and compact whitespace, so the same record hashes
 * the same on any machine. A reader that re-serialises the fetched document
 * with this function and gets a different hash has found a changed record,
 * which is the entire point of putting the hash on chain.
 */
export function canonicalise(attestation: Attestation): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(attestation).sort()) {
    ordered[key] = attestation[key as keyof Attestation];
  }
  return JSON.stringify(ordered);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Which of the arena's two keys signs a write.
 *
 * Two, because the standard pulls in opposite directions and each key
 * satisfies one side. Feedback comes from outside the agent's owner and
 * approved operators, and the deployed Reputation Registry reverts it otherwise.
 * A validation request comes from exactly that owner. So the registrar owns
 * every identity and asks for validation, and the attestor, which owns zero
 * identities, is the judge that answers it and scores the agent.
 */
export type Signer = 'registrar' | 'attestor';

export interface PlannedWrite {
  signer: Signer;
  registry: 'reputation' | 'validation';
  functionName: 'validationRequest' | 'validationResponse' | 'giveFeedback';
  args: readonly unknown[];
  /** The attestation column its transaction hash is written to once mined. */
  column: 'validationTx' | 'validationResponseTx' | 'reputationTx';
}

/**
 * Every write that publishes one attestation, in the order they must be mined.
 *
 * The validation request goes first where there is a registry for it, so the
 * score that follows answers a question that was already public. Pure, so who
 * signs what is testable in memory, which is where a signer mix-up gets caught.
 */
export function publishPlan(input: {
  registryId: bigint;
  attestor: `0x${string}`;
  uri: string;
  evidenceHash: `0x${string}`;
  attestation: Attestation;
  validation: boolean;
}): PlannedWrite[] {
  const { registryId, attestor, uri, evidenceHash, attestation } = input;
  const writes: PlannedWrite[] = [];

  if (input.validation) {
    writes.push(
      {
        signer: 'registrar',
        registry: 'validation',
        functionName: 'validationRequest',
        args: [attestor, registryId, uri, evidenceHash],
        column: 'validationTx',
      },
      {
        signer: 'attestor',
        registry: 'validation',
        functionName: 'validationResponse',
        args: [evidenceHash, attestation.confidence, uri, evidenceHash, VALIDATION_TAG],
        column: 'validationResponseTx',
      },
    );
  }

  writes.push({
    signer: 'attestor',
    registry: 'reputation',
    functionName: 'giveFeedback',
    args: [
      registryId,
      BigInt(Math.round(attestation.rating * 10 ** REPUTATION_DECIMALS)),
      REPUTATION_DECIMALS,
      REPUTATION_TAGS.game,
      REPUTATION_TAGS.metric,
      uri,
      uri,
      evidenceHash,
    ],
    column: 'reputationTx',
  });

  return writes;
}

/** One minted identity, as the registration file lists it. */
export interface Identity {
  chainId: number;
  registry: string;
  registryId: string;
}

/**
 * The document an agent's on-chain URI resolves to: ERC-8004's registration-v1.
 *
 * One file for every chain. Each chain's mint points here, and the file lists
 * all of them, which is how the standard says an agent registered in several
 * places is recognised as one agent.
 */
export interface Registration {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image: string;
  services: Array<{ name: string; endpoint: string }>;
  x402Support: false;
  active: boolean;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: string[];
}

export function buildRegistration(input: {
  agentId: string;
  name: string;
  baseUrl: string;
  identities: Identity[];
}): Registration {
  const { agentId, name, baseUrl } = input;

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description: `${name} is an agent that plays no-limit Texas hold'em on Pokertunity. Its rating is earned from where it finishes in matches whose opponents the arena chose, each of which costs an entry fee.`,
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: `${baseUrl}/standings` },
      { name: 'attestation', endpoint: `${baseUrl}/api/agents/${agentId}/attestation` },
    ],
    x402Support: false,
    active: true,
    // Sorted so the same set of mints always serialises the same way.
    registrations: [...input.identities]
      .sort((a, b) => a.chainId - b.chainId)
      .map((identity) => ({
        agentId: Number(identity.registryId),
        agentRegistry: `eip155:${identity.chainId}:${identity.registry}`,
      })),
    supportedTrust: ['reputation'],
  };
}

/**
 * What the interface is told about one agent on one chain.
 *
 * Hashes, since which explorer a hash belongs to is the
 * chain registry's business and the browser already has it.
 */
export interface OnChainRecord {
  /** The chain's key, as in `src/lib/chains.ts`. */
  chain: string;
  registryId: string;
  mintTx: string;
  /** The newest record whose feedback was mined, or null before the first. */
  published: {
    attestationId: string;
    rating: number;
    confidence: number;
    tx: string;
    at: string;
  } | null;
}

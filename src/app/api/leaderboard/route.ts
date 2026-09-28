import { onchainRecords } from '@/server/attestation';
import { getSession } from '@/server/auth';
import { leaderboard } from '@/server/metrics';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The standings, ranked by rating.
 *
 * Not by chips, and not by win rate. Agents are matched against opponents of
 * their own strength, so a win rate converges on break even for everybody and
 * stops separating anyone. The rating asks the question that survives that:
 * how often did this agent finish above players we already believed were good.
 *
 * The money is published beside it because it is what actually happened, and an
 * arena that hid it would be hiding the only number with a unit.
 */
export async function GET(request: Request): Promise<Response> {
  const allowed = take('leaderboard', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const rows = await leaderboard({ limit: 50 });
  const onchain = await onchainRecords(rows.map((row) => row.agentId));

  return Response.json({
    agents: rows.map((row) => ({
      agentId: row.agentId,
      name: row.name,
      // The pessimistic end of the estimate. An agent nobody has seen play
      // publishes zero rather than an average, which is different from being
      // rated average and is shown as such.
      rating: row.rating,
      ratingMu: row.ratingMu,
      ratingSigma: row.ratingSigma,
      matches: row.matchesPlayed,
      wins: row.wins,
      chips: row.chips,
      earnings: row.earnings,
      hands: row.rate.hands,
      // Both halves, never the optimistic one on its own. The rate is what
      // happened; the floor is what it is evidence for, and over a short sample
      // the two are nowhere near each other — forty hot hands read as a
      // spectacular rate over a floor deep underwater. Null when there are too
      // few hands for an interval to exist, which sorts last: unknown is not
      // good.
      winRate: row.rate.rate,
      winRateFloor: row.rate.floor,
      // Its ERC-8004 identity and newest published record on each chain, so
      // the standings can show what anyone can check without asking us.
      onchain: onchain.get(row.agentId) ?? [],
    })),
  });
}

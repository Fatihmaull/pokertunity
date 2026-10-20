import { onchainRecords } from '@/server/attestation';
import { getSession } from '@/server/auth';
import { standings, type Standing } from '@/server/metrics';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The standings, ranked by rating, a page at a time, with the viewer's own
 * agents and where each of them stands.
 *
 * Agents are matched against opponents of their own strength, so every win
 * rate converges on break even. The rating asks the sharper question:
 * how often did this agent finish above players we already believed were good.
 *
 * The money is published beside it because it is what actually happened, and
 * it is the one number with a unit.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  const allowed = take('leaderboard', callerOf(request, session?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const board = await standings({
    page: Number(new URL(request.url).searchParams.get('page')) || 1,
    ownerId: session?.userId ?? null,
  });
  const onchain = await onchainRecords([...board.ranked, ...(board.mine ?? [])].map((row) => row.agentId));

  const shape = (row: Standing) => ({
    agentId: row.agentId,
    name: row.name,
    place: row.place,
    // The pessimistic end of the estimate. A newcomer publishes zero, a
    // placeholder distinct from a rated average, and is shown as such.
    rating: row.rating,
    ratingMu: row.ratingMu,
    ratingSigma: row.ratingSigma,
    matches: row.matchesPlayed,
    wins: row.wins,
    chips: row.chips,
    earnings: row.earnings,
    hands: row.rate.hands,
    // Both halves, always together. The rate is what happened; the floor is
    // what it is evidence for, and over a short sample the two sit far apart:
    // forty hot hands read as a spectacular rate over a floor deep underwater.
    // Null when there are too few hands for an interval to exist, which sorts
    // last: unknown ranks below known.
    winRate: row.rate.rate,
    winRateFloor: row.rate.floor,
    // Its ERC-8004 identity and newest published record on each chain, so
    // the standings can show what anyone can check independently.
    onchain: onchain.get(row.agentId) ?? [],
  });

  return Response.json({
    agents: board.ranked.map(shape),
    page: board.page,
    pages: board.pages,
    mine: board.mine?.map(shape) ?? null,
  });
}

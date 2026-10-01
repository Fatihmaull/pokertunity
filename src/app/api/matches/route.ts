import { matchLabel } from '@/lib/format';
import { getSession } from '@/server/auth';
import { account } from '@/server/actions';
import { callerOf, take, tooMany } from '@/server/rate-limit';
import { allMatches } from '@/server/registry';
import { storedMatches } from '@/server/store';

/**
 * The floor: every match being dealt, and a page of the ones that have ended.
 *
 * Built from the match rows rather than from this process's own runtimes. Only
 * one instance deals, so only that one has runtimes, and a floor read off them
 * would tell every other instance that the arena is empty. That is
 * indistinguishable from the arena being empty, which is the worst way for it
 * to be wrong.
 *
 * The dealing instance then overlays what only it can know: the pot in the
 * middle right now, and whose turn it is.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  const allowed = take('matches', callerOf(request, session?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const mine = session ? await account(session).catch(() => null) : null;
  const myMatchIds = new Set(
    (mine?.agents ?? []).flatMap((agent) => (agent.seat ? [agent.seat.matchId] : [])),
  );

  const floor = await storedMatches(Number(new URL(request.url).searchParams.get('page')) || 1);
  const live = new Map(allMatches().map((runtime) => [runtime.matchId, runtime]));

  const matches = floor.matches.map((row) => {
    const runtime = live.get(row.matchId);
    const view = runtime?.view(mine?.agents.find((agent) => agent.seat?.matchId === row.matchId)?.id ?? null) ?? null;

    return {
      id: row.matchId,
      label: matchLabel(row.number),
      status: row.status,
      seatCount: row.seatCount,
      smallBlind: row.smallBlind,
      bigBlind: row.bigBlind,
      buyIn: row.buyIn,
      handCap: row.handCap,
      handNumber: view?.handNumber ?? row.handsPlayed,
      live: row.status === 'playing',
      pot: view?.pot ?? 0,
      /** Average rating of the entrants, which is what the band was drawn on. */
      bandRating: row.bandRating,
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
    };
  });

  return Response.json({
    matches,
    // Of the ended matches. The live ones are not paged.
    page: floor.page,
    pages: floor.pages,
    // Which matches the viewer has an agent in, so the interface can point at
    // them rather than making somebody find their own name in a list.
    mine: [...myMatchIds],
  });
}

import { stakesLabel } from '@/lib/economy';
import { getSession } from '@/server/auth';
import { account } from '@/server/actions';
import { callerOf, take, tooMany } from '@/server/rate-limit';
import { allMatches } from '@/server/registry';
import { storedMatches } from '@/server/store';

/**
 * The floor: every match being dealt, and the ones that just finished.
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

  // One owner can hold at most one seat in any match, so a set of their agent
  // ids is enough to answer "is that me" without picking between them.
  const myAgentIds = new Set((mine?.agents ?? []).map((agent) => agent.id));
  const myMatchIds = new Set(
    (mine?.agents ?? []).flatMap((agent) => (agent.seat ? [agent.seat.matchId] : [])),
  );

  const stored = await storedMatches();
  // Read what each runtime already knows. Forcing a refresh here would publish
  // a snapshot into every spectator's feed on each poll.
  const live = new Map(allMatches().map((runtime) => [runtime.matchId, runtime]));

  const matches = stored.map((row) => {
    const runtime = live.get(row.matchId);
    const view = runtime?.view(mine?.agents.find((agent) => agent.seat?.matchId === row.matchId)?.id ?? null) ?? null;

    const seats = view?.seats.length
      ? view.seats.map((seat) => ({
          index: seat.index,
          name: seat.name,
          color: seat.color,
          stack: seat.stack,
          // Read off the seat row, which is written in the same transaction as
          // the hand that knocked it out. The live view has no notion of out:
          // a seat that busted still has an occupant, so it never reads empty.
          busted: row.seats.find((entry) => entry.index === seat.index)?.busted ?? false,
          isMine: seat.agentId !== null && myAgentIds.has(seat.agentId),
        }))
      : Array.from({ length: row.seatCount }, (_, index) => {
          const seat = row.seats.find((entry) => entry.index === index);
          return {
            index,
            name: seat?.name ?? null,
            color: seat?.color ?? null,
            stack: seat?.stack ?? 0,
            busted: seat?.busted ?? false,
            isMine: seat !== undefined && seat.agentId !== null && myAgentIds.has(seat.agentId),
          };
        });

    return {
      id: row.matchId,
      label: `${stakesLabel()} match`,
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
      seats,
    };
  });

  return Response.json({
    matches,
    // Which matches the viewer has an agent in, so the interface can point at
    // them rather than making somebody find their own name in a list.
    mine: [...myMatchIds],
    // Whether any of their agents is connected and asking for a game, which is
    // what the empty state needs to know to say something useful.
    queued: (mine?.agents ?? []).some((agent) => agent.ready),
  });
}

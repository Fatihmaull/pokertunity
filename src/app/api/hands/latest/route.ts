import { decisionsForHand, latestHand } from '@/server/store';
import { allMatches } from '@/server/registry';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * Feeds the landing page. If a table is dealing right now the hero watches it
 * live; while the room is idle, the page replays the last real hand and says
 * so. Every hand it shows was really played.
 *
 * A hand that was thrown away face down stays face down here too. The table
 * mucks, and this route keeps the muck private: the opponents from that hand
 * are usually still sitting at the same table, and an owner who learned what
 * one of them folded could write it straight into their own agent. What each
 * agent did is public. What it was holding when it declined to show stays
 * private.
 */
export async function GET(request: Request): Promise<Response> {
  const allowed = take('hands-latest', callerOf(request, (await getSession())?.userId ?? null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const live = allMatches().find((match) => {
    const view = match.view(null);
    return view.toAct !== null || view.street !== 'idle';
  });

  if (live) return Response.json({ mode: 'live', matchId: live.matchId });

  const hand = await latestHand();
  if (!hand) return Response.json({ mode: 'empty' });

  const shown = tabled(hand.events);
  const rows = await decisionsForHand(hand.id);

  return Response.json({
    mode: 'replay',
    matchId: hand.matchId,
    handNumber: hand.handNumber,
    lineup: hand.lineup,
    board: hand.board,
    decisions: rows.map((row) => {
      const revealed = shown.has(row.seatIndex);
      return {
        seatIndex: row.seatIndex,
        street: row.street,
        // How the hand was played is the record. How strong it was is the
        // holding, by another name: an equity of 0.95 on the river names the
        // cards as surely as showing them would.
        equity: revealed ? row.equity : null,
        handRead: revealed ? row.handRead : null,
        reasoning: revealed ? row.reasoning : null,
        mucked: !revealed,
        say: row.say,
        action: row.action,
        amount: row.amount,
        elapsedMs: row.elapsedMs,
        outcome: row.outcome,
      };
    }),
  });
}

/**
 * Seats that turned their cards face up, read from the hand's own events.
 *
 * The engine already decided this when it settled: winners table, plus
 * everyone still live once somebody is all in. Reading the events keeps the
 * rule in one place.
 */
function tabled(events: unknown): Set<number> {
  if (!Array.isArray(events)) return new Set();

  return new Set(
    events
      .filter((event) => event?.type === 'showdown' && typeof event.seat === 'number')
      .map((event) => event.seat as number),
  );
}

import { account } from '@/server/actions';
import { getSession } from '@/server/auth';
import { callerOf } from '@/server/rate-limit';
import { matchRuntime } from '@/server/registry';
import { admit } from '@/server/spectators';
import type { ArenaEvent } from '@/server/view';

export const dynamic = 'force-dynamic';

/**
 * The arena feed. One direction only: spectators never send anything back, so
 * server-sent events fit exactly and cost nothing a socket would.
 *
 * Hole cards are redacted per viewer on the way out. Events that carry seat
 * state are replaced with a snapshot rendered for this specific viewer, so a
 * spectator's stream physically does not contain another agent's cards.
 *
 * What a deciding seat thinks of its cards never reaches the bus in the first
 * place: the runtime seals reasoning, equity and hand read for the whole hand
 * and opens them only with a `reveal` at showdown. Forwarding everything else
 * unchanged is safe because of that, not because of anything done here.
 *
 * That per-viewer render is also why the gallery is capped. Every subscriber
 * costs the dealing process work on every event, and the render cannot be
 * shared without sharing one viewer's cards with another, so the only safe
 * lever on the cost is how many subscribers there are.
 */
export async function GET(request: Request, context: RouteContext<'/api/matches/[id]/stream'>): Promise<Response> {
  const { id } = await context.params;
  const runtime = matchRuntime(id);
  if (!runtime) {
    // A live feed can only come from the process actually dealing, and only one
    // instance does. Saying so is worth doing: a 404 here reads as "no such
    // match", which would send a client away from a game that is running
    // perfectly well somewhere it cannot see. A match that has finished is also
    // gone from here, and that is the same answer.
    // JSON, like every other refusal in this API, so a client can branch on it.
    return Response.json(
      {
        error: 'That match is not being dealt by this instance. It has either finished or is running elsewhere.',
        matchId: id,
        dealing: false,
      },
      { status: 503, headers: { 'retry-after': '5' } },
    );
  }

  const session = await getSession();

  // Before the account lookup, so a refusal costs this process nothing. A 503
  // with a retry-after is what this route already answers when it is not the
  // dealer, and the client backs off and retries on any refusal alike.
  const seat = admit(id, callerOf(request, session?.userId ?? null));
  if (!seat.ok) {
    return Response.json(
      seat.reason === 'full'
        ? { error: 'The arena cannot take more spectators on this match right now. Try again shortly.', matchId: id, full: true }
        : { error: 'Too many open feeds for this match from one viewer.', matchId: id, full: false },
      { status: seat.reason === 'full' ? 503 : 429, headers: { 'retry-after': '15' } },
    );
  }

  // Whichever of the viewer's agents is in this match, if any. One owner can
  // hold at most one seat per match, because the matchmaker refuses to seat two
  // of theirs together, so there is never a choice to make here.
  const viewerAgentId = session
    ? await account(session)
        .then((row) => row.agents.find((agent) => agent.seat?.matchId === id)?.id ?? null)
        .catch(() => null)
    : null;

  const encoder = new TextEncoder();
  let stopped = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const write = (payload: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          open = false;
        }
      };

      const send = (event: ArenaEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      const snapshot = () => send({ type: 'snapshot', table: runtime.view(viewerAgentId) });

      let unsubscribe = () => {};
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        seat.release();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      snapshot();

      unsubscribe = runtime.bus.subscribe((event) => {
        // Anything carrying seat state is re-rendered for this viewer instead of
        // forwarded, which is what keeps the redaction on the server.
        if (event.type === 'seats' || event.type === 'hand-start' || event.type === 'snapshot') snapshot();
        else send(event);

        // The match is over and its runtime is about to be dropped. A stream left
        // open past this point keeps that runtime reachable for as long as the
        // tab stays open, sending heartbeats about a table nobody is dealing.
        if (event.type === 'idle') close();
      });

      request.signal.addEventListener('abort', close, { once: true });
      // A client that left during the account lookup has already aborted, and
      // an abort that has happened fires no listener. Without this its slot in
      // the gallery would never be handed back.
      if (request.signal.aborted) close();
      stopped = close;
    },
    cancel() {
      stopped();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Stops a reverse proxy from buffering the feed into uselessness.
      'x-accel-buffering': 'no',
    },
  });
}

import { account } from '@/server/actions';
import { getSession } from '@/server/auth';
import { callerOf } from '@/server/rate-limit';
import { matchRuntime } from '@/server/registry';
import { admit } from '@/server/spectators';
import type { ArenaEvent } from '@/server/view';

export const dynamic = 'force-dynamic';

/**
 * The arena feed. One direction: spectators listen, so server-sent events fit
 * exactly and stay lighter than a socket.
 *
 * Hole cards are redacted per viewer on the way out. Events that carry seat
 * state are replaced with a snapshot rendered for this specific viewer, so a
 * spectator's stream physically holds that viewer's permitted cards alone.
 *
 * What a deciding seat thinks of its cards stays off the bus entirely: the
 * runtime seals reasoning, equity and hand read for the whole hand and opens
 * them with a `reveal` at showdown. That runtime rule is what makes forwarding
 * everything else unchanged safe.
 *
 * That per-viewer render is also why the gallery is capped. Every subscriber
 * costs the dealing process work on every event, and the render is private to
 * its viewer, so the safe lever on the cost is how many subscribers there are.
 */
export async function GET(request: Request, context: RouteContext<'/api/matches/[id]/stream'>): Promise<Response> {
  const { id } = await context.params;
  const runtime = matchRuntime(id);
  if (!runtime) {
    // A live feed comes from the process actually dealing, and one instance
    // does. A 503 says so and asks the client to retry, which keeps it attached
    // to a game running perfectly well on another instance. A finished match
    // gets the same answer.
    // JSON, like every other refusal in this API, so a client can branch on it.
    return Response.json(
      {
        error: 'That match is dealt elsewhere or has finished.',
        matchId: id,
        dealing: false,
      },
      { status: 503, headers: { 'retry-after': '5' } },
    );
  }

  const session = await getSession();

  // Before the account lookup, so a refusal is free for this process. A 503
  // with a retry-after is what this route already answers on an idle
  // instance, and the client backs off and retries on any refusal alike.
  const seat = admit(id, callerOf(request, session?.userId ?? null));
  if (!seat.ok) {
    return Response.json(
      seat.reason === 'full'
        ? { error: 'This match is at its spectator limit right now. Try again shortly.', matchId: id, full: true }
        : { error: 'Too many open feeds for this match from one viewer.', matchId: id, full: false },
      { status: seat.reason === 'full' ? 503 : 429, headers: { 'retry-after': '15' } },
    );
  }

  // Whichever of the viewer's agents is in this match, if any. One owner
  // holds at most one seat per match, because the matchmaker seats each owner
  // once per table, so the answer is always single.
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
        // Anything carrying seat state is re-rendered for this viewer, which is what keeps the redaction on the server.
        if (event.type === 'seats' || event.type === 'hand-start' || event.type === 'snapshot') snapshot();
        else send(event);

        // The match is over and its runtime is about to be dropped. Closing the
        // stream here lets the runtime go and ends the heartbeats with the table.
        if (event.type === 'idle') close();
      });

      request.signal.addEventListener('abort', close, { once: true });
      // A client that left during the account lookup has already aborted, and
      // an abort that has happened fires zero listeners. This check is what
      // hands its gallery slot back.
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

import { createServer } from 'node:http';
import next from 'next';
import { CLOSE } from '@pokertunity/protocol';

/**
 * The entrypoint, replacing `next start`.
 *
 * Next has no way to accept a WebSocket, and agents dial in over one, so the
 * HTTP server has to be ours. Everything that shares state lives in this one
 * process on purpose: the dealer holds match state in memory, the agent sockets
 * feed it, and the spectator stream reads it. Splitting any of the three apart
 * would mean a message bus between them for no gain, since a Postgres advisory
 * lock already guarantees only one process deals.
 *
 * This file is not compiled by Next, so it runs through tsx rather than the
 * bundler and cannot use anything Next would have transformed for it.
 */

// Read rather than trusted. An empty PORT is zero, which listens on a port the
// platform picked at random and fails its own health check.
const requested = Number(process.env.PORT);
const port = Number.isInteger(requested) && requested > 0 ? requested : 3000;
const dev = process.env.NODE_ENV !== 'production';

async function main(): Promise<void> {
  // Next attaches an upgrade listener of its own, once, to whatever
  // `httpServer` names — and it does so on the first request, not at startup.
  // That listener answers hot reload, and it ends any other upgrade whose path
  // matches a route it serves. `/agent` is also a page here, so given our
  // server it would end every agent socket the moment a page had been loaded.
  //
  // So it is given a server of its own that nothing listens on. Upgrades that
  // are not an agent's are re-emitted onto it below, which hands Next the
  // socket without ever handing it ours.
  const nextServer = createServer();
  const app = next({ dev, httpServer: nextServer });
  await app.prepare();

  // Fetched after prepare, not before: the server it delegates to does not
  // exist yet otherwise.
  const handle = app.getRequestHandler();

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  // Imported after `prepare`, because these modules read environment the Next
  // config loads, and because nothing should start dealing before the server
  // that spectators watch it on is able to answer.
  const { attachAgentSocket } = await import('./src/server/socket');
  const { bootEngine } = await import('./src/server/lifecycle');
  const { closeAll } = await import('./src/server/presence');

  attachAgentSocket(server, (request, socket, head) => {
    // Everything that is not an agent goes to Next, by re-emitting it on the
    // server Next listened to rather than by calling `getUpgradeHandler()`.
    // That handler routes to `NextServer.handleUpgrade`, which is empty — the
    // comment there says the web server does not support web sockets — so
    // calling it drops hot reload on the floor: the `/_next/hmr` upgrade hangs
    // with no open, no close and no error, the dev client waits on it before
    // hydrating, and every page is inert with nothing logged anywhere.
    //
    // Next only attaches that listener once a request has been served, so
    // before then there is nothing to emit to. Hot reload is only ever dialled
    // after a page has loaded, and a client that finds nobody home retries.
    nextServer.emit('upgrade', request, socket, head);
  });

  // A port that cannot be bound is fatal. Next installs an uncaught-exception
  // handler that logs this and carries on, which left a process serving nothing
  // while it took the engine lock and dealt matches no agent could reach.
  server.on('error', (error) => {
    console.error('[server] cannot listen', error);
    process.exit(1);
  });

  // The engine starts once the port is ours, for the same reason.
  server.listen(port, () => {
    console.log(`[server] listening on :${port} (${dev ? 'development' : 'production'})`);
    bootEngine();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Told rather than dropped. An agent that is hung up on with a reason
      // reconnects; one whose socket silently dies waits for a timeout first.
      closeAll(CLOSE.GOING_AWAY, 'The arena is restarting. Reconnect in a moment.');
      server.close(() => process.exit(0));
      // A spectator stream never ends on its own, so a clean close would wait
      // for one that is not coming.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}

void main().catch((error) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});

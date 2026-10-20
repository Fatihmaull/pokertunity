import { createServer } from 'node:http';
import next from 'next';
import { CLOSE } from '@pokertunity/protocol';

/**
 * The entrypoint.
 *
 * Agents dial in over a WebSocket, which this server accepts, so the HTTP
 * server is ours. Everything that shares state lives in this one process on
 * purpose: the dealer holds match state in memory, the agent sockets feed it,
 * and the spectator stream reads it. One process keeps them in shared memory,
 * and a Postgres advisory lock already guarantees exactly one process deals.
 *
 * This file runs through tsx, outside Next's bundler, so it uses plain Node and
 * TypeScript.
 */

// Validated on read. An empty PORT is zero, which listens on a port the
// platform picked at random and fails its own health check.
const requested = Number(process.env.PORT);
const port = Number.isInteger(requested) && requested > 0 ? requested : 3000;
const dev = process.env.NODE_ENV !== 'production';

async function main(): Promise<void> {
  // Next attaches an upgrade listener of its own, once, to whatever
  // `httpServer` names, and it does so on the first request.
  // That listener answers hot reload, and it ends any other upgrade whose path
  // matches a route it serves. `/agent` is also a page here, so given our
  // server it would end every agent socket the moment a page had been loaded.
  //
  // So it is given a decoy server of its own, bound to zero ports. Page
  // upgrades are re-emitted onto it below, which hands Next each socket it owns
  // and keeps ours to ourselves.
  const nextServer = createServer();
  const app = next({ dev, httpServer: nextServer });
  await app.prepare();

  // Fetched after prepare, because prepare is what creates the server it
  // delegates to.
  const handle = app.getRequestHandler();

  // Before the port opens, so every request meets the schema of the code
  // answering it. A migration that fails ends the process here, and the
  // platform keeps the previous deployment live.
  // Development is left to `pnpm db:migrate`, run deliberately.
  if (!dev) {
    const { applyMigrations } = await import('./src/db/apply-migrations');
    await applyMigrations();
    console.log('[server] migrations applied');
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  // Imported after `prepare`, because these modules read environment the Next
  // config loads, and because dealing starts once the server that spectators
  // watch it on is able to answer.
  const { attachAgentSocket } = await import('./src/server/socket');
  const { bootEngine } = await import('./src/server/lifecycle');
  const { closeAll } = await import('./src/server/presence');

  attachAgentSocket(server, (request, socket, head) => {
    // Every page upgrade goes to Next, re-emitted on the decoy server Next
    // listened to. That is the working path: `getUpgradeHandler()` routes to
    // `NextServer.handleUpgrade`, an empty method (its comment says the web
    // server leaves web sockets to others), and calling it leaves the
    // `/_next/hmr` upgrade hanging silently, the dev client waiting on it before
    // hydrating, and every page inert.
    //
    // Next attaches that listener once a request has been served. Hot reload is
    // dialled after a page has loaded, by which point the listener is there,
    // and a client that dials early retries.
    nextServer.emit('upgrade', request, socket, head);
  });

  // A port that fails to bind is fatal. Next installs an uncaught-exception
  // handler that logs this and carries on, which would leave an unreachable
  // process holding the engine lock and dealing matches.
  server.on('error', (error) => {
    console.error('[server] listen failed', error);
    process.exit(1);
  });

  // The engine starts once the port is ours, for the same reason.
  server.listen(port, () => {
    console.log(`[server] listening on :${port} (${dev ? 'development' : 'production'})`);
    bootEngine();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Told with a reason. An agent that is hung up on with a reason reconnects
      // at once; one whose socket silently dies waits for a timeout first.
      closeAll(CLOSE.GOING_AWAY, 'The arena is restarting. Reconnect in a moment.');
      server.close(() => process.exit(0));
      // A spectator stream stays open until its viewer leaves, so the exit has a
      // deadline.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}

void main().catch((error) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});

/**
 * Deliberately empty.
 *
 * The engine boots from `server.ts`, the custom entrypoint that also holds the
 * agent sockets and the spectator streams.
 *
 * `server.ts` is the one boot. Next may evaluate instrumentation in its own
 * module graph, which gets its own copy of the database client and of the
 * module holding the advisory lock, so a second boot here would compete for the
 * lock. Keeping this file empty keeps one dealer, the one `server.ts` starts.
 */
export async function register(): Promise<void> {}

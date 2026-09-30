/**
 * Deliberately empty.
 *
 * The engine boots from `server.ts`, the custom entrypoint that also holds the
 * agent sockets and the spectator streams.
 *
 * Booting from here as well would not be merely redundant. Next may evaluate
 * instrumentation in its own module graph, which gets its own copy of the
 * database client and of the module holding the advisory lock, so the two
 * boots would compete for the lock and one would lose to the other. The
 * symptom is an arena that starts cleanly and then announces that some other
 * process is dealing.
 */
export async function register(): Promise<void> {}

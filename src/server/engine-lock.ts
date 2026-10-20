import { sql } from '../db/client';

/**
 * Exactly one process deals.
 *
 * Table state lives in memory, so two server processes running the engine would
 * each deal their own copy of every table: two different hands with the same
 * hand number, two sets of decisions, and stacks that disagree with the seat
 * rows, all of it plausible and all of it wrong.
 *
 * So the lock lives in the database every process already talks to: a
 * property of the system, where a replica count is a setting a platform can
 * quietly override during a deploy or a restart. A Postgres
 * advisory lock is held for the life of a connection and released the moment
 * that connection drops, which means a process that is killed hands the room to
 * the next one by itself.
 *
 * A process that loses the lock serves pages and leaves the dealing to the
 * winner, which is exactly what a second web instance should do.
 */

/**
 * The lock's name, as the arbitrary integer Postgres wants.
 *
 * Fixed so that every process of this application competes for the same one,
 * and unusual enough to stay clear of anything else using advisory locks on a
 * shared database. Kept inside the range a double holds exactly, so it passes
 * through the driver as is.
 */
const ENGINE_LOCK_KEY = 800_407_111_314_200;

type Reserved = Awaited<ReturnType<typeof sql.reserve>>;

/**
 * The connection holding the lock, kept apart from the pool and off this
 * module.
 *
 * It has to be the same session for as long as we hold it, so it is a
 * dedicated connection that stays ours.
 *
 * Parked on `globalThis` for the same reason the table registry is. The engine
 * is started from `server.ts` and read from a route, and those two resolve to
 * separate copies of this module, so `globalThis` is where both see the same
 * answer.
 */
const globalForLock = globalThis as unknown as { __pokertunityEngineLock?: Reserved | null };

function held(): Reserved | null {
  return globalForLock.__pokertunityEngineLock ?? null;
}

/** Whether this process is the one dealing. */
export function dealing(): boolean {
  return held() !== null;
}

/**
 * Tries to become the dealing process.
 *
 * Returns false when another process already holds it, because that is the
 * ordinary case for a second web instance. It throws when the database itself
 * could not be asked.
 */
export async function claimEngine(): Promise<boolean> {
  if (held()) return true;

  const connection = await sql.reserve();
  try {
    const [row] = await connection`select pg_try_advisory_lock(${ENGINE_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      connection.release();
      return false;
    }

    globalForLock.__pokertunityEngineLock = connection;
    return true;
  } catch (error) {
    connection.release();
    throw error;
  }
}

/**
 * Gives the room up.
 *
 * Called on shutdown so a redeploy hands over immediately. Closing the
 * connection would release it too; unlocking explicitly also covers a pool
 * that recycles connections.
 */
export async function releaseEngine(): Promise<void> {
  const connection = held();
  if (!connection) return;
  globalForLock.__pokertunityEngineLock = null;

  try {
    await connection`select pg_advisory_unlock(${ENGINE_LOCK_KEY})`;
  } catch {
    // Shutting down. The connection is about to close, which releases it
    // anyway, so this failure is safe to ignore.
  } finally {
    connection.release();
  }
}

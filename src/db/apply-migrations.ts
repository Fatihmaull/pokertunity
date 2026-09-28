import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Serialises migrators, as the arbitrary integer Postgres wants. Distinct from
 * the engine's lock, which is held for a process's whole life and would make a
 * booting replacement wait for the outgoing process to die.
 */
const MIGRATION_LOCK_KEY = 800_407_111_314_201;

/**
 * Brings the schema up to the migrations this build carries.
 *
 * The server calls this on every production boot, before it opens its port.
 * It used to be left to the platform's pre-deploy step, and the schema fell
 * behind anyway without anything saying so: deploys kept shipping code that
 * read columns the database had never been given, and every route that touched
 * one answered an empty 500 for days. A server that migrates itself cannot start
 * ahead of its own schema, and one that fails to migrate never listens, so the
 * platform's health check holds the old deployment in place instead.
 *
 * On a connection of its own rather than the shared pool, because the lock is
 * a session lock and has to stay on the connection that took it. Closing that
 * connection is what releases it, on success and on failure alike.
 */
export async function applyMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set, so there is no database to migrate.');

  // Notices silenced because every run creates the bookkeeping schema "if not
  // exists", which on every boot after the first is two lines of noise.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  } finally {
    await sql.end();
  }
}

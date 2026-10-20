/**
 * A real database for the tests that need one, and a guard that it is the test one.
 *
 * The ledger suite truncates every table between tests, so it runs against a
 * database named for it. When `TEST_DATABASE_URL` is unset it is skipped, so
 * `pnpm test` runs on a bare machine.
 *
 * Imported first, for the same reason as `test-env`: the database module reads
 * the connection string the moment it loads.
 */
const url = process.env.TEST_DATABASE_URL?.trim() || null;

function databaseName(value: string): string {
  try {
    return new URL(value).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// The name alone is quoted back. The rest of the string carries a password.
if (url && !databaseName(url).endsWith('_test')) {
  throw new Error(
    `TEST_DATABASE_URL must name a database ending in _test, because the suite truncates it. It names "${databaseName(url)}".`,
  );
}

if (url) process.env.DATABASE_URL = url;
else process.env.DATABASE_URL ||= 'postgres://placeholder/placeholder';

/** Null when the test database is unconfigured, which is what the suite skips on. */
export const testDatabaseUrl = url;

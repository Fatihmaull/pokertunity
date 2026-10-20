/**
 * Whether a string is a uuid, which every row id in this database is.
 *
 * Checked at the edge of a route. Postgres answers a malformed uuid with an
 * error, so checking here turns a mistyped link into a clean 404 and saves the
 * round trip to the database.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

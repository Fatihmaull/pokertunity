-- A database that once ran PR #32's own 0002 (0002_yellow_maelstrom, since
-- replaced by 0003) recorded it with a later timestamp than main's 0002. The
-- migrator only applies what is newer than the last row it recorded, so on such
-- a database 0002_minor_pandemic is skipped for good and this column never
-- arrives. Idempotent, so it is a no-op everywhere the history was clean.
ALTER TABLE "match_results" ADD COLUMN IF NOT EXISTS "seat_index" integer;

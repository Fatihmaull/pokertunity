-- Numbers the matches that predate the column in the order they were created.
-- Adding an identity column numbers existing rows in the order a table scan
-- meets them, which drifts from creation order once rows have been updated.
-- Negated first, so no two rows hold the same number partway through and the
-- unique index lets the renumbering through. Idempotent: created_at and id fix
-- the order, and the sequence carries on from the highest number.
UPDATE "matches" SET "number" = -"number";--> statement-breakpoint
UPDATE "matches" SET "number" = "ordered"."n"
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "n" FROM "matches") AS "ordered"
WHERE "matches"."id" = "ordered"."id";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('matches', 'number'), coalesce(max("number"), 0) + 1, false) FROM "matches";

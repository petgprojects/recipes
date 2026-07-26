-- Postgres extensions, PLAN.md §3 / §5 Phase 0.
--
-- This migration is hand-written because drizzle-kit does not emit
-- CREATE EXTENSION for a Drizzle schema. It is `0000_` on purpose: every
-- migration after it depends on something created here, so it was scaffolded
-- with `drizzle-kit generate --custom` *before* the schema existed, which is
-- what put it first in drizzle/meta/_journal.json rather than hand-editing the
-- journal afterwards.
--
--   pgcrypto — gen_random_uuid(), the default for every primary key.
--              (Built in since PG13, but creating it explicitly means this also
--              works on an older or minimal image.)
--   citext   — users.email is case-insensitive; PLAN.md §4 says so, and the
--              alternative is a lower(email) unique index plus discipline.
--   pg_trgm  — fuzzy ingredient matching, stage 2 of the matcher in §4. The GIN
--              indexes on ingredients.name and ingredient_aliases.alias in the
--              next migration will not create without gin_trgm_ops.
--   vector   — unused on day one. §3: "we don't need vectors on day one, but
--              having the extension available avoids a migration later when
--              personalization gets more serious" (Phase 7).
--
-- Every statement is idempotent, so re-running this migration is harmless.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";

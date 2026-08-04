-- Shareable recipe links. Hand-written, like 0002_ingestion_state and
-- 0004_search: drizzle-kit cannot express a plpgsql function or a backfill, so
-- the journal entry in meta/_journal.json is hand-maintained too.
--
-- Why a new column rather than reusing what is already here:
--
--   * `slug` is explicitly not unique — `scanner/text.ts` says so, and the
--     corpus proves it: 425 recipes, 419 distinct slugs, with
--     `spicy-grilled-watermelon` appearing twice. A link keyed on the slug
--     would resolve to whichever row the planner happened to pick.
--   * `id` is unique but it is the internal key. Putting 36 characters of UUID
--     in a link people paste into a text message is both ugly and a promise we
--     would rather not make about our own primary keys.
--
-- So: a short code that exists only to be pasted. The link renders as
-- `/r/<slug>-<share_code>` and resolves on the code alone, which is what keeps
-- a shared link alive if Phase 2 ever rewrites a title.
--
-- 1. The generator. The alphabet is Crockford-shaped — no `i`, `l`, `o` or `u`
--    — so a code read aloud or retyped from a screenshot cannot be ambiguous,
--    and a code cannot accidentally spell much. 32 symbols and 256 % 32 = 0,
--    so the byte-modulo draw below is uniform rather than slightly biased
--    toward the front of the alphabet.
--
--    The loop is not superstition about 32^8 = 1.1e12: it costs one indexed
--    lookup per insert and turns the one collision this table will never see
--    from a failed crawl into a retry.
CREATE OR REPLACE FUNCTION gen_share_code() RETURNS text
LANGUAGE plpgsql VOLATILE AS $gen_share_code$
DECLARE
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  candidate text;
BEGIN
  LOOP
    candidate := '';
    FOR position IN 1..8 LOOP
      candidate := candidate || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM recipes WHERE share_code = candidate);
  END LOOP;
  RETURN candidate;
END;
$gen_share_code$;--> statement-breakpoint
-- 2. The column, nullable for now — the backfill has not run yet.
ALTER TABLE "recipes" ADD COLUMN "share_code" text;--> statement-breakpoint
-- 3. The unique index *before* the backfill, deliberately. A unique index
--    permits many NULLs, so it costs nothing here, and having it in place means
--    the generator's EXISTS check below is an index probe rather than a scan of
--    the whole table once per row.
CREATE UNIQUE INDEX "recipes_share_code_key" ON "recipes" ("share_code");--> statement-breakpoint
-- 4. The backfill, one row per statement rather than a single set-based UPDATE.
--    A set-based update evaluates every `gen_share_code()` against the same
--    snapshot, in which every `share_code` is still NULL — so the generator's
--    uniqueness check would be checking against nothing and the only thing
--    standing between us and a failed migration would be the birthday bound.
--    Separate statements in one transaction see each other's writes.
DO $backfill$
DECLARE
  row_to_fill record;
BEGIN
  FOR row_to_fill IN SELECT id FROM recipes WHERE share_code IS NULL LOOP
    UPDATE recipes SET share_code = gen_share_code() WHERE id = row_to_fill.id;
  END LOOP;
END;
$backfill$;--> statement-breakpoint
-- 5. Only now can it be NOT NULL. The DEFAULT is what keeps the worker out of
--    this entirely: every insert path — JSON-LD extraction, the LLM extractor,
--    the Reddit adapter — gets a code without naming the column.
ALTER TABLE "recipes" ALTER COLUMN "share_code" SET DEFAULT gen_share_code();--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "share_code" SET NOT NULL;--> statement-breakpoint
-- 6. The shape the application depends on, enforced where it cannot drift:
--    eight characters from the alphabet above. `lib/share.ts` parses a handle
--    against exactly this, and a route that 404s on a well-formed code because
--    something inserted a code of a different shape is a bug nobody would find.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_share_code_shape" CHECK ("recipes"."share_code" ~ '^[0-9a-hjkmnp-tv-z]{8}$');

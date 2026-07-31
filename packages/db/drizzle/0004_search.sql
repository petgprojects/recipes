-- Natural-language search (FILTER_PLAN.md §6). Hand-written, like
-- 0002_ingestion_state: drizzle-kit cannot express an expression index, so the
-- journal entry in meta/_journal.json is hand-maintained too.
--
-- 1. scan_runs.kind — the discriminator FILTER_PLAN.md §8's separate search
--    budget is built on. `source_id is null` is already taken; it means "a run
--    spanning every source", which is what the nightly scan writes.
ALTER TABLE "scan_runs" ADD COLUMN "kind" text DEFAULT 'scan' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_kind_vocab" CHECK ("scan_runs"."kind" = ANY (ARRAY['scan', 'search']::text[]));--> statement-breakpoint
-- 2. Full-text search over our own prose, for the unmapped concept words in
--    FILTER_PLAN.md §5 ("spicy", "date night"). The expression must stay
--    character-for-character identical to `ftsDocument()` in
--    apps/web/src/lib/search.ts, or the planner will not use this index.
CREATE INDEX "recipes_search_fts_idx" ON "recipes" USING gin (to_tsvector('english', "title" || ' ' || coalesce("blurb", '')));--> statement-breakpoint
-- 3. Trigram over the title, for typo tolerance on a raw query. A different
--    tool from the one above and not a substitute for it: trigram is fuzzy
--    spelling, FTS is word and stem matching.
CREATE INDEX "recipes_title_trgm_idx" ON "recipes" USING gin ("title" gin_trgm_ops);

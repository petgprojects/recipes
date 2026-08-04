# Recipes repository guide

This file is the quick orientation layer for coding agents. For the full
checkpoint, read documents in this order:

1. `HANDOFF.md` — current state, verified facts, credentials and exact next move.
2. The `progress/` log for the plan you are working on — authoritative amendments
   and phase checklist.
3. The relevant sections of the matching `plans/` document — original design; the
   progress log overrides it when they disagree.
4. `reqs.md` when a product decision or acceptance criterion is unclear.

**Plans and their logs pair up by filename**: `plans/X.md` is designed work,
`progress/X.md` is what actually happened to it.

| Plan | Log | State |
|---|---|---|
| `plans/PLAN.md` | `progress/PLAN.md` | ✅ complete — Phases 0–7, amendments A1–A22 |
| `plans/FILTER_PLAN.md` | `progress/FILTER_PLAN.md` | ✅ complete — NL search, Phases 1–6, amendments A23–A39 |
| *(none — unplanned)* | `progress/SHARE_LINKS.md` | ✅ complete — in-site share links, amendments A40–A45 |

`progress/SHARE_LINKS.md` is the one log with no plan beside it: it was a
single-session feature request, so that file is both the design record and the
log.

Amendment numbering is continuous across plans, so "amendment A18" resolves to
exactly one document. Inline `PLAN.md §4` citations in source comments refer to
`plans/PLAN.md`; they are citations, not paths, and were deliberately left
un-rewritten when the file moved.

Do not restart completed phases or re-research facts already recorded there.

## Current checkpoint

- **`PLAN.md` Phases 0–7 and `FILTER_PLAN.md` Phases 1–6 are all complete.**
  Nothing is half-finished and no phase is queued; `HANDOFF.md` lists the open
  options.
- **Natural-language search works end to end.** `@recipes/shared/search` owns
  the `SearchFilter` contract, the notice contract and their copy;
  `packages/shared/src/llm/parse-search-query.ts` produces a filter from a
  sentence (it lives in shared, not the worker, because the web route is its
  only caller — amendment A35); `apps/web/src/lib/search.ts` compiles it into
  SQL with the relaxation ladder and `searchRecipes()`; and
  `apps/web/src/lib/search-service.ts` behind `GET /api/search` joins them to
  the budget. The UI is `apps/web/src/components/search-bar.tsx` with `?q=` as
  the URL state. Three rules govern every change to it, all in `HANDOFF.md` in
  full: time compiles to `total_minutes` and never the `Under 20 min` tag; the
  null convention is **inverted** from `hardRuleFilter()` — a typed requirement
  drops null rows, an exclusion does not fire on them; hard rules are named in a
  notice but never applied; and a *food* is `anyIngredients` while a specific
  *item* is `ingredients`, because the corpus files one food under several
  canonical names (A39).
- **Recipes have shareable in-site links.** `/r/<slug>-<share_code>` renders the
  planner with the detail sheet already open, and the "Share" button in that
  sheet hands the link over. `recipes.share_code` is eight unambiguous
  characters with a database `DEFAULT`, so the worker knows nothing about this;
  `@recipes/shared/share` owns the handle format. Two rules govern any change:
  **resolution is on the code alone** — the slug is decoration, so a retitled
  recipe keeps its old links and gets a 307 — and the lookup is `active`-only
  and bypasses the reader's hard rules, because a link is one recipe someone was
  sent rather than a feed. Full account in `progress/SHARE_LINKS.md` (A40–A45).
- **Search and enrichment budgets are separate and durable.**
  `@recipes/db/llm-budget` is the one implementation both apps use; every read
  and write requires `kind='scan' | 'search'`. Scan keeps advisory key 2 and
  search uses key 3. `SEARCH_DAILY_BUDGET_USD` defaults to `$0.10`, about 175
  measured searches per UTC day. `/ops` labels the successful day-rolling
  search row while its UTC-day tile correctly remains total spend.
- **The parse step is graded by a script that spends money.** 1,000 committed
  fixtures in `apps/worker/test/fixtures/search-queries.ts` run offline in
  `pnpm test`, and `apps/worker/scripts/check-search-parse.ts` runs the same
  pairs against the live model — opt-in, never part of `pnpm test`. **Use
  `--anchors`**: the thirty hand-authored cases plus every food family, 66 calls
  and ~$0.02, against ~$0.27 for the full matrix. It scores 60–62 of 66 and the
  failing set rotates; that is `temperature: 0` sampling, not a regression.
- The Phase 7 loop runs nightly as scan → Phase 2 enrichment → personalization,
  and per reader as hard rules (pure SQL, always) → soft profile → batched
  scoring. Rules are a `WHERE` clause with a visible per-rule switch (A20);
  scores order browse and carry a one-line reason onto the card (A21). Both
  halves are gated on ≥5 *distinct rated recipes*. Run the pass by hand with
  `apps/worker/scripts/run-personalization.ts` — it spends real money unless
  given `--rules-only`.
- Phase 6 (ratings) shipped `@recipes/shared/ratings`, `apps/web/src/lib/ratings.ts`,
  `GET/POST /api/ratings` + `DELETE /api/ratings/:id`, and a "Rate it" section in
  the detail sheet — star picker, aspect chips, notes, history, remove. Rating
  requires an account (401 signed out, no `localStorage` draft) because unlike
  the grocery list there is nothing sensible to migrate on a later sign-in.
- The grocery tab's live browser check — carried since Phase 5 — is **done**
  (2026-07-28). It confirmed what tests could not: the signed-out list merged in
  TypeScript and the signed-in list merged in SQL render identically, including
  which lines migrated check-offs land on.
- The grocery list is merged in SQL (`apps/web/src/lib/grocery.ts`); unit choice
  and fraction formatting stay in `@recipes/shared` and the two paths meet at
  `finalizeGroceryBuckets()` (amendment A19). `apps/web/test/grocery-sql.integration.test.ts`
  proves the two agree over the whole corpus — keep it and the shared spec both.
- The Phase 2 semantic mapper now guards its `existing` claims
  (`isPlausibleCanonicalMatch`, amendment A18) after an audit found 31 aliases
  that had merged unrelated items — `ketchup` into `kalamata olives`. The guard
  prefers a missed merge to a wrong one and will split some true synonyms.
- Auth.js v5 + Google is live over the existing `users`/`accounts`/`sessions`
  tables. `AUTH_URL` must stay pinned in `docker-compose.yml`: the container
  binds `0.0.0.0`, and Google rejects a `0.0.0.0` `redirect_uri` at the
  token-exchange step (amendment A16). `trustHost` alone does not fix it.
- The planner works signed out; auth adds persistence and is not a gate. The
  `dev@local` fallback is opt-in via `DEV_AUTH_FALLBACK` (A15).
- The verified Phase 2 exit has 425 recipes: 235 active, 190 rejected and zero
  pending, with zero duplicate source URLs.
- Semantic enrichment mapped 4,456 of 4,617 ingredient rows across 789
  canonical ingredients and 1,733 aliases. The remaining 161
  compound/alternative lines intentionally retain renderable `raw_text` and
  are a successful terminal condition, not retryable failures.
- The planner UI at `/` is live: server-rendered browse, cached photos,
  TanStack Query polling and the "N new recipes" pill. `meal-prep-planner.jsx`
  is retired. Picks and check-offs live in `localStorage` when signed out and in
  `saved_recipes` / `grocery_checks` when signed in, behind one store interface.
- Serious Eats is approved and enabled.
- Classpop is intentionally removed everywhere.
- GypsyPlate currently returns HTTP 403 for both sitemap endpoints. Its run is
  deliberately `partial`, its checkpoint must remain null, and normal scans
  retry it.

## Repository map

- `apps/web` — Next.js app, APIs and `/ops`.
- `apps/worker` — polite discovery, JSON-LD extraction, ingredient matching,
  image caching, persistence, pg-boss jobs and cron.
- `packages/db` — Drizzle schema, migrations, seed and database client.
- `packages/shared` — client-safe contracts, vocabularies, display formatting,
  grocery bucket finalization and plain-text rendering, the `SearchFilter` and
  `SearchNotice` contracts with their copy, the share-link handle format
  (`./share`), source configuration and validated
  environment handling. Two subpaths are server-only and deliberately absent
  from the barrel: `./env`, and `./llm` — which pulls in the `openai` SDK and
  also owns the search parse prompt, the one task prompt not in the worker
  (A35).
- `apps/web/test` — database-backed suites for the app's queries. Added in
  `PLAN.md` Phase 5; needs `DATABASE_URL` like the worker's integration tests.
- `apps/worker/test/fixtures` — real committed source HTML. Keep it; tests must
  not crawl the internet.
- `plans/` — design documents, one per plan.
- `progress/` — durable implementation log and task checklist, one per plan,
  paired by filename. Update the current one when a stage changes state.

## Working rules

- Always create a task list, keep it current, and mark every item complete when
  finished.
- Keep the current `progress/` log and `HANDOFF.md` accurate after meaningful
  checkpoints.
- Prefer one reviewable commit per stage.
- Use tightly scoped synchronous subagents for implementation when useful, then
  independently verify their claims.
- Preserve unrelated user changes in a dirty worktree.
- Crawling and deterministic extraction never use an LLM. Phase 2 analysis uses
  direct, stateless structured-output calls—no agent loop.
- Do not build the `emit_recipe` tool workaround. The selected OpenRouter model
  supports strict `json_schema` structured output; see amendment A2.
- `@recipes/shared/env` is server-only and must not enter client bundles.
- The shared and database packages export TypeScript directly; do not add a
  separate package build pipeline.

## Commands and environment

`pnpm` is not directly on `PATH`; always use Corepack:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm --filter @recipes/web build
docker compose ps
docker compose up --build -d
```

Host-side database URL:

```text
postgresql://recipes:recipes@localhost:5432/recipes
```

Database-backed tests require the Compose database to be running *and*
`DATABASE_URL` exported into the test process:

```bash
DATABASE_URL=postgresql://recipes:recipes@localhost:5432/recipes corepack pnpm test
```

After any `package.json` change, Compose's anonymous dependency volumes are
stale. Refresh only those; do **not** reach for `down -v`, which deletes
`pgdata` and with it every crawled and enriched recipe:

```bash
docker compose build
docker compose rm -svf web worker migrate   # anonymous volumes only
docker compose up -d
```

`docker compose down -v` remains the right command for a deliberate clean
reset, and only for that.

Do **not** start a second web instance in this Compose project (for example
`docker compose run … web`): it shares the `web-next` volume with the running
server, and two dev servers writing one `.next` corrupts it — the page goes
blank with `ENOENT … /.next/server/pages/_document.js`. Recover with:

```bash
docker compose stop web && docker compose rm -f web
docker volume rm recipes_web-next
docker compose up -d web
```

The volume is build output, so nothing is lost. Use `-p <other-project>` if a
second instance is genuinely needed.

## Moving the corpus to another machine

The 425 recipes are not in the repository — they are in the `pgdata` volume, and
their photos are in `recipe-images`. A fresh server therefore starts with 117
seeded ingredients and **zero recipes**. Both halves have to travel, and they
have to travel together: the database rows carry `image_local_path`, so a
database restored without the images renders 425 cards with broken photos.

Verified end to end on 2026-07-29 (amendment A22) — restored into a throwaway
project, which then served all 425 recipes and a real cached photo over HTTP.

**A dump is a credential.** `accounts` holds `access_token` and `id_token`
columns for every linked Google account, and `sessions` holds live session
tokens. Treat `recipes.dump` exactly like `.env`: never commit it, move it over
`scp`, and delete it from both machines when the restore is confirmed.

### 1. On the source machine

Stop the worker first. `pg_dump` is internally consistent, but the images are a
*separate* archive, and a crawl finishing between the two writes rows that
reference files the tar never saw.

```bash
docker compose stop worker
docker compose exec -T db pg_dump -U recipes -d recipes -Fc --no-owner --no-privileges > recipes.dump
docker run --rm -v recipes_recipe-images:/src:ro -v "$PWD":/out alpine \
  tar czf /out/recipe-images.tgz -C /src .
docker compose start worker
```

Expect roughly 1.2 MB and 39 MB respectively at the Phase 7 corpus size. `-Fc`
is the custom format — compressed, and restorable by `pg_restore`.

### 2. On the target machine, before the first full `up`

Bring up **only** the database, so `migrate` does not create a schema for the
restore to collide with:

```bash
docker compose up -d db
```

Then wait for it properly. Do **not** gate on `pg_isready`: the postgres image's
first-boot initialisation runs a *transient* server on the same socket before it
creates `recipes` and restarts, so `pg_isready` reports ready while the database
does not yet exist, and the restore fails with `database "recipes" does not
exist`. Gate on a real query instead:

```bash
until docker compose exec -T db psql -U recipes -d recipes -c 'select 1' >/dev/null 2>&1; do sleep 1; done
docker compose exec -T db pg_restore -U recipes -d recipes --no-owner --no-privileges < recipes.dump
```

The dump carries the schema, the four extensions (`vector`, `citext`, `pg_trgm`,
`pgcrypto`) and `drizzle.__drizzle_migrations`, which is what makes the ordering
work: the later `migrate` service finds all four migrations already recorded and
the seed's upserts find nothing new, so a normal `up` is an idempotent no-op over
restored data rather than a conflict.

### 3. The images, and the ownership trap

```bash
docker run --rm -v recipes_recipe-images:/dst -v "$PWD":/in:ro alpine \
  tar xzf /in/recipe-images.tgz -C /dst
docker run --rm -v recipes_recipe-images:/dst alpine chown -R 1000:1000 /dst
```

The `chown` is required, not defensive. The archive's `./` entry resets the
directory to `root:root` on extraction, and the production images run `USER node`
(uid 1000) — so without it the worker cannot write the next photo it downloads,
having crawled the page successfully first. 1000 is `node`'s uid in
`node:24-bookworm-slim`; the dev images run as root and would not have noticed.

### 4. Then the rest, and check it

```bash
docker compose up -d
curl -s localhost:${WEB_PORT:-3000}/api/health
```

`/api/health` must report the source machine's counts — `"recipes":425` and
`"ingredients":789`, not the seed's 117. Then fetch one photo by its
`image_local_path` through `/api/images/:file` and expect a `200` with
`image/webp`; that is the check that proves both halves arrived, and it is the
one a database-only restore fails.

Two things a restore deliberately carries over: `users` and `accounts`, so the
same Google account links to the same user row and its ratings and saved recipes
survive the move. `sessions` rows come too and are harmless — their cookies were
issued for the old origin and will never be sent to the new one.

## Verification baseline

Current, at share links (`progress/SHARE_LINKS.md`):

- `corepack pnpm test` (with `DATABASE_URL`) — 1,880 passing (shared 199, db 20,
  worker 1,558, web 103). The root script runs packages one at a time on purpose;
  see `HANDOFF.md`. It was 712 at the Phase 7 checkpoint and through
  FILTER_PLAN Phase 1; Phase 2 added 50, Phase 3 another 65, Phase 4 another 9,
  the 1,000-case stress extension took it to 1,806, Phase 5 added 26 and
  Phase 6 another 17, and share links another 24 — without changing an existing
  assertion.
- `corepack pnpm typecheck` — clean across all workspaces.
- Production Next.js build — passing, and `apps/web/.next/static` greps clean
  for `OpenAI`, `openrouter.ai`, `createOpenRouterClient` and
  `StructuredOutputError`. **Run that grep now that `apps/web` calls the model**
  — it stopped being free at Phase 5.
- `/api/health` — healthy with 425 recipes.
- `/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file` — HTTP 200,
  and `POST /api/grocery` — HTTP 200.
- `/r/<slug>-<code>` — 200; a bare code or a stale slug 307s to the canonical
  handle; an unknown code or a handle with no code in it 404s. None of these
  cost anything.
- `GET /api/search` — 401 signed out, 400 on an empty or oversized `q`, 503 at
  the 90% search-budget gate, 200 otherwise. A 200 spends real money; the other
  three do not.

For a change, run the focused test first, then the full relevant suite. Verify
database, queue, crawl or UI exit criteria directly rather than relying only on
unit tests.

## Credentials

- `OPENROUTER_API_KEY` is configured in local `.env`. Never print or commit it.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` are configured in
  local `.env` and verified end to end against the real Google client. Never
  print or commit them.
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `REDDIT_USER_AGENT` are
  configured in local `.env` and verified live against the real API on
  2026-08-03. Never print or commit them. The adapter authenticates with
  `client_credentials` (application-only OAuth), so the app's registered
  redirect URI is never used. Re-check for free with
  `apps/worker/scripts/check-reddit-credentials.ts`. The adapter is still
  `enabled = false` and does not block later phases.
  `apps/worker/scripts/check-reddit-extraction.ts` is the paid companion — it
  routes live posts through the production seam and persists nothing. It is what
  found that roundup posts yielded only their first recipe; the multi-recipe fix
  and the `?recipe=<slug>` `source_url` rule it rests on are both in the
  Reddit sections of `HANDOFF.md`. Read those before enabling the source.
- The Google OAuth client and its test user use the callback
  `http://localhost:3000/api/auth/callback/google`. Changing the app's host or
  port means updating both that registration and `AUTH_URL`.
- Never print or commit secrets from `.env`.

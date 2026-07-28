# Recipes repository guide

This file is the quick orientation layer for coding agents. For the full
checkpoint, read documents in this order:

1. `HANDOFF.md` — current state, verified facts, credentials and exact next move.
2. `PROGRESS.md` — authoritative amendments and phase checklist.
3. The relevant sections of `PLAN.md` — original design; `PROGRESS.md`
   overrides it when they disagree.
4. `reqs.md` when a product decision or acceptance criterion is unclear.

Do not restart completed phases or re-research facts already recorded there.

## Current checkpoint

- Phase 0 through Phase 5 are complete.
- Resume at **Phase 6: ratings** — the after-cooking flow: 1–5 stars, free-text
  notes and fixed-vocabulary aspect tags. It needs **no migration and no
  vocabulary work**: `cook_logs` is live, `RATING_ASPECTS` is already in
  `@recipes/shared/vocab`, and the database already enforces it with the
  `cook_logs_aspects_vocab` check constraint. What is missing is the API, the
  store and the UI. See `HANDOFF.md` for the brief.
- **First, though:** the grocery tab was never clicked through in a browser at
  the Phase 5 checkpoint (the extension was unavailable). `HANDOFF.md` opens
  with the ten-minute check.
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
  grocery bucket finalization and plain-text rendering, source configuration and
  validated environment handling.
- `apps/web/test` — database-backed suites for the app's queries. Added in
  Phase 5; needs `DATABASE_URL` like the worker's integration tests.
- `apps/worker/test/fixtures` — real committed source HTML. Keep it; tests must
  not crawl the internet.
- `PROGRESS.md` — durable implementation log and task checklist. Update it when
  a stage changes state.

## Working rules

- Always create a task list, keep it current, and mark every item complete when
  finished.
- Keep `PROGRESS.md` and `HANDOFF.md` accurate after meaningful checkpoints.
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

## Verification baseline

At the Phase 5 checkpoint:

- `corepack pnpm test` (with `DATABASE_URL`) — 582 passing (shared 95, db 20,
  worker 461, web 8).
- `corepack pnpm typecheck` — clean across all workspaces.
- Production Next.js build — passing.
- `/api/health` — healthy with 425 recipes.
- `/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file` — HTTP 200,
  and `POST /api/grocery` — HTTP 200.

For a change, run the focused test first, then the full relevant suite. Verify
database, queue, crawl or UI exit criteria directly rather than relying only on
unit tests.

## Credentials

- `OPENROUTER_API_KEY` is configured in local `.env`. Never print or commit it.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` are configured in
  local `.env` and verified end to end against the real Google client. Never
  print or commit them.
- Reddit credentials remain unavailable; the production-wired Reddit adapter
  is disabled and does not block later phases.
- The Google OAuth client and its test user use the callback
  `http://localhost:3000/api/auth/callback/google`. Changing the app's host or
  port means updating both that registration and `AUTH_URL`.
- Never print or commit secrets from `.env`.

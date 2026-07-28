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

- Phase 0 through Phase 3 are complete.
- Resume at **Phase 4: auth** — it needs `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` in `.env` first.
- The verified Phase 2 exit has 425 recipes: 235 active, 190 rejected and zero
  pending, with zero duplicate source URLs.
- Semantic enrichment mapped 4,456 of 4,617 ingredient rows. The remaining 161
  compound/alternative lines intentionally retain renderable `raw_text` and
  are a successful terminal condition, not retryable failures.
- The planner UI at `/` is live: server-rendered browse, cached photos, picks
  and grocery receipt in `localStorage`, TanStack Query polling and the
  "N new recipes" pill. `meal-prep-planner.jsx` is retired.
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
  grocery aggregation, source configuration and validated environment handling.
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

## Verification baseline

At the Phase 3 checkpoint:

- `corepack pnpm test` (with `DATABASE_URL`) — 551 passing (shared 72, db 20,
  worker 459).
- `corepack pnpm typecheck` — clean across all workspaces.
- Production Next.js build — passing.
- `/api/health` — healthy with 425 recipes.
- `/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file` — HTTP 200.

For a change, run the focused test first, then the full relevant suite. Verify
database, queue, crawl or UI exit criteria directly rather than relying only on
unit tests.

## Credentials

- `OPENROUTER_API_KEY` is configured in local `.env`. Never print or commit it.
- Reddit credentials remain unavailable; the production-wired Reddit adapter
  is disabled and does not block Phase 3.
- Google OAuth client and test user are configured with callback
  `http://localhost:3000/api/auth/callback/google`. The client ID/secret and
  `AUTH_SECRET` still need to be placed in `.env` before Phase 4.
- Never print or commit secrets from `.env`.

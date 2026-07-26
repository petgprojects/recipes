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

- Phase 0 and Phase 1 are complete.
- Resume at **Phase 2: LLM enrichment**.
- The clean Phase 1 exit produced 425 recipes, all with local image references,
  zero duplicate source URLs, zero LLM tokens and $0 LLM cost.
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
- `packages/shared` — client-safe contracts, vocabularies, source configuration
  and validated environment handling.
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

Database-backed tests require the Compose database to be running. After any
`package.json` change, Compose's anonymous dependency volumes are stale. Rebuild
with:

```bash
docker compose down -v
docker compose up --build -d
```

`down -v` deletes this project's local database and cached-image volumes, so
first confirm that a clean reset is actually intended.

## Verification baseline

At the Phase 1 checkpoint:

- `corepack pnpm test` — 421 passing.
- `corepack pnpm typecheck` — clean across all workspaces.
- Production Next.js build — passing.
- `/api/health` — Phase 1 healthy.
- `/ops` and `/api/recipes` — HTTP 200.

For a change, run the focused test first, then the full relevant suite. Verify
database, queue, crawl or UI exit criteria directly rather than relying only on
unit tests.

## Credentials

- An OpenRouter key is required only for real Phase 2 calls; implementation and
  mocked tests can proceed without it.
- Google OAuth client and test user are configured with callback
  `http://localhost:3000/api/auth/callback/google`. The client ID/secret and
  `AUTH_SECRET` still need to be placed in `.env` before Phase 4.
- Never print or commit secrets from `.env`.


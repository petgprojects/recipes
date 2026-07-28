# Session Handoff

**Read this first, then `PROGRESS.md`, then the relevant parts of `PLAN.md`.**
Written 2026-07-27 after the verified Phase 2 live exit.

`PLAN.md` remains the original design. `PROGRESS.md` is the authoritative live
record; its amendments override `PLAN.md` where they disagree.

---

## Where things stand

| Phase | State |
|---|---|
| 0 — Scaffold | ✅ complete |
| 1 — Deterministic ingestion | ✅ complete |
| 2 — LLM enrichment | ✅ complete |
| 3 — UI port | **resume here** |
| 4–7 | not started |

The main Phase 2 implementation is committed in `8202b4c`; live-provider
hardening is committed in `3f6e67d`. The final terminal-status fix and this
checkpoint are the next commit.

### Verified live database state

- 425 recipes total: 235 `active`, 190 `rejected`, 0 `pending`.
- Every active recipe has its blurb and category; every rejected recipe has an
  audit reason.
- 0 duplicate source URLs.
- 4,617 ingredient rows: 4,456 mapped and 161 intentionally unmapped.
- 774 canonical ingredients and 1,727 aliases.
- All 161 unmapped rows retain non-empty `raw_text` and are renderable. They are
  compound quantities, alternatives or annotations that cannot safely become a
  single normalized ingredient.
- The newest enrichment queue job completed successfully in 15 ms with zero
  tokens: it inspected the entire 161-row remainder and reported
  `unparseableRows=remainingRows=161`.
- Recorded OpenRouter usage across all live probes/runs: 1,364,931 input
  tokens, 568,637 output tokens and **$0.311476**.

### Verification at this checkpoint

- `corepack pnpm test` — **524 passing** (shared 45, db 20, worker 459).
- `corepack pnpm typecheck` — clean across all workspaces.
- `DATABASE_URL=postgresql://recipes:recipes@localhost:5432/recipes corepack
  pnpm --filter @recipes/web build` — passing.
- Compose: db/web healthy and worker running.
- `/api/health` reports Phase 2 with 425 recipes.
- `/ops` and `/api/recipes?limit=1` return HTTP 200.

---

## Phase 2 rules that must be preserved

- Enrichment uses direct, stateless strict `json_schema` OpenRouter calls. Do
  not introduce an agent loop or the discarded `emit_recipe` workaround.
- The provider requires `max_tokens`, not the alternative spelling assumed by
  the original plan.
- OpenRouter rejects JavaScript Unicode-property regexes such as `\p{L}` in the
  submitted schema. Strip only unsupported provider-facing `pattern` keywords;
  retain full local Zod validation.
- A malformed 200 response without `choices` goes through the one bounded,
  independently accounted repair path.
- Ingredient mapping uses 20-name batches, exact input/canonical enums,
  deterministic normalization for an existing canonical mislabeled `new`, and
  a 180-second request deadline.
- Every provider response, including malformed/repair responses, is accounted
  durably before further work. The UTC-day budget guard remains serialized.
- When all remaining ingredient rows have been inspected and are unparseable,
  the scan is a successful terminal result, not a retryable partial. A loaded
  window smaller than the full remainder must still return `partial`.
- Raw content and source JSON remain server-side; public recipe APIs default to
  active rows.
- Reddit is production-wired but disabled because credentials are unavailable.

---

## Credentials and source state

- `OPENROUTER_API_KEY` is configured in `.env`. Never print or commit it.
- Reddit credentials remain unavailable after the account/app setup block;
  Reddit is disabled and does not block Phase 3.
- Google OAuth client/test user exist, but the client ID, client secret and
  `AUTH_SECRET` still need to be added to `.env` before Phase 4.
- Serious Eats is approved and enabled.
- Classpop is intentionally absent everywhere.
- GypsyPlate returns HTTP 403 for both sitemap endpoints. Its ingestion run
  deliberately remains `partial`, its checkpoint stays null, and normal scans
  retry it.

---

## Operational facts

- `pnpm` is not on `PATH`; use `corepack pnpm`.
- Host database URL:
  `postgresql://recipes:recipes@localhost:5432/recipes`.
- Database-backed tests require the Compose database.
- After a `package.json` change, anonymous dependency volumes are stale.
  Rebuild with `docker compose down -v && docker compose up --build -d` only
  after confirming that deleting this project's database/image volumes is
  intended.
- `packages/shared` and `packages/db` export TypeScript directly; do not add a
  package build step.
- `@recipes/shared/env` is server-only and must never enter client bundles.
- Preserve the committed real-source HTML fixtures; tests must not crawl the
  internet.

---

## Exact next move

Start **Phase 3 — UI port** from the existing `meal-prep-planner.jsx` reference:

1. Inventory the reference UI and the current `apps/web` routes/components.
2. Port the product shell and recipe views in reviewable stages.
3. Use the local cached-image API and existing active-only recipe endpoints.
4. Add TanStack Query polling/refresh behavior and the “N new recipes” pill.
5. Verify optional ratings, responsive behavior and operations navigation.
6. Retire `meal-prep-planner.jsx` only after the port matches the Phase 3 exit
   criteria in `PLAN.md`/`PROGRESS.md`.

Do not rerun Phase 2 enrichment just to prove completion; the final live
zero-token queue job and database audit already establish the exit.

# Session Handoff

**Read this first, then `PROGRESS.md`, then the relevant parts of `PLAN.md`.**
Written 2026-07-27 after the verified Phase 3 exit.

`PLAN.md` remains the original design. `PROGRESS.md` is the authoritative live
record; its amendments override `PLAN.md` where they disagree.

---

## Where things stand

| Phase | State |
|---|---|
| 0 — Scaffold | ✅ complete |
| 1 — Deterministic ingestion | ✅ complete |
| 2 — LLM enrichment | ✅ complete |
| 3 — UI port | ✅ complete |
| 4 — Auth | **resume here** |
| 5–7 | not started |

Phase 2 is committed in `8202b4c`, `3f6e67d` and `5c90c5a`. Phase 3 is the next
commit; `meal-prep-planner.jsx` is deleted in it and lives on in git history.

### Verified live state

- 425 recipes: 235 `active`, 190 `rejected`, 0 `pending`; 0 duplicate URLs.
- 4,617 ingredient rows, 4,456 mapped, 161 intentionally unmapped and still
  renderable from `raw_text`.
- 774 canonical ingredients, 1,727 aliases.
- Recorded OpenRouter usage to date: 1,364,931 input tokens, 568,637 output
  tokens, **$0.311476**. Phase 3 spent nothing — the UI makes no LLM calls.

### Verification at this checkpoint

- `DATABASE_URL=postgresql://recipes:recipes@localhost:5432/recipes corepack
  pnpm test` — **551 passing** (shared 72, db 20, worker 459). Without
  `DATABASE_URL` in the environment, four database-backed worker suites fail to
  load; that is the documented requirement, not a regression.
- `corepack pnpm typecheck` — clean across all four workspaces.
- `DATABASE_URL=… corepack pnpm --filter @recipes/web build` — passing.
- Compose db/web healthy, worker running; `/api/health` 200, `/ops` 200,
  `/api/recipes` 200, `/api/recipes/:id` 200, `/api/images/:file` 200.
- Driven live in headless Chrome (see the Phase 3 log entry in `PROGRESS.md`
  for the full list): picks → receipt → check-off persistence, the pill, the
  detail sheet, the no-photo fallback, 390px and 1280px widths.

---

## Phase 3 rules that must be preserved

- **The pill counts unseen recipe ids, not `?since=` rows** (amendment A13).
  `last_seen_at` moves on every re-crawl and does not move when Phase 2
  activates a pending row, so a timestamp watermark is wrong in both
  directions. Do not "simplify" this back to `?since=`.
- Display formatting and grocery aggregation live in `@recipes/shared`
  (`format.ts`, `grocery.ts`) and are tested there. Phase 5 replaces the
  aggregation's internals with SQL over
  `saved_recipes × recipe_ingredients × ingredients`; the item key it produces
  is already `grocery_checks.item_key`, so the check-offs migrate as they are.
- Merge grocery lines within a unit dimension only. `2 cans` and `14 oz` are two
  lines; an unmapped row keys on its slugified raw text.
- The browse feed carries no instruction steps or ingredient lines — those are
  `/api/recipes/:id` — and no `raw_jsonld`, content hash or HTTP validators.
- `/api/images/:file` accepts only `^[0-9a-f]{64}\.webp$`; that shape check is
  the path-traversal defence.
- The server-rendered page and `GET /api/recipes` must keep returning the same
  JSON shape from the same `listRecipes()`; that is what makes `initialData`
  safe.
- `next/image` runs `unoptimized` and `image_blurhash` is unpopulated (A14).
- Cards with no usable photo fall back to the text-only layout — verified with
  every image request blocked.

## Phase 2 rules that must be preserved

- Enrichment uses direct, stateless strict `json_schema` OpenRouter calls. No
  agent loop, no `emit_recipe` workaround.
- The provider requires `max_tokens`; strip only unsupported provider-facing
  `pattern` keywords (`\p{L}`) while keeping full local Zod validation.
- A malformed 200 without `choices` goes through the one bounded, independently
  accounted repair path.
- Ingredient mapping: 20-name batches, exact enums, deterministic normalization
  for an existing canonical mislabeled `new`, 180-second deadline.
- Every provider response is accounted durably before further work; the UTC-day
  budget guard stays serialized.
- An inspected remainder of unparseable ingredient rows is a successful
  terminal result, not a retryable partial.
- Raw content and source JSON stay server-side; public recipe APIs default to
  active rows.

---

## Credentials and source state

- `OPENROUTER_API_KEY` is configured in `.env`. Never print or commit it.
- **Phase 4 needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET`
  placed in `.env`.** The OAuth client and test user already exist, with the
  callback `http://localhost:3000/api/auth/callback/google`. This is the one
  thing blocking the next phase from starting cleanly.
- Reddit credentials remain unavailable; the Reddit adapter is production-wired
  and `enabled=false`.
- Serious Eats is approved and enabled; Classpop is intentionally absent.
- GypsyPlate returns HTTP 403 for both sitemap endpoints. Its run stays
  `partial`, its checkpoint null, and normal scans retry it.

---

## Operational facts

- `pnpm` is not on `PATH`; use `corepack pnpm`.
- Host database URL: `postgresql://recipes:recipes@localhost:5432/recipes`.
- Database-backed tests need the Compose database *and* `DATABASE_URL` exported.
- **After a `package.json` change, do not reach for `docker compose down -v`** —
  it deletes `pgdata` and with it 425 crawled, enriched recipes. Refresh only
  the stale anonymous dependency volumes:
  `docker compose build && docker compose rm -svf web worker migrate &&
  docker compose up -d`. `rm -sv` removes anonymous volumes only; named volumes
  survive. This is how `@tanstack/react-query` was added in Phase 3.
- `packages/shared` and `packages/db` export TypeScript directly; no build step.
- `@recipes/shared/env` is server-only. The image route imports it; nothing in
  `src/components` may. Client-facing types live in `src/lib/recipe-types.ts`
  precisely so a component never has to import from a module that opens a pool.
- Preserve the committed real-source HTML fixtures; tests must not crawl.

---

## Exact next move

Start **Phase 4 — Auth** (`PLAN.md` §5):

1. Get `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` into `.env`.
2. Wire Auth.js with the Drizzle adapter — `users`, `accounts`, `sessions` and
   `verification_tokens` already match its expected shape, so no migration.
3. Implement `getCurrentUser()` with the `dev@local` fallback described in
   `PLAN.md` §4 (development only; production means no user without a session).
4. Move picks and check-offs from `localStorage` into `saved_recipes` and
   `grocery_checks`. The client shapes are already `{recipeId: batches}` and
   `{itemKey: true}` under `mealprep:v2:saved` / `mealprep:v2:checked`, so the
   one-time migration on first sign-in is a direct insert.
5. Keep the planner working signed-out; auth adds persistence, it does not
   become a gate.

Known issue worth a look at some point, not a Phase 3 defect: spot-checking
ingredient rows turned up a bad Phase 2 semantic mapping —
`1 large bunch flat-leaf parsley (about 2 ounces; 57 g)…` mapped to canonical
`mushrooms`. The row renders correctly from `raw_text`, but a wrong canonical
merges wrongly on the grocery list. A crude probe (canonical name's first token
absent from the raw line) flags 390 of the 4,456 mapped rows, and most of those
are legitimate synonyms — `fresh herbs` for a parsley/dill/chives line,
`scallions` for `green onions` — so the real error rate is unknown and needs a
proper sampled audit. Worth scheduling before Phase 5 puts those joins under a
SQL grocery aggregation.

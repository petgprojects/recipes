# Session Handoff

**Read this first, then `PROGRESS.md`, then the relevant parts of `PLAN.md`.**
Written 2026-07-27 after the verified Phase 4 exit.

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
| 4 — Auth | ✅ complete |
| 5 — Grocery list server-side | **resume here** |
| 6–7 | not started |

Phase 2 is committed in `8202b4c`, `3f6e67d` and `5c90c5a`; Phase 3 in
`b0e0121`. Phase 4 is the next commit.

### Verified live state

- 425 recipes: 235 `active`, 190 `rejected`, 0 `pending`; 0 duplicate URLs.
- 4,617 ingredient rows, 4,456 mapped, 161 intentionally unmapped and still
  renderable from `raw_text`.
- 774 canonical ingredients, 1,727 aliases.
- Two `users` rows: the seeded `dev@local`, and Peter's Google account with one
  linked `accounts` row. No `saved_recipes` or `grocery_checks` rows — every
  Phase 4 probe row was removed after verification.
- Recorded OpenRouter usage to date: 1,364,931 input tokens, 568,637 output
  tokens, **$0.311476**. Phases 3 and 4 spent nothing — neither makes LLM calls.

### Verification at this checkpoint

- `DATABASE_URL=postgresql://recipes:recipes@localhost:5432/recipes corepack
  pnpm test` — **564 passing** (shared 85, db 20, worker 459). Without
  `DATABASE_URL` in the environment, four database-backed worker suites fail to
  load; that is the documented requirement, not a regression.
- `corepack pnpm typecheck` — clean across all four workspaces.
- `DATABASE_URL=… corepack pnpm --filter @recipes/web build` — passing.
- The three Phase 4 secrets confirmed absent from every file in
  `apps/web/.next/static` after a production build.
- Compose db/web healthy, worker running; `/api/health` 200, `/ops` 200,
  `/api/recipes` 200, `/api/recipes/:id` 200, `/api/images/:file` 200.
- Driven live in Chrome against the **real** Google OAuth client — see the
  Phase 4 log entry in `PROGRESS.md` for the full list.

---

## Phase 4 rules that must be preserved

- **`AUTH_URL` must be pinned** (amendment A16). The container runs
  `next dev --hostname 0.0.0.0`, which makes `request.url` read
  `http://0.0.0.0:3000`, so Auth.js would send that as the token-exchange
  `redirect_uri` and Google rejects it as an OAuth policy violation. The
  authorize step looks perfect and only the last server-to-server hop fails, so
  this presents as a generic `?error=Configuration`. `trustHost: true` does
  **not** fix it. `docker-compose.yml` sets `AUTH_URL` from `NEXT_PUBLIC_APP_URL`.
- **Auth must stay optional at boot.** The three Phase 4 secrets are phase-gated;
  `isAuthConfigured` gates the provider list and the sign-in control. Never call
  `requireEnv()` at module scope in `lib/auth.ts` — it would make importing the
  file a boot requirement and take the signed-out planner down with it.
- **The `dev@local` fallback is opt-in** (`DEV_AUTH_FALLBACK`, default off,
  amendment A15). Turning it on makes every development request permanently
  signed in, which makes the signed-out planner and the first-sign-in migration
  unreachable. Production ignores it.
- **Every mutating `/api/planner/*` endpoint returns the whole state**, and the
  four client mutations share `scope: { id: 'planner-state' }` so they serialise.
  Without the scope, a slow early response overwrites a fast later one.
- **The migration only adds, and the account wins conflicts** (A17). It must stay
  idempotent: the "already migrated" marker lives in the same `localStorage` the
  migration reads, so a cleared browser re-runs it.
- **Signed-in edits must not write to `localStorage`** — that is what `active`
  gates in `useLocalPlannerStore`. The browser's anonymous state is left intact
  so signing out returns to it.
- **`plannerKeys.state()` returns a module constant, not a fresh array.** It is a
  `useEffect` dependency; a new identity per render re-runs the effect and its
  cleanup, which previously discarded an in-flight migration *after* its marker
  was written. See the Phase 4 log entry.
- `users.email` is `citext`, which the Drizzle adapter's types reject. The cast
  stays confined to the one `DrizzleAdapter(...)` expression.

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
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` are configured in
  `.env` and verified end to end against the real Google client. Never print or
  commit them. The registered callback is
  `http://localhost:3000/api/auth/callback/google`.
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
  survive. This is how `next-auth` was added in Phase 4.
- **Do not run a second web instance against the same Compose project.** A
  throwaway `docker compose run … web` shares the `web-next` volume with the
  running server, and two dev servers writing one `.next` corrupts it — the page
  goes blank with `ENOENT … /.next/server/pages/_document.js`. Recovery is
  `docker compose stop web && docker compose rm -f web && docker volume rm
  recipes_web-next && docker compose up -d web`; the volume is build output, so
  nothing is lost. Use `-p <other-project>` if a second instance is really needed.
- `packages/shared` and `packages/db` export TypeScript directly; no build step.
- `@recipes/shared/env` is server-only. `lib/auth.ts`, `lib/current-user.ts`,
  `lib/planner.ts` and the route handlers import it; nothing in `src/components`
  may. Client-facing types live in `src/lib/recipe-types.ts` and
  `@recipes/shared/planner` precisely so a component never has to import from a
  module that opens a pool.
- Preserve the committed real-source HTML fixtures; tests must not crawl.

---

## Exact next move

Start **Phase 5 — Grocery list server-side** (`PLAN.md` §5):

1. Port the aggregation in `@recipes/shared/grocery.ts` from its current
   in-memory form to a SQL query over
   `saved_recipes × recipe_ingredients × ingredients`, keeping the batch
   multiplier and in-dimension unit conversion. The item key it produces is
   already `grocery_checks.item_key`, so the per-user check-offs Phase 4 just
   built need no migration.
2. Keep the receipt aesthetic — it is the best part of the current design.
3. Add a printable view and copy-to-clipboard as plain text.

The tests in `packages/shared/test/grocery.test.ts` are the specification for
what the SQL has to reproduce; keep them passing against the new implementation
rather than rewriting them to match it.

**Worth doing before Phase 5 puts these joins under SQL:** a proper sampled
audit of the Phase 2 semantic ingredient mapping. Spot-checking turned up
`1 large bunch flat-leaf parsley (about 2 ounces; 57 g)…` mapped to canonical
`mushrooms`. The row renders correctly from `raw_text`, but a wrong canonical
merges wrongly on the grocery list — and Phase 5 is exactly where that starts to
matter. A crude probe (canonical name's first token absent from the raw line)
flags 390 of the 4,456 mapped rows, but most of those are legitimate synonyms
(`fresh herbs` for a parsley/dill/chives line, `scallions` for `green onions`),
so the real error rate is still unknown.

# Session Handoff

**Read this first, then `PROGRESS.md`, then the relevant parts of `PLAN.md`.**
Written 2026-07-28 after the verified Phase 5 exit.

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
| 5 — Grocery list server-side | ✅ complete |
| 6 — Ratings | **resume here** |
| 7 | not started |

Phase 2 is committed in `8202b4c`, `3f6e67d` and `5c90c5a`; Phase 3 in
`b0e0121`; Phase 4 in `3ef13a0`. Phase 5 is the next commit.

### Verified live state

- 425 recipes: 235 `active`, 190 `rejected`, 0 `pending`; 0 duplicate URLs.
- 4,617 ingredient rows, 4,456 mapped, 161 intentionally unmapped and still
  renderable from `raw_text`.
- **789** canonical ingredients, **1,733** aliases — up from 774/1,727 because
  the Phase 5 mapping repair deleted 31 wrong aliases and let 15 ingredients
  that had been wrongly merged become their own canonicals (amendment A18).
- Two `users` rows: the seeded `dev@local`, and Peter's Google account with one
  linked `accounts` row. No `saved_recipes` or `grocery_checks` rows — every
  probe row from Phases 4 and 5 was removed after verification.
- Recorded OpenRouter usage to date: **$0.31** and change. Phase 5 spent only
  the one re-mapping run (63 rows, ~31 distinct names); the port makes no LLM
  calls.

### Verification at this checkpoint

- `DATABASE_URL=postgresql://recipes:recipes@localhost:5432/recipes corepack
  pnpm test` — **582 passing** (shared 95, db 20, worker 461, web 8). Without
  `DATABASE_URL` the database-backed suites fail to load; that is the documented
  requirement, not a regression.
- `corepack pnpm typecheck` — clean across all four workspaces.
- `DATABASE_URL=… corepack pnpm --filter @recipes/web build` — passing, with
  `/api/grocery` in the route table.
- All four secrets confirmed absent from every file in `apps/web/.next/static`.
- Compose db/web healthy, worker running, after the full dependency-volume
  refresh the `package.json` change required. `/api/health` 200 with 425
  recipes; `/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file`
  and `POST /api/grocery` all 200.

### Outstanding — do this first

**The Chrome extension was not connected this session, so the grocery tab was
never clicked through.** Phases 3 and 4 were both verified in a real browser and
both turned up bugs that only a browser could find (see the Phase 4 log entry).
Phase 5's server side is covered by tests and hand-checked API responses, but
these have not been seen working:

- the grocery tab rendering the server-built list, signed out and signed in;
- **Print** opening a print dialog whose preview is the receipt alone — no
  masthead, tabs or browse grid (`@media print` in `artifact.css`);
- **Copy as text** putting the list on the clipboard, including which boxes are
  ticked;
- a check-off round-trip against the new keys, surviving a reload.

Ten minutes at the start of Phase 6.

---

## Phase 5 rules that must be preserved

- **The mapper's `existing` claim is guarded** (A18). `isPlausibleCanonicalMatch()`
  rejects a canonical that shares no identity word with the input, and the
  decision is rewritten as `new` on the reader's own words. This is why
  `existing` decisions now carry an `aisle` the database already knows — without
  one, a rejection would need a second provider round-trip. Do not "simplify"
  that field away.
- **The guard is blunt in one direction on purpose.** It also rejects
  `garbanzo beans` → `chickpeas`. A missed merge is a second line on the
  receipt; a wrong merge is a quantity nobody can see is wrong. Aliases already
  in `ingredient_aliases` are matched exactly and never reach the guard.
- **SQL merges; TypeScript picks the unit** (A19). Do not move `units.ts` or
  `format.ts` into SQL — two copies of the unit vocabulary in two languages will
  drift, and the failure mode is a wrong number on a shopping list. The unit
  alias table is *generated* into the query from the same records
  `normalizeUnit()` reads.
- **Three expressions must match the TypeScript character for character**, or
  the same shopping line gets two different `grocery_checks.item_key`s depending
  on which path built it and a reader's check-offs silently stop matching:
  the raw-text slug (lower → NFKD → dashes → trim dashes → cut to 80, in that
  order), `normalizeUnit()`'s case-sensitive-first lookup (`T` is tablespoon,
  `t` is teaspoon), and the `unit:` fallback slug, which is **not** dash-trimmed
  unlike the raw-text one.
- **The batch multiplier multiplies in `float8`, not `numeric`.** A numeric
  product cast to float8 afterwards rounds differently in the last bit, and the
  differential test compares exact values.
- **`finalizeGroceryBuckets()` sorts by bucket order before inserting.** Two
  items can sort equal by name — the same ingredient by the clove and by the
  each — and the sort is stable, so insertion order breaks the tie. A `group by`
  returns rows in any order it likes.
- **`POST /api/grocery` does not use `withUser()`.** Being signed out is not an
  error there: a signed-out reader's picks arrive in the body. A signed-in
  reader sends the same body and the server ignores it in favour of
  `saved_recipes` (A17's principle: the account wins).
- `packages/shared/test/grocery.test.ts` says what a correct list *is*;
  `apps/web/test/grocery-sql.integration.test.ts` says the database agrees.
  Neither is sufficient alone — do not delete one because the other passes.

## Phase 4 rules that must be preserved

- **`AUTH_URL` must be pinned** (A16). The container runs
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
  A15). Turning it on makes every development request permanently signed in,
  which makes the signed-out planner and the first-sign-in migration
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

- **The pill counts unseen recipe ids, not `?since=` rows** (A13).
  `last_seen_at` moves on every re-crawl and does not move when Phase 2
  activates a pending row, so a timestamp watermark is wrong in both
  directions. Do not "simplify" this back to `?since=`.
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
- Cards with no usable photo fall back to the text-only layout.

## Phase 2 rules that must be preserved

- Enrichment uses direct, stateless strict `json_schema` OpenRouter calls. No
  agent loop, no `emit_recipe` workaround.
- The provider requires `max_tokens`; strip only unsupported provider-facing
  `pattern` keywords (`\p{L}`) while keeping full local Zod validation.
- A malformed 200 without `choices` goes through the one bounded, independently
  accounted repair path.
- Ingredient mapping: 20-name batches, exact enums, deterministic normalization
  for an existing canonical mislabeled `new`, 180-second deadline — **and now
  the A18 plausibility guard**.
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
  This now includes `apps/web`, which gained a test suite in Phase 5.
- **After a `package.json` change, do not reach for `docker compose down -v`** —
  it deletes `pgdata` and with it 425 crawled, enriched recipes. Refresh only
  the stale anonymous dependency volumes:
  `docker compose build && docker compose rm -svf web worker migrate &&
  docker compose up -d`. `rm -sv` removes anonymous volumes only; named volumes
  survive. This is how `next-auth` was added in Phase 4 and `vitest` in Phase 5.
- **Do not run a second web instance against the same Compose project.** A
  throwaway `docker compose run … web` shares the `web-next` volume with the
  running server, and two dev servers writing one `.next` corrupts it — the page
  goes blank with `ENOENT … /.next/server/pages/_document.js`. Recovery is
  `docker compose stop web && docker compose rm -f web && docker volume rm
  recipes_web-next && docker compose up -d web`; the volume is build output, so
  nothing is lost. Use `-p <other-project>` if a second instance is really needed.
- The worker mounts the repo and runs `tsx watch`, so a source edit restarts it
  and a bootstrap enrichment job runs on start. That is how the Phase 5
  re-mapping was triggered: repair the data, then `docker compose restart worker`.
- **Backticks inside a `sql\`…\`` template close the template literal.** Two SQL
  comments in `lib/grocery.ts` had to lose theirs. The error esbuild gives is
  unhelpful ("Expected ; but found …" pointing at prose).
- `packages/shared` and `packages/db` export TypeScript directly; no build step.
- `@recipes/shared/env` is server-only. `lib/auth.ts`, `lib/current-user.ts`,
  `lib/planner.ts`, `lib/grocery.ts` and the route handlers import it; nothing
  in `src/components` may. Client-facing types live in `src/lib/recipe-types.ts`
  and `@recipes/shared/planner` precisely so a component never has to import
  from a module that opens a pool.
- Preserve the committed real-source HTML fixtures; tests must not crawl.

---

## Exact next move

1. Click through the grocery tab in Chrome — the Outstanding list above. Ten
   minutes, and both previous UI phases found a real bug this way.
2. Start **Phase 6 — Ratings** (`PLAN.md` §5): the after-cooking flow, 1–5
   stars, free-text notes, and the **fixed-vocabulary aspect tags** (`quick`,
   `slow`, `cheap`, `expensive`, `tasty`, `bland`, `reheats_well`,
   `soggy_leftovers`, `too_much_cleanup`, `would_repeat`). The `cook_logs` table
   already exists with `rating` and an `aspects` text array.

   The fixed vocabulary is the whole point — Phase 7 derives hard rules from
   these in SQL, and free text alone cannot drive a deterministic `WHERE`
   clause. Put the vocabulary in `@recipes/shared/vocab` next to `AISLES` and
   the category/tag lists, so the database enum, the UI and the Phase 7 rule
   derivation all read the same list.

**Known limitation worth remembering in Phase 6/7.** The A18 guard is lexical,
so it cannot catch a canonical that shares a real word but is a different
product — `green bell pepper` → `red bell pepper` was repaired by hand, not by
the guard. If ingredient quality ever needs to be better than this, the answer
is a confirmation pass over lexically-distant decisions, not a stricter regex.

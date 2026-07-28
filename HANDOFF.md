# Session Handoff

Current state and the next move. Written 2026-07-28 after the verified Phase 6
exit.

This file is **not** a history — it holds only what still constrains the code.
`PROGRESS.md` is the archive: every amendment (A1–A19), why each decision was
made, and a log entry per phase. Read that when you need the reasoning behind a
rule here, or before reopening a settled decision. `AGENTS.md` has the
repository map, commands and working rules.

---

## Start here

### 1. Ten minutes in a browser, first

Phase 5's grocery **tab** — print preview, copy-as-text, check-off persistence
— still has not been clicked through live. It was skipped again at the start
of Phase 6, deliberately, not forgotten: Peter judged the Chrome extension
wouldn't connect and asked to go straight to ratings. It turned out the in-app
Browser pane (not the Chrome extension) works fine in this environment and
drove the whole Phase 6 flow end-to-end, so this is worth ten minutes with
that tool before Phase 7. Load `/`, save two or three recipes, then on the
**Grocery list** tab check:

- the list renders, signed out and signed in;
- **Print** previews the receipt alone — no masthead, tabs or browse grid
  (`@media print` at the end of `apps/web/src/styles/artifact.css`);
- **Copy as text** reaches the clipboard, ticked boxes included;
- ticking an item survives a reload.

Everything server-side is covered by tests; nothing visual is.

### 2. Phase 7 — Personalization loop (the payoff)

PLAN.md §5: nightly, per user — (1) derive hard rules deterministically in SQL
(`median(rating) WHERE total_minutes > 60` etc. → `user_preferences.hard_rules`,
applied as a SQL filter, not a prompt), (2) derive a short prose soft profile
with an LLM call over the rating history → `user_preferences.profile`, (3) score
new recipes in the daily scan with a batched prompt → `recipe_scores.score` plus
a one-line human-readable `reason`. **Cold start:** scoring only runs once a
user has ≥5 rated recipes; below that `recipe_scores` stays empty and browse
sorts by `published_at DESC` with source rating as a tiebreak. Hard rules need
≥5 observations *in the relevant bucket* before they're emitted. Show active
rules in the UI with a switch to disable each — PLAN.md is explicit that "a
filter you can't see is indistinguishable from a bug."

`user_preferences` and `recipe_scores` already exist in the schema, unused
until now. `cook_logs` is what Phase 7 reads from — Phase 6 (see below) is what
populates it, and there are 0 rows in it right now (the manual test data was
removed), so Phase 7's cold-start path is the only one exercisable until real
ratings accumulate. Consider seeding a handful of synthetic `cook_logs` rows for
development, and delete them before calling the phase done, the same way the
Phase 4/5 probe rows were removed.

---

## Current state

- **425 recipes**: 235 `active`, 190 `rejected`, 0 `pending`; no duplicate URLs.
- **4,617 ingredient rows**, 4,456 mapped across 789 canonical ingredients and
  1,733 aliases. The 161 unmapped are compound/alternative lines that still
  render from `raw_text` — a successful terminal condition, not a backlog.
- **2 users**: seeded `dev@local` and Peter's Google account. **0**
  `saved_recipes`, **0** `grocery_checks`, **0** `cook_logs` — every probe row
  from Phases 4, 5 and 6 was removed.
- OpenRouter spend to date ≈ **$0.31**.

Verified at this checkpoint: `corepack pnpm test` with `DATABASE_URL` — **601
passing** (shared 104, db 20, worker 461, web 16); four typechecks clean;
production build clean; all four secrets absent from `apps/web/.next/static`;
`/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file`,
`POST /api/grocery`, `GET/POST /api/ratings` and `DELETE /api/ratings/:id` all
respond correctly with the Compose stack up. The ratings flow (star picker,
aspect chips, note, history, remove) was driven live through the in-app Browser
pane, signed in via a temporary local `DEV_AUTH_FALLBACK=true` (reverted after
— see the Phase 6 log entry in PROGRESS.md for exactly how, if you need to
repeat it).

---

## Invariants — these will bite you

Each one has a plausible-looking wrong version, and most fail silently.

### Grocery list (A18, A19)

- **SQL merges; TypeScript picks and prints the units.** Do not move `units.ts`
  or `format.ts` into SQL — two copies of the unit vocabulary in two languages
  will drift, and the symptom is a wrong number on a shopping list. The two
  paths meet at `finalizeGroceryBuckets()`; the SQL unit alias table is
  *generated* from the same records `normalizeUnit()` reads.
- **Three expressions must match the TypeScript character for character**, or
  one shopping line gets two different `grocery_checks.item_key`s depending on
  which path built it, and a reader's check-offs quietly stop matching: the
  raw-text slug (lower → NFKD → dashes → trim dashes → cut to 80, that order),
  the case-sensitive-first unit lookup (`T` is tablespoon, `t` is teaspoon), and
  the `unit:` fallback slug — which is **not** dash-trimmed, unlike the first.
- **Batch multipliers multiply in `float8`, not `numeric`.** A numeric product
  cast afterwards rounds differently in the last bit.
- **`finalizeGroceryBuckets()` sorts by bucket order before inserting.** Two
  items can sort equal by name — one ingredient by the clove and by the each —
  and the sort is stable, so insertion order breaks the tie. `group by` returns
  rows in any order it likes.
- **Merge within a unit dimension only.** `2 cans` and `14 oz` stay two lines.
  An unmapped row keys on its slugified raw text.
- **`POST /api/grocery` deliberately does not use `withUser()`.** Signed out is
  not an error there — those picks arrive in the body. Signed in, the body is
  ignored in favour of `saved_recipes`.
- **Keep both test suites.** `packages/shared/test/grocery.test.ts` says what a
  correct list *is*; `apps/web/test/grocery-sql.integration.test.ts` says the
  database agrees. Neither is sufficient alone.

### Ingredient mapping (A18)

- **The mapper's `existing` claim is guarded.** `isPlausibleCanonicalMatch()`
  rejects a canonical sharing no identity word with the input, and the decision
  is rewritten as `new`. This is why `existing` decisions carry an `aisle` the
  database already knows — without it a rejection needs a second provider call.
  Do not "simplify" that field away.
- **The guard is blunt in one direction on purpose.** It also rejects
  `garbanzo beans` → `chickpeas`. A missed merge is an extra line on a receipt;
  a wrong merge is a quantity nobody can see is wrong. Aliases already in
  `ingredient_aliases` match exactly and never reach the guard.
- Known limitation: it cannot catch a canonical that shares a real word but is a
  different product (`green bell pepper` → `red bell pepper`). Those were fixed
  by hand. If this needs to get better, the answer is a confirmation pass over
  lexically-distant decisions, not a stricter regex.
- Repairs go through `apps/worker/scripts/repair-mismapped-ingredients.ts`
  (dry run unless `--apply`), which returns rows to the backfill queue.

### Ratings (Phase 6)

- **Rating requires an account — there is no `localStorage` draft.**
  `/api/ratings` is `withUser()`-wrapped like every planner mutation, so signed
  out it is a 401, and `RatingForm` renders a sign-in prompt instead of a form.
  Unlike the grocery list this is deliberate and permanent, not a gap to close:
  a cook log with nowhere to migrate it into on sign-in is just data loss.
- **Delete is scoped to the owner, not just the id.** `deleteCookLog(userId,
  id, recipeId)` deletes `where id = ... and user_id = ...`. An id that isn't
  the caller's matches no row and no-ops silently — same response shape as one
  already gone. Covered live in `ratings.integration.test.ts`.
- **All three endpoints answer with the recipe's whole log list**, not just the
  row touched — same "mutation returns the full state" shape the planner routes
  use, so the client's cache update is one `setQueryData` call regardless of
  which of GET/POST/DELETE produced it.
- **Do not widen `RATING_ASPECTS` without knowing `cook_logs_aspects_vocab` is
  generated from it.** A stray tag fails the insert with a database error, not
  a friendly 400 — `cookLogCreateSchema`'s `ratingAspectSchema` (from
  `packages/shared/src/schemas.ts`, reused rather than redefined) is what turns
  that into a 400 before it reaches SQL.

### Auth and planner state (A15, A16, A17)

- **`AUTH_URL` must stay pinned** in `docker-compose.yml`. The container binds
  `0.0.0.0`, so Auth.js would send that as the token-exchange `redirect_uri` and
  Google rejects it. The consent screen looks perfect and only the last
  server-to-server hop fails, presenting as a generic `?error=Configuration`.
  `trustHost: true` does **not** fix it.
- **Auth stays optional at boot.** Never call `requireEnv()` at module scope in
  `lib/auth.ts` — it would make importing the file a boot requirement and take
  the signed-out planner down with it.
- **`DEV_AUTH_FALLBACK` is opt-in and off.** On, every dev request is
  permanently signed in, which makes the signed-out planner and the
  first-sign-in migration unreachable.
- **Mutating `/api/planner/*` endpoints return the whole state**, and the client
  mutations share `scope: { id: 'planner-state' }` so they serialise. Without
  the scope a slow early response overwrites a fast later one.
- **The sign-in migration only adds, and the account wins conflicts.** It must
  stay idempotent — the "already migrated" marker lives in the same
  `localStorage` the migration reads, so a cleared browser re-runs it.
- **Signed-in edits must not write to `localStorage`.** The browser's anonymous
  state is left intact so signing out returns to it.
- **`plannerKeys.state()` returns a module constant, not a fresh array.** It is
  a `useEffect` dependency; a new identity per render previously discarded an
  in-flight migration *after* its marker was written.
- `users.email` is `citext`, which the Drizzle adapter's types reject. The cast
  stays confined to the one `DrizzleAdapter(...)` expression.

### Browse feed (A13, A14)

- **The "N new recipes" pill counts unseen recipe ids, not `?since=` rows.**
  `last_seen_at` moves on every re-crawl and does *not* move when Phase 2
  activates a pending row, so a timestamp watermark is wrong in both directions.
- The server-rendered page and `GET /api/recipes` must keep returning the same
  shape from the same `listRecipes()` — that is what makes `initialData` safe.
- The feed carries no instruction steps, ingredient lines, `raw_jsonld`, content
  hash or HTTP validators. Those are detail-only or server-only.
- `/api/images/:file` accepts only `^[0-9a-f]{64}\.webp$`; that shape check *is*
  the path-traversal defence.
- `next/image` runs `unoptimized`; `image_blurhash` is unpopulated.

---

## Traps that cost time

`AGENTS.md` has the routine commands. These are the ones that bite:

- **Never `docker compose down -v` to pick up a `package.json` change.** It
  deletes `pgdata` and with it 425 crawled, enriched recipes. Refresh only the
  anonymous dependency volumes:
  `docker compose build && docker compose rm -svf web worker migrate && docker compose up -d`.
  `rm -sv` leaves named volumes alone. `down -v` is only for a deliberate reset.
- **Never run a second web instance in this Compose project.** It shares the
  `web-next` volume and two dev servers writing one `.next` corrupts it — the
  page goes blank with `ENOENT … /.next/server/pages/_document.js`. Recover:
  `docker compose stop web && docker compose rm -f web && docker volume rm recipes_web-next && docker compose up -d web`.
  Use `-p <other-project>` if you really need one.
- **Backticks inside a `` sql`…` `` template close the template literal.**
  esbuild's error points at the prose and says "Expected ; but found …".
- Database-backed tests need the Compose database **and** `DATABASE_URL`
  exported — now including `apps/web`.
- The worker bind-mounts the repo and runs `tsx watch`, so a source edit
  restarts it and a bootstrap enrichment job runs on start. That is how to
  trigger a re-map: repair the data, then `docker compose restart worker`.
- `@recipes/shared/env` is server-only. Route handlers and `lib/*.ts` import it;
  nothing in `src/components` may. Client-facing types live in
  `src/lib/recipe-types.ts` and `@recipes/shared/planner` for exactly this
  reason.
- Keep the committed source HTML fixtures. Tests must never crawl.

---

## Credentials and sources

- `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `AUTH_SECRET` are all in the local `.env` and verified end to end. **Never
  print or commit them.**
- The Google client's registered callback is
  `http://localhost:3000/api/auth/callback/google`. Changing the app's host or
  port means updating both that registration and `AUTH_URL`.
- Reddit credentials are still unavailable (app creation fails a reCAPTCHA
  check). The adapter is production-wired with `enabled = false`; flipping one
  boolean turns it on. It blocks nothing.
- Serious Eats is approved and enabled. Classpop is intentionally removed
  everywhere — do not re-add it.
- GypsyPlate returns HTTP 403 for both sitemap endpoints. Its run stays
  `partial`, its checkpoint stays null, and normal scans retry it.

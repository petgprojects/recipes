# Session Handoff

Current state and the next move. Written 2026-07-28, after Phase 7 closed —
the personalization loop runs end to end and was verified live against the real
provider.

This file is **not** a history — it holds only what still constrains the code.
`PROGRESS.md` is the archive: every amendment (A1–A22), why each decision was
made, and a log entry per phase. Read that when you need the reasoning behind a
rule here, or before reopening a settled decision. `AGENTS.md` has the
repository map, commands and working rules.

---

## Start here

**Phases 0 through 7 are complete.** There is no half-finished work and nothing
carried over. The next move is a decision rather than a task, and it is Peter's:

| Option | What it is |
| --- | --- |
| **Phase 8, from PLAN.md's list** | Apple Sign In, nutrition estimates, meal-calendar assignment, pantry tracking, YouTube as a source |
| **pgvector similarity** | PLAN.md §5 defers it deliberately: "add it later, as a *signal feeding into* the score, once there's enough history to justify it." The table exists. Today there are 0 `cook_logs`, so there is not enough history. |
| **Reddit** | The adapter is production-wired with `enabled = false`. One boolean turns it on, and it needs credentials that reCAPTCHA has so far prevented creating. |
| **Live use** | Nothing is blocking daily use. The loop needs 5 rated recipes per reader before it does anything. |
| **Deploy to the server** | Config is in place (A22): `compose.prod.yml` publishes almost nothing, `compose.tunnel.yml` adds Cloudflare Tunnel. Waiting on Peter for the Google console's deployed redirect URI + verified domain, and a `TUNNEL_TOKEN`. `compose.prod.yml` has still never been run. |

### How the nightly loop fits together

Read this before changing any of it; the ordering is load-bearing.

```
cron (0 3 * * *) → scan job → [enrichment job] → personalization job
```

- **Personalization is last**, enqueued by the enrichment job on completion.
  Scoring a recipe before Phase 2 has given it a category, tags and a blurb
  would score it on a blank.
- **Without `OPENROUTER_API_KEY` the scan job enqueues it instead**, and the
  pass runs its free half only. Hard rules must be re-derived nightly whether or
  not a provider is configured, or a filter outlives the ratings behind it.
- **Per reader, in order:** hard rules (pure SQL, always) → profile (gated on
  ≥5 distinct rated recipes) → scoring (needs the profile just written).
- A reader-level failure is recorded and the pass moves on. A budget stop ends
  the pass as an orderly `partial` — retrying it would meet the same UTC-day cap.

| Thing | Where |
| --- | --- |
| Rule/profile/score contracts, thresholds, all the judgement calls | `packages/shared/src/personalization.ts` (pure, no DB) |
| The two prompts | `apps/worker/src/llm/taste-profile.ts`, `score-recipes.ts` |
| Evidence gathering, history, candidate rows, persistence | `apps/worker/src/personalization/{hard-rules,profile,scoring}.ts` |
| Per-reader and whole-pass orchestration | `apps/worker/src/personalization/runtime.ts` |
| The queue and its wiring | `apps/worker/src/jobs/personalization-queue.ts`, `apps/worker/src/index.ts` |
| Reading prefs, the `WHERE` fragment, the switch write | `apps/web/src/lib/preferences.ts` |
| The score join and the browse order | `apps/web/src/lib/recipes.ts` |
| The rules panel, the reason on the card | `apps/web/src/components/{hard-rules,recipe-card}.tsx` |

**To run the pass by hand**, instead of waiting for a scan:

```bash
docker compose exec worker ./node_modules/.bin/tsx scripts/run-personalization.ts --user <uuid>
docker compose exec worker ./node_modules/.bin/tsx scripts/run-personalization.ts --rules-only
```

It spends real money without `--rules-only`. A full 235-recipe scoring pass for
one reader is 12 provider calls and cost **$0.0093** measured; budget several
minutes, since batches occasionally take 90–150 seconds each.

### Signing in locally, to verify anything in a browser

Google's real OAuth flow is not something to automate. The established recipe,
used for Phases 6 and 7:

```bash
cp .env .env.backup                # byte-exact copy; .env.backup is gitignored
printf '\nDEV_AUTH_FALLBACK=true\n' >> .env
docker compose up -d web           # recreate; ~15s to answer
# … drive the browser as dev@local …
cp .env.backup .env && rm .env.backup   # restore; never hand-edit the line out
docker compose up -d web
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/planner   # expect 401
```

Restore from the copy rather than deleting the line by hand — `.env` holds four
live secrets and is the one file in this repo that cannot be reconstructed.
Check it with `diff .env .env.backup > /dev/null; echo $?` rather than anything
that prints the file: a diff of `.env` puts every secret in your transcript.

Delete any probe rows you created on the way out (`user_preferences`,
`cook_logs`, `recipe_scores`, `saved_recipes`, `grocery_checks`). Keep the
`scan_runs` rows a personalization run opens — they record real spend and are
what the daily budget reads.

Two things that cost time, both tooling and not the app: browser clicks
dispatched before React finishes hydrating land on the DOM and silently do
nothing, so wait for hydration or drive the element directly; and screenshots
come back scaled ~0.907× from the 1280px viewport, so coordinates read straight
off a screenshot are the correct ones to pass back.

---

## Current state

- **425 recipes**: 235 `active`, 190 `rejected`, 0 `pending`; no duplicate URLs.
- **4,617 ingredient rows**, 4,456 mapped across 789 canonical ingredients and
  1,733 aliases. The 161 unmapped are compound/alternative lines that still
  render from `raw_text` — a successful terminal condition, not a backlog.
- **2 users**: seeded `dev@local` and Peter's Google account. **0**
  `saved_recipes`, **0** `grocery_checks`, **0** `cook_logs`, **0**
  `user_preferences`, **0** `recipe_scores` — every probe row from Phases 4
  through 7 was removed.
- OpenRouter spend to date ≈ **$0.32**.

Verified at this checkpoint: `corepack pnpm test` with `DATABASE_URL` — **712
passing** (shared 152, db 20, worker 500, web 40); four typechecks clean;
production build clean; all four secrets absent from `apps/web/.next/static`;
`/`, `/ops`, `/api/recipes`, `/api/recipes/:id`, `/api/images/:file`,
`POST /api/grocery`, `GET/POST /api/ratings`, `DELETE /api/ratings/:id` and
`GET/PATCH /api/preferences/rules` all respond correctly with the Compose stack
up. Signed out, `/api/recipes` returns all 235 active recipes with every `score`
null, and `/api/preferences/rules` is a 401.

The production build needs `DATABASE_URL` in its environment — `/api/health`
imports `@recipes/shared/env` at module scope, so `next build` fails at "collect
page data" without it. That is pre-existing and not a regression.

Driven live in a browser, signed in through a temporary local
`DEV_AUTH_FALLBACK=true` (reverted after; recipe above): the Phase 6 ratings
flow, the Phase 5 grocery tab both signed in and signed out, the Phase 7 rules
panel, and the full Phase 7 loop — three derived rules took browse from 235 to
74, in strict score order from 100 down to 10, every card carrying its reason.

---

## Invariants — these will bite you

Each one has a plausible-looking wrong version, and most fail silently.

### Personalization, the model half (A21)

- **The model is never sent a recipe id.** Batches are numbered `ref: 1…20` and
  `resolveScoreBatch()` maps them back locally. A mistyped UUID writes a score
  against the wrong recipe and nothing anywhere would notice; a bad `ref` is
  droppable. The response schema is built per batch, so its ceiling is that
  batch's length.
- **A short or duplicated response costs rows, never correctness.** Unknown refs
  dropped, first answer per ref wins, scores clamped, missing refs left
  unscored — which is a state the whole system already handles, and the next run
  picks them up because "unscored" is durable in the table.
- **An unscored recipe sorts as neutral, not last.** `coalesce(score, 50)`.
  Nulls-last would bury every new arrival under the corpus; nulls-first would
  put unranked rows above a 95. Signed out every row coalesces the same way, so
  the browse order is exactly the pre-Phase-7 one — which is what keeps the
  server render usable as `initialData`.
- **A changed profile rescores the corpus**, because a score answers the
  question the profile asked. Rows are overwritten in place, never deleted
  first, so the ranking stays complete even if the run stops on budget.
- **The cold-start floor counts distinct recipes rated, not cook logs**, and it
  gates step 2 as well as step 3. One chili cooked five times is one data point.
- **Three writers share `user_preferences`; each owns one column.** The rules
  job owns `hard_rules`, the switch owns `enabled` inside it, the profile job
  owns `profile`. Every `onConflictDoUpdate` lists only its own column plus
  `updated_at` — a full-row upsert silently reverts whichever ran first.
- **Scoring ignores hard rules on purpose.** It scores rows a rule currently
  hides, because that switch can flip at any moment and a feed that came back
  unranked the instant it did would look broken.
- **The reason must be shown.** A score with no reason is dropped rather than
  stored: PLAN.md, "an opaque ranking is one you can't debug or trust."

### Hard rules (A20)

- **Both `listRecipes()` callers must pass the same rules *and* the same
  `userId`.** The server-rendered page is the client's `initialData`; a filter
  or an ordering applied on one path and not the other is a hydration mismatch,
  and it looks like the feed flickering rather than like a bug.
- **`/api/recipes` resolves both from the session, never the query string.** A
  filter or a ranking over your own feed must not be something a caller can
  spoof or switch off by editing a URL.
- **Every clause keeps a row whose column is null.** An unknown `total_minutes`
  or `category` has not been disliked. Hiding it would let missing data act as
  a preference.
- **A rule change is not a "N new recipes" pill.** Un-hidden recipes are not new
  arrivals, and saying so is a lie about where they came from. `adoptNextFeed`
  in `planner.tsx` handles it, and the flag is set *before* the invalidate
  because the refetch can resolve in the same tick.
- **A disabled rule stays listed and stays in the column.** Removing it from the
  UI would leave no way to switch it back on; dropping it from `hard_rules`
  would let the nightly job silently re-arm the filter.
- **`hard_rules` is parsed, not cast** (`parseHardRules()`). One malformed entry
  costs its own filter, not the browse feed.

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
  `/api/ratings` is `withUser()`-wrapped like every planner mutation, so a
  well-formed request signed out is a 401, and `RatingForm` renders a sign-in
  prompt instead of a form. (A *malformed* one is a 400 even signed out:
  `parseBody()` runs before `withUser()`. Verified, harmless, but don't "fix"
  a 400 you were expecting to be a 401.)
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

### Auth and planner state (A15, A16, A17, A22)

- **`AUTH_URL` must stay pinned** in `docker-compose.yml`. The container binds
  `0.0.0.0`, so Auth.js would send that as the token-exchange `redirect_uri` and
  Google rejects it. The consent screen looks perfect and only the last
  server-to-server hop fails, presenting as a generic `?error=Configuration`.
  `trustHost: true` does **not** fix it.
- **This is not a localhost lock-in.** Pinning a public `https` origin satisfies
  the same requirement; the port was never the constraint. Two traps when you do
  (A22): `NEXT_PUBLIC_APP_URL` is inlined by `next build`, so it must be set
  *before* `docker compose build` or the server and the bundle disagree about the
  origin; and an `https` value switches Auth.js to `__Secure-` cookies, so a
  mismatch between the real scheme and the configured one gives you a sign-in
  that completes and then has no session.
- **The deployed callback needs registering, but not a second OAuth client.** One
  client holds many redirect URIs, so localhost and the deployed origin coexist.
  The consent screen's *Authorized domains* is the step with a wait — Google
  requires Search Console domain verification first.
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
- **The root `test` script runs packages one at a time on purpose**
  (`--workspace-concurrency=1`). Worker integration suites insert a temporary
  *active* recipe; web suites count active recipes. Run them concurrently and
  the web suite fails by one against a corpus that changed under it. If you add
  a suite that counts corpus rows, assert against what a call actually saw
  rather than against a second query.
- **Backticks inside a `` sql`…` `` template close the template literal.**
  esbuild's error points at the prose and says "Expected ; but found …".
  Relatedly, `sql` expands a JS array into a *parameter list*, not an array
  literal: a `text[]` value has to go in as `'{a,b}'`.
- Database-backed tests need the Compose database **and** `DATABASE_URL`
  exported — worker and web both.
- The worker bind-mounts the repo and runs `tsx watch`, so a source edit
  restarts it, and a bootstrap enrichment job runs on start — which now also
  enqueues a personalization pass. That is how to trigger a re-map: repair the
  data, then `docker compose restart worker`.
- `@recipes/shared/env` is server-only. Route handlers and `lib/*.ts` import it;
  nothing in `src/components` may. Client-facing types live in
  `src/lib/recipe-types.ts` and `@recipes/shared/planner` for exactly this
  reason.
- Keep the committed source HTML fixtures. Tests must never crawl.

---

## Credentials and sources

- `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `AUTH_SECRET` are all in the local `.env` and verified end to end. **Never
  print or commit them** — and never `diff` or `cat` `.env` itself; compare with
  `diff .env .env.backup > /dev/null; echo $?`.
- The Google client's registered callback is
  `http://localhost:3000/api/auth/callback/google`. Changing the app's host or
  port means updating both that registration and `AUTH_URL` — *adding* an origin
  means adding a second redirect URI to the same client and leaving this one
  alone (A22).
- `TUNNEL_TOKEN` is not configured yet. It is only read by `compose.tunnel.yml`,
  which is opt-in, so its absence blocks nothing local.
- Reddit credentials are still unavailable (app creation fails a reCAPTCHA
  check). The adapter is production-wired with `enabled = false`; flipping one
  boolean turns it on. It blocks nothing.
- Serious Eats is approved and enabled. Classpop is intentionally removed
  everywhere — do not re-add it.
- GypsyPlate returns HTTP 403 for both sitemap endpoints. Its run stays
  `partial`, its checkpoint stays null, and normal scans retry it.

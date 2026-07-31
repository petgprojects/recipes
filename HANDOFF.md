# Session Handoff

Current state and the next move. Updated 2026-07-31, after natural-language
search **Phase 5** closed — the plan is complete end to end: a sentence typed
into the running app reaches the right recipes, and says what it gave up to get
there.

This file is **not** a history — it holds only what still constrains the code.
`progress/PLAN.md` is the archive: every amendment (A1–A22), why each decision
was made, and a log entry per phase. Read that when you need the reasoning behind
a rule here, or before reopening a settled decision. `AGENTS.md` has the
repository map, commands and working rules.

---

## Start here

**Phases 0 through 7 are complete.** There is no half-finished work and nothing
carried over.

**The next move has been chosen: natural-language search.** The design is settled
in [`plans/FILTER_PLAN.md`](./plans/FILTER_PLAN.md) and the log is
[`progress/FILTER_PLAN.md`](./progress/FILTER_PLAN.md), amendments from A23.

**All five of its phases are complete** — 1 through 4 on 2026-07-30 and Phase 5
on 2026-07-31, on branch `filters`.

Phase 1 moved the OpenRouter transport into `packages/shared/src/llm/` behind
the server-only `@recipes/shared/llm` subpath, as 100%-similarity renames with
no assertion changed. The plan says "17 importing modules" in two places and the
real number was 12 — the worker's `src/llm/index.ts` barrel absorbed the rest.

Phase 2 added the `SearchFilter` contract (`packages/shared/src/search.ts`,
client-safe and in the barrel), the compiler (`apps/web/src/lib/search.ts` —
`WHERE`, `match_count`, the relaxation ladder and `searchRecipes()`), and
migration `0004_search.sql`. **Its exit criterion is met**: the hand-authored
filter for the plan's example query returns exactly the 12 recipes §1 names,
through the compiler, verified against the live corpus and by dumping the
compiler's emitted SQL and comparing it to §1's hand-written query. The suite
went 712 → **762**; nothing existing changed. No LLM is involved anywhere in it.

Phase 3 added `apps/worker/src/llm/parse-search-query.ts` — the prompt, the
strict schema and three deterministic repairs — plus committed fixture pairs
and the opt-in `scripts/check-search-parse.ts`. The original 30-case exit
criterion remains met (28–29 of 30 live agreements); it now has a corpus-shaped
1,000-case stress matrix layered over those anchors. All 1,000 pass offline.
The one-off live stress run on 2026-07-30 agreed on **932 of 1,000 (93.2%)**,
above the 90% gate, with zero time-tag repairs, at an estimated **$0.27187**.
The whole pipeline still works end to end: the §1 example query, parsed by the
*live* model, returns a filter byte-identical to the hand-authored one, and that
filter compiles to exactly the 12 recipes §1 names, with zero relaxations.
The suite grew by the stress cases; the current full count is recorded below.

Phase 4 moved the one durable lease/accounting implementation out of the worker
and into the server-only `@recipes/db/llm-budget` subpath. Both budget reads and
writes require a `scan_runs.kind`; scan keeps advisory key 2 and search uses key
3, so the independent pots do not block or leak into each other. The
day-rolling search accumulator is `success` from creation, `/ops` labels it
**Search**, and `SEARCH_DAILY_BUDGET_USD` defaults to `$0.10` — about 175
measured production-shaped searches, not thousands. The suite went 827 →
**836**.

Phase 5 shipped `GET /api/search` (401 / 400 / 503 / 200), the orchestration in
`apps/web/src/lib/search-service.ts`, the notice contract in
`@recipes/shared/search`, the signed-in search bar and `?q=` URL state. The
example query returns the same 12 recipes through the running app; the URL is
shareable, one back press restores a previous query, and all four notices plus
the disabled state were seen in a browser. The full account is in the progress
log's Phase 5 section — read that before changing any of it.

**There is no next phase in this plan.** The options below are open and
unstarted:

| Option | What it is |
| --- | --- |
| **Phase 8, from PLAN.md's list** | Apple Sign In, nutrition estimates, meal-calendar assignment, pantry tracking, YouTube as a source |
| **pgvector similarity** | PLAN.md §5 defers it deliberately: "add it later, as a *signal feeding into* the score, once there's enough history to justify it." The table exists. Today there are 0 `cook_logs`, so there is not enough history. |
| **Reddit** | The adapter is production-wired with `enabled = false`. One boolean turns it on, and it needs credentials that reCAPTCHA has so far prevented creating. |
| **Live use** | Nothing is blocking daily use. The loop needs 5 rated recipes per reader before it does anything. |
| **Deploy to the server** | Config is in place and the prod stack has been run and verified (A22): `compose.prod.yml` publishes almost nothing, `compose.tunnel.yml` adds Cloudflare Tunnel, `COMPOSE_FILE` in the server's `.env` makes bare `docker compose up -d --build` mean all of it. Waiting on Peter for the Google console's deployed redirect URI + verified domain, and a `TUNNEL_TOKEN`. A fresh server starts with **0 recipes** — the corpus is in `pgdata`, not the repo; `AGENTS.md` has a verified dump/restore runbook. |

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

The other script that spends money is the Phase 3 parse check — opt-in, never
part of `pnpm test`. The committed suite has 1,000 cases; the live script uses
the Phase 5 90% gate and prints field-level drift summaries:

```bash
docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts
docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts --live-vocabulary
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
- **1 `kind='search'` scan row**, for 2026-07-31, at **$0.006970** over 49,616
  in / 3,486 out. That is the Phase 5 browser check's real spend, and it is the
  UTC day's accumulator — left in place deliberately, because it records money
  that was actually spent and is what the daily budget reads.
- OpenRouter spend to date ≈ **$0.71** — the prior ≈ $0.70 plus Phase 5's ≈
  $0.008 of live searches. The 1,000-case stress run used
  `SEARCH_DAILY_BUDGET_USD=5` only on its `docker compose exec` process; the
  repository default and `.env` remain unchanged.
- A search costs **$0.00057–0.00064** measured through the real route, which is
  exactly Phase 3's estimate — about **160–175 searches per UTC day** at the
  `$0.10` default.

Verified at this checkpoint: `corepack pnpm test` with `DATABASE_URL` — **1,832
passing** (shared 181, db 20, worker 1,539, web 92); all four typechecks clean;
production build clean; all four secrets absent from `apps/web/.next/static`,
and so are `OpenAI`, `openrouter.ai`, `createOpenRouterClient` and
`StructuredOutputError`; `/`, `/ops`, `/api/recipes`, `/api/recipes/:id`,
`/api/images/:file`, `POST /api/grocery`, `GET/POST /api/ratings`,
`DELETE /api/ratings/:id`, `GET/PATCH /api/preferences/rules` and
`GET /api/search` all respond correctly with the Compose stack up. Signed out,
`/api/recipes` returns all 235 active recipes with every `score` null, and both
`/api/preferences/rules` and `/api/search?q=…` are 401.

The production build needs `DATABASE_URL` in its environment — `/api/health`
imports `@recipes/shared/env` at module scope, so `next build` fails at "collect
page data" without it. That is pre-existing and not a regression.

Driven live in a browser, signed in through a temporary local
`DEV_AUTH_FALLBACK=true` (reverted after; recipe above): the Phase 6 ratings
flow, the `PLAN.md` Phase 5 grocery tab both signed in and signed out, the Phase
7 rules panel, and the full Phase 7 loop — three derived rules took browse from
235 to 74, in strict score order from 100 down to 10, every card carrying its
reason.

And, on 2026-07-31, all of `FILTER_PLAN.md` Phase 5: the example query returning
its 12 recipes from a typed sentence, a shareable `?q=` URL, one back press
restoring a previous query with its results and notices, chips narrowing within
results (91 → 25) and resetting to *All* on a new search, all four notices on
screen, and the bar rendered disabled-with-an-explanation at the 90% gate while
browse carried on working.

---

## Invariants — these will bite you

Each one has a plausible-looking wrong version, and most fail silently.

### Search (FILTER_PLAN Phases 2–5, A27, A28, A32, A33, A35–A38)

- **Time compiles to `total_minutes`, never to the `Under 20 min` tag.** 12
  recipes carry the tag; 34 satisfy the column. Trusting the tag silently loses
  two thirds of the matches and returns twelve plausible recipes while doing it.
  The tag vocabulary is for concepts with no column; where a column exists, the
  column wins.
- **The null convention is inverted from `hardRuleFilter()`, on purpose.** A
  requirement is not satisfied by unknown data — "under 20 minutes" drops the
  recipe with no time, and "freezes well" drops the 144 with no
  `freezer_months`. An exclusion does not fire on unknown data. A hard rule was
  *inferred* from ratings and deserves the benefit of the doubt; a search was
  *typed*, and a null is not a yes. Both directions are pinned by tests, because
  both wrong versions return a believable number of rows.
- **Ingredient constraints and every `exclude*` field are never relaxed.**
  They appear nowhere in `RELAXATION_LADDER` and must stay out of it. Returning
  mushroom recipes to someone who said "no mushrooms" because nothing else
  matched is worse than returning nothing.
- **Ingredients match `ingredients.name` exactly, in both directions** — never
  the trigram or alias path `recipe_ingredients` uses. Canonical `chicken` is on
  2 recipes and `chicken broth` on 22; a fuzzy include answers the wrong
  question and a fuzzy exclude hides recipes with no way to find out.
- **`match_count` is computed from the *un-relaxed* filter while `where` uses
  the relaxed one.** That mismatch is the feature: once a criterion is dropped
  the `WHERE` can no longer rank the rows that met it, and ranking them first is
  the only reason §4.3 sorts on the column.
- **A bare integer in an `ORDER BY` is a positional reference.** An empty filter
  compiled `order by 0 desc` and the query failed outright. It is `0::int`.
- **`ftsDocument()` must stay character-for-character identical to
  `recipes_search_fts_idx`.** Change the coalesce, the separator or the
  regconfig and the query still returns the right rows — by sequential scan.
  `search.integration.test.ts` EXPLAINs the compiler's own clause inside a
  transaction with `enable_seqscan` off and asserts the index name appears.
- **Search does not apply hard rules (§4.2), and cannot.** `searchRecipes()`
  takes no `hardRules` option, so there is none to forget to pass. Scores are
  *not* overridden — they stay as the tiebreak.
- **`scan_runs.kind` is not decoration.** `source_id is null` already means "a
  run spanning every source"; do not reuse that null as the search
  discriminator, or Phase 4's separate budget cannot be built.
- **There is one budget implementation: `@recipes/db/llm-budget`.** Shared
  cannot own DB-backed accounting because DB already depends on shared, and web
  cannot import worker. Do not restore a worker-local copy or add a web-local
  lease; two implementations are two budgets.
- **Every budget read and write names its kind.** `getDailyLlmUsage()` filters
  by both UTC day and kind, and `recordLlmUsage()` rejects a mismatched row.
  The `/ops` UTC-day tile is the deliberate exception: it is total spend and
  continues summing both kinds.
- **The advisory keys are separate on purpose:** scan is `2`, search is `3`.
  The pots are independent, so making a user search wait behind an enrichment
  preflight protects nothing. Search accumulator creation shares key `3`, which
  is what makes one row per UTC day safe without another migration.
- **A search accumulator is never `running`.** It is `success` with a non-null
  `finished_at` from creation and advances the timestamp per search, or `/ops`
  reads the all-day accumulator as a stuck scan. `hasCompletedScan()` must keep
  filtering `kind='scan'`, or that successful row suppresses fresh-DB bootstrap.
- **The paid parse diagnostic is outside the search pot.**
  `scripts/check-search-parse.ts` opens no `scan_runs` row by design; routing it
  through the budget would let a diagnostic consume the next day's search
  allowance.
- **The parse prompt lives in `@recipes/shared/llm`, not the worker** (A35).
  It is the only task prompt that does, because its only caller is the web
  route and `apps/web` must not import `@recipes/worker`. It inherits the
  subpath's rule — server-only, absent from the package barrel — and the
  worker's `src/llm` barrel re-exports it, so anything addressing it through
  that barrel already works. Do not move it back.
- **The bundle-leak grep is no longer free.** `apps/web` now has a real LLM
  caller, so a production build plus a grep of `apps/web/.next/static` for
  `OpenAI`, `openrouter.ai`, `createOpenRouterClient` and
  `StructuredOutputError` is a check to actually run, not a formality. It was
  clean at the Phase 5 exit over 35 files.
- **The search is never run server-side.** `page.tsx` reads `?q=` and passes the
  string down; the client runs it once and caches it forever. A search is a
  billable call, and a crawler, a link preview or a reload each paying for one
  is not something to find out about from a bill.
- **`?q=` is written with `pushState`, and the push is outside the state
  updater** (A37). React calls a `setState` updater more than once — twice under
  StrictMode in development — so a `pushState` inside one pushed two identical
  history entries and leaving a query took two back presses. `router.push` was
  rejected separately: the page is `force-dynamic`, so it would re-run the whole
  server render to change a string the component already holds.
- **A notice the reader is not shown is worse than an empty state.** All four —
  §4.2's bypassed rules, §4.4's relaxations, §5.1's union and A26's degraded
  parse — are assembled by one pure `searchNoticesFor()` in
  `@recipes/shared/search`, because the assembly step is where one gets
  silently dropped. Add a fifth there, with a fixture, not in the route.
- **A26's text fallback must drop English stopwords, and asks Postgres which
  they are** (A38). `plainto_tsquery('english','with')` is the *empty* query and
  `@@` against it is false, so one surviving "with" makes the whole conjunction
  unsatisfiable however good the other terms are. `numnode(...) > 0` is the
  filter. Do not reimplement the stopword list in TypeScript.
- **A route module may only export handlers and Next's own config fields.**
  `next build` type-checks this and fails on anything else — an exported message
  constant is enough to break the build while `tsc` stays clean.
- **`scan_runs.cost_usd` is `numeric(12,6)`.** A JS product like `0.1 × 0.9`
  rounds on the way in and reads back below the number it was written as, so the
  90% gate cannot be tested exactly on its boundary. Real spend arrives in
  ~$0.00057 steps and crosses it within one search either way.
- **`SEARCH_VOCAB_VERSION` is meant to break the build** (A25, A27). It is
  derived from `CATEGORIES` and `TAGS` and pinned literally in
  `packages/shared/test/search.test.ts` *and* in
  `apps/worker/test/fixtures/search-queries.ts`. When it goes red, go and look
  at whether the Phase 3 fixtures still say what they meant, *then* paste the
  new value in. Not the other way round.

### The parse step (FILTER_PLAN Phase 3, A29–A31)

- **The prompt carries the vocabularies, not just the schema.** The strict
  `json_schema` enum stops the model returning a tag that does not exist; it
  does not tell it that `Cheap` and `Slow cooker` *exist*. Deleting those two
  interpolated lines from `PARSE_SEARCH_QUERY_SYSTEM_PROMPT` measurably halves
  the parse quality — that is where 16 of 30 came from, before they were added.
- **The model cannot name a canonical ingredient it has not been shown.**
  `parseSearchQuery()` takes the vocabulary as an input, and Phase 5 must pass
  the ~554 names on active recipes. Pass `[]` and the two ingredient fields come
  back empty — silently, and correctly, because an invented name matches no row.
- **Do not "simplify away" the three repairs.** `repairTimeTags()`,
  `foldSingletonAnyTags()` and `dropEmptyTerms()` each guarantee something the
  prompt merely asks for. The middle one matters even though it cannot change a
  result: `@>` and `&&` over one element are the same predicate, but
  `RELAXATION_LADDER` drops `anyTags` two rungs before `tags`, so without it the
  same query relaxes differently depending on the sampling.
- **`repairTimeTags()` reporting non-empty is the alarm worth watching.** It has
  never fired against the live model. When it does, the §1 time trap is being
  attempted and the prompt is losing that argument.
- **The contract's dedupe must stay `.overwrite()`, never `.transform()`.** A
  Zod transform is unrepresentable in JSON Schema and `z.toJSONSchema()` throws
  on one — which is what the transport calls. It fails at the provider boundary,
  not at a type boundary, so nothing catches it until a real search is run.
- **`scripts/check-search-parse.ts` spends money and is not a test.**
  `vitest.config.ts` includes `test/**/*.test.ts` only, which is the one thing
  keeping it out of `pnpm test`. Do not widen that glob.
- **Prompt tuning past ~28 of 30 is fitting to noise.** At `temperature: 0` the
  failing *set* rotates run to run while the count sits at 28 ± 1. One edit — an
  "ORDER OF WORK" numbered checklist — made the model honour an injected
  `freezerOnly: true` in two runs of three. If you add procedural framing to
  this prompt, re-run the injection fixture before believing it helped.

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
  the same requirement; the port was never the constraint (A22).
- **An `https` `AUTH_URL` switches Auth.js to `__Secure-` cookies.** Correct
  behind Cloudflare, where the browser's leg is HTTPS even though the last hop to
  the container is not. A mismatch between the real scheme and the configured one
  gives you a sign-in that completes and then has no session — not an error.
- **`AUTH_URL` is the runtime value that decides sign-in; `NEXT_PUBLIC_APP_URL`
  is a build input on paper only.** Nothing in `apps/web/src` reads the latter —
  verified absent from the built `.next/static` — so its readers today are
  compose's `AUTH_URL` derivation and the worker's `HTTP-Referer`. Still set it
  before `docker compose build`, because that stops being true the moment a
  client component reads it; just don't debug a deployment there first.
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
- **Bare `docker compose` means the dev stack**, including on a server, unless
  `COMPOSE_FILE` is set in that machine's `.env`. Locally it must stay unset. To
  exercise the production stack on a machine that already runs the dev one, use a
  separate project *and* a free port — `-p recipes-prodtest … WEB_PORT=3100`, with
  `SCAN_BOOTSTRAP_ENABLED=false` so the throwaway stack cannot crawl or spend.
  That is how A22 was verified; `down -v` on that project touches only its own
  volumes, never `recipes_pgdata`.
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
- **`@recipes/shared/llm` inherits that rule and is worse if broken.** It pulls
  in the `openai` SDK, so a client import ships the provider SDK to the browser
  and nothing errors — the page just gets fatter. Both subpaths are deliberately
  absent from the package barrel, which is the only thing standing between an
  `import … from '@recipes/shared'` in a component and that outcome. The check
  is a production build plus a grep of `apps/web/.next/static` for `OpenAI` and
  `openrouter.ai`; it was clean when the transport moved, and it stops being
  free once `apps/web` has a real caller.
- **`@recipes/db/llm-budget` is the server-side seam for both apps.** It is
  deliberately absent from the `@recipes/db` barrel and receives a database
  explicitly; keep it that way so importing budget types does not open a
  second connection or make client code inherit server accounting.
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

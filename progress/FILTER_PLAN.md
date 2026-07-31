# Natural-Language Filtering — Progress

Durable checkpoint log for the build described in
[`../plans/FILTER_PLAN.md`](../plans/FILTER_PLAN.md). Each phase lands as its own
commit (or several). This file records **what is done**, **what was decided that
differs from the plan**, and **what is blocked on Peter**.

Amendments continue at **A23**. A1–A22 belong to the previous plan and live in
[`PLAN.md`](./PLAN.md) — the numbering does not restart, so a citation like
"amendment A18" in `AGENTS.md` or a source comment resolves to exactly one
document.

---

## Setup still needed from Peter

Nothing. `SEARCH_DAILY_BUDGET_USD` has a validated `0.10` default; a local
`.env` value is only an optional override. `OPENROUTER_API_KEY` is already
configured and is the only credential this plan needs.

---

## Phase checklist

| Phase | State |
|---|---|
| 1 — Move the LLM transport to `@recipes/shared/llm` | ✅ complete — 2026-07-30 |
| 2 — `SearchFilter` contract, compiler, migration `0004_search.sql` | ✅ complete — 2026-07-30 |
| 3 — The parse step and its fixtures | ✅ complete — 2026-07-30 |
| 4 — Budget, accounting, `/ops` labelling | ✅ complete — 2026-07-30 |
| 5 — `/api/search`, search bar, URL state | ⬜ not started |

Exit criteria for each are in `plans/FILTER_PLAN.md` §7. Verification baseline
after Phase 4: **836 tests passing** (shared 171, db 20, worker 569, web 76),
clean typecheck, passing production build. It was 712 at the Phase 7 checkpoint
and at the end of Phase 1; Phase 2 added 50, Phase 3 added 65 and Phase 4 added
9, without changing an existing assertion.

---

## Phase 1 — Move the LLM transport ✅

`openrouter.ts` and `usage.ts` now live in `packages/shared/src/llm/`, reachable
only as `@recipes/shared/llm`. `openai@^6.49.0` is a dependency of
`@recipes/shared`, matching the version the worker already had.

**Exit criterion met, in the strong form the plan asked for.** `corepack pnpm
test` with `DATABASE_URL` is **712 passing** (shared 152, db 20, web 40, worker
500) and all four typechecks are clean. Git reports both moved files as
**100%-similarity renames — zero insertions, zero deletions** — so the transport
is byte-identical to what the worker was running, and the whole diff outside the
two renames is fourteen files' worth of import lines plus a package manifest.
No assertion was touched: the only test edits are the two import statements in
`llm-openrouter.test.ts` collapsing into one (both halves now come from the same
subpath) and one path in `reddit-postgres.integration.test.ts`.

### Decisions

**The worker's `src/llm/index.ts` barrel re-exports the shared subpath.** Its
first two lines became `export * from '@recipes/shared/llm'`, and everything that
addresses the transport through `../llm` — `personalization/{runtime,scoring,profile}.ts`,
`reddit/postgres.ts`, `enrichment/runtime.ts`, `src/index.ts`, four test files
and `scripts/run-personalization.ts` — was left completely untouched. The barrel
is the seam that existed precisely so a move like this would not be a twenty-file
diff; using it kept the blast radius at direct importers only.

**`@recipes/shared/llm` is absent from the package barrel on purpose**, exactly
as `./env` is, and the module header says why in the file rather than only here.
It carries a second reason `./env` does not: it pulls in the `openai` SDK, and
that landing in a browser bundle is the failure mode that would not announce
itself. Verified rather than assumed — a production `next build` was run and
`apps/web/.next/static` (34 files) greps clean for `openrouter.ai`, `OpenAI`,
`createOpenRouterClient` and `StructuredOutputError`. That check is the one to
repeat in Phase 5, when `apps/web` gains a real caller and the guarantee stops
being free.

### Correction to the plan

**It was 12 files, not 17.** `plans/FILTER_PLAN.md` §2.2 and §7 both say "17
importing modules"; the actual count of files importing the transport directly
is 12 — ten under `apps/worker/src` and two tests. The figure evidently counted
import *sites* or barrel consumers. Nothing follows from it, but the plan's
number should not be trusted as a checklist.

### Operational note

The `packages/shared/package.json` change staled Compose's anonymous dependency
volumes, refreshed with `docker compose build && docker compose rm -svf web
worker migrate && docker compose up -d` — never `down -v`. The stack came back
with `/api/health` reporting **425 recipes and 789 ingredients**, and the worker
booted printing "OpenRouter configured", which is what proves the moved module
resolves *inside the container* and not merely on the host.

The worktree is left dirty and uncommitted for review.

---

## Phase 2 — The contract and the compiler ✅

Three new modules and one migration, no LLM anywhere in them:
`packages/shared/src/search.ts` (the `SearchFilter` contract, its Zod schema and
`SEARCH_VOCAB_VERSION`), `apps/web/src/lib/search.ts` (the compiler, the
`match_count` expression, the relaxation ladder and the executing
`searchRecipes()`), and `packages/db/drizzle/0004_search.sql`.

**Exit criterion met.** The hand-authored filter for the §1 example query
returns **exactly the 12 recipes** §1 names, through the compiler. Verified two
ways: `apps/web/test/search.integration.test.ts` runs it against the live corpus
and asserts the twelve titles literally, and the compiler's emitted SQL was
dumped and compared against §1's hand-written query. They are the same clause,
fully parameterised:

```
"recipes"."total_minutes" <= $1
  and "recipes"."tags" @> array[$2]::text[]
  and "recipes"."tags" && array[$3, $4, $5, $6, $7]::text[]
```

762 tests pass (up 50), typecheck is clean across four workspaces, the
production build passes, and `apps/web/.next/static` (34 files) still greps
clean for `openrouter.ai`, `OpenAI`, `createOpenRouterClient` and
`StructuredOutputError` — the Phase 1 guarantee, re-checked because
`@recipes/shared/search` is the first search module to enter the package barrel.

### The migration

Applied through the `migrate` service on a normal `docker compose up -d`, after
the usual `build && rm -svf web worker migrate` refresh that a
`packages/shared/package.json` change requires. Verified in the running
database:

- `scan_runs.kind text not null default 'scan'`, with
  `scan_runs_kind_vocab` generated from the new `SCAN_RUN_KIND` constant. All
  183 pre-existing rows read `scan`, and `insert … values ('bogus')` is rejected
  by the constraint rather than accepted.
- `recipes_search_fts_idx` and `recipes_title_trgm_idx` exist, and an `EXPLAIN`
  of the compiler's own FTS clause shows `Bitmap Index Scan on
  recipes_search_fts_idx` — so the expression in `ftsDocument()` really does
  match the one in the index.

Hand-written, so `meta/_journal.json` gained a matching `0004_search` entry, in
the same way `0002_ingestion_state` did.

### Decisions

**The null convention is stated by direction, not by column (§4.1).** The plan
says a clause keeps null rows except for "an explicit numeric bound the reader
typed". Written out per-column that rule is ambiguous for `freezerOnly` and
`categories`, which are neither numeric nor inferred, so the compiler states it
as: **a requirement is not satisfied by unknown data; an exclusion does not fire
on unknown data.** A search for "freezes well" therefore drops the 144 recipes
whose `freezer_months` is null, and `excludeCategories` keeps a row whose
category is unknown. Both halves point the same way as A18 and A20 — prefer a
missed filter to a wrong one — and the numeric cases come out exactly as §4.1
specifies. The inversion against `hardRuleFilter()` is pinned by a test that
runs the same 30-minute bound down both paths and asserts the null-time recipe
appears in one and not the other.

**`match_count` is computed from the un-relaxed filter.** `where` uses the
effective filter, `match_count` uses what the reader actually asked for. That
is the only arrangement in which the column earns its place: once a criterion
has been dropped, the `WHERE` can no longer distinguish rows that met it, and
ranking those rows first is the entire reason §4.3 sorts on it.

**A ladder rung is one round, not one field.** §4.4's cap is two rounds and its
first rung lists three fields, so dropping one field per round would never reach
`anyTags`. Each rung drops every field on it that the filter actually sets, and
a rung the filter never used is skipped rather than spent.

**Ingredient inclusion is exact too, not only exclusion.** §3.2 argues the case
for `excludeIngredients`; the same argument inverted applies to `ingredients`,
since a fuzzy include would answer "chicken" with the 22 recipes containing
chicken *broth*. Both directions resolve against `ingredients.name` exactly.
There is a test for precisely that number.

### Corrections to the plan

**§4.3's `coalesce(score, 5.0)` is wrong** — scores are 0–100 and the neutral
value is `NEUTRAL_SCORE = 50`. The compiler reuses `scoreOrder` from
`lib/recipes.ts` rather than restating the expression, so search and browse
cannot drift on it.

**The search ordering keeps `coalesce(source_rating, 0)` as well**, which §4.3's
four-key snippet omits while its prose asks for "the existing browse order from
`listRecipes()`". The prose is the intent; the omission looks like a slip.
`listRecipes()` and `searchRecipes()` now share one exported
`browseTiebreakOrder` constant, so there is one definition of that order.

### One real bug the tests caught

`match_count` for a filter with zero criteria compiled to a bare `0`, and a bare
integer in an `ORDER BY` is a **positional reference** to a select-list column.
`order by 0 desc` is an error, not a no-op — so an empty filter, which is a real
case, failed outright. It is `0::int` now. Nothing else about the compiler was
wrong on first run; the other four red tests were two bad expectations of mine
(a `minKeepsDays` of 999 that the schema's own 365 cap correctly rejected, and a
title regex used as a proxy for an ingredient, which is exactly the mistake §3.2
is about).

### Note for Phase 3

`SEARCH_VOCAB_VERSION` is `1-723fe8e6` and is asserted literally in
`packages/shared/test/search.test.ts`. When that assertion goes red a vocabulary
changed: check whether the fixtures still express what they meant **before**
pasting the new value in. *Phase 3 pinned the same literal a second time, in
`apps/worker/test/fixtures/search-queries.ts`, so both go red together.*

The worktree is left dirty and uncommitted for review.

---

## Phase 3 — The parse step ✅

`apps/worker/src/llm/parse-search-query.ts` (the prompt, the strict schema and
three deterministic repairs), `apps/worker/test/fixtures/search-queries.ts` (30
committed query→`SearchFilter` pairs and the fixture vocabulary),
`apps/worker/test/llm-parse-search-query.test.ts` (65 offline assertions) and
`apps/worker/scripts/check-search-parse.ts` (opt-in, billable, never in
`pnpm test`).

**Exit criterion met.** All 30 fixtures pass offline. Against the live model the
last three runs of the check script agreed on **28, 28 and 29 of 30**, against a
threshold of 27.

And the end-to-end check the plan asks for: the §1 example query, parsed by the
**live model**, produced

```json
{"maxMinutes":20,"tags":["High protein"],
 "anyTags":["Hands-off","One pot","One cleanup","Sheet pan","No cook"], …}
```

— byte-identical to the hand-authored `EXAMPLE_QUERY_FILTER` in
`apps/web/test/search.integration.test.ts` — and that filter, run through the
Phase 2 compiler, returned **exactly 12 recipes with zero relaxations**. A
sentence now reaches the same twelve rows §1 named, end to end.

827 tests pass (up 65), four typechecks are clean, the production build passes,
and `apps/web/.next/static` (34 files) still greps clean for `openrouter.ai`,
`OpenAI`, `createOpenRouterClient` and `StructuredOutputError`. Total live spend
across eleven check-script runs was about **$0.11**; one run is roughly $0.009
for 35 calls.

### How to run it

```bash
docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts
docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts --live-vocabulary
```

It spends real money. `vitest.config.ts` includes `test/**/*.test.ts` only, so
nothing can drag it into `pnpm test` by accident — which is the point: a suite
that calls a paid provider fails on an aeroplane and goes red for reasons that
have nothing to do with the commit under it.

### Decisions

**The canonical ingredient vocabulary is an input to the parse (A29).** §3.2
says the model must emit exact `ingredients.name` values and the plan notes that
789 of them will not fit in a JSON Schema enum — but it never says how the model
is supposed to know them. Prompt rules alone cannot work: the corpus splits one
food across many rows, so "no chicken" has to reach `chicken`, `chicken breast`,
`chicken thighs` and `ground chicken`, and a model told only to "use the plain
generic name" emits `chicken`, which is on 2 recipes. So the vocabulary is
supplied in the user payload, the way `map-ingredients.ts` supplies its own.
Pass the names on at least one *active* recipe — 554 of the 789 — because a
canonical no live recipe uses cannot change a result and is pure cost.

**No guard drops an unknown ingredient name**, and that is deliberate rather
than an omission. An unknown *exclusion* is already a no-op in SQL, so dropping
it changes nothing; an unknown *inclusion* correctly returns nothing, and
dropping it would turn "with harissa" — which the corpus genuinely cannot
answer — into a page of recipes without harissa. The schema's free strings plus
exact matching are already right in both directions.

**The prompt carries the `CATEGORIES` and `TAGS` vocabularies (A30).** They were
already in the strict JSON Schema as enums, and that is not enough. The enum
stops the model returning a tag that does not exist; it does not tell it that
`Cheap` and `Slow cooker` are things this collection *has*. The first live run,
before those two lines existed, scored **16 of 30** and put "cheap" and "high
protein" in `unmappedTerms` while leaving `tags` empty. `derive-fields.ts`
states its vocabulary in the prompt for the same reason, and it was the single
largest improvement of the phase: 16 → 25.

**Three deterministic repairs sit between the model and the caller (A31).** Each
is a property the prompt asks for and code now guarantees, in the same spirit as
`isPlausibleCanonicalMatch()` (A18):

- `repairTimeTags()` takes any of `TIME_TAGS` back out of `tags`/`anyTags` and
  turns it into the `maxMinutes` it was standing in for. Dropping the tag alone
  would be *worse* than leaving it — "under 20 minutes" would silently become no
  constraint at all — and where several disagree the loosest wins, because a
  bound that is too tight hides recipes while one too loose only shows extra.
  It reports what it repaired rather than swallowing it, and the check script
  counts that: **across every live run it has never once fired.**
- `foldSingletonAnyTags()` moves a lone tag from `anyTags` into `tags`. Over one
  element `@>` and `&&` are the *same predicate*, so the model's choice between
  them is invisible in the results — and very visible afterwards, because
  `RELAXATION_LADDER` drops `anyTags` at rung 2 and `tags` at rung 4. Without
  this, the same query relaxes two rungs earlier depending on a coin toss.
- `dropEmptyTerms()` removes a short stoplist of meal nouns ("dinners",
  "leftovers", "meals") and the time words the minute bounds already spend
  ("quick", "weeknight"). Terms are ANDed into the `WHERE` (§5.1), so
  `minKeepsDays: 7` plus a term "leftovers" is a materially narrower search than
  the cook typed, and the recipes it loses are lost for containing the wrong
  noun. Deliberately tiny, and not a general stopword list: a word that
  describes food stays, however common.

**`.transform(unique)` became `.overwrite(unique)` in the contract.** Not a
change to what a filter is — same input, same output, same dedupe. A Zod
transform is *unrepresentable in JSON Schema*; `z.toJSONSchema()` throws on one,
and the transport calls exactly that. Phase 2 could not have found this because
nothing called the transport yet. The offline suite now pins the converted
schema: 14 required properties, `additionalProperties: false`.

### Two fixtures were wrong, and were changed rather than argued with

Both were cases where the model's answer was defensible and mine was not.

- *"slow cooker recipes for the weekend"* → the model read "for the weekend" as
  a duration and set `minMinutes: 120`, which the prompt's own "an all-afternoon
  braise is 120" rule half-licenses. The fixture is about the profile losing to
  the query, so the ambiguity is gone: it is now *"slow cooker recipes"*.
- *"something with minimal cleanup"* → `One cleanup` is a tag, so the query named
  a tag by name and one prompt rule sent it to `tags` while another claimed the
  whole effort group for that phrase. Two rules pointing opposite ways at one
  phrase. The phrase left the prompt and the fixture together; the fixture is now
  *"something that isn't much work"*.

### What the tuning actually looked like

Worth recording, because the shape of it is the finding. Eleven live runs:
**16 → 25 → 26 → 28 → 27 → 26 → 25/28/26 → 25/26/27 → 28/28/29.**

The first two jumps were real: the missing vocabularies, then the
category/ingredient and effort-versus-speed rules. After that the failing
*set* rotated on every run while the count sat at 26 ± 2 — different fixtures,
same prompt. That is sampling variance dominating, at `temperature: 0`, and it
is the reason the exit criterion is 27 of 30 rather than 30 of 30.

One edit made things actively worse and is worth remembering: an "ORDER OF WORK"
numbered checklist appended to the prompt dropped the score and, more seriously,
made the model **honour the injected `freezerOnly: true`** in two runs of three.
A procedural instruction to work through "what the query explicitly asks for"
appears to re-frame an injected instruction as part of the query. It was
reverted; the injection fixture has passed every run since.

The last three changes — hardening the untrusted-data line against text that
*names a filter field*, matching tags on meaning rather than spelling, and the
`dropEmptyTerms` stoplist — took it to 28/28/29 and tuning stopped there. Past
that point I would have been fitting the prompt to noise.

### §10 open question 1, answered

> Should `anyTags` groupings ("easy", "healthy", "impressive") be a curated
> constant the model selects from, rather than free tag selection?

**In effect, yes — and it already is, in the prompt rather than in a constant.**

The evidence is `GROUPING_PROBES`, five queries the check script runs and prints
without scoring, chosen precisely because the prompt does *not* name them. The
fixtures cannot answer this question: the prompt spells the "easy" grouping out,
so a fixture over "easy to make" measures instruction following. The probes
measure judgement. Unaided, on the final prompt:

| Probe | What the model did |
|---|---|
| "something healthy" | `unmappedTerms: ["healthy"]` — no grouping at all, though `High fiber`, `High protein` and `Vegetarian` were all available |
| "something impressive for guests" | `unmappedTerms: ["guests","impressive"]` — nothing |
| "comforting food for a cold night" | `tags: ["Comfort"]` — correct, but that is a *single tag lookup*, not a grouping |
| "something I can eat at my desk" | `categories: ["No-reheat"]` once, `unmappedTerms: ["desk"]` another run — unstable |
| "low effort dinners" | the full five-tag effort group, every run — the one the prompt names |

So: the model reliably produces the grouping it is told about, and produces no
grouping at all for the ones it is not. It does not invent sensible groupings on
its own. An earlier prompt version did once answer "something healthy" with
`["High fiber","High protein","Vegan option","Vegetarian"]`, which is a good
grouping — but it did it once, and not again.

The recommendation is therefore **not** to add a `TAG_GROUPS` constant now. The
prompt is already the curation, it costs nothing extra, and there is exactly one
grouping the corpus needs. Promote it to a constant when a second grouping earns
its place — "healthy" is the obvious candidate — and at that point the constant
should be shared, so Phase 5 can name the grouping in the results header
("Showing low-effort recipes") instead of listing five tags.

### Known gap, and what it measures

The check script sends the **committed 90-name fixture vocabulary**, while Phase
5 will send the ~554 canonical names on active recipes. A fixture that changes
whenever the crawler finds a new ingredient is not a fixture, so this is the
right trade — but it means the exclusion fixtures are not exercised at
production vocabulary size. `--live-vocabulary` runs exactly that, and prints a
banner saying its count is information rather than the §7 exit criterion.

Run once at 554 names, it scored **26 of 30** against 28–29 at fixture size, so
the larger vocabulary does cost some accuracy — more near-miss distractors for
every exclusion. Not alarming, and worth re-checking in Phase 5 against a real
route.

### What a search actually costs — a correction to §8

Measured on the `--live-vocabulary` run, which is the shape Phase 5 will send:
**153,811 input and 11,049 output tokens over 35 calls, $0.01993** — about
**4,400 input tokens and $0.00057 per search**. The 554-name vocabulary is most
of that.

§8 proposes `SEARCH_DAILY_BUDGET_USD` at `0.10` and describes it as "thousands
of queries at flash pricing". At the measured rate it is closer to **175
searches a day**. Still ample for a ~10-user ceiling, and the 90% gate will
never be seen in normal use — but the plan's parenthetical is wrong by an order
of magnitude, and Phase 4 should pick the default knowing the real number rather
than inheriting the estimate. Trimming the vocabulary to names on active recipes
is already the cheap half of this; the rest is the vocabulary itself.

The worktree is left dirty and uncommitted for review.

---

## Phase 4 — Budget and accounting ✅

The separate search pot is now real, not just an env name.
`SEARCH_DAILY_BUDGET_USD` is a positive validated number in
`@recipes/shared/env`, defaults to **`0.10`**, and is listed in `.env.example`.
That default was retained from §8 because the Phase 3 measurement gives it a
meaningful capacity: at about **$0.00057 per search**, it is roughly **175
searches per UTC day** for the expected ~10 users — ample, but not “thousands.”

**Exit criterion met against the live database.** A synthetic scan response and
search response on the same UTC day were accounted through the real budget
hooks at **$0.011111** and **$0.022222** respectively. The scan usage read saw
only the first, the search usage read saw only the second, and the running
`/ops` page returned 200 with both the **Search** label and `$0.0222`. The two
probe rows were deleted afterwards and the probe day was verified back at zero.
No provider call was made.

836 tests pass (up 9: shared 171, db 20, web 76, worker 569), all four
typechecks are clean, and the production build passes.

### Where the one budget implementation lives

The worker-local `apps/worker/src/enrichment/budget.ts` is gone. Its lease,
`createBudgetedLlmCallOptions()`, `getDailyLlmUsage()` and the atomic usage
write now live together in `packages/db/src/llm-budget.ts`, exported only as
the server-side `@recipes/db/llm-budget` subpath. Every existing worker caller
passes `kind: 'scan'`; Phase 5's web route can import the same implementation
and pass `kind: 'search'`.

This could not follow Phase 1 literally into `@recipes/shared`: `@recipes/db`
already depends on shared for its schema vocabularies and env, so shared
importing DB would create a package cycle. DB is the lowest common server-side
owner both apps already depend on, and the new subpath accepts a `Database`
rather than opening a connection at import time. It is deliberately absent
from the side-effectful `@recipes/db` root barrel.

The old Postgres helpers were moved, not copied. `getDailyLlmUsage(db, kind,
at)` requires the kind and includes `scan_runs.kind` in the UTC-day predicate.
`recordLlmUsage(db, runId, kind, usage)` also checks the row kind, so a caller
cannot charge a search row through the scan pot or vice versa.

### The daily search accumulator and locks

`getOrCreateDailySearchRun()` lazily creates the UTC day's one
`kind='search'`, null-source row. It is `success` from creation, starts with
zero counts and usage, and has a non-null `finished_at`; every search call
advances that timestamp monotonically. Concurrent first searches return the
same row, and the UTC rollover creates a new one.

**The pots use separate advisory keys (A33): scan remains key `2`; search uses
key `3`.** The daily totals are genuinely independent now, so sharing a key
would add user-visible waiting behind enrichment without protecting shared
state. Search-row select-or-insert uses the same search key, which is what makes
the one-row-per-day invariant safe without another migration or a duplicate
lease implementation.

Tests pin same-kind serialization, cross-kind non-blocking, both directions of
budget isolation at the cap, concurrent accumulator creation, UTC rollover,
success/`finished_at` lifecycle fields and mismatched-kind write rejection.

### `/ops` and one hidden lifecycle consequence

The recent-run query now selects `kind`: a search row is labelled **Search**,
while a null-source scan row remains **All sources**. The “LLM UTC day” tile is
still deliberately unfiltered and therefore remains total spend across both
kinds.

Making the search accumulator `success` from creation exposed one unrelated
consumer of the old implicit assumption: `hasCompletedScan()` counted any
successful `scan_runs` row. On a fresh database, a search row could therefore
suppress bootstrap ingestion. It now requires `kind='scan'`, with a
database-backed regression test.

`apps/worker/scripts/check-search-parse.ts` remains deliberately outside this
machinery. It still opens no `scan_runs` row and cannot consume the following
day's user-facing search budget; no prompt or fixture changed.

---

## Amendments

Recorded here as they happen. The four below were settled during the design
conversation on 2026-07-30, before any code was written, and are stated in full
in `plans/FILTER_PLAN.md` §9.

**A23 — The LLM does not write SQL.** It emits a validated `SearchFilter`; our
code compiles that to SQL. Text-to-SQL was rejected: it buys expressive power the
corpus cannot use in exchange for an injection surface and nothing testable.

**A24 — No cache and no cache table.** The parse is profile-aware (§3.3) and
therefore per-reader; at a ~10-user ceiling both a real cache and a log-only
table cost more in staleness and invalidation logic than they save. Every search
parses fresh. Consequence accepted: the Phase 3 fixtures are hand-written rather
than harvested from a log.

**A25 — `SEARCH_VOCAB_VERSION` exists to fail the build, not to invalidate
anything.** Nothing is stored, so there is nothing to invalidate; the constant is
there so a `TAGS`/`CATEGORIES` change that leaves the fixtures un-updated breaks
loudly instead of quietly degrading parse quality.

**A26 — LLM failure is visible to the reader.** Fall back to full-text search
over the raw query and say so. At operator scale a silent degradation to worse
results is worse than an honest notice.

The two after them were settled during Phase 2, in code rather than in
conversation.

**A27 — `SEARCH_VOCAB_VERSION` is derived from the vocabulary, not hand-bumped.**
It is `1-<FNV-1a of CATEGORIES and TAGS>`; the leading number is the shape of
`SearchFilter` and moves by hand when a field is added or removed. A25 says the
constant exists to fail the build when a vocabulary changes without the fixtures
being revisited — and a hand-bumped integer cannot do that, because the person
who forgot to update the fixtures is the same person who would have forgotten to
bump it. Deriving it makes the failure automatic. Cost: the literal value is
pinned in a test and has to be re-pasted deliberately after a vocabulary change,
which is the point.

**A28 — The compiler's null rule is stated by direction.** "A requirement is not
satisfied by unknown data; an exclusion does not fire on unknown data" replaces
§4.1's "a clause keeps nulls, except an explicit numeric bound". The two agree
everywhere §4.1 is unambiguous, and the restatement decides the cases it does
not cover — `freezerOnly` and `categories` are requirements, so they drop nulls,
even though neither is a numeric bound. Rationale in the Phase 2 log above.

The three below were settled during Phase 3, all of them by watching the live
model rather than by reasoning about it.

**A29 — The canonical ingredient vocabulary is an input to the parse step.**
`SearchFilter.excludeIngredients` takes exact `ingredients.name` values, 789 of
them, too many for a JSON Schema enum — so the schema takes free strings and the
*vocabulary* is supplied in the user payload instead, the way `map-ingredients.ts`
supplies its own. Prompt rules alone cannot do it: the corpus splits one food
across many rows, so "no chicken" must reach four names, and a model told to use
"the plain generic name" emits `chicken`, which is on 2 recipes. Phase 5 passes
the names on at least one active recipe (554 of 789); the rest cannot change a
result and are pure prompt cost. No guard drops an unknown name — an unknown
exclusion is already a SQL no-op, and an unknown inclusion *correctly* returns
nothing.

**A30 — The controlled vocabularies go in the prompt as well as the schema.**
The strict `json_schema` enum stops the model returning a tag that does not
exist; it does not tell it that `Cheap` and `Slow cooker` are things this
collection has. The first live fixture run, before `CATEGORIES` and `TAGS` were
stated in the prompt, scored 16 of 30 and put "cheap" and "high protein" in
`unmappedTerms` with `tags` left empty. Adding them took it to 25. Same reason
`derive-fields.ts` has always done it.

**A31 — Three deterministic repairs sit between the model and the caller.**
`repairTimeTags()` converts a `TIME_TAGS` entry into the `maxMinutes` it was
standing in for (dropping it alone would turn "under 20 minutes" into no
constraint; the loosest of several wins, per A18's direction) and *reports* the
repair rather than swallowing it. `foldSingletonAnyTags()` moves a lone tag into
`tags`, because over one element `@>` and `&&` are the same predicate but
`RELAXATION_LADDER` drops them two rungs apart — without it the same query
relaxes differently on a coin toss. `dropEmptyTerms()` removes a small stoplist
of meal nouns and spent time words, because terms are ANDed into the `WHERE` and
a stray "leftovers" narrows a search by the wrong noun. Each is a property the
prompt asks for and code guarantees, in the spirit of A18's mapper guard.

The two below were settled during Phase 4 by the package boundary and the two
independent durable totals.

**A32 — Budget/accounting is a server-only `@recipes/db` subpath.** Moving it
to `@recipes/shared` would make shared import DB while DB already imports
shared, and leaving it in the worker would keep it unreachable from Phase 5.
`@recipes/db/llm-budget` is the one implementation both apps use; it is absent
from the DB barrel and receives its database explicitly.

**A33 — Scan and search use separate advisory-lock keys.** Scan keeps key `2`;
search uses key `3`, including daily accumulator creation. Once every usage
read and write requires a kind, the pots share no mutable budget state, so one
lock would only make a search wait behind enrichment. Same-kind requests still
serialize from preflight through the durable write, and tests prove cross-kind
preflights do not block.

---

## Notes

**Two facts found during design that shaped the plan**, both verified against the
live database on 2026-07-30:

- `scan_runs.source_id = NULL` is already taken — it means "a run spanning every
  source", which is what the nightly scan uses. The search accumulator row
  therefore needs a real `kind` discriminator column, and without it the separate
  search budget is unimplementable. **Shipped in Phase 2**; all 183 existing
  rows are `kind = 'scan'`.
- Only 12 recipes carry the `Under 20 min` tag while 34 have
  `total_minutes <= 20`. Time must compile to the column, never the tag.
  **Both numbers are now asserted in `search.integration.test.ts`**, so the trap
  is a failing test rather than a paragraph.

**Corpus numbers Phase 2's tests lean on**, all measured 2026-07-30 over the 235
active recipes. Where a suite can derive a number from an independent SQL query
it does, so only the first of these is hard-coded:

| Fact | Value |
|---|---|
| the §1 example query | 12 recipes |
| `total_minutes <= 20` / tagged `Under 20 min` | 34 / 12 |
| `total_minutes is null` | 1 |
| `keeps_days is null` / `freezer_months is null` | 19 / 144 |
| recipes with at least one unmapped ingredient line | 66 |
| canonical `chicken` / `chicken broth` | 2 / 22 recipes |
| FTS `creamy` / `crispy` / both | 24 / 9 / **0** |

The last row is what makes §5.1's union fallback testable at all: the two terms
have an empty intersection and a 33-recipe union, so the AND attempt is
guaranteed to come back empty and the fallback is guaranteed to fire.

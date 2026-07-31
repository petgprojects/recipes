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

| Item | Needed by | Status |
|---|---|---|
| `SEARCH_DAILY_BUDGET_USD` in local `.env` | Phase 4 | ⏳ not yet added; defaults to `0.10` if absent |

Nothing else. `OPENROUTER_API_KEY` is already configured and is the only
credential this plan needs.

---

## Phase checklist

| Phase | State |
|---|---|
| 1 — Move the LLM transport to `@recipes/shared/llm` | ✅ complete — 2026-07-30 |
| 2 — `SearchFilter` contract, compiler, migration `0004_search.sql` | ✅ complete — 2026-07-30 |
| 3 — The parse step and its fixtures | ⬜ not started |
| 4 — Budget, accounting, `/ops` labelling | ⬜ not started |
| 5 — `/api/search`, search bar, URL state | ⬜ not started |

Exit criteria for each are in `plans/FILTER_PLAN.md` §7. Verification baseline
after Phase 2: **762 tests passing** (shared 167, db 20, worker 500, web 75),
clean typecheck, passing production build. It was 712 at the Phase 7 checkpoint
and at the end of Phase 1; Phase 2 added 50 and changed no existing assertion.

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
pasting the new value in.

The worktree is left dirty and uncommitted for review.

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

The two below were settled during Phase 2, in code rather than in conversation.

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

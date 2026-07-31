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
| 2 — `SearchFilter` contract, compiler, migration `0004_search.sql` | ⬜ not started |
| 3 — The parse step and its fixtures | ⬜ not started |
| 4 — Budget, accounting, `/ops` labelling | ⬜ not started |
| 5 — `/api/search`, search bar, URL state | ⬜ not started |

Exit criteria for each are in `plans/FILTER_PLAN.md` §7. Verification baseline to
beat, carried from the Phase 7 checkpoint: **712 tests passing** (shared 152, db
20, worker 500, web 40), clean typecheck, passing production build.

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

---

## Notes

**Two facts found during design that shaped the plan**, both verified against the
live database on 2026-07-30:

- `scan_runs.source_id = NULL` is already taken — it means "a run spanning every
  source", which is what the nightly scan uses. The search accumulator row
  therefore needs a real `kind` discriminator column, and without it the separate
  search budget is unimplementable.
- Only 12 recipes carry the `Under 20 min` tag while 34 have
  `total_minutes <= 20`. Time must compile to the column, never the tag.

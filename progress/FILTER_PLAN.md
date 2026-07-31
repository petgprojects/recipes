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
| 1 — Move the LLM transport to `@recipes/shared/llm` | ⬜ not started |
| 2 — `SearchFilter` contract, compiler, migration `0004_search.sql` | ⬜ not started |
| 3 — The parse step and its fixtures | ⬜ not started |
| 4 — Budget, accounting, `/ops` labelling | ⬜ not started |
| 5 — `/api/search`, search bar, URL state | ⬜ not started |

Exit criteria for each are in `plans/FILTER_PLAN.md` §7. Verification baseline to
beat, carried from the Phase 7 checkpoint: **712 tests passing** (shared 152, db
20, worker 500, web 40), clean typecheck, passing production build.

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

# Build Progress

Durable checkpoint log for the build described in [`PLAN.md`](./PLAN.md).
Each phase lands as its own commit (or several). This file records **what is
done**, **what was decided that differs from PLAN.md**, and **what is blocked
on Peter**.

---

## Setup still needed from Peter

| Item | Needed by | Status |
|---|---|---|
| `OPENROUTER_API_KEY` | Phase 2 | ⬜ not yet provided |
| Reddit API credentials | Phase 2 (Reddit source only) | ⛔ blocked — see below |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Phase 4 | ◐ OAuth client + test user configured; values not yet copied into `.env` |

Google OAuth is configured to redirect to the exact callback
`http://localhost:3000/api/auth/callback/google`, and Peter's email is an
allowed test user. The local `.env` entries are still blank; that does not
block work before Phase 4.

**Reddit blocker.** App creation at reddit.com/prefs/apps fails with the
"Responsible Builder Policy" message; browser console shows a 401 from
`google.com/recaptcha/api2/pat`. Diagnosis: reCAPTCHA cannot complete, so the
form fails closed. Fixes to try, in order: disable ad/privacy extensions for
reddit.com *and* google.com; allow third-party cookies for reddit.com; disable
VPN; verify the account's email address.

Reddit is **not** a blocker for the build. The Reddit adapter ships in Phase 2
with its `sources` row `enabled = false`; flipping one boolean turns it on once
credentials exist.

---

## Amendments to PLAN.md

Decisions made during implementation that differ from the plan as written.
PLAN.md is left intact as the original design document; this section is the
authoritative delta.

### A1 — LLM access goes through OpenRouter, not DeepSeek direct
*Phase 2. Reason: Peter has an OpenRouter key, not a DeepSeek one.*

- Base URL `https://openrouter.ai/api/v1`, env var `OPENROUTER_API_KEY`
  (replaces `DEEPSEEK_API_KEY` throughout, including `.env.example`).
- Model id is `deepseek/deepseek-v4-flash`, not `deepseek-v4-flash`.
- Still the `openai` npm client with `baseURL` swapped, exactly as §2 describes.
  Nothing else in the architecture changes.

Verified live against OpenRouter's `/api/v1/models` on 2026-07-26:

| | PLAN.md assumed | OpenRouter actual |
|---|---|---|
| Context | 1M | 1,048,576 ✅ |
| Max output | 384K | 393,216 ✅ |
| Input | $0.14/M | $0.14/M ✅ |
| Output | $0.28/M | $0.28/M ✅ |
| Cached input | $0.0028/M | **$0.028/M** (80% off, not 98%) |

The cache discount is an order of magnitude weaker than the plan assumed. Cost
impact is negligible at this scale (~$3/mo → ~$3.50/mo) and the prompt
structuring advice in §2 still applies — it is simply worth less.

### A2 — Strict JSON Schema replaces the repair-retry as the primary mechanism
*Phase 2. Reason: OpenRouter exposes a capability DeepSeek's own API does not.*

PLAN.md §2 states DeepSeek supports only `response_format: {type: "json_object"}`
and therefore requires client-side Zod validation plus a repair retry. Via
OpenRouter, `deepseek/deepseek-v4-flash` reports `structured_outputs` in its
`supported_parameters`, so `response_format: {type: "json_schema", strict: true}`
is enforced server-side.

Consequence: Zod validation stays (it is the TypeScript type boundary and
guards against provider fallback), but the repair retry becomes a rarely-hit
safety net rather than the expected path. §2's "Alternative worth prototyping"
— the `emit_recipe` tool-calling hack — is **not needed** and will not be built.

### A3 — Source list resolved (PLAN.md §8, open question 11)
Budget Bytes, Pinch of Yum, Downshiftology, GypsyPlate, Skinnytaste, The
Kitchn, Love & Lemons, Serious Eats.

### A6 — Classpop dropped permanently
*Phase 1. Resolved by Peter on 2026-07-26.*

Probed live: Classpop's sitemap holds 1,684 magazine URLs, zero under
`/recipe/`, and its pages emit only `Article` + `WebPage` JSON-LD — no
`Recipe` node anywhere. It came from the artifact's source list, but it is a
cooking-class marketplace, not a recipe publisher. Routing it to the Phase 2
LLM extraction path would mean paying tokens to repeatedly discover there is no
recipe on the page. It has been removed from the canonical source list, capture
tooling, coverage report, and committed fixture corpus.

### A7 — Serious Eats enabled
*Phase 1. Resolved by Peter on 2026-07-26.*

Serious Eats' robots.txt `Disallow: /`s the named AI crawlers
(`anthropic-ai`, `GPTBot`, `CCBot`, `PerplexityBot`) and carries a People Inc.
licensing notice prohibiting text/data mining and LLM use. Our crawler matches
the `*` group, which does not disallow recipe pages — so we are *technically*
permitted while the site's stated intent is clearly the opposite.

Peter confirmed the project is permitted to use the source and directed that
it be enabled, noting that crawling/extraction is deterministic rather than
LLM-driven; any later analysis is a separate Phase 2 concern. Serious Eats is
therefore included in the canonical eight-source seed with `enabled = true`.

### A4 — Unset and empty env vars are treated identically
*Phase 0. Found while bringing up compose from a clean state.*

`.env.example` deliberately ships Phase 2/4 secrets blank (`OPENROUTER_API_KEY=`),
and PLAN.md §3 expects a `.env` copied from it to boot. The original Zod helper
was `.string().trim().min(1).optional()`, but `.optional()` only rescues
`undefined` — `min(1)` rejects `""` before optionality is considered, so a stock
`.env` made every service refuse to boot. The emptiness check now happens inside
the `.transform()`. `FOO=` and an absent `FOO` are now the same thing: not
configured.

### A5 — Compose migrates in a dedicated one-shot service
*Phase 0.* `web` and `worker` both wait on a `migrate` service with
`condition: service_completed_successfully`, rather than either app migrating at
startup. Two services racing to migrate the same database is a real bug; this
removes it structurally.

---

## Phase checklist

- [x] **Phase 0 — Scaffold.** ✅ Monorepo, docker-compose, Drizzle schema +
      migration, vocabularies, Zod env module, 117 seeded canonical
      ingredients, `dev@local` user, `/api/health`, `/api/recipes`.
      *Exit verified: `docker compose up` from clean → 5 extensions, 15 tables,
      117 ingredients + 117 self-aliases, health 200, `/api/recipes` → `[]`.*
- [ ] **Phase 1 — Deterministic ingestion.** ◐ **IN PROGRESS — `/ops` + live exit validation remain.**
    - [x] Polite fetcher (robots.txt, crawl delay, conditional GET, backoff)
    - [x] RSS + sitemap discovery
    - [x] JSON-LD → Recipe extraction, 30 committed fixtures, coverage report
    - [x] Ingredient normalization (parse → match → alias writeback, stages 1–2)
    - [x] Insert path + dedupe on `source_url` + `content_hash`
    - [x] Image pipeline (fetch once, downscale ~800px, `recipe-images` volume)
    - [x] pg-boss wiring, cron + advisory lock, `scan_runs` telemetry
    - [x] `sources` seeded (8 approved blogs, all enabled — A6, A7)
    - [ ] `/ops` page: last run, counts, cost
      *Exit: hundreds of real recipes with photos, zero LLM involvement.*
- [ ] **Phase 2 — LLM enrichment.** OpenRouter client, suitability gate,
      derived fields, HTML + Reddit extraction, blurbs, budget cap, backfill.
      *Exit: recipes complete, junk filtered.*
- [ ] **Phase 3 — UI port.** Components, images, TanStack Query auto-refresh,
      "N new recipes" pill. Retire `meal-prep-planner.jsx`.
- [ ] **Phase 4 — Auth.** Auth.js + Google, localStorage migration on first sign-in.
- [ ] **Phase 5 — Grocery list server-side.** SQL aggregation, per-user checks,
      print + copy-to-clipboard.
- [ ] **Phase 6 — Ratings.** 1–5 stars, notes, fixed-vocabulary aspect tags.
- [ ] **Phase 7 — Personalization.** SQL-derived hard rules, LLM soft profile,
      batched scoring with visible reasons, cold-start guards.

---

## Log

### 2026-07-26 — Baseline
Repo had no commits. Committed `PLAN.md`, `reqs.md`, `meal-prep-planner.jsx`
as-is plus this file and a `.gitignore`. Verified toolchain: Node 24.13,
Docker 29.2, Compose v5.0.2. pnpm absent from PATH — **use `corepack pnpm`**
for every command (`corepack enable pnpm` needs sudo; not required).

### 2026-07-26 — Phase 0 complete
Extracted the artifact's lasting value before touching it: 117 canonical
`{name, aisle, defaultUnit}` ingredients, the real vocabularies (9 aisles in
store-walk order, 6 categories, 27 tags), the 24 recipes as UI fixtures, and
272 lines of CSS byte-identical for the Phase 3 port. `meal-prep-planner.jsx`
stays until Phase 3 retires it.

Built `packages/shared` (vocab, units, Zod env, schemas) and `packages/db`
(full §4 schema, extensions migration ordered first, idempotent seed), then
`apps/web`, `apps/worker` and the compose stack.

Verified independently, not just reported: typecheck clean across all projects,
38/38 tests pass, and `docker compose down -v` → `up --build` yields
`{"reachable":true,"migrated":true,"seeded":true,"ingredients":117}` with
`/api/recipes` → `[]`, which is the correct Phase 0 answer.

**Gotcha for later:** the compose bind mounts are shadowed by anonymous
`node_modules` volumes, so after any `package.json` change run
`docker compose down -v && docker compose up --build`.

### 2026-07-26 — Phase 1, part 1 of 2: discovery + extraction
Built the polite fetcher, RSS/sitemap discovery and JSON-LD extraction as pure
functions in `apps/worker/src/scanner/`, plus 30 real committed HTML fixtures
and 298 tests. No database, queue or cron yet — that is part 2.

**The phase's risk is now retired, and PLAN.md §1 was somewhat optimistic.**
Probed all nine sources live. 21 of 29 captured pages carry a Recipe node.
Details in `apps/worker/test/fixtures/COVERAGE.md`; the three findings that
change the design:

1. **RSS is not universal.** GypsyPlate and Serious Eats have no usable feed
   (302 to homepage / WAF 403 / all RSS paths 404). The sitemap fallback is
   load-bearing on day one, not a nicety.
2. **Roughly a third of feed items are round-up posts** with no recipe at all
   ("15 Best Sheet Pan Dinners"). Absence of a Recipe node is a free,
   zero-token filter — `scan_runs` must count "no Recipe node" separately from
   Phase 2 gate rejections, or the numbers will be unreadable.
3. **Ratings are not free.** 9 of 21 pages have none; The Kitchn never
   publishes `aggregateRating` at all. Treat it as genuinely optional in the UI.

Also: `author` is frequently a bare `@id` reference to a sibling `Person` node
(Yoast sites). Dereferencing took author coverage from 17/21 to 21/21 — and
`raw_jsonld` alone cannot re-derive it, since the referenced node lives outside
the Recipe object.

### 2026-07-26 — Phase 1, ingredient normalization
Implemented deterministic parsing plus exact-first, conservative pg_trgm
matching. Fuzzy matches must score above 0.78 and lead the nearest distinct
ingredient by at least 0.08 before the spelling is written back to
`ingredient_aliases`; ambiguous or unknown lines remain renderable with a null
`ingredient_id` for Phase 2's semantic matcher.

Verification: 47 focused parser/matcher tests, 345 worker tests and 383 tests
workspace-wide pass; all workspace typechecks pass. A live Postgres probe
confirmed both exact matching (`Chicken Breast`) and fuzzy alias learning
(`Chicken Breasts` → `chicken breast`) against the seeded rows.

### 2026-07-26 — Phase 1, storage + images + source decisions
The source list now has exactly eight enabled blogs. Classpop is removed
entirely; Serious Eats is enabled. The same typed source configuration drives
database seeding, scanner URL adapters and fixture capture, so those surfaces
cannot silently drift.

Added persisted feed/page conditional-GET validators and a separate
`scan_runs.no_recipe` counter, transactional recipe upserts with canonical URL
dedupe and content-hash-aware ingredient replacement, and a binary-safe Sharp
image cache. Images are fetched through the polite crawler, bounded by byte and
pixel limits, auto-oriented, resized within 800×800 without enlargement, and
atomically stored as deterministic WebP files. Image failures degrade without
losing the recipe or its source-image attribution.

Verification: migration + idempotent seed pass against Postgres; the database
contains 8/8 enabled sources and no Classpop row. Live integration tests cover
insert, unchanged touch, changed-content replacement, rollback and 304
semantics. Workspace totals: shared 33, db 19 and worker 353 tests passing;
typecheck and the 26-page fixture coverage report pass.

### 2026-07-26 — Phase 1, scan orchestration + scheduling
Wired the deterministic scanner into a coalescing pg-boss queue, a daily
`03:00 America/New_York` node-cron trigger, a one-time fresh-database bootstrap,
and a session-scoped Postgres advisory lock. The job retries transient failures
twice with bounded exponential backoff, expires after six hours, emits
per-source `scan_runs` counters/status/errors, and shuts down cooperatively.

Source checkpoints now distinguish errors that require a retry from useful
partial runs: page-fetch/extraction failures retain the prior validators so
they can be retried, while harmless feed fallback warnings and image-cache
failures are recorded as partial without repeatedly re-fetching the whole
source. Feed `304` responses only skip discovery when stored recipes prove the
source has been populated.

Verification: the complete workspace has 419 passing tests (shared 35, db 19,
worker 365), all workspace typechecks pass, the fixture coverage report passes,
database-backed lifecycle tests pass, duplicate queue sends coalesce, and a
real worker startup/shutdown smoke test initialized pg-boss and cron then
released both cleanly with bootstrap crawling disabled.

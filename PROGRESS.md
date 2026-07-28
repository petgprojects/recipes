# Build Progress

Durable checkpoint log for the build described in [`PLAN.md`](./PLAN.md).
Each phase lands as its own commit (or several). This file records **what is
done**, **what was decided that differs from PLAN.md**, and **what is blocked
on Peter**.

---

## Setup still needed from Peter

| Item | Needed by | Status |
|---|---|---|
| `OPENROUTER_API_KEY` | Phase 2 | ✅ configured in local `.env` (never printed or committed) |
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

### A8 — Enrichment is a durable post-insert gate
*Phase 2. Reason: restart safety and an auditable Phase 1 → Phase 2 boundary.*

PLAN.md describes `classifySuitability()` as running before insert. In the
implemented pipeline, deterministic ingestion always persists a complete source
record as `status='pending'`; an exclusive restart-safe Phase 2 job then
publishes it atomically as `active` or `rejected`. Changed upstream content
clears stale enrichment fields and returns the row to `pending`.

This preserves every source decision, avoids holding a crawl transaction open
across provider calls, and lets a budget stop or worker restart resume from the
oldest unfinished row without repeating completed LLM work. Public recipe
queries default to `active`, so pending work never leaks into browse results.

### A9 — OpenRouter uses `max_tokens` with reasoning-safe output headroom
*Phase 2. Verified live on 2026-07-26.*

With `provider.require_parameters=true`, OpenRouter could not route
`max_completion_tokens` for `deepseek/deepseek-v4-flash`; the model capability
is exposed as `max_tokens`. After that correction, tiny JSON-shaped ceilings
still failed intermittently because DeepSeek reasoning tokens count against the
same output budget: live responses exhausted 180/1,024 tokens before emitting
complete JSON.

Requests now use deterministic temperature 0, 4,096 tokens for the compact
classification/derived-field/blurb tasks and 8,192 for extraction/semantic
mapping. Strict JSON Schema plus local Zod validation remains the contract, and
one independently budget-guarded repair remains the bounded safety net.

### A10 — Reddit is runtime-ready but live-disabled pending credentials
*Phase 2. Reddit credentials remain blocked by the setup issue above.*

The official OAuth client, listing/comment discovery, deterministic external
blog routing, JSON-LD/HTML/post extraction, image/ingredient/persistence path,
telemetry and budget hooks are all wired into the production scan runtime.
Database-backed tests exercise the enabled path with mocked Reddit/provider
boundaries. The canonical source row remains `enabled=false`, and disabled
startup never reads credentials.

PLAN.md's Phase 2 exit phrase “Reddit is reachable” is therefore amended to:
**the complete runtime is mock-verified and ready to enable; a live Reddit call
is deferred until credentials can be created.** This does not block the blog
backfill or Phase 2 completion.

### A11 — The LLM budget is a serialized UTC-day hard guard
*Phase 2. Reason: scan fallback and backlog enrichment use separate queues.*

Every billable provider attempt acquires a transaction-scoped Postgres advisory
lease, re-reads durable UTC-day spend, records provider-reported usage before
parsing, then releases the lease. This prevents concurrent HTML/Reddit fallback
and enrichment calls from racing past the cap. Malformed responses and repairs
are charged immediately, and scan finalization cannot overwrite an already
durable increment.

### A12 — Live structured-output compatibility and terminal ingredient leftovers
*Phase 2. Verified against the complete live backfill on 2026-07-27.*

OpenRouter accepts the selected model's strict JSON Schema support, but its
schema validator rejects JavaScript Unicode property regexes such as `\p{L}`.
The provider-facing schema therefore omits only those unsupported `pattern`
keywords; the original Zod schema still performs the stronger Unicode-aware
validation locally. Malformed success envelopes with no `choices` enter the
single guarded repair path instead of throwing a `TypeError`.

Semantic ingredient requests use 20-name batches, exact input/canonical enums,
deterministic normalization when an existing canonical is mislabeled `new`,
and an explicit 180-second request deadline. These rules were required by the
live provider: 40-name batches approached the reasoning/output cap, near-match
canonical names escaped prompt-only constraints, and the SDK's nominal timeout
did not stop several hung requests.

Rows that cannot safely parse into a normalized ingredient identity remain
renderable from `raw_text` with `ingredient_id = null`. Once every remaining
row has been inspected and is unparseable, that is a successful terminal
backfill condition rather than a retryable partial. The live exit retains 161
such compound/alternative lines intentionally.

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
- [x] **Phase 1 — Deterministic ingestion.** ✅ **COMPLETE.**
    - [x] Polite fetcher (robots.txt, crawl delay, conditional GET, backoff)
    - [x] RSS + sitemap discovery
    - [x] JSON-LD → Recipe extraction, 30 committed fixtures, coverage report
    - [x] Ingredient normalization (parse → match → alias writeback, stages 1–2)
    - [x] Insert path + dedupe on `source_url` + `content_hash`
    - [x] Image pipeline (fetch once, downscale ~800px, `recipe-images` volume)
    - [x] pg-boss wiring, cron + advisory lock, `scan_runs` telemetry
    - [x] `sources` seeded (8 approved blogs, all enabled — A6, A7)
    - [x] `/ops` page: last run, counts, cost, manual queue control
      *Exit verified from a clean stack: 425 real recipes, every row with a
      local image reference, 0 duplicate URLs, 0 tokens and $0 LLM cost.*
- [x] **Phase 2 — LLM enrichment.** ✅ **COMPLETE.**
    - [x] Direct stateless OpenRouter strict-output client + bounded repair
    - [x] Suitability gate, derived fields, blurbs and active/rejected publish
    - [x] Durable usage accounting, serialized UTC-day budget and restart-safe queue
    - [x] Guarded HTML fallback and production-ready Reddit runtime
    - [x] Semantic ingredient mapping with safe canonical/alias learning
    - [x] Live backfill and terminal unparseable-row audit
      *Exit verified live: 425 recipes → 235 active + 190 rejected + 0 pending;
      4,456/4,617 ingredient rows mapped, 161 intentionally unparseable rows
      retained with renderable raw text; newest enrichment queue job completed
      successfully; total recorded LLM usage 1,364,931 input tokens + 568,637
      output tokens at $0.311476.*
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

Verification: the complete workspace has 421 passing tests (shared 35, db 19,
worker 367), all workspace typechecks pass, the fixture coverage report passes,
database-backed lifecycle tests pass, duplicate queue sends coalesce, and a
real worker startup/shutdown smoke test initialized pg-boss and cron then
released both cleanly with bootstrap crawling disabled. Interrupted jobs
finalize their `scan_runs` telemetry before propagating the abort for retry.

### 2026-07-26 — Phase 1, operations surface
Added a dynamic, server-rendered `/ops` control room with recipe/source totals,
an aggregate of each enabled source's latest state, checkpoint-aware per-source
health, error detail, recent scan history, durations and LLM cost. Sitemap-only
sources are labeled explicitly rather than appearing to lack a feed validator.

The accessible "Scan now" control POSTs to a lightweight web-side pg-boss
producer and returns immediately; the worker remains the only scan executor.
The shared queue's exclusive policy coalesces repeated manual requests. A live
endpoint probe returned queued then coalesced, and the responsive page was
checked at desktop and mobile widths with no page overflow or browser errors.
The production Next.js build and all workspace typechecks pass.

### 2026-07-26 — Phase 1 complete: clean live exit
Recreated the project database, image and dependency volumes, rebuilt all
services, and let the authorized deterministic bootstrap job finish across all
eight enabled sources. It found and inserted 425 recipes, skipped 18 fetched
pages with no Recipe node, and made zero LLM calls. All 425 recipe rows have a
local image reference backed by 421 unique WebP files (four source images are
legitimately shared), with zero duplicate source URLs.

Per-source initial results: Budget Bytes 7, Downshiftology 200, Love & Lemons 9,
Pinch of Yum 3, Serious Eats 193, Skinnytaste 7, The Kitchn 6. Serious Eats
completed successfully, validating the enabled-source decision. GypsyPlate's
two sitemap endpoints currently return HTTP 403, so it contributed zero rows;
the run is visibly `partial`, retains a null checkpoint, and remains eligible
for retry instead of silently advancing.

The live run exposed and fixed two final lifecycle details: interrupted jobs
finalize telemetry before pg-boss retry, and an empty discovery with warnings
cannot advance a source checkpoint. A follow-up manual scan took 23 seconds,
inserted zero duplicates, used conditional/incremental discovery for completed
sources, and proved GypsyPlate's failed checkpoint remains null. Final checks:
421 workspace tests pass, all typechecks pass, the production web build passes,
Compose reports db/web healthy and worker running, `/api/health` reports Phase
1 with 425 recipes, and `/ops` plus `/api/recipes` return HTTP 200.

### 2026-07-27 — Phase 2 complete: live enrichment and semantic mapping exit
Implemented the complete direct, stateless Phase 2 pipeline in `8202b4c` and
the live-provider hardening in `3f6e67d`: strict OpenRouter JSON Schema calls,
one independently budgeted repair, durable per-response accounting, an
exclusive restart-safe enrichment queue, suitability/derived-field/blurb
tasks, guarded HTML fallback, a production-wired but credential-disabled
Reddit adapter, semantic ingredient mapping and the Phase 2 operations/API
surface.

The live recipe pass classified all 425 Phase 1 rows. Final state is 235
`active`, 190 `rejected` and zero `pending`; every active row has a blurb and
category, every rejected row has an audit reason, and source URLs remain
unique. Public recipe queries default to active rows and do not expose raw
source JSON/content hashes.

The semantic pass mapped 4,456 of 4,617 ingredient rows, growing the vocabulary
from 117 to 774 canonical ingredients and from 117 to 1,727 aliases. The 161
remaining rows are compound quantities, alternatives or serving annotations
that do not admit a safe normalized identity; every one retains non-empty
`raw_text` and remains renderable. A final zero-token queue run inspected that
entire remainder and completed successfully with
`unparseableRows=remainingRows=161`.

Live provider execution exposed and fixed issues that mocks could not: the
required `max_tokens` spelling, reasoning-safe output headroom, malformed
success envelopes, unsupported Unicode regexes in the wire schema, prompt-only
canonical near-matches, redundant `new`/`existing` mistakes and SDK requests
that exceeded the nominal timeout. A12 records the durable rules so they are
not re-learned.

Final recorded LLM usage across probes, interrupted audit runs, the recipe
backfill and ingredient mapping is 1,364,931 input tokens, 568,637 output
tokens and **$0.311476**. The $1 UTC-day hard guard was never approached.
Verification after the terminal-status fix: **524 tests passing** (shared 45,
db 20, worker 459), all workspace typechecks clean, production Next.js build
passing, Compose db/web healthy with worker running, `/api/health` reporting
Phase 2, and `/ops` plus `/api/recipes` returning HTTP 200.

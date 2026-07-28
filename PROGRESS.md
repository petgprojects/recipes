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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_SECRET` | Phase 4 | ✅ configured in local `.env` (never printed or committed) |

Google OAuth redirects to the exact callback
`http://localhost:3000/api/auth/callback/google`, and Peter's email is an
allowed test user. All three Phase 4 secrets are now in the local `.env`, and a
real end-to-end Google sign-in has been driven through the live app.

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

### A13 — The "N new recipes" pill diffs ids, not `?since=`
*Phase 3. Reason: `last_seen_at` answers a different question than the pill asks.*

PLAN.md §5 specifies polling `GET /api/recipes?since=<ts>` and surfacing the
result as a pill. The parameter exists and works, but anchoring the pill to it
would be wrong in both directions:

- **False positives.** `storage/recipes.ts` bumps `last_seen_at` on every
  recipe a re-crawl re-observes, unchanged or not. The morning after a scan the
  pill would announce all 235 recipes as new.
- **False negatives.** Phase 2 publishes a `pending` row as `active` without
  touching `last_seen_at` (amendment A8), so a genuinely new recipe can become
  browsable with a timestamp already behind the client's watermark and never
  appear.

The planner therefore polls the browse list and counts **recipe ids it has
never rendered**. That is correct under both behaviours, needs no new column,
and keeps the reader's list stable until they ask for the new rows — which was
the actual point of the pill. `?since=` remains supported and documented for
any consumer asking "what changed since X".

### A14 — Three deliberate deviations in the UI port
*Phase 3.*

1. **The artifact's CSS is no longer byte-identical.** Its reset,
   `.mp button { … border: none; background: none }`, scores (0,1,1) and so beat
   every single-class rule in the same file: `.mp-btn`'s outline, `.mp-btn-fill`'s
   green, `.mp-tab`'s pill and `.mp-mini`'s background all lost to it, and the
   artifact rendered its buttons as flat text. The selector is now
   `:where(.mp) button`, which contributes no specificity and restores the
   design the rest of the file describes. Everything else above the Phase 3
   marker in `artifact.css` is unchanged.
2. **`next/image` runs `unoptimized`.** The worker already fetches each photo
   once, auto-orients it, fits it inside 800×800 and writes one WebP frame, so
   the optimizer would re-encode an already-optimal file — and would require
   `sharp` in the web image, which nothing else there needs. Lazy loading,
   intrinsic sizing and the reserved aspect box still come from `next/image`.
3. **No blurhash placeholder.** `recipes.image_blurhash` is populated for zero
   of 425 rows — Phase 1 never computed one. Rather than add an encode
   dependency to the worker and a decode dependency to the browser for a
   local-network app, cards reserve the 16:9 box in `--blush` and fill it when
   the image lands. The column stays for whenever that changes.

### A15 — The `dev@local` fallback is opt-in, not automatic
*Phase 4.*

PLAN.md §4 says `getCurrentUser()` "returns [`dev@local`] when
`NODE_ENV !== 'production'` and no session is present". It is implemented, but
behind `DEV_AUTH_FALLBACK=true`, **default off**.

The reason the plan gave for the fallback was scaffolding: it let Phases 1–3
exercise the `user_id` columns "before Auth.js exists". Phase 4 is Auth.js
existing, and two of Phase 4's own requirements contradict an automatic
fallback — the planner must keep working *signed out* (auth adds persistence,
it does not become a gate), and `localStorage` picks must migrate on *first
sign-in*. If every development request is silently `dev@local`, there is no
signed-out state and no first sign-in, so neither is reachable in the only
environment that exists. Both were verified live only because the fallback
defaults off.

The capability is preserved rather than deleted: one env var restores the
documented behaviour, and it is ignored outright when `NODE_ENV=production`, so
production still means "no session, no user".

### A16 — `AUTH_URL` must be pinned, because `0.0.0.0` fails at the last hop
*Phase 4. Found by driving a real Google sign-in; not caught by any test.*

The container runs `next dev --hostname 0.0.0.0` so it is reachable from the
host. That makes `request.url` inside a route handler read
`http://0.0.0.0:3000`, and Auth.js derives its base URL from it — so the
`redirect_uri` it sends in the **token exchange** becomes
`http://0.0.0.0:3000/api/auth/callback/google`.

Google allows loopback only as `localhost` or `127.0.0.1`. It rejects
`0.0.0.0` with `invalid_request` and the message *"this app doesn't comply with
Google's OAuth 2.0 policy for keeping apps secure"* — which reads like an app
registration or verification problem and is not one.

The failure is nastily late. The *authorize* step is built in a server-action
context where the host is correct, so the consent screen appears with a
perfectly good `redirect_uri=http://localhost:3000/...`; only the final
server-to-server exchange uses the wrong origin. Everything looks right until
the last hop, and the user lands on a generic `?error=Configuration` page.

`docker-compose.yml` therefore sets `AUTH_URL` from `NEXT_PUBLIC_APP_URL`, and
`AUTH_URL` is declared in `packages/shared/src/env.ts` so a bad value fails at
boot with the rest. **`trustHost: true` alone does not fix this** — it governs
whether forwarded host headers are believed, not what `request.url` reports.

### A17 — Planner state is server-authoritative, and a migration only adds
*Phase 4.*

Three rules the code depends on, recorded because each has a plausible-looking
wrong version:

1. **Every mutating `/api/planner/*` endpoint returns the whole state**, not the
   row it touched. Each response is then a complete correction of the client
   cache, so a mutation that raced another tab self-heals on the next
   round-trip. This is also why the four TanStack mutations share one
   `scope: { id: 'planner-state' }`: without it they run concurrently, and a
   slow early response overwriting a fast later one would resurrect stale state.
2. **The first-sign-in migration is additive and idempotent.** On a conflict the
   *account* wins — a recipe saved at two batches is not reset to the one batch
   an anonymous session in this browser happened to leave. It can only add, so
   re-running is safe, which matters because the "already migrated" marker lives
   in the same `localStorage` the migration reads.
3. **A pick whose recipe no longer exists is skipped, not fatal.**
   `saved_recipes.recipe_id` is a foreign key, so one stale id would otherwise
   abort the whole insert and lose every other pick with it.

Signed-in edits deliberately do **not** write to `localStorage`. The browser's
anonymous state is left exactly as it was, so signing out returns to it rather
than to a half-copy of the account.

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
- [x] **Phase 3 — UI port.** ✅ **COMPLETE.**
    - [x] Shared display formatting + grocery aggregation (`@recipes/shared`)
    - [x] Browse/detail queries, `/api/recipes/:id`, cached-image route
    - [x] `RecipeCard`, `RecipeSheet`, `PicksList`, `GroceryReceipt`, planner shell
    - [x] Photos with a deliberate text-only fallback; optional ratings
    - [x] TanStack Query polling + focus refetch + "N new recipes" pill (A13)
    - [x] `localStorage` picks and check-offs, shaped like the Phase 4 tables
    - [x] `meal-prep-planner.jsx` retired
      *Exit verified live: 235 active recipes rendered from Postgres with local
      photos, picks → grocery receipt → check-off round-trip persisting across a
      reload, the pill counting exactly one probe row and clearing on click, no
      horizontal overflow at 390px or 1280px, and no page or console errors.*
- [x] **Phase 4 — Auth.** ✅ **COMPLETE.**
    - [x] Auth.js v5 + Google provider + Drizzle adapter over the existing
          `users`/`accounts`/`sessions`/`verification_tokens` tables (no migration)
    - [x] `AUTH_URL` pinned so the token-exchange `redirect_uri` is never
          `0.0.0.0` (A16)
    - [x] `getCurrentUser()` with the opt-in `dev@local` fallback (A15)
    - [x] `saved_recipes` / `grocery_checks` served by `/api/planner{,/saved,/checks,/import}`
    - [x] Dual-mode planner store: `localStorage` signed out, optimistic
          server mutations signed in — auth is not a gate
    - [x] One-time first-sign-in migration, additive and idempotent (A17)
    - [x] Sign-in/sign-out via server actions in the masthead eyebrow
      *Exit verified live against the real Google client: signed-out picks and
      check-offs persisting in `localStorage` across a reload; a real Google
      sign-in creating the `users` + `accounts` rows; 2 picks and 2 ticked items
      migrating into the account on first sign-in with the notice shown; a third
      pick added while signed in surviving a reload; `localStorage` untouched by
      signed-in edits; sign-out returning to the browser's own 2 picks with
      `/api/planner` answering 401. Merge semantics, idempotence and the
      stale-recipe skip additionally exercised against a minted session.*
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

### 2026-07-27 — Phase 3 complete: the artifact, live
The planner now runs on real crawled data. `meal-prep-planner.jsx` is deleted;
its two lasting contributions — the ingredient seed and the CSS — were carried
forward in Phase 0 and this phase respectively.

**Where the logic went.** Display formatting (`fmtQty`/`fmtLine`/`fmtTime`, plus
`fmtKeeps` and `fmtRating` for the two nullable-column cases the artifact never
had) and the grocery aggregation live in `packages/shared`, not in a React
`useMemo`. That is where they can be tested — 27 new tests — and it is the seam
Phase 5 replaces with SQL without touching a component. The merge key is
already `grocery_checks.item_key`: canonical ingredient identity plus unit
*dimension*, so "1 lb chicken breast" and "8 oz boneless skinless chicken
breasts" become one line with one checkbox while `2 cans` and `14 oz` stay two,
and an unmapped row keys on its own slugified text rather than colliding.

**What real data forced.** Aggregation prints the largest unit that keeps the
total at or above 1 (`2 tbsp + 1 cup` reads `1⅛ cup`, not `18 tbsp`); a line
with no parseable quantity folds into that ingredient's real line and marks the
total `+` instead of inventing a number or vanishing; the detail sheet prints a
mapped row as parsed amount + canonical name but an unmapped row as its whole
raw line, since the raw text already carries the quantity. Cards omit time,
servings, shelf life and rating individually when the source never published
them.

**Serving and polling.** `/api/images/:file` hands out the worker's cached WebP
behind an exact `sha256.webp` shape check, so no path outside the volume is
expressible; `/api/recipes/:id` carries steps and ingredient lines, which the
235-row browse feed deliberately does not. The browse page is server-rendered
from the same `listRecipes()` the API uses — identical JSON shape, so it can be
handed straight to TanStack Query as `initialData` — then polled every five
minutes and on window focus. Amendments A13 and A14 record the pill's id-diff,
the CSS specificity fix, `unoptimized` images and the absent blurhash.

**Verification.** 551 tests passing (shared 72, db 20, worker 459) with the
Compose database up, all four typechecks clean, production build clean, and no
server-only symbol reachable from the client bundle. Driven live in headless
Chrome: 235 cards with local photos, three saved picks producing a 29-line
receipt across eight aisles, a check-off surviving a reload, the batch
multiplier scaling servings, the detail sheet loading 16 ingredients and 4 steps
with its outbound attribution link and closing on Escape, an inserted probe row
raising exactly "1 new recipe — show it" and clearing on click (row removed
afterwards; the database is back to 425), every cached image blocked degrading
to the text-only card with zero broken frames, and no horizontal overflow at
390px or 1280px. `/ops` and its link back to the planner still work.

### 2026-07-27 — Phase 4 complete: multi-user, saves persist across devices

**What auth actually needed.** Nothing in the schema. `users`, `accounts`,
`sessions` and `verification_tokens` were shaped for the Auth.js adapter back in
Phase 0, so Phase 4 added two dependencies and zero migrations. The one snag was
a type, not a column: `users.email` is `citext` (PLAN.md §4, so `A@b.com` and
`a@b.com` cannot become two accounts), Drizzle types a `customType` as
`PgCustomColumn`, and the adapter's schema type only admits `PgVarchar | PgText`.
`citext` *is* text at runtime and every adapter query against it is a plain
equality, so the fix is one cast confined to that single expression rather than
loosening anything in the schema.

**Auth is optional at boot, on purpose.** The three Phase 4 secrets stay
phase-gated in `@recipes/shared/env`. `isAuthConfigured` reports whether they are
present; without them the provider list is empty, the sign-in control does not
render, and the planner runs exactly as it did in Phase 3. Calling `requireEnv()`
at module scope would have made importing `lib/auth.ts` a boot requirement and
taken the whole planner down with it — which is the opposite of "auth adds
persistence, it does not become a gate".

**The bug only a browser could find.** A real Google sign-in failed at the very
last hop with `?error=Configuration`, from Google, saying the app "doesn't
comply with Google's OAuth 2.0 policy for keeping apps secure" — a message that
reads like an app-registration problem and is not one. `next dev --hostname
0.0.0.0` makes `request.url` read `http://0.0.0.0:3000`, so the token-exchange
`redirect_uri` became `http://0.0.0.0:3000/...`, and Google allows loopback only
as `localhost` or `127.0.0.1`. The authorize step is built in a server-action
context where the host is right, so the consent screen looks perfect and only
the final server-to-server call is wrong. `AUTH_URL` is now pinned in
docker-compose; `trustHost` alone does not fix it. Amendment A16.

**The second bug only a browser could find.** After signing in, the migration
ran, the account was correct in Postgres, the marker was written — and the UI
showed nothing. `plannerKeys.state()` returned a fresh array per call, so it was
an unstable `useEffect` dependency; the effect re-ran every render, its cleanup
set `cancelled = true`, and the in-flight import's `.then` bailed out *after*
writing the "already migrated" marker but *before* updating the cache. Worst
shape of failure available: durably marked done, visibly undone, and
self-suppressing on retry. The key is now a module constant, the effect depends
on `user?.id`, and the cleanup is gone — an unmount must not abandon an import
whose marker is written on resolve.

**Where the logic went.** Shapes, wire schemas and merge rules are in
`@recipes/shared/planner` (13 new tests) because the API routes and the client
both have to agree with them; the SQL is in `apps/web/src/lib/planner.ts`, the
same split as `grocery.ts` ↔ `lib/recipes.ts`. The store keeps its Phase 3
interface and swaps backends underneath, so the components were untouched apart
from receiving `user`. Amendment A17 records the three rules that have plausible
wrong versions: whole-state responses, additive-and-idempotent migration with
the account winning conflicts, and a stale recipe id skipping rather than
aborting the batch.

**Verification.** 564 tests passing (shared 85, db 20, worker 459) with the
Compose database up, all four typechecks clean, production build clean, and the
three Phase 4 secrets confirmed absent from every file in the client bundle.
Driven live in Chrome against the real Google client: signed-out picks and
check-offs persisting in `localStorage` across a reload; a real sign-in creating
the `users` and `accounts` rows; 2 picks and 2 ticked items migrating on first
sign-in with "Moved 2 picks and 2 ticked items from this browser into your
account"; a reload showing no second migration; a third pick added while signed
in surviving a reload; `localStorage` still holding its own 2 picks untouched by
signed-in edits; sign-out returning to those 2 with `/api/planner` answering
401. Merge semantics, idempotence, the stale-recipe skip and both
`DEV_AUTH_FALLBACK` states were exercised against a minted session and a
throwaway second instance. All probe rows removed; the database is back to 425
recipes, 235 active, 190 rejected, 0 pending, with no `saved_recipes` or
`grocery_checks` rows.

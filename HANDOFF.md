# Session Handoff

**Read this first, then `PROGRESS.md`, then `PLAN.md`.**
Written 2026-07-26 at the end of session 1. Feed this to a new session to resume.

`PLAN.md` is the original design doc and is deliberately left unedited.
`PROGRESS.md` is the live checkpoint log — its **Amendments** section overrides
PLAN.md wherever the two disagree, and its **Phase checklist** is the source of
truth for what is done. This file is the orientation layer that neither covers.

---

## Where things stand

| Phase | State |
|---|---|
| 0 — Scaffold | ✅ done, verified from clean, committed `f138173` |
| 1 — Deterministic ingestion | ◐ **nearly done** — `/ops` + live exit validation remain |
| 2–7 | not started |

Six commits are on `main` through the storage stage; scan orchestration is the
current checkpoint. No remote is configured.

**Phase 1 remaining** (checklist in `PROGRESS.md`): the `/ops` page and clean
live exit validation. Ingredient normalization, transactional recipe
persistence, image caching, source seeding, scanner library, pg-boss/cron and
`scan_runs` telemetry are done and tested.

Everything currently passes: `corepack pnpm typecheck` clean across 4 projects,
`corepack pnpm test` → **419 passing** (shared 35, db 19, worker 365).

---

## Source decisions resolved

Peter resolved both on 2026-07-26:

1. **Serious Eats is enabled.** Peter confirmed permission and noted that the
   crawl/extraction path is deterministic; later LLM analysis is separate.
2. **Classpop is dropped entirely.** It is absent from the canonical source
   config, seed, capture tooling, coverage report and fixture corpus.

## Credentials outstanding

`PROGRESS.md` has the live table. Summary: **OpenRouter key** needed before
Phase 2 can run against anything real (the code can be built and tested against
mocks without it). **Reddit** credentials are blocked on a reCAPTCHA failure at
reddit.com/prefs/apps — diagnosis and fixes are in `PROGRESS.md`; Reddit is one
source adapter and blocks nothing. **Google OAuth** client and test user are
configured with the exact redirect
`http://localhost:3000/api/auth/callback/google`; the client ID/secret and
`AUTH_SECRET` still need to be copied into `.env` before Phase 4.

---

## How Peter wants this run

- **Use synchronous subagents** for implementation work, to keep the main
  context clean. He asked for this explicitly. Not agent teams unless there is a
  real case for them. Give each agent a tight scope, tell it what *not* to
  touch, and make it verify before reporting.
- **Verify subagent claims independently.** Two of three agents so far reported
  something worth double-checking, and one silently fixed a real bug in a
  package it was told not to modify (correctly, as it turned out — see A4).
  Re-run the tests and the actual exit criterion yourself.
- **One commit (or several) per stage**, so he can checkpoint through the build.
- **Keep `PROGRESS.md` current** — it is the durable record he asked for, and
  explicitly not the assistant memory directory.
- He describes himself as not confident with infra/auth setup. Give numbered,
  literal, click-by-click instructions for anything he has to do himself, and
  say which exact string goes where.

---

## Environment facts that will trip you up

- **`pnpm` is NOT on PATH.** Use `corepack pnpm <cmd>` everywhere. `corepack
  enable pnpm` fails with EACCES on `/usr/local/bin`; it needs sudo and is not
  worth it since Docker is the real dev loop. All root scripts already use
  `corepack pnpm`.
- **Workspace packages have no build step.** `packages/shared` and
  `packages/db` export raw `.ts` via their `exports` field; `apps/web` handles
  them with `transpilePackages`. Don't add a build pipeline.
- **After any `package.json` change**, the compose anonymous `node_modules`
  volumes are stale: `docker compose down -v && docker compose up --build`.
- `@recipes/shared/env` is **server-only** and deliberately not in the barrel
  export — keep it out of client bundles.
- `docker compose up` may currently be running from session 1; `docker compose
  ps` to check, `docker compose down` to stop.

### Import specifiers

```ts
import { db, recipes, eq, desc } from '@recipes/db';        // opens a pool
import { recipes } from '@recipes/db/schema';               // side-effect free
import { AISLES, convert } from '@recipes/shared';          // pure, client-safe
import { env, requireEnv } from '@recipes/shared/env';      // SERVER ONLY
```

### The scanner API Phase 1 part 2 wires up

```ts
createFetcher(opts?): PoliteFetcher
fetcher.fetch(url, {etag?, lastModified?, crawlDelayMs?})
  : Promise<FetchOk | FetchNotModified | FetchError>
discoverSource(fetcher, {feedUrl?, baseUrl}, {since?, limit?, feedEtag?})
  : Promise<DiscoverResult>
extractRecipeFromHtml(html, pageUrl?): ExtractionResult  // {found, recipe, missing[], stats}
toRecipeDraft(recipe, sourceUrl, {publishedAt?, title?}): RecipeDraft | null
```

`toRecipeDraft` returns `null` when there is no title or no ingredients, and
deliberately omits `blurb` / `keeps` / `tags` / `category` — those are Phase 2's
job and are *expected* to be null after Phase 1.

---

## What the live probe taught us (don't re-learn this)

Detail in `apps/worker/test/fixtures/COVERAGE.md`. The load-bearing bits:

- **The sitemap fallback is not optional.** 2 of 8 sources have no usable RSS.
- **~1/3 of feed items are round-up posts** with no recipe. Absence of a Recipe
  node is a free zero-token filter — count it *separately* from Phase 2 gate
  rejections in `scan_runs` or the telemetry becomes unreadable.
- **Ratings are often missing** (9/21 pages; The Kitchn never publishes them).
  The UI must treat rating as genuinely optional.
- **`author` is often a bare `@id`** pointing at a sibling `Person` node.
  Already handled, but note `raw_jsonld` alone cannot re-derive it later.
- Fixtures are ~12 MB of real HTML, committed on purpose so CI never hits the
  network. Don't "clean them up."

---

## Verified facts worth not re-deriving

- `deepseek/deepseek-v4-flash` **exists on OpenRouter** at exactly PLAN.md's
  assumed pricing ($0.14/M in, $0.28/M out, 1M context, 393K max output).
  Checked live against `https://openrouter.ai/api/v1/models`.
- It reports **`structured_outputs`** in `supported_parameters`, so
  `response_format: {type:"json_schema", strict:true}` is enforced server-side.
  This **resolves PLAN.md §2's "one wrinkle"** — Zod stays as the TS boundary,
  but the repair-retry becomes a safety net, not the expected path, and the
  `emit_recipe` tool-calling workaround in §2 should **not** be built (A2).
- Cached input is $0.028/M — an 80% discount, not the 98% PLAN.md claimed.
  Immaterial at this scale (~$3/mo → ~$3.50/mo).
- Toolchain: Node 24.13, Docker 29.2, Compose v5.0.2.

---

## Suggested first move next session

Resume Phase 1 part 2. Ingredient canonicalization is the substantial piece —
PLAN.md §4 calls it "the real work," and it is what makes requirement 3 (one
grocery list from many recipes) feel magic or broken. The three-stage matcher is
specified there; stages 1–2 are deterministic and need no LLM, so all of Phase 1
part 2 can be built and tested with no API key. Stage 3 is a Phase 2 concern.

The 117 seeded ingredients each already have a self-alias row in
`ingredient_aliases`, so exact-match hits work from the first run.

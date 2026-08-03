# Recipe Planner — Build Plan

Turning `meal-prep-planner.jsx` (a static 24-recipe artifact) into a live, self-hosted service.

Source requirements: [`reqs.md`](../reqs.md). The original `meal-prep-planner.jsx`
draft was retired in Phase 3 and is no longer in the repository.

---

## 1. The core insight that shapes everything

**Almost every recipe site already publishes its recipes as structured data.** Budget Bytes, Pinch of Yum, Downshiftology, Serious Eats, NYT Cooking and basically anything running a WordPress recipe plugin emit [schema.org/Recipe](https://schema.org/Recipe) JSON-LD in the page head:

```json
{
  "@type": "Recipe",
  "name": "Spanish Chickpeas and Rice",
  "image": ["https://.../spanish-chickpeas.jpg"],
  "recipeYield": "6 servings",
  "totalTime": "PT35M",
  "recipeIngredient": ["1 Tbsp olive oil", "1 yellow onion, diced", ...],
  "recipeInstructions": [{"@type": "HowToStep", "text": "..."}],
  "aggregateRating": {"ratingValue": "4.8", "ratingCount": "24"}
}
```

That is the title, image, time, yield, ingredients, steps and rating — for free, deterministically, with zero tokens. Discovery is equally cheap: those sites all expose RSS feeds and sitemaps.

So the LLM should **not** be doing the bulk scraping. The pipeline is:

| Layer | Tool | Cost |
|---|---|---|
| Discovery — what's new? | RSS / sitemap / Reddit API | free |
| Extraction — the recipe | JSON-LD parse | free |
| Extraction fallback — no JSON-LD, or a Reddit post | DeepSeek V4 Flash, one call | ~$0.001/page |
| **Suitability gate — is this even meal prep?** | DeepSeek V4 Flash, one call, batched | ~$0.0001/recipe |
| **Derived fields — `keeps`, `tags`, `category`** | DeepSeek V4 Flash, one call | ~$0.0003/recipe |
| Normalization — ingredient → `{qty, unit, canonical_item, aisle}` | DeepSeek V4 Flash, one call, batched | ~$0.0005/recipe |
| Judgment — will *you* like it? | DeepSeek V4 Flash, one call, batched | ~$0.0002/recipe |

Two of those rows exist because **schema.org gives us less than the UI needs**:

- **Suitability gate.** Budget Bytes' RSS feed carries cocktails, desserts and single-serve breakfasts. Nothing about "it's a recipe" implies "it's meal prep." Without a cheap classifier before insert, the database fills with junk that isn't obvious until you're staring at 400 rows. Gate on `{is_meal_prep: bool, reason}` and store rejects as `status='rejected'` rather than dropping them, so the filter's mistakes stay auditable.
- **Derived fields.** The card design leans on `keeps` ("4 days · 3 months frozen"), `tags` ("Sheet pan", "One cleanup") and `category`. Schema.org has **no shelf-life field at all**, and its `recipeCategory` is free-form rather than our six fixed buckets. These must be inferred at ingest against a controlled vocabulary (see §4), or every scraped recipe renders visibly plainer than the design intends.

Every LLM step is a **single stateless completion**. There is no agent loop anywhere in this system — see §2. It also degrades gracefully: if the LLM budget is exhausted or DeepSeek is down, JSON-LD ingestion keeps working on its own.

**Estimated running cost: under $5/month.** DeepSeek V4 Flash is $0.14/M input, $0.28/M output, with cache-hit input at $0.0028/M (a 98% discount, which matters a lot since our system prompts are identical across thousands of calls). At ~3k in / 800 out per recipe that's ~$0.0007 each; 150 recipes/day lands at roughly $3/month.

---

## 2. No agent harness — direct API calls

**An earlier draft of this plan routed the messy cases through the [pi](https://github.com/earendil-works/pi) harness. That was over-engineering, and the design is better without it.**

Walk through every job the LLM actually does here:

| Job | Input | Output | Loop? |
|---|---|---|---|
| Extract recipe from a page with no JSON-LD | page text | Recipe JSON | no |
| Extract recipe from a Reddit post | post + top comments | Recipe JSON | no |
| Parse ingredient lines | 20 raw strings | 20 `{qty, unit, name, note}` | no |
| Map unknown ingredient → canonical + aisle | one name + candidates | one decision | no |
| Write the blurb | recipe facts | one sentence | no |
| Score a recipe against taste profile | profile + recipe facts | `{score, reason}` | no |

Every one is `text in → structured JSON out`. Nothing needs to decide what to do next, call a tool, observe a result and re-plan — which is the only thing an agent loop buys you. **Direct `POST /chat/completions` against `https://api.deepseek.com`, OpenAI-compatible, `openai` npm client with `baseURL` swapped.**

What dropping the harness gains:

- **The prompt-injection problem largely evaporates.** The earlier draft needed a warning about not giving the agent `bash` and about egress allowlisting, because an agent with tools, fed untrusted scraped text, can be induced to *act*. A tool-less completion can't act on anything — worst case it returns bad data, which schema validation rejects. This is a real reduction in attack surface, not just less code.
- **Cheaper.** Agent loops resend a growing transcript every turn. One call is one call.
- **Testable.** `extractRecipe(html) → Recipe` is a pure function you can pin against fixture pages in CI. An agent loop isn't.
- **Less to build and ship:** no pi in the worker image, no `models.json`, no custom tool extension, no JSONL subprocess parsing.

### The one wrinkle: DeepSeek has JSON mode, not strict JSON Schema

Verified: DeepSeek supports `response_format: {"type": "json_object"}`, which guarantees **syntactically valid** JSON — but it does **not** support OpenAI's `json_schema` strict structured outputs on normal completions. So the shape isn't enforced server-side. Two consequences:

1. The literal string `"json"` must appear in the prompt or `response_format` is ignored — an easy silent failure. Include a schema example in the system prompt too, or the model invents its own keys.
2. Validate client-side with **Zod**, and on failure do **one repair retry** feeding back the validation error. That is the only "loop" in the system: a bounded retry in ~20 lines, not a harness.

> **Alternative worth prototyping:** DeepSeek *does* support strict JSON Schema for **tool calling** (beta), where the schema constrains function arguments. Defining a single `emit_recipe` tool and forcing one call to it gets schema enforcement server-side — still a single request with no loop, just using the tool-calling channel as a typed output port. Worth an afternoon in Phase 2 to see whether it removes the repair-retry path entirely.

### Prompt caching is now the main cost lever

Cache-hit input is $0.0028/M against $0.14/M standard — 98% off — but only for an **identical prefix, positioned first**. So structure every prompt as:

```
[ static system prompt: role + JSON schema + few-shot examples ]  ← cached, ~2k tokens
[ variable: this page's text ]                                    ← paid at full rate
```

Keep the static block byte-identical across calls and never interpolate anything into it. Done right, the schema and examples cost effectively nothing after the first call of each run.

### If an agent ever earns its place

One case would genuinely need a loop: **open-ended source discovery** — "go explore the web and find me recipe sites I'm not already following," where each result determines the next query. That's speculative Phase 8 territory. If it ever happens, add it then as an isolated component; nothing in this design blocks it.

**DeepSeek V4 Flash** remains the right model: `deepseek-v4-flash`, 1M context, 384K max output, $0.14/M in, $0.28/M out. It's explicitly positioned as the extraction/classification/high-throughput tier, which is exactly this workload.

---

## 3. Architecture

```
                        ┌───────────────────────────────────┐
   docker compose up →  │                                   │
                        │  web        Next.js (UI + API)    │ :3000
                        │  worker     scanner + cron + jobs │
                        │  db         Postgres 16 + pgvector│ :5432
                        │  (volumes: pgdata, recipe-images)  │
                        └───────────────────────────────────┘
```

**Three compose services, one `docker compose up`.** Postgres in its own container gets the official image's tuning, backups and upgrade path for free; the worker is the crawl/LLM path and wants to restart independently of the web app; and it's still one command.

The worker needs a small amount of orchestration — concurrency limits, retry with backoff, the daily budget cap, token accounting. That's a **job queue, not an agent**: use [`pg-boss`](https://github.com/timgit/pg-boss), which runs on the Postgres already in the stack and adds no new service.

**Stack:**

- **Next.js (App Router)** for web — gives API routes, server components, Auth.js integration and `next/image` (which handles the recipe photo pipeline: resizing, AVIF/WebP, lazy loading) in one deployable. The existing artifact's CSS ports over essentially unchanged; the component splits into `RecipeCard`, `RecipeSheet`, `GroceryReceipt`, `PicksList`.
- **Postgres 16** via `pgvector/pgvector:pg16` — we don't need vectors on day one, but having the extension available avoids a migration later when personalization gets more serious. Also enable `pg_trgm` (fuzzy ingredient matching) and `citext`.
- **Drizzle ORM** for schema + migrations — TypeScript-native, generates SQL migrations you can read, no codegen daemon.
- **node-cron in the worker** for scheduling, with a Postgres advisory lock so a restart mid-scan can't double-run.
- **Vitest** for tests, scoped to the logic where silent wrongness is likely (see §5).

### Repo layout — pnpm monorepo

```
recipes/
├── apps/
│   ├── web/          Next.js — UI + API routes
│   └── worker/       scanner, cron, job handlers, llm/
├── packages/
│   ├── db/           Drizzle schema + migrations + client   ← shared
│   └── shared/       zod schemas, vocabularies, unit conversion, types
├── docker-compose.yml
├── .env.example
└── PLAN.md
```

`packages/db` is the single definition of the schema, imported by both apps — that's the main reason for the monorepo. `packages/shared` holds anything both the extractor and the UI must agree on: the category/tag/aspect vocabularies, the Zod recipe schema, unit-conversion tables.

### Dev workflow and secrets

- **`docker compose up`** brings up all three services with bind-mounts and hot reload — that's the primary dev loop *and* the "runnable entirely via docker" deliverable. A `compose.prod.yml` overlay does real builds with no mounts.
- **Local-only alternative:** `docker compose up db` plus `pnpm dev` if you'd rather run Node natively.
- **Secrets** live in a git-ignored `.env` at the repo root, consumed by compose. A committed **`.env.example`** lists every variable with dummy values: `DATABASE_URL`, `DEEPSEEK_API_KEY`, `REDDIT_CLIENT_ID/SECRET/USER_AGENT`, `GOOGLE_CLIENT_ID/SECRET`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `LLM_DAILY_BUDGET_USD`. The app fails fast at boot on a missing required var (Zod-validated env module in `packages/shared`) rather than throwing at 3am mid-scan.

---

## 4. Data model

```sql
-- ── sources & provenance ────────────────────────────────────
sources            id, name, kind(blog|reddit|social), base_url, feed_url,
                   enabled, crawl_delay_s, robots_checked_at, last_scanned_at

recipes            id, source_id → sources, source_url UNIQUE,   -- dedupe key
                   content_hash,                                 -- detect edits
                   title, slug,
                   blurb,               -- OUR text, LLM-written (see §7)
                   total_minutes, active_minutes, servings,
                   keeps_days, freezer_months,
                   category, tags text[],
                   image_url, image_local_path, image_w, image_h, image_blurhash,
                   author, source_rating, source_rating_count,
                   instructions jsonb,  -- ordered steps
                   raw_jsonld jsonb,    -- keep it; lets us re-derive without re-crawling
                   status(pending|active|rejected),
                   published_at, first_seen_at, last_seen_at

-- ── the hard part: ingredient canonicalization ──────────────
ingredients        id, name UNIQUE, aisle, default_unit, density_g_per_ml
ingredient_aliases id, ingredient_id → ingredients, alias UNIQUE
recipe_ingredients recipe_id, position, raw_text,
                   ingredient_id NULL,  -- NULL = unmapped, goes to review queue
                   qty, unit, note, optional

-- ── users ───────────────────────────────────────────────────
users              id, email citext UNIQUE, name, avatar_url, created_at
accounts           user_id, provider, provider_account_id, ...   -- Auth.js schema
sessions           ...

saved_recipes      PK(user_id, recipe_id), batches DEFAULT 1, saved_at
grocery_checks     PK(user_id, item_key), checked_at
cook_logs          id, user_id, recipe_id, rating 1-5,
                   aspects text[],      -- fixed vocab, see Phase 6 in §5
                   notes, cooked_at

-- ── personalization & ops ───────────────────────────────────
user_preferences   user_id, profile jsonb, hard_rules jsonb, updated_at
recipe_scores      PK(user_id, recipe_id), score, reason, scored_at
scan_runs          id, source_id, started_at, finished_at, status,
                   found, new, tokens_in, tokens_out, cost_usd, error
```

**`recipes.source_url` is the dedupe key** and `content_hash` catches upstream edits, so a daily re-scan is idempotent — re-seeing a recipe bumps `last_seen_at` and nothing else. Every recipe in the system arrives from a crawl, so this is always a real URL — there is no seed data to special-case.

**`recipe_ingredients.ingredient_id` is nullable on purpose.** An unmapped ingredient still renders (we have `raw_text`) and still shows on the grocery list under a fallback aisle; it just doesn't merge with anything. Failure is degraded, not broken.

**`grocery_checks.item_key` is `{ingredient_id}:{unit_dimension}`** — e.g. `4f2a:mass`. Not the artifact's `{name}|{unit}`, because canonicalization means "chicken breast" in lb and in oz are one shopping line and must share one checkbox. Unmapped ingredients fall back to `raw:{slugified_raw_text}`.

**Controlled vocabularies live in code, not tables** (`packages/shared/vocab.ts`): the six categories, the tag list, the aisle list and the rating-aspect list. They're referenced by extraction prompts, DB check constraints and UI filter chips, and all three must agree — a TS constant with a Drizzle `pgEnum` derived from it keeps them in lockstep, and a vocabulary change becomes a reviewable diff plus a migration.

**A `dev@local` user is seeded in development** so Phases 1–3 can exercise the `user_id` columns before Auth.js exists. `getCurrentUser()` returns it when `NODE_ENV !== 'production'` and no session is present; in production, no session means no user. This keeps every query multi-user-shaped from day one without blocking on auth.

### Why ingredient canonicalization is the real work

Requirement 3 — one grocery list from many recipes — is where this app either feels magic or feels broken. "chicken breast", "boneless skinless chicken breasts", and "2 lbs chicken breast, cubed" must collapse into one line. The current artifact sidesteps this by hand-authoring `{item, qty, unit, aisle}` for all 24 recipes. Real scraped data won't be that kind.

Three-stage matcher, cheapest first:

1. **Parse** the raw line → `{qty, unit, name, note}`. Try a deterministic parser first; fall back to DeepSeek structured output, batched ~20 lines per call.
2. **Match** `name` against `ingredient_aliases` — exact, then `pg_trgm` similarity above a threshold.
3. **Decide** only on a miss: ask DeepSeek "is this an existing canonical ingredient, or a new one? if new, which aisle?" — then **write the result back to `ingredient_aliases`**.

Stage 3 is self-extinguishing: every LLM call permanently teaches the alias table, so the miss rate decays toward zero and steady-state cost approaches free. Seed the canonical table with the ~120 ingredients already in the artifact — they're clean, hand-classified, and cover the common cases.

Unit merging only happens **within a dimension** (tbsp↔cup↔ml, oz↔lb↔g). Never merge `2 cans` with `14 oz`; show them as separate lines on the same item rather than inventing a conversion.

---

## 5. Phases

Each phase ends somewhere you could stop and still have a working thing.

> **Ordering note.** There is no seeded recipe data — every recipe comes from a crawl. So ingestion is built *before* the UI, and the UI is developed against real scraped rows from its first commit. That ordering is better regardless: it surfaces sparse and awkward real-world data while the components are still cheap to change, instead of after they've been built around 24 immaculate hand-authored records.

### Phase 0 — Scaffold *(foundation)*
- pnpm monorepo per §3; `docker-compose.yml` with `db`, `web`, `worker` + named volumes; `.env.example`.
- `packages/db`: Drizzle schema + first migration; extensions `pgvector`, `pg_trgm`, `citext`.
- `packages/shared`: vocabularies, Zod schemas, Zod-validated env module, unit-conversion table.
- **Seed the ~120 canonical ingredients** lifted from `meal-prep-planner.jsx` — hand-classified `{name, aisle}` pairs that give the matcher in §4 a real head start on day one. This is the one piece of the artifact worth keeping as data.
- Seed `dev@local`; `GET /api/health`; `GET /api/recipes` (returns `[]`, and that's correct).
- *Tests:* unit-conversion and aisle-vocabulary round-trips.

✅ **Exit: `docker compose up` → migrated schema, seeded ingredients, health check green.**

### Phase 1 — Deterministic ingestion
- `sources` seeded with the five sites from the artifact + a few more.
- Fetcher: robots.txt honored, real User-Agent with contact URL, per-source crawl delay, conditional GETs (ETag/If-Modified-Since), retry with backoff.
- RSS/sitemap discovery → JSON-LD extraction → ingredient normalization (§4) → insert.
- **Image pipeline:** fetch once, downscale to ~800px, store in the `recipe-images` volume, keep source URL for attribution.
- pg-boss wiring, `scan_runs` telemetry, `/ops` page showing last run, counts, cost.
- *Tests:* JSON-LD extraction against saved fixture pages from each source; ingredient parsing and merging; the aggregation query. **This is the highest-value test surface in the project** — it's where wrongness is silent.

✅ **Exit: hundreds of real recipes in Postgres, with photos, zero LLM involvement.** Expect visible junk (cocktails, desserts) and null `keeps`/`tags`/`category` — Phase 2 fixes exactly that.

### Phase 2 — LLM enrichment layer
A thin `llm/` module — one `deepseek.ts` client (the `openai` package with `baseURL` swapped), one file per task, each a pure `input → validated output` function:

- `classifySuitability(recipe)` → `{is_meal_prep, reason}`. Runs before insert; failures land as `status='rejected'` with the reason kept, so you can audit what it threw away.
- `deriveFields(recipe)` → `{keeps_days, freezer_months, tags[], category}` against the controlled vocab in `packages/shared`.
- `extractRecipe(pageText)` — pages where JSON-LD is missing or malformed.
- `extractRecipeFromPost(post, comments)` — Reddit (`r/MealPrepSunday`, `r/EatCheapAndHealthy` via the official API). Posts linking out to a blog are handled deterministically: pull URLs from the post, fetch, try JSON-LD, fall back to `extractRecipe`. No agent needed for that hop.
- `writeBlurb(recipe)` — the punchy one-liner the artifact does so well ("Three pans, forty-five minutes, five lunches"). Ours, not scraped (§7).
- Shared plumbing: Zod schema per task, single repair retry, cached static prompt prefix (§2), per-call token/cost logging into `scan_runs`, daily budget cap that hard-stops the run.
- Backfill job to enrich everything Phase 1 already ingested.
- *Tests:* Zod validation and the repair path against recorded (including deliberately malformed) responses; extraction against fixture HTML. Mock the API — no live calls in CI.

✅ **Exit: recipes are complete, junk is filtered, Reddit is reachable.**

### Phase 3 — Port the UI, add images and auto-refresh
Now there's real data to build against.
- Split `meal-prep-planner.jsx` into components; CSS carries over nearly as-is.
- **Images:** card gets a 16:9 photo, detail sheet a hero. `next/image` + blurhash placeholder. Cards without a photo fall back to the current text-only layout rather than a broken frame — this *will* happen with real data, so build it deliberately.
- **Auto-refresh (UI polling):** TanStack Query with `refetchInterval` (~5 min) against `GET /api/recipes?since=<ts>`. Surface it as a **"7 new recipes — show them"** pill rather than silently re-sorting the list under someone mid-scroll; also refetch on window focus. Separately, `/ops` gets a manual "scan now" button that enqueues a pg-boss job.
- Saves/checks still in `localStorage` at this stage.
- **Retire `meal-prep-planner.jsx`** once ported — it stays in git history, and its two lasting contributions (the CSS and the ingredient seed) are already carried forward.

✅ **Exit: the artifact, but live, with real recipes and real photos.**

### Phase 4 — Auth
- Auth.js with the Google provider; `saved_recipes` and `grocery_checks` move server-side.
- One-time migration of existing `localStorage` state into the account on first sign-in — don't make the user lose their picks.

> **Apple Sign In is a bigger lift than Google** and I'd defer it: it requires a paid Apple Developer account ($99/yr), and the client secret is a JWT you must **regenerate at least every 6 months** — meaning a rotation job, or a service that silently breaks half a year in. Ship Google first; add Apple in Phase 8 if you still want it.

✅ **Exit: multi-user, saves persist across devices.**

### Phase 5 — Grocery list server-side
- Port the aggregation from `useMemo` to a SQL query over `saved_recipes × recipe_ingredients × ingredients`, with the batch multiplier and in-dimension unit conversion.
- Check-off state per user; keep the receipt aesthetic (it's the best part of the current design).
- Add: printable view, and copy-to-clipboard as plain text.

### Phase 6 — Ratings
- After-cooking flow: 1–5 stars, free-text notes, plus **fixed-vocabulary aspect tags** — `quick`, `slow`, `cheap`, `expensive`, `tasty`, `bland`, `reheats_well`, `soggy_leftovers`, `too_much_cleanup`, `would_repeat`.
- The fixed vocab is what makes Phase 7 tractable — free text alone can't drive a deterministic filter.

### Phase 7 — Personalization loop *(the payoff)*

**Start with derived rules, not embeddings.** With 20 ratings a vector model has nothing to work with; explicit rules extracted from those same 20 ratings work immediately and — critically — you can read them and tell whether they're right.

Nightly, per user:

1. **Derive hard rules deterministically in SQL.** `median(rating) WHERE total_minutes > 60` → if it's 2.1 across ≥5 recipes, emit `{"max_minutes": 60}`. Same for cost aspects, cleanup aspects, categories. These become `user_preferences.hard_rules` and are applied as a **SQL filter**, not a prompt — reqs.md's "if I don't like things that take more than 1 hour, don't show it" should be a `WHERE` clause, deterministic and debuggable.
2. **Derive a soft profile with DeepSeek.** Feed it the rating history (title, time, tags, rating, aspects, notes) and get back a short prose profile: *"Prefers one-pot and sheet-pan; dislikes anything needing day-of assembly; rates spicy food highly; consistently marks >1hr recipes down."* Store as `user_preferences.profile`.
3. **Score new recipes** in the daily scan by injecting that profile into a batched scoring prompt → `recipe_scores.score` + a one-line `reason`. Show the reason in the UI ("because you rated 4 other sheet-pan recipes 5★") — an opaque ranking is one you can't debug or trust.

**Cold start:** scoring only runs once a user has **≥5 rated recipes**; below that, `recipe_scores` stays empty and browse sorts by `published_at DESC` with source rating as a tiebreak. Hard rules need ≥5 observations *in the relevant bucket* before they're emitted, so one bad experience with a slow recipe can't silently hide every recipe over an hour. Show the active rules in the UI with a switch to disable each one — a filter you can't see is indistinguishable from a bug.

Add pgvector similarity later, as a *signal feeding into* the score, once there's enough history to justify it. The table's already there.

### Phase 8 — Optional
Social media (see §6), Apple Sign In, nutrition estimates, meal-calendar assignment, pantry tracking.

---

## 6. Social media: honest scoping

reqs.md asks for "sites and social media." These are very different problems, and **v1 covers recipe blogs + Reddit only**:

- **Recipe blogs** *(in v1, Phase 1)* — RSS/sitemap discovery + JSON-LD. Free and deterministic; the backbone of the whole system.
- **Reddit** *(in v1, Phase 2)* — real, free, documented API. `r/MealPrepSunday` and `r/EatCheapAndHealthy` are genuinely high-signal and the vote count is a built-in quality filter. Posts are unstructured prose, so this is the main consumer of the LLM extraction path — still one call per post, no loop.
- **YouTube** *(deferred)* — official Data API; descriptions often contain full recipes. Cheap to add later if wanted; nothing in the design blocks it.
- **TikTok / Instagram** *(deferred)* — no usable official API for this. The options are unofficial scraping (breaks constantly, against ToS, risks IP bans) or a paid third-party scraping API (~$50+/mo, which would dwarf the entire DeepSeek bill). The recipe also often exists only as spoken audio over video, so you'd need transcription on top. If these ever come back, the paid-API route is the only maintainable one — and it's worth deciding deliberately whether they're worth being the largest line item in the project.

The `sources.kind` column already distinguishes `blog | reddit | social`, so adding a source type later is a new adapter, not a schema change.

---

## 7. Content and attribution

Worth getting right early since it's structural, not cosmetic:

- **Ingredient lists and factual data are not copyrightable.** Ingredients, times, yields, ratings — safe to store and display.
- **Prose (headnotes, step wording) and photos are.** So: store `raw_jsonld` for internal processing, but **display our own LLM-written `blurb`** rather than the site's description, always show the source name, and always link to the original.
- **Images:** cache one downscaled copy for performance rather than hotlinking (hotlinking hammers their bandwidth and breaks when they reorganize), keep the attribution and link visible on every card.
- **Crawl politely:** honor robots.txt, identify with a real User-Agent and contact URL, respect crawl delays, conditional GETs.

The upside: a well-behaved crawler that drives clicks back to the source is roughly what an RSS reader does, and the current artifact's design already credits sources prominently. Keep that.

---

## 8. Decisions and open questions

**Settled:**

1. **Packaging** — `docker compose` with three services (§3), not a single container.
2. **Stack** — Next.js App Router, pnpm monorepo (§3).
3. **v1 sources** — recipe blogs via RSS + JSON-LD, plus Reddit. YouTube and TikTok/Instagram are out of v1 (§6).
4. **Multi-user** — build it properly, `user_id` on every table from Phase 0; `dev@local` stands in until Phase 4.
5. **No agent harness** — direct DeepSeek API calls, no pi (§2).
6. **No seeded recipes** — only the ~120 canonical ingredients. Ingestion is built before the UI (§5).
7. **Derived fields are LLM-inferred** against a controlled vocabulary in `packages/shared` (§1, §4).
8. **Testing** — Vitest, targeted at ingestion, ingredient matching, unit conversion and LLM output validation. No UI tests, no CI workflow unless you want one later.

**Still open:**

9. **Scale of scanning?** Plan assumes ~10 sources, daily, ~150 recipes/day. Ten times that is still cheap in tokens but changes politeness/rate-limit engineering.
10. **Recipe retention?** Recipes accumulate forever by default. Worth an archive rule (e.g. never cooked, never saved, >1yr old, low score) eventually.
11. **Which blogs beyond the artifact's five?** Phase 1 needs a concrete `sources` list. Defaults to Budget Bytes, Pinch of Yum, Downshiftology, GypsyPlate, Classpop + a few obvious meal-prep sites unless you have preferences.

---

## 9. Suggested next step

**Phase 0 + Phase 1**, delivered together: `docker compose up` gives you a migrated database and a working crawler pulling real recipes, with photos, off the five sites already in the artifact. No UI yet beyond `/ops` — you inspect results in Postgres or the ops page.

That's a deliberately unglamorous first milestone, and it's the right one. Ingestion is where this project's real risk lives: if JSON-LD coverage is worse than expected, or ingredient canonicalization is messier than expected, you want to know in week one — while the schema is still cheap to change and before any UI has been built on top of assumptions about the data. Phase 3 then ports the UI against whatever the crawler actually produced, warts included.

**Before starting, the implementer needs:** a `DEEPSEEK_API_KEY` (not until Phase 2), Reddit API credentials (Phase 2), and the source list from open question 11.

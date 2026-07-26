# JSON-LD coverage across the eight sources

Captured **2026-07-26** with `pnpm --filter @recipes/worker capture`, which uses
the same `PoliteFetcher` as the worker: robots.txt honoured, real User-Agent
(`RecipePlannerBot/0.1 (+https://github.com/petergelgor/recipes)`), ≥1.5s
between requests to a host, ~3 pages per site. Regenerate the numbers below
with `pnpm --filter @recipes/worker coverage`.

**Headline: 21 of 26 captured pages carry schema.org Recipe JSON-LD, and every
one of the eight sources publishes it on its actual recipe pages. Not one page
in the corpus needs the LLM extractor. The five pages without a Recipe node
are not recipes** — they are round-ups and listicles that arrived through the
feed, which is a *discovery* problem and a job for the Phase 2 suitability
gate, not an extraction problem.

PLAN.md §1's core assumption holds. The places it is optimistic are listed at
the bottom, and they are about *discovery* and *access*, not about JSON-LD.

## Per-site summary

| Source | Discovery | Recipe JSON-LD? | Pages with a Recipe | Fields missing on recipe pages | Structural notes |
|---|---|---|---|---|---|
| **Budget Bytes** | RSS `/feed/` (10 items) | ✅ yes, every recipe page | 3/3 | `rating` on 1 (no reviews yet) | Yoast `@graph`; `author` is an `@id` reference; per-step `HowToStep.name` headings |
| **Pinch of Yum** | RSS `/feed` (6 items) | ✅ yes | 2/3 | none | Yoast `@graph`; `HowToStep.name` used as real headings; 3rd page is a round-up |
| **Downshiftology** | RSS `/feed/` (10 items) | ✅ yes on `/recipes/*` | 2/5 | none | **All 10 feed items on capture day were round-ups**; the 2 recipe permalinks probed directly are perfect |
| **GypsyPlate** | ⚠️ sitemap only | ✅ yes | 3/3 | none | `/feed/` 302s to the homepage; `sitemap_index.xml` is 403 behind the host WAF, plain `/sitemap.xml` works |
| **Skinnytaste** | RSS `/feed/` (10 items) | ✅ yes | 2/3 | `rating` on 1 (new post) | Yoast `@graph`; `author` is an `@id` reference; feed URLs carry an `?adt_ei=*|EMAIL|*` merge tag |
| **The Kitchn** | RSS `/main.rss` (20 items) | ✅ yes | 3/3 | **`aggregateRating` on all 3 — the field is simply absent** | `HowToSection` nesting on every page, incl. a "Recipe Notes" pseudo-section; 2–3 JSON-LD blocks per page |
| **Love & Lemons** | RSS `/feed/` (10 items) | ✅ yes | 3/3 | none | Cleanest source in the set; two authors as an array; range yields (`"4 to 6"`) |
| **Serious Eats** | ⚠️ sitemap only (no RSS) | ✅ yes | 3/3 | `aggregateRating` on all 3; times/yield absent on the cocktail | Recipe and `NewsArticle` are separate sibling nodes; 14,460-URL flat sitemap |

## Field-by-field, over the 21 pages that have a Recipe node

| Field | Present | Notes |
|---|---|---|
| `name` | 21/21 | |
| `recipeIngredient` | 21/21 | 6–29 lines. Budget Bytes embeds prices (`"1 tsp smoked paprika ($0.08)"`); the ingredient parser must cope. |
| `recipeInstructions` | 21/21 | Always structured (`HowToStep`/`HowToSection`), never a bare HTML blob, on all eight sources. |
| `image` | 21/21 | |
| `datePublished` | 21/21 | |
| `author` | 21/21 | **17/21 before `@id` dereferencing** — see below. |
| `totalTime` (or prep+cook) | 20/21 | Missing only on the Serious Eats cocktail. |
| `recipeYield` | 20/21 | Same page. |
| `aggregateRating` | 12/21 | The Kitchn (0/3) and Serious Eats (0/3) never publish it; elsewhere it is missing only on posts with no reviews yet. |
| `keeps_days` / `freezer_months` / `category` / `tags` | **0/21, by definition** | schema.org has no shelf-life field, and `recipeCategory` is free text (`"Dinner"`, `"Salad"`), not our six buckets. Phase 2, exactly as PLAN.md §1 says. |

## Structural weirdness we hit, and what we do about it

1. **`author` as a bare `@id` reference.** Budget Bytes and Skinnytaste emit
   `"author": {"@id": "https://site/#/schema/person/ab12…"}` and put the
   `Person` node with the actual name elsewhere in the same `@graph`. A reader
   that only looks inside the Recipe node reports "no author" on 4 of 21 pages
   (2 of 3 at each of those two sites), and would do so on any other Yoast site
   configured the same way. `buildRefIndex()` + `deref()` resolve it. **This
   was the single biggest extraction bug found by this exercise**, and it is
   invisible without a fixture corpus — every other field looked fine.
2. **`HowToSection` nesting.** The Kitchn puts every step inside a section
   (`"Make the dressing:"`), and Kalua Pork uses eight sections named
   `"Step 1"…"Step 7"` plus a `"Recipe Notes"` section. We flatten to an
   ordered list and carry the heading on each step. Notes end up as steps —
   faithful to the source, and better than dropping them.
3. **`HowToStep.name` that is not a heading.** Budget Bytes gives real labels
   ("Prep the kale") but sometimes repeats the step text. We keep the name only
   when it is not a prefix of the text.
4. **Yield that is not a serving count.** `"6 pieces"`, `"8 large slices"`,
   `"4 to 6"`. Ranges take the lower bound; the raw string is always kept; a
   volume yield (`"4 1/2 cups"`) produces `servings: null` rather than a lie.
5. **`totalTime` that is not prep + cook.** GypsyPlate publishes
   `PT1H10M` with prep 10 and cook 30. We store what the source said and never
   "correct" it; we only sum prep+cook when `totalTime` is absent.
6. **Chill time counted as prep.** Pinch of Yum's strawberry pie is
   `prepTime: PT6H`. `active_minutes` from `prepTime` is a proxy, not a truth,
   and the UI should not present it as hands-on time without Phase 2 review.
7. **Recipe and `NewsArticle` as sibling nodes** (Serious Eats) rather than a
   combined `@type` array. Handled by walking every node rather than assuming
   the first one.
8. **Several JSON-LD blocks per page.** The Kitchn ships 3. Nobody in this
   corpus shipped a *malformed* block — `malformed=0` across all 29 pages — but
   the repair path (CDATA guards, raw newlines in strings) is tested
   synthetically because it costs nothing and one bad deploy at one source
   would otherwise silently lose that source.

## Access and robots.txt findings

- **No source disallows its recipe pages.** Every captured `robots.txt` allows
  our User-Agent on the URLs we care about; the disallows are `/wp-admin/`,
  `/wp-json/`, search endpoints and `/cdn-cgi/`. Asserted in `robots.test.ts`.
- **No source publishes a `Crawl-delay`.** Our 1s floor is therefore the
  binding constraint everywhere, which is the right default.
- **Serious Eats (People Inc.) is a legal problem, not a robots problem.** Its
  `robots.txt` opens with a licensing notice prohibiting "text and data mining"
  and "development or operation of any … large language model technology,
  including … using it for retrieval-augmented generation", and it
  `Disallow: /`s a named list of AI crawlers (`GPTBot`, `CCBot`,
  `anthropic-ai`, `Claude-SearchBot`, `PerplexityBot`, `Google-Extended`,
  `Meta-ExternalAgent`). `RecipePlannerBot` is not on that list, so under
  `User-agent: *` we are technically permitted everything except `/embed?` and
  `/cdn-cgi/`. The project owner has explicitly confirmed permission and
  directed that this source be enabled; the crawl itself is deterministic, and
  any later analysis is a separate Phase 2 concern. The canonical seed
  therefore ships Serious Eats with `sources.enabled = true`.
- **GypsyPlate sits behind a WAF (BigScoots).** `/sitemap_index.xml` returns
  403 while `/sitemap.xml` returns 200, and `/feed/` 302s to the homepage. The
  site is crawlable, but expect intermittent 403s; the fetcher's non-retry of
  4xx is correct here — retrying would look like an attack.

## Where PLAN.md is optimistic

1. **"Those sites all expose RSS feeds and sitemaps" (§1).** Two of eight have
   no usable feed: Serious Eats serves 404 at every conventional RSS path, and
   GypsyPlate's `/feed/` redirects to its homepage. The sitemap fallback is not
   a nicety — it is load-bearing for 2/8 sources on day one.
2. **Feeds are round-up-heavy, not recipe-heavy.** All 10 Downshiftology feed
   items on capture day were listicles, as was 1 of 3 at Pinch of Yum and
   Skinnytaste. §1 anticipates junk ("cocktails, desserts") but frames it as a
   *taste* problem; a third of feed traffic is pages with no recipe on them at
   all. Discovery should prefer sitemap URLs matching a source's recipe path
   pattern, and the scan telemetry should track "fetched but no Recipe node"
   separately from "rejected by the gate" — otherwise the two failure modes are
   indistinguishable in `scan_runs`.
3. **"Ratings for free" (§1).** 9 of 21 pages have no `aggregateRating`, and
   two entire sources never publish one. Any UI sort that leans on
   `source_rating` will silently exclude The Kitchn and Serious Eats.
4. **`raw_jsonld` is not enough to re-derive `author` on Yoast sites.** The
   name lives in a *sibling* node, not in the Recipe node, so §4's promise that
   `raw_jsonld` "lets us re-derive without re-crawling" is not quite true for
   that one field. Storing the resolved `author` string alongside `raw_jsonld`
   (which is what `toRecipeDraft` does) is the mitigation; persisting the whole
   `@graph` instead of the Recipe node would be the alternative.
5. **The suitability gate is needed earlier than §1 implies.** Round-ups reach
   extraction, not just the gate — and they get filtered for free by "no Recipe
   node", which costs zero tokens. Worth doing that check *before* any LLM call.

## Fixture format

`page-*.html` is the page as served, with one modification: the bodies of
inline `<script>` (except `application/ld+json`) and `<style>` elements are
emptied. Ad and analytics bundles were two thirds of the bytes and can never
affect extraction; every JSON-LD block and all document structure is preserved
byte-for-byte. `manifest.json` records both the as-served size (`bytes`) and
the committed size (`storedBytes`) for every page, so the trimming is visible.

`manifest.json` also records the capture URL, the feed or sitemap it came from,
the User-Agent used, and — for pages that failed — the reason. `robots.txt` and
`feed.xml` / `sitemap.xml` are stored verbatim, including Serious Eats'
14,460-URL sitemap: 12 MB on disk, ~1.6 MB packed, which buys a CI suite that
never touches the network.

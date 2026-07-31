# Natural-Language Recipe Filtering — Build Plan

Adding a search bar that takes `"Recipes that take less than 20 minutes and have
lots of protein, and are easy to make"` and returns the right recipes.

Predecessor: [`PLAN.md`](./PLAN.md), Phases 0–7, complete. Progress log for this
plan: [`../progress/FILTER_PLAN.md`](../progress/FILTER_PLAN.md), amendments
continuing at **A23**.

---

## 1. The core insight that shapes everything

**The LLM must never write SQL.** It translates the query into a structured
filter object; our code compiles that object into a Drizzle `WHERE` clause. The
model never sees the database, never sees SQL, and can only express filters we
have defined and tested.

This is not a new architecture. It is a second caller of one the repo already
has: `hardRuleFilter()` in `apps/web/src/lib/preferences.ts:101` takes JSON
rules (`{kind: 'max_minutes', value: 30}`) and emits SQL fragments. A search
filter is the same function with a richer vocabulary of rule kinds.

The second insight is that **Phase 2 already did the hard part.** Verified
against the live corpus on 2026-07-30:

| Field | Coverage on 235 active recipes |
| --- | --- |
| `total_minutes` | 234 |
| `category` | 235 |
| `blurb` | 235 |
| `servings` | 231 |
| `keeps_days` | 216 |
| tags | 5.31 per recipe, all 27 vocabulary tags in use |

So the example query decomposes onto real columns:

| Phrase | Compiles to |
| --- | --- |
| "less than 20 minutes" | `total_minutes <= 20` |
| "lots of protein" | `tags @> ARRAY['High protein']` |
| "easy to make" | `tags && ARRAY['Hands-off','One pot','One cleanup','Sheet pan','No cook']` |

Run as hand-written SQL against the live database, that returns **12 recipes**.
The query already works. The only missing piece is the translation step.

### The time trap

Map time to `total_minutes`, **never** to the `Under 20 min` tag. That tag is on
12 recipes while 34 recipes actually have `total_minutes <= 20`. Trusting the
tag silently loses two thirds of the matches. The tag vocabulary is for concepts
with no column; where a column exists, the column wins.

---

## 2. Architecture

### 2.1 The pipeline

```
query text + reader's profile
  │
  ├─ 1. parse    LLM, strict json_schema → SearchFilter  (§3)
  │
  ├─ 2. compile  SearchFilter → Drizzle WHERE + ORDER BY (§4)
  │
  ├─ 3. execute  one query against recipes
  │
  └─ 4. relax    zero results → drop one criterion, label it (§4.4)
```

Steps 2–4 are pure functions over a validated object and are fully testable with
no network. Step 1 is the only billable, non-deterministic part, and its output
is validated by Zod before anything downstream sees it.

### 2.2 Where the code lives

The OpenRouter transport currently lives at `apps/worker/src/llm/openrouter.ts`,
and `apps/web` depends on neither `@recipes/worker` nor `openai`. Something has
to move.

**Decision: promote the transport to `@recipes/shared/llm`, a server-only
subpath** alongside the existing server-only `@recipes/shared/env`. `openrouter.ts`
and `usage.ts` move; every task-specific prompt module
(`score-recipes.ts`, `derive-fields.ts`, …) stays in the worker where it belongs.
`openai` becomes a dependency of `@recipes/shared`; `zod` already is.

This is mechanical but broad: **17 modules import the transport** across
`apps/worker/src` and `apps/worker/test`. It is its own phase with its own exit
criterion for exactly that reason (§7, Phase 1).

Rejected: having `apps/web` import `@recipes/worker`. The worker's package entry
boots cron and queues; a web request has no business pulling that in, and adding
an `exports` map to paper over it inverts the dependency direction.

New modules:

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/search.ts` | The `SearchFilter` contract, Zod schema, vocabulary version. Client-safe. |
| `packages/shared/src/llm/openrouter.ts` | Moved transport. Server-only. |
| `apps/worker/src/llm/parse-search-query.ts` | The prompt and task definition. |
| `apps/web/src/lib/search.ts` | Compiler: `SearchFilter` → SQL. Relaxation ladder. |
| `apps/web/src/app/api/search/route.ts` | `GET /api/search?q=` |
| `apps/web/src/components/search-bar.tsx` | The input, the notices, the disabled state. |

---

## 3. The filter contract

`SearchFilter` is the entire surface the model can express. Anything not in this
object cannot be asked for, which is the point.

```ts
interface SearchFilter {
  maxMinutes: number | null;        // total_minutes
  minMinutes: number | null;        // "something to spend a Sunday on"
  maxActiveMinutes: number | null;  // hands-on time specifically
  categories: Category[];           // include; empty means no constraint
  excludeCategories: Category[];
  tags: Tag[];                      // include, ALL must match
  anyTags: Tag[];                   // include, ANY may match ("easy to make")
  excludeTags: Tag[];
  ingredients: string[];            // canonical names, ALL must be present
  excludeIngredients: string[];     // canonical names, exact only — see below
  minServings: number | null;
  minKeepsDays: number | null;
  freezerOnly: boolean;
  unmappedTerms: string[];          // §5
}
```

Every field is populated in the corpus and either indexed or cheap over 235
rows. `Category` and `Tag` come from `@recipes/shared/vocab`, so the strict JSON
Schema sent to OpenRouter carries the enum values and the model physically
cannot return a tag that does not exist.

### 3.1 Both flavours of tag inclusion

`tags` and `anyTags` exist separately because "quick vegetarian" and "easy to
make" are different requests. The first is a conjunction of two specific
properties. The second is one fuzzy property that several tags each partially
satisfy — a recipe needs to be *any* of hands-off, one-pot, one-cleanup,
sheet-pan or no-cook to count as easy, not all five. Collapsing them into one
field makes one of the two queries return nothing.

### 3.2 Exclusion is exact-match only

`excludeIngredients` resolves against `ingredients.name` exactly. It never goes
through the trigram or alias path that `recipe_ingredients` matching uses.

The reason is asymmetry of harm. A missed exclusion shows someone a recipe they
have to skip. A wrong exclusion silently hides recipes they wanted and gives
them no way to find out. "No chicken" fuzzily excluding `chicken broth`,
`chicken stock` and `chicken-fried steak` is a plausible reading and a bad
default. Same direction as amendment A18's ingredient guard and A20's rules:
**prefer a missed filter to a wrong one.**

### 3.3 The profile is an input to parsing

The parse prompt receives the reader's `user_preferences.profile` (the Phase 7
prose profile, capped at `MAX_PROFILE_CHARS` = 600), so `"something I'd like
tonight"` and `"the usual but faster"` are answerable.

Consequence, accepted deliberately: the parse is per-reader and not shareable.
With a hard ceiling of ~10 users this costs nothing that matters. See §9 for why
there is no cache table at all.

Note the deliberate asymmetry with §4.2: the soft profile *informs* how a query
is read, while hard rules are *overridden* by it. A profile is context for
interpreting what someone meant; a rule is a filter they are explicitly setting
aside by typing a query that contradicts it.

---

## 4. Compiling and executing

### 4.1 The `WHERE` clause

Same shape as `hardRuleFilter()`, and the same null-handling rule: **a clause
must keep a row whose column is null.** A recipe whose `keeps_days` Phase 2
could not derive has not failed the reader's requirement, it is simply unknown,
and hiding it lets missing data act as a filter.

The one exception is an explicit numeric bound the reader typed. If someone asks
for "under 20 minutes", a recipe with no time at all is not a match — they asked
a direct question and a null is not a yes. This inverts the `hardRuleFilter`
convention on purpose: there, the constraint was *inferred* from behaviour and
deserved the benefit of the doubt; here it was *typed*.

### 4.2 Hard rules are overridden

An explicit search bypasses the reader's Phase 7 hard rules entirely, and the
results header says so:

> Ignoring your "under 30 minutes" rule for this search.

A typed query is a stronger statement of intent than a rule inferred from rating
history. Applying both means a reader with a `max_minutes: 30` rule who searches
"weekend slow-cooker braise" gets nothing and cannot tell why. Silence is the
worst possible answer there.

Scores are *not* overridden — see below.

### 4.3 Ordering: match quality, then score

```sql
ORDER BY match_count DESC,
         coalesce(score, 5.0) DESC,
         coalesce(published_at, first_seen_at) DESC,
         id DESC
```

`match_count` is the number of the filter's criteria a row satisfies, computed
as a sum of boolean casts. Personalization score stays as the tiebreak, so among
equally good matches the reader still sees their kind of thing first. The trailing
two keys are the existing browse order from `listRecipes()`, kept so that a
search with one criterion degrades into something recognisable rather than
arbitrary.

### 4.4 Zero results relax one criterion at a time

235 recipes is a small corpus and empty results will be common. Rather than an
empty state, drop the least important criterion, re-run, and **say what was
dropped**:

> No 15-minute vegan soups. Showing 30-minute ones.

Relaxation order, least-costly to drop first:

1. `minKeepsDays`, `freezerOnly`, `minServings` — usually incidental
2. `anyTags` — the fuzziest criterion by construction
3. numeric time bounds — widened by 50%, not dropped
4. `tags`
5. `categories`

Ingredient constraints and every `exclude*` field are **never** relaxed. If
someone says "no mushrooms", returning mushroom recipes because nothing else
matched is worse than returning nothing.

Cap at two relaxation rounds, then show a genuine empty state.

---

## 5. Unmapped terms: FTS and trigram

"Spicy", "kid-friendly", "date night" have no column and no tag. The model puts
them in `unmappedTerms` rather than forcing a bad mapping.

**Full-text search, not trigram, for concept words.** These are different tools:
trigram is fuzzy *spelling* (`chikcen` → `chicken`); FTS is word and stem
matching, which is what finds "spicy" inside a blurb. Both are used, for
different jobs:

- `tsvector` over `title || ' ' || blurb`, GIN indexed, for `unmappedTerms`
- trigram over `title`, for typo tolerance on the raw query

Neither index exists today — the only two trigram indexes in the database are on
`ingredients.name` and `ingredient_aliases.alias`. Both are new (§6).

### 5.1 Intersect, then union

Unmapped terms **narrow** the structured result set. If that intersection is
empty, fall back to the union and say so:

> Nothing matched both "spicy" and under 20 minutes. Showing recipes that match
> one.

This runs before the §4.4 relaxation ladder — widening the fuzziest part of the
query is cheaper than dropping a criterion the reader actually typed.

---

## 6. Migration

One migration, `0004_search.sql`:

1. `scan_runs.kind` — `text not null default 'scan'`, with a CHECK constraint
   over a new `SCAN_RUN_KIND` vocabulary (`'scan' | 'search'`) generated from the
   shared constant, exactly as `recipes.tags` does.

   **This column is load-bearing, not decoration.** `scan_runs.source_id = NULL`
   already means "a run spanning every source" and is what the nightly scan
   uses, so it cannot double as the discriminator for search. Without `kind`
   there is no way to separate search spend from enrichment spend, and §8's
   separate budget is unimplementable.

2. GIN index on `to_tsvector('english', title || ' ' || coalesce(blurb, ''))`.
3. GIN trigram index on `recipes.title`.

No cache table (§9).

---

## 7. Phases

### Phase 1 — Move the LLM transport *(pure refactor)*
- `openrouter.ts` and `usage.ts` → `packages/shared/src/llm/`, exported as the
  server-only `@recipes/shared/llm` subpath.
- Add `openai` to `@recipes/shared` dependencies.
- Update all 17 importing modules in `apps/worker`.
- No behaviour change anywhere.

✅ **Exit: `corepack pnpm test` is 712 passing and `typecheck` is clean, with
zero test files modified except for their import paths.** If any assertion had
to change, the refactor was not pure and something was moved that should not
have been.

### Phase 2 — The contract and the compiler *(no LLM)*
- `packages/shared/src/search.ts`: `SearchFilter`, its Zod schema, `SEARCH_VOCAB_VERSION`.
- `apps/web/src/lib/search.ts`: compiler, `match_count`, relaxation ladder.
- Migration `0004_search.sql` (§6).
- *Tests:* hand-written `SearchFilter` → expected-rows pairs run against the real
  corpus. This is the highest-value test surface in the plan — it is where
  wrongness is silent.

✅ **Exit: a hand-authored `SearchFilter` for the example query returns exactly
the 12 recipes §1 identifies, via the compiler and not by hand.**

### Phase 3 — The parse step
- `apps/worker/src/llm/parse-search-query.ts`: system prompt, strict schema,
  `temperature: 0`.
- Prompt treats the query and the profile as **untrusted data, never
  instructions** — same wording as `SCORE_RECIPES_SYSTEM_PROMPT`.
- *Tests:* ~30 committed query→`SearchFilter` fixture pairs, asserted against a
  stubbed transport. Plus `scripts/check-search-parse.ts`, opt-in, which runs the
  same pairs against the real model and reports drift. It costs money and is
  never part of `pnpm test`.

✅ **Exit: all 30 fixtures pass offline; the opt-in script agrees on at least 27
of 30 against the live model.**

### Phase 4 — Budget and accounting
- `SEARCH_DAILY_BUDGET_USD` in `@recipes/shared/env` (§8).
- Kind-filtered `getDailyLlmUsage()`; day-rolling search run row.
- `/ops` labels a `kind='search'` run rather than rendering a blank source.

✅ **Exit: a search increments the search run's `cost_usd` and `/ops` shows it;
enrichment spend does not move the search budget and vice versa.**

### Phase 5 — Route and UI
- `GET /api/search?q=` — 401 signed out, 400 on empty `q`, 503 when gated.
- Search bar, `?q=` URL state, the §4.2/§4.4/§5.1 notices, the disabled state.
- Searching resets the category chip to `All`; chips then narrow the results.

✅ **Exit: typing the example query into the running app returns the 12 recipes,
the URL is shareable, the back button works, and every notice path has been seen
in the browser.** Phases 5 and 6 of `PLAN.md` both ended with a live browser
check for the same reason: these are the failures tests do not catch.

---

## 8. Budget and gating

**A separate pot.** `SEARCH_DAILY_BUDGET_USD`, default `0.10` — thousands of
queries at flash pricing. Deliberately *not* the existing
`LLM_DAILY_BUDGET_USD`: with one shared pot, a heavy enrichment night silently
kills the search bar for the whole following day and gives no clue why.

Both halves need the kind filter to work. `getDailyLlmUsage()` currently sums
*every* `scan_runs` row for the UTC day; it gains a `kind` parameter so the two
budgets cannot leak into each other. `/ops`'s today's-spend tile keeps summing
everything, which is correct — that tile is total spend.

**Accounting.** One `scan_runs` row per UTC day with `kind='search'`, created
lazily on the day's first search and accumulated into by every search after it.
Status is `'success'` from creation, with `finished_at` bumped per search: a row
left `'running'` all day would read as a stuck scan on `/ops`. The existing
advisory-lock budget lease in `createBudgetedLlmCallOptions()` works unchanged.

**The 90% gate.** At ≥90% of the search budget, `/api/search` returns 503 and the
bar renders **disabled with an explanation** — "Search is resting until
tomorrow" — never hidden. A control that vanishes reads as a bug.

**No per-user limiter.** The daily budget is the real backstop and a ~10-user
ceiling makes anything finer theatre.

**Signed-in only.** Unlike the grocery list there is nothing to migrate on a
later sign-in, so this follows ratings (Phase 6): 401 signed out, and the bar is
not rendered at all. It also means the profile in §3.3 is always available.

---

## 9. Decisions and rejected alternatives

**A23 — The LLM does not write SQL.** Rejected: text-to-SQL. It buys expressive
power the corpus cannot use — there is no nutrition data for "under 600
calories" no matter how good the SQL is — in exchange for an injection surface,
unbounded query cost, and nothing testable.

**A24 — No cache, no cache table.** Considered and rejected twice over: a real
per-user cache (keyed on user, query, vocabulary version *and* profile version,
since §3.3 makes the parse per-reader) and a log-only table. At ~10 users the
saving is rounding error, and every entry is a chance to serve yesterday's idea
of someone. Every search parses fresh. The §7 Phase 3 fixtures are hand-written
rather than harvested, which is the real cost of this decision and is accepted.

**A25 — Vocabulary changes invalidate nothing, because nothing is stored.** The
`SEARCH_VOCAB_VERSION` constant in `packages/shared/src/search.ts` still exists,
because the fixture tests assert against it: a `TAGS` or `CATEGORIES` change that
does not update the fixtures should fail the build loudly rather than quietly
degrade parse quality.

**A26 — LLM failure is visible.** On a transport error or a parse that fails
validation twice, fall back to FTS over the raw query string **and tell the
reader** — "Search understanding is down; showing text matches." Standard advice
is to hide this, but with an operator-sized user base a silent degradation to
worse results is worse than an honest notice.

### Deliberately out of scope

- **Nutrition.** "Under 600 calories" is unanswerable — there is no nutrition
  data in the schema. `High protein` is a Phase 2 judgment call, not a
  measurement. `PLAN.md` §5 Phase 8 lists nutrition estimates as optional; if it
  ever lands, `SearchFilter` gains fields and nothing else changes.
- **Semantic / embedding search.** `pgvector` is installed but no embedding
  column exists anywhere. A 235-row corpus with 27 curated tags does not need
  it.
- **Multi-turn refinement.** Each search is independent. "Now make it
  vegetarian" is a genuinely nice follow-up and a different plan.

---

## 10. Open questions

1. Should `anyTags` groupings ("easy", "healthy", "impressive") be a curated
   constant the model selects from, rather than free tag selection? Curation is
   more predictable and less flexible. Deferred until the Phase 3 fixtures show
   whether the model groups sensibly on its own.
2. Does `match_count` need weighting? An ingredient match is arguably worth more
   than a tag match. Start unweighted; revisit only if ordering looks wrong in
   the Phase 5 browser check.
3. Does the search bar eventually replace the category chips entirely? Not now —
   the chips are one tap and a query is a sentence.

/**
 * The search filter contract — the entire surface a natural-language query can
 * be turned into.
 *
 * FILTER_PLAN.md §1, amendment A23: **the LLM never writes SQL.** It emits one
 * of these objects and `apps/web/src/lib/search.ts` compiles it into a `WHERE`
 * clause. So this file is the security boundary as much as it is the type: a
 * concept absent from `SearchFilter` cannot be asked for, however the query is
 * phrased, and `Category`/`Tag` come from `./vocab` so the strict JSON Schema
 * sent to the model carries the enum values and it physically cannot return a
 * tag that does not exist.
 *
 * Client-safe, and in the package barrel — unlike `./env` and `./llm`. It is
 * pure data and pure functions over vocabularies the browser already ships.
 */

import { z } from 'zod';
import { CATEGORIES, TAGS, type Category, type Tag } from './vocab';

// ── Bounds ──────────────────────────────────────────────────────────────────
// Every array and string is capped. Nothing here is a security control on its
// own — the compiler parameterises everything — but a filter is model output,
// and an unbounded one is an unbounded query plan.

/** Two weeks, matching `minutes` in `./schemas.ts`. */
export const MAX_SEARCH_MINUTES = 60 * 24 * 14;
export const MAX_SEARCH_INGREDIENTS = 10;
export const MAX_UNMAPPED_TERMS = 6;
export const MAX_TERM_CHARS = 60;
/** Longest raw query the parse step will accept, for the Phase 5 route. */
export const MAX_SEARCH_QUERY_CHARS = 300;

/**
 * §8's gate: at this fraction of `SEARCH_DAILY_BUDGET_USD`, `/api/search`
 * answers 503 and the bar renders disabled with an explanation.
 *
 * Short of the cap rather than at it, deliberately. The durable lease in
 * `@recipes/db/llm-budget` already refuses at 100%, but it refuses *mid-call* —
 * the reader has typed a sentence and waited for it. Stopping at 90% means the
 * last thing that happens before the budget is spent is a control that says it
 * is resting, not a request that fails. §8 again: "A control that vanishes reads
 * as a bug", and one that errors instead of answering is not much better.
 */
export const SEARCH_BUDGET_GATE_FRACTION = 0.9;

// ── The contract (§3) ───────────────────────────────────────────────────────

export interface SearchFilter {
  /** `recipes.total_minutes`, **never** the `Under 20 min` tag — see below. */
  maxMinutes: number | null;
  /** "something to spend a Sunday on". */
  minMinutes: number | null;
  /** Hands-on time specifically: `recipes.active_minutes`. */
  maxActiveMinutes: number | null;
  /** Include. Empty means no constraint, in every array field here. */
  categories: Category[];
  excludeCategories: Category[];
  /** Include, **all** must match. */
  tags: Tag[];
  /** Include, **any** may match — "easy to make". See §3.1. */
  anyTags: Tag[];
  excludeTags: Tag[];
  /** Canonical `ingredients.name`, all must be present. */
  ingredients: string[];
  /** Canonical `ingredients.name`, exact only — see §3.2. */
  excludeIngredients: string[];
  minServings: number | null;
  minKeepsDays: number | null;
  freezerOnly: boolean;
  /** Concept words with no column and no tag: "spicy", "date night". §5. */
  unmappedTerms: string[];
}

/**
 * The time trap, stated where it will be read (§1).
 *
 * Time maps onto `total_minutes` and never onto the `Under 20 min` tag. On the
 * live corpus 12 recipes carry that tag while 34 have `total_minutes <= 20`, so
 * trusting the tag silently loses two thirds of the matches. The tag vocabulary
 * exists for concepts with no column; where a column exists, the column wins.
 *
 * Named here so the Phase 3 prompt and its fixtures have something to point at:
 * a query about duration must set `maxMinutes`, and must not set any of these.
 */
export const TIME_TAGS: readonly Tag[] = ['10 minutes', '30 minutes', 'Under 20 min'];

export const EMPTY_SEARCH_FILTER: SearchFilter = Object.freeze({
  maxMinutes: null,
  minMinutes: null,
  maxActiveMinutes: null,
  categories: [],
  excludeCategories: [],
  tags: [],
  anyTags: [],
  excludeTags: [],
  ingredients: [],
  excludeIngredients: [],
  minServings: null,
  minKeepsDays: null,
  freezerOnly: false,
  unmappedTerms: [],
});

// ── The schema ──────────────────────────────────────────────────────────────

const boundedMinutes = z.number().int().positive().max(MAX_SEARCH_MINUTES).nullable();

/**
 * Order-preserving dedupe, so a repeated tag is one criterion and not two.
 *
 * Applied with `.overwrite()` rather than `.transform()` below. The two do the
 * same thing to a value, but a transform is *unrepresentable in JSON Schema* —
 * `z.toJSONSchema()` throws on one — and the whole contract is sent to the
 * provider as a strict `json_schema`. `.overwrite()` is Zod's same-type-in,
 * same-type-out variant, and it converts. Found in Phase 3, when the contract
 * first met the transport; nothing about what a filter *is* changed.
 */
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const categoryList = z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).overwrite(unique);
const tagList = z.array(z.enum(TAGS)).max(TAGS.length).overwrite(unique);

/**
 * Free strings, unlike the two above, because the canonical ingredient
 * vocabulary is 789 rows in a table rather than a constant in this file — far
 * too large to put in a JSON Schema enum. The compiler resolves them by exact
 * name and a name that matches nothing simply matches no recipe, which is the
 * safe failure in both directions: an unknown include returns nothing, an
 * unknown exclude excludes nothing.
 */
const ingredientList = z
  .array(z.string().trim().min(1).max(MAX_TERM_CHARS).toLowerCase())
  .max(MAX_SEARCH_INGREDIENTS)
  .overwrite(unique);

const termList = z
  .array(z.string().trim().min(1).max(MAX_TERM_CHARS))
  .max(MAX_UNMAPPED_TERMS)
  .overwrite(unique);

/**
 * Every field is required, with no defaults.
 *
 * That is what OpenRouter's strict `json_schema` mode needs (amendment A2), and
 * it is also the property that makes the model's output auditable: a filter
 * that omits `excludeIngredients` and a filter that sets it to `[]` are the
 * same query, but only one of them proves the model considered the question.
 * Use {@link makeSearchFilter} to write one by hand.
 */
export const searchFilterSchema = z.object({
  maxMinutes: boundedMinutes,
  minMinutes: boundedMinutes,
  maxActiveMinutes: boundedMinutes,
  categories: categoryList,
  excludeCategories: categoryList,
  tags: tagList,
  anyTags: tagList,
  excludeTags: tagList,
  ingredients: ingredientList,
  excludeIngredients: ingredientList,
  minServings: z.number().int().positive().max(1000).nullable(),
  minKeepsDays: z.number().int().positive().max(365).nullable(),
  freezerOnly: z.boolean(),
  unmappedTerms: termList,
});

/**
 * Build one from a partial, validating the result.
 *
 * The ergonomic entry point for the corpus tests and the Phase 3 fixtures,
 * which care about two fields out of fourteen. Throws on a filter that does not
 * validate — a hand-authored one is a bug, not untrusted input; use
 * `searchFilterSchema.safeParse()` for anything that came off the wire.
 */
export function makeSearchFilter(partial: Partial<SearchFilter> = {}): SearchFilter {
  return searchFilterSchema.parse({ ...EMPTY_SEARCH_FILTER, ...partial });
}

/** True when the filter constrains nothing — every field at its empty value. */
export function isEmptySearchFilter(filter: SearchFilter): boolean {
  return (
    filter.maxMinutes === null &&
    filter.minMinutes === null &&
    filter.maxActiveMinutes === null &&
    filter.minServings === null &&
    filter.minKeepsDays === null &&
    filter.freezerOnly === false &&
    filter.categories.length === 0 &&
    filter.excludeCategories.length === 0 &&
    filter.tags.length === 0 &&
    filter.anyTags.length === 0 &&
    filter.excludeTags.length === 0 &&
    filter.ingredients.length === 0 &&
    filter.excludeIngredients.length === 0 &&
    filter.unmappedTerms.length === 0
  );
}

// ── Relaxation (§4.4) ───────────────────────────────────────────────────────

/**
 * The fields the relaxation ladder is allowed to touch.
 *
 * `ingredients` and every `exclude*` field are deliberately absent and must
 * stay absent (§4.4): returning mushroom recipes to someone who said "no
 * mushrooms" because nothing else matched is worse than returning nothing.
 * The ladder itself lives in `apps/web/src/lib/search.ts` — this is only the
 * vocabulary of what it may say, which the browser needs in order to render
 * the notice.
 */
export type RelaxableField =
  | 'minKeepsDays'
  | 'freezerOnly'
  | 'minServings'
  | 'anyTags'
  | 'maxMinutes'
  | 'minMinutes'
  | 'maxActiveMinutes'
  | 'tags'
  | 'categories';

/**
 * The three fields §4.4 widens by half rather than dropping: the reader asked
 * for 15 minutes, and 23 is a useful answer where "any duration" is not.
 */
export type WidenableField = 'maxMinutes' | 'minMinutes' | 'maxActiveMinutes';
/** Everything else on the ladder, which is given up outright. */
export type DroppableField = Exclude<RelaxableField, WidenableField>;

/** One thing given up to get results, in the order it was given up. */
export type Relaxation =
  | { kind: 'dropped'; field: DroppableField }
  | { kind: 'widened'; field: WidenableField; from: number; to: number }
  /** §5.1's union fallback, which runs before the ladder. */
  | { kind: 'unmapped-union'; terms: string[] };

// ── Notices (§4.2, §4.4, §5.1, A26) ─────────────────────────────────────────

/**
 * What the reader has to be told about a search that did not run as typed.
 *
 * Every one of these exists because the plan says silence is the worse answer.
 * §4.4: "Rather than an empty state, drop the least important criterion, re-run,
 * and **say what was dropped**." §4.2: an explicit search bypasses the reader's
 * hard rules, "and the results header says so". A26: an LLM failure degrades to
 * text matching and the reader is told, because "with an operator-sized user
 * base a silent degradation to worse results is worse than an honest notice."
 *
 * A discriminated union rather than a rendered string, for the same reason
 * `HardRule` is data and `describeHardRule()` is separate: the route decides
 * *that* something happened, this file decides how to say it, and a test can
 * pin the wording without a browser.
 */
export type SearchNotice =
  /** §4.2 — hard rules were not applied to this search. */
  | { kind: 'rules-bypassed'; rules: string[] }
  /** §5.1 — the unmapped terms went from intersect to union. */
  | { kind: 'terms-union'; terms: string[] }
  /** §4.4 — criteria were given up, in the order the ladder gave them up. */
  | { kind: 'relaxed'; relaxations: Relaxation[] }
  /** A26 — the parse step failed and this is a plain text match. */
  | { kind: 'degraded' };

/**
 * Most fundamental first, then pipeline order.
 *
 * `degraded` leads because it changes what every notice under it means — a
 * relaxation reported after "we could not understand your query" is a different
 * statement from one reported after a successful parse. `rules-bypassed` is
 * next because it is about the reader's standing settings rather than about
 * this query, and then the two in the order the search actually tried them:
 * §5.1's union runs before §4.4's ladder.
 */
const NOTICE_ORDER: readonly SearchNotice['kind'][] = [
  'degraded',
  'rules-bypassed',
  'terms-union',
  'relaxed',
];

export function orderSearchNotices(notices: readonly SearchNotice[]): SearchNotice[] {
  return [...notices].sort(
    (left, right) => NOTICE_ORDER.indexOf(left.kind) - NOTICE_ORDER.indexOf(right.kind),
  );
}

/** Everything one search has to admit to, as facts the route already knows. */
export interface SearchNoticeInput {
  /** {@link shortHardRuleLabel} of each *enabled* rule this search stepped over. */
  readonly bypassedRules: readonly string[];
  /** A26: the parse step failed and this is a plain text match. */
  readonly degraded: boolean;
  /** Exactly what `searchRecipes()` reported giving up, in order. */
  readonly relaxations: readonly Relaxation[];
}

/**
 * Assemble the notices for one search.
 *
 * A pure function over facts the route has already established, rather than
 * something the route builds inline, for the reason every seam in this plan
 * exists: the assembly is where a notice gets *dropped*, and a dropped notice
 * is invisible — the reader sees a plausible list of recipes and no reason to
 * doubt it. This can be tested without a database or a provider call.
 *
 * The one piece of real logic is splitting `searchRecipes()`'s single
 * `relaxations` list in two. §5.1's union fallback and §4.4's ladder arrive
 * together because they happened in one run, but they are different sentences
 * to the reader: one says the fuzzy half of the query widened, the other says a
 * criterion they typed was given up.
 */
export function searchNoticesFor(input: SearchNoticeInput): SearchNotice[] {
  const notices: SearchNotice[] = [];

  if (input.bypassedRules.length > 0) {
    notices.push({ kind: 'rules-bypassed', rules: [...input.bypassedRules] });
  }
  if (input.degraded) notices.push({ kind: 'degraded' });

  for (const relaxation of input.relaxations) {
    if (relaxation.kind === 'unmapped-union') {
      notices.push({ kind: 'terms-union', terms: [...relaxation.terms] });
    }
  }

  const ladder = input.relaxations.filter((item) => item.kind !== 'unmapped-union');
  if (ladder.length > 0) notices.push({ kind: 'relaxed', relaxations: ladder });

  return orderSearchNotices(notices);
}

/** `a`, `a and b`, `a, b and c` — the joiner every notice below shares. */
function inWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

function quoted(values: readonly string[]): string {
  return inWords(values.map((value) => `“${value}”`));
}

/**
 * What a single relaxation shows *instead*.
 *
 * Phrased as the new state rather than as the loss — "up to 30 minutes" rather
 * than "dropped your time limit" — because the reader is looking at a list of
 * recipes and needs to know what it is a list *of*. A time bound is widened
 * rather than dropped (§4.4), so it can say the new number, which is the whole
 * reason that rung widens.
 */
function describeRelaxation(relaxation: Relaxation): string {
  switch (relaxation.kind) {
    case 'unmapped-union':
      return `recipes that match one of ${quoted(relaxation.terms)}`;
    case 'widened':
      return describeWidened(relaxation.field, relaxation.from, relaxation.to);
    case 'dropped':
      return describeDropped(relaxation.field);
  }
}

function describeWidened(field: WidenableField, from: number, to: number): string {
  switch (field) {
    case 'maxMinutes':
      return `recipes up to ${to} minutes instead of ${from}`;
    case 'minMinutes':
      return `recipes from ${to} minutes instead of ${from}`;
    case 'maxActiveMinutes':
      return `recipes with up to ${to} minutes of hands-on time instead of ${from}`;
  }
}

function describeDropped(field: DroppableField): string {
  switch (field) {
    case 'minKeepsDays':
      return 'recipes however long they keep';
    case 'freezerOnly':
      return 'recipes that may not freeze';
    case 'minServings':
      return 'recipes whatever they serve';
    case 'anyTags':
      return 'recipes without the effort part';
    case 'tags':
      return 'recipes without every tag you asked for';
    case 'categories':
      return 'recipes from every category';
  }
}

/**
 * One notice, as a sentence.
 *
 * The plan writes its examples against one specific query — "No 15-minute vegan
 * soups. Showing 30-minute ones." — and the compiler does not know it was
 * looking for vegan soups, only that it widened a bound. So the shape is kept
 * (what failed, then what is on screen instead) and the specifics come from the
 * relaxation itself, which is the part that is actually true every time.
 */
export function describeSearchNotice(notice: SearchNotice): string {
  switch (notice.kind) {
    case 'rules-bypassed':
      return `Ignoring your ${quoted(notice.rules)} ${
        notice.rules.length === 1 ? 'rule' : 'rules'
      } for this search.`;
    case 'terms-union':
      // "both" only survives for two. §5.1's example has two terms and reads
      // beautifully; three made it "Nothing matched both a, b and c", which is
      // the kind of sentence that makes a reader stop trusting the rest of it.
      return `Nothing matched ${notice.terms.length === 2 ? 'both' : 'all of'} ${quoted(
        notice.terms,
      )}. Showing recipes that match one.`;
    case 'relaxed':
      return `Nothing matched all of that. Showing ${inWords(
        notice.relaxations.map(describeRelaxation),
      )}.`;
    case 'degraded':
      return 'Search understanding is down; showing text matches.';
  }
}

// ── Vocabulary version (A25) ────────────────────────────────────────────────

/** FNV-1a, 32-bit. Not a security hash — a change detector with no deps. */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Identifies the vocabulary the parse prompt and its fixtures were written
 * against.
 *
 * Amendment A25: nothing is stored, so this invalidates nothing — its whole job
 * is to **fail the build**. The Phase 3 fixtures assert against the literal
 * value below, so adding a tag to `TAGS` changes the fingerprint, breaks that
 * assertion, and forces someone to look at whether the fixtures still express
 * what they meant. A hand-bumped integer would not have done that; it would
 * have been forgotten, which is the exact failure the constant exists to
 * prevent.
 *
 * The leading number is the *shape* of `SearchFilter` and is bumped by hand
 * when a field is added or removed; the suffix is derived.
 */
export const SEARCH_VOCAB_VERSION = `1-${fingerprint(
  `categories:${CATEGORIES.join('|')}\ntags:${TAGS.join('|')}`,
)}`;

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

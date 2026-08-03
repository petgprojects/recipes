/**
 * Controlled vocabularies. PLAN.md §4: "Controlled vocabularies live in code,
 * not tables ... referenced by extraction prompts, DB check constraints and UI
 * filter chips, and all three must agree — a TS constant with a Drizzle pgEnum
 * derived from it keeps them in lockstep."
 *
 * The literal values below are lifted from `src/data/artifact-vocab.json`.
 * They are duplicated as `as const` tuples on purpose: `resolveJsonModule`
 * widens JSON string arrays to `string[]`, which would destroy the derived
 * union types. `test/vocab.test.ts` asserts the two never drift.
 *
 * Nothing in this module may import anything with side effects — it is pulled
 * into both the worker and the browser bundle.
 */

// ── Aisles ──────────────────────────────────────────────────────────────────
// Store-walk order (Frozen last, so nothing melts in the cart), then the
// fallback bucket for ingredients the matcher could not canonicalise.

/** Aisle used when an ingredient has no canonical mapping. Always sorts last. */
export const FALLBACK_AISLE = 'Other' as const;

export const AISLES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery',
  'Grains & Pasta',
  'Canned & Jarred',
  'Pantry',
  'Spices',
  'Frozen',
  FALLBACK_AISLE,
] as const;

export type Aisle = (typeof AISLES)[number];

/** Single-letter codes from the original artifact. `Other` had none; it gets `X`. */
export const AISLE_CODES = {
  'Produce': 'P',
  'Meat & Seafood': 'M',
  'Dairy & Eggs': 'D',
  'Bakery': 'B',
  'Grains & Pasta': 'G',
  'Canned & Jarred': 'C',
  'Pantry': 'N',
  'Spices': 'S',
  'Frozen': 'F',
  'Other': 'X',
} as const satisfies Record<Aisle, string>;

const AISLE_INDEX: ReadonlyMap<string, number> = new Map(AISLES.map((a, i) => [a, i]));

export function isAisle(value: unknown): value is Aisle {
  return typeof value === 'string' && AISLE_INDEX.has(value);
}

/** Sort key for a grocery list: store-walk order, unknowns after everything. */
export function aisleSortIndex(value: string): number {
  return AISLE_INDEX.get(value) ?? AISLES.length;
}

// ── Categories ──────────────────────────────────────────────────────────────

export const CATEGORIES = [
  'Chicken',
  'Beef & Turkey',
  'Vegetarian',
  'Soup',
  'Breakfast',
  'No-reheat',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * UI filter chips only. `All` is a rendering sentinel, not a value that may
 * ever be written to `recipes.category` — hence it is excluded from
 * `CATEGORIES` and from the `category` pgEnum.
 */
export const CATEGORY_FILTER_ALL = 'All' as const;
export const CATEGORY_FILTER_UI = [CATEGORY_FILTER_ALL, ...CATEGORIES] as const;
export type CategoryFilter = (typeof CATEGORY_FILTER_UI)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

// ── Tags ────────────────────────────────────────────────────────────────────

export const TAGS = [
  '10 minutes',
  '30 minutes',
  'Better on day two',
  'Big batch',
  'Cheap',
  'Comfort',
  'Component prep',
  'Crunchy',
  'Freezes',
  'Gluten-free',
  'Grab and go',
  'Hands-off',
  'High fiber',
  'High protein',
  'Marinate ahead',
  'No cook',
  'No microwave',
  'One cleanup',
  'One pot',
  'Pantry staples',
  'Reader favorite',
  'Sheet pan',
  'Slow cooker',
  'Under 20 min',
  'Vegan',
  'Vegan option',
  'Vegetarian',
] as const;

export type Tag = (typeof TAGS)[number];

export function isTag(value: unknown): value is Tag {
  return typeof value === 'string' && (TAGS as readonly string[]).includes(value);
}

// ── Rating aspects (PLAN.md §5, Phase 6) ────────────────────────────────────

export const RATING_ASPECTS = [
  'quick',
  'slow',
  'cheap',
  'expensive',
  'tasty',
  'bland',
  'reheats_well',
  'soggy_leftovers',
  'too_much_cleanup',
  'would_repeat',
] as const;

export type RatingAspect = (typeof RATING_ASPECTS)[number];

export function isRatingAspect(value: unknown): value is RatingAspect {
  return typeof value === 'string' && (RATING_ASPECTS as readonly string[]).includes(value);
}

// ── Enumerated column vocabularies ──────────────────────────────────────────

/**
 * `pending`  — ingested, not yet through the Phase 2 suitability gate.
 * `active`   — visible in the UI.
 * `rejected` — the gate said "not meal prep"; kept, with a reason, for audit.
 */
export const RECIPE_STATUS = ['pending', 'active', 'rejected'] as const;
export type RecipeStatus = (typeof RECIPE_STATUS)[number];

export const SOURCE_KIND = ['blog', 'reddit', 'social'] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

/** Lifecycle of a row in `scan_runs`. Not in PLAN.md §4; see the report. */
export const SCAN_RUN_STATUS = ['running', 'success', 'partial', 'error'] as const;
export type ScanRunStatus = (typeof SCAN_RUN_STATUS)[number];

/**
 * What a `scan_runs` row is accounting for (FILTER_PLAN.md §6).
 *
 * A separate discriminator and **not** a reuse of `source_id is null`, which
 * already means "a run spanning every source" and is what the nightly scan
 * writes. Without this column search spend and enrichment spend are the same
 * number, and FILTER_PLAN.md §8's separate `SEARCH_DAILY_BUDGET_USD` is
 * unimplementable: one heavy enrichment night would silently kill the search
 * bar for the whole following day and give no clue why.
 */
export const SCAN_RUN_KIND = ['scan', 'search'] as const;
export type ScanRunKind = (typeof SCAN_RUN_KIND)[number];

/** The kind every pre-existing row has, and the column default. */
export const DEFAULT_SCAN_RUN_KIND = 'scan' satisfies ScanRunKind;

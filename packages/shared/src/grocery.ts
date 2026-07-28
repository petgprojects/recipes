/**
 * Grocery-list aggregation: many saved recipes → one store-ordered list.
 *
 * PLAN.md §4 calls this "where this app either feels magic or feels broken".
 * The artifact hand-authored `{item, qty, unit, aisle}` for 24 recipes and
 * merged on `` `${name}|${unit}` ``; real scraped data does not cooperate, so
 * the merge key here is the canonical ingredient identity plus the unit
 * *dimension*:
 *
 *   `{ingredient_id}:{unit_dimension}`, unmapped rows → `raw:{slug}:{...}`
 *
 * which is exactly `grocery_checks.item_key` (PLAN.md §4). That means "1 lb
 * chicken breast" and "8 oz boneless skinless chicken breasts" become one line
 * with one checkbox, while `2 cans` and `14 oz` of the same tomatoes stay two
 * lines — `unitDimensionKey()` keys count units on the unit itself, so no
 * conversion is ever invented.
 *
 * Phase 5 replaces this with the equivalent SQL over
 * `saved_recipes × recipe_ingredients × ingredients`. The key derivation and
 * the formatting are the parts that must survive that move unchanged, which is
 * why they live here rather than in a React `useMemo`.
 */

import { fmtLine } from './format';
import { convert, normalizeUnit, unitDimensionKey, type CanonicalUnit } from './units';
import { AISLES, aisleSortIndex, FALLBACK_AISLE, isAisle, type Aisle } from './vocab';

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface GroceryLineInput {
  /** Canonical ingredient id, or `null` for a row the matcher left unmapped. */
  readonly ingredientId: string | null;
  /** Canonical ingredient name when mapped; otherwise the renderable raw text. */
  readonly name: string;
  /** Raw source line. Identifies unmapped rows and is the display fallback. */
  readonly rawText: string;
  readonly aisle: string | null;
  readonly qty: number | null;
  readonly unit: string | null;
  readonly optional?: boolean;
}

export interface GroceryRecipeInput {
  readonly id: string;
  readonly title: string;
  /** The "I'm making two of these" multiplier. Defaults to 1. */
  readonly batches?: number;
  readonly ingredients: readonly GroceryLineInput[];
}

// ── Outputs ─────────────────────────────────────────────────────────────────

export interface GroceryItem {
  /** `grocery_checks.item_key`. Stable across renders and across sessions. */
  readonly key: string;
  readonly name: string;
  readonly aisle: Aisle;
  /** Total in `unit`, or `null` when no contributing line carried a quantity. */
  readonly qty: number | null;
  readonly unit: string | null;
  /** Ready to print: `1½ lb`, `2 cans`, `` when nothing is quantified. */
  readonly amount: string;
  /**
   * At least one contributing line had no parseable quantity ("salt, to
   * taste"), so the total understates. The receipt marks these with a `+`
   * rather than silently rounding them away.
   */
  readonly approximate: boolean;
  /** Every contributing line was optional. */
  readonly optional: boolean;
  /** Titles of the saved recipes that need this item, in save order. */
  readonly recipes: readonly string[];
}

export interface GroceryAisleGroup {
  readonly aisle: Aisle;
  readonly items: readonly GroceryItem[];
}

// ── Key derivation ──────────────────────────────────────────────────────────

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unknown'
  );
}

/**
 * The identity half of the key. An unmapped row keys on its own text, so two
 * different unparseable lines never collapse into one another.
 */
export function groceryIdentityKey(ingredientId: string | null, rawText: string): string {
  return ingredientId ?? `raw:${slugify(rawText)}`;
}

export function groceryItemKey(
  ingredientId: string | null,
  rawText: string,
  unit: string | null,
): string {
  return `${groceryIdentityKey(ingredientId, rawText)}:${unitDimensionKey(unit)}`;
}

/**
 * A line with no parseable quantity ("kosher salt, to taste") has no dimension
 * to key on. It gets its own bucket, which is then folded into the same
 * ingredient's real line if there is one — otherwise it stands alone, because
 * a renderable row with an unknown amount still belongs on the list.
 */
const UNSPECIFIED = 'unspecified';

// ── Aggregation ─────────────────────────────────────────────────────────────

interface Bucket {
  key: string;
  identity: string;
  name: string;
  /** Set once by the first mapped line; a canonical name beats raw text. */
  named: boolean;
  aisle: Aisle;
  quantified: { qty: number; unit: CanonicalUnit | null; rawUnit: string | null }[];
  approximate: boolean;
  optional: boolean;
  order: number;
  recipes: Set<string>;
}

export function aggregateGroceries(
  recipes: readonly GroceryRecipeInput[],
): GroceryAisleGroup[] {
  const buckets = new Map<string, Bucket>();
  let order = 0;

  for (const recipe of recipes) {
    const batches = Math.max(1, Math.round(recipe.batches ?? 1));

    for (const line of recipe.ingredients) {
      const quantified = line.qty !== null && Number.isFinite(line.qty);
      const identity = groceryIdentityKey(line.ingredientId, line.rawText);
      const key = quantified
        ? `${identity}:${unitDimensionKey(line.unit)}`
        : `${identity}:${UNSPECIFIED}`;
      const display = line.name.trim() === '' ? line.rawText.trim() : line.name.trim();

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          key,
          identity,
          name: display,
          named: line.ingredientId !== null,
          aisle: isAisle(line.aisle) ? line.aisle : FALLBACK_AISLE,
          quantified: [],
          approximate: false,
          optional: true,
          order: order++,
          recipes: new Set(),
        };
        buckets.set(key, bucket);
      } else if (!bucket.named && line.ingredientId !== null) {
        bucket.name = display;
        bucket.named = true;
        if (isAisle(line.aisle)) bucket.aisle = line.aisle;
      }

      bucket.recipes.add(recipe.title);
      if (line.optional !== true) bucket.optional = false;

      if (!quantified) {
        bucket.approximate = true;
      } else {
        bucket.quantified.push({
          qty: line.qty! * batches,
          unit: normalizeUnit(line.unit),
          rawUnit: line.unit,
        });
      }
    }
  }

  foldUnspecifiedBuckets(buckets);

  const grouped = new Map<Aisle, GroceryItem[]>();
  for (const bucket of buckets.values()) {
    const item = finalize(bucket);
    const list = grouped.get(item.aisle);
    if (list === undefined) grouped.set(item.aisle, [item]);
    else list.push(item);
  }

  return AISLES.filter((aisle) => grouped.has(aisle))
    .sort((a, b) => aisleSortIndex(a) - aisleSortIndex(b))
    .map((aisle) => ({
      aisle,
      items: (grouped.get(aisle) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
      ),
    }));
}

/**
 * "Salt, to taste" alongside "1 tsp salt" is one shopping line, not two. Each
 * unspecified bucket is folded into the earliest real line for the same
 * ingredient, which inherits its recipes and an `approximate` flag; a bucket
 * with no real line to join survives on its own.
 */
function foldUnspecifiedBuckets(buckets: Map<string, Bucket>): void {
  const byIdentity = new Map<string, Bucket>();
  for (const bucket of buckets.values()) {
    if (bucket.quantified.length === 0) continue;
    const existing = byIdentity.get(bucket.identity);
    if (existing === undefined || bucket.order < existing.order) {
      byIdentity.set(bucket.identity, bucket);
    }
  }

  for (const [key, bucket] of buckets) {
    if (!key.endsWith(`:${UNSPECIFIED}`)) continue;
    const target = byIdentity.get(bucket.identity);
    if (target === undefined) continue;

    target.approximate = true;
    for (const title of bucket.recipes) target.recipes.add(title);
    if (!bucket.optional) target.optional = false;
    buckets.delete(key);
  }
}

/**
 * Every quantified line in a bucket shares a dimension — that is what the key
 * guarantees — so the only question is which unit to *print*. Prefer the
 * largest unit that still leaves a total of at least 1: `2 tbsp + 1 cup` reads
 * `1⅛ cup` rather than `18 tbsp`, and `1 tbsp + ½ cup` reads `9 tbsp` rather
 * than `⁹⁄₁₆ cup`. Ties fall back to the unit written most often, then the one
 * written first, so the result never depends on map iteration order.
 */
function finalize(bucket: Bucket): GroceryItem {
  const { quantified } = bucket;

  if (quantified.length === 0) {
    return {
      key: bucket.key,
      name: bucket.name,
      aisle: bucket.aisle,
      qty: null,
      unit: null,
      amount: '',
      approximate: true,
      optional: bucket.optional,
      recipes: [...bucket.recipes],
    };
  }

  // Unrecognised units cannot be converted. The key already slugs the unit
  // string, so every line here wrote it the same way: sum and print verbatim.
  if (quantified[0]!.unit === null) {
    const total = quantified.reduce((sum, line) => sum + line.qty, 0);
    const unit = quantified[0]!.rawUnit;
    return {
      key: bucket.key,
      name: bucket.name,
      aisle: bucket.aisle,
      qty: total,
      unit,
      amount: fmtLine(total, unit),
      approximate: bucket.approximate,
      optional: bucket.optional,
      recipes: [...bucket.recipes],
    };
  }

  const frequency = new Map<CanonicalUnit, { count: number; first: number }>();
  quantified.forEach((line, index) => {
    const unit = line.unit;
    if (unit === null) return;
    const entry = frequency.get(unit);
    if (entry === undefined) frequency.set(unit, { count: 1, first: index });
    else entry.count += 1;
  });

  const candidates = [...frequency.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .map(([unit]) => ({ unit, total: totalIn(quantified, unit) }))
    .filter((candidate): candidate is { unit: CanonicalUnit; total: number } =>
      candidate.total !== null,
    );

  if (candidates.length === 0) {
    // Only reachable if a bucket was assembled by hand from mismatched units.
    // Report the raw sum rather than inventing a conversion.
    const total = quantified.reduce((sum, line) => sum + line.qty, 0);
    return {
      key: bucket.key,
      name: bucket.name,
      aisle: bucket.aisle,
      qty: total,
      unit: quantified[0]!.rawUnit,
      amount: fmtLine(total, quantified[0]!.rawUnit),
      approximate: true,
      optional: bucket.optional,
      recipes: [...bucket.recipes],
    };
  }

  const readable = candidates.filter((candidate) => candidate.total >= 1);
  // Smallest total ≥ 1 is the largest usable unit; with none, the largest total
  // is the smallest unit, which is the least bad way to say "not much".
  const best =
    readable.length > 0
      ? readable.reduce((a, b) => (b.total < a.total ? b : a))
      : candidates.reduce((a, b) => (b.total > a.total ? b : a));

  const chosen = best.unit;
  const qty = best.total;
  return {
    key: bucket.key,
    name: bucket.name,
    aisle: bucket.aisle,
    qty,
    unit: chosen,
    amount: fmtLine(qty, chosen),
    approximate: bucket.approximate,
    optional: bucket.optional,
    recipes: [...bucket.recipes],
  };
}

function totalIn(
  lines: readonly { qty: number; unit: CanonicalUnit | null }[],
  target: CanonicalUnit,
): number | null {
  let total = 0;
  for (const line of lines) {
    const converted = convert(line.qty, line.unit, target);
    // Cross-dimension merging is structurally impossible here; a null means the
    // caller built a bucket by hand from mismatched units, and a wrong total is
    // worse than no total.
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

/** Convenience for the receipt header: how many distinct lines to shop for. */
export function countGroceryItems(groups: readonly GroceryAisleGroup[]): number {
  return groups.reduce((sum, group) => sum + group.items.length, 0);
}

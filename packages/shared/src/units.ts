/**
 * Unit normalisation and conversion.
 *
 * PLAN.md §4: "Unit merging only happens **within a dimension** (tbsp↔cup↔ml,
 * oz↔lb↔g). Never merge `2 cans` with `14 oz`; show them as separate lines on
 * the same item rather than inventing a conversion."
 *
 * So there are three dimensions — `mass`, `volume` and `count` — and `count` is
 * a deliberate dead end: a can is not a number of millilitres, an "inch" of
 * ginger is not a mass, and pretending otherwise silently corrupts a grocery
 * list. `convert()` returns `null` instead of throwing whenever the answer is
 * not knowable, because every caller here is aggregating a shopping list and
 * wants to fall back to a separate line, not crash.
 */

export const UNIT_DIMENSIONS = ['mass', 'volume', 'count'] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

// ── Canonical units ─────────────────────────────────────────────────────────

export const MASS_UNITS = ['mg', 'g', 'kg', 'oz', 'lb'] as const;
export const VOLUME_UNITS = ['ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'quart', 'gallon'] as const;

/**
 * Countable / ambiguous units. Every one of these came out of the artifact's
 * ingredient data, plus `clove` and `each`. They never convert to anything —
 * not even to each other (`1 can` is not `1 head`).
 *
 * `each` is the canonical form of the empty unit (`""`), i.e. "3 avocados".
 */
export const COUNT_UNITS = [
  'each',
  'can',
  'bunch',
  'stalk',
  'slice',
  'head',
  'inch',
  'clove',
  'pint',
] as const;

export type MassUnit = (typeof MASS_UNITS)[number];
export type VolumeUnit = (typeof VOLUME_UNITS)[number];
export type CountUnit = (typeof COUNT_UNITS)[number];
export type CanonicalUnit = MassUnit | VolumeUnit | CountUnit;

export const CANONICAL_UNITS = [...MASS_UNITS, ...VOLUME_UNITS, ...COUNT_UNITS] as const;

/** The unit every other unit in a dimension is expressed in. */
export const BASE_UNIT = {
  mass: 'g',
  volume: 'ml',
  count: 'each',
} as const satisfies Record<UnitDimension, CanonicalUnit>;

// ── Conversion factors, expressed in the dimension's base unit ──────────────
// US customary volume (the recipe corpus is US); mass is exact by definition
// (1 lb === 453.59237 g).

const FACTORS: Record<CanonicalUnit, number> = {
  // mass → grams
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
  // volume → millilitres
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  'fl oz': 29.5735295625,
  cup: 236.5882365,
  quart: 946.352946,
  gallon: 3785.411784,
  // count → itself; present so the record is total, never used for conversion
  each: 1,
  can: 1,
  bunch: 1,
  stalk: 1,
  slice: 1,
  head: 1,
  inch: 1,
  clove: 1,
  pint: 1,
};

const DIMENSION_OF: Record<CanonicalUnit, UnitDimension> = {
  ...(Object.fromEntries(MASS_UNITS.map((u) => [u, 'mass'])) as Record<MassUnit, UnitDimension>),
  ...(Object.fromEntries(VOLUME_UNITS.map((u) => [u, 'volume'])) as Record<
    VolumeUnit,
    UnitDimension
  >),
  ...(Object.fromEntries(COUNT_UNITS.map((u) => [u, 'count'])) as Record<CountUnit, UnitDimension>),
};

// ── Aliases ─────────────────────────────────────────────────────────────────

/**
 * Case-SENSITIVE aliases, checked first. This exists for exactly one collision:
 * in recipe writing `T` is tablespoon and `t` is teaspoon. Lower-casing before
 * lookup would silently triple every such quantity.
 */
export const CASE_SENSITIVE_UNIT_ALIASES: Record<string, CanonicalUnit> = {
  T: 'tbsp',
  Tb: 'tbsp',
  Tbs: 'tbsp',
  Tbsp: 'tbsp',
  t: 'tsp',
  C: 'cup',
};

/** Case-insensitive aliases. Keys must be lower-case, trimmed, punctuation-free. */
export const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  // mass
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  g: 'g',
  gr: 'g',
  gram: 'g',
  grams: 'g',
  gramme: 'g',
  grammes: 'g',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ozs: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',

  // volume
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  cc: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  tsp: 'tsp',
  tsps: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tbsp: 'tbsp',
  tbsps: 'tbsp',
  tbs: 'tbsp',
  tb: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  'fl oz': 'fl oz',
  floz: 'fl oz',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  cup: 'cup',
  cups: 'cup',
  quart: 'quart',
  quarts: 'quart',
  qt: 'quart',
  qts: 'quart',
  gallon: 'gallon',
  gallons: 'gallon',
  gal: 'gallon',

  // count
  '': 'each',
  each: 'each',
  ea: 'each',
  whole: 'each',
  piece: 'each',
  pieces: 'each',
  pc: 'each',
  pcs: 'each',
  can: 'can',
  cans: 'can',
  tin: 'can',
  tins: 'can',
  bunch: 'bunch',
  bunches: 'bunch',
  stalk: 'stalk',
  stalks: 'stalk',
  rib: 'stalk',
  ribs: 'stalk',
  slice: 'slice',
  slices: 'slice',
  head: 'head',
  heads: 'head',
  inch: 'inch',
  inches: 'inch',
  '"': 'inch',
  clove: 'clove',
  cloves: 'clove',
  pint: 'pint',
  pints: 'pint',
  pt: 'pint',
};

/**
 * `2 Tbsp.` → `tbsp`, `"  Ounces "` → `oz`, `""`/`null` → `each`.
 * Returns `null` for anything not in the vocabulary, so callers can route the
 * line to the "unmergeable" bucket rather than guessing.
 */
export function normalizeUnit(unit: string | null | undefined): CanonicalUnit | null {
  if (unit === null || unit === undefined) return 'each';

  const trimmed = unit.trim();
  const caseSensitive = CASE_SENSITIVE_UNIT_ALIASES[trimmed];
  if (caseSensitive) return caseSensitive;

  // Strip trailing periods ("Tbsp.") and collapse internal whitespace
  // ("fluid  ounces"), then match case-insensitively.
  const key = trimmed.toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
  return UNIT_ALIASES[key] ?? null;
}

/** The dimension a unit belongs to, or `null` if the unit is unrecognised. */
export function unitDimension(unit: string | null | undefined): UnitDimension | null {
  const canonical = normalizeUnit(unit);
  return canonical === null ? null : DIMENSION_OF[canonical];
}

export function isSameDimension(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = unitDimension(a);
  return da !== null && da === unitDimension(b);
}

/**
 * Convert `qty` from one unit to another.
 *
 * Returns `null` — never throws — when:
 *   - either unit is outside the vocabulary;
 *   - the units belong to different dimensions (`14 oz` → `can`);
 *   - both are `count` units but not the same one (`can` → `head`).
 *
 * A `count` unit converts only to itself, which makes `2 cans` and `14 oz`
 * structurally incapable of merging.
 */
export function convert(
  qty: number,
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!Number.isFinite(qty)) return null;

  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (a === null || b === null) return null;

  // Short-circuit the identity so `tsp -> tsp` is exact rather than
  // `(qty * 4.92892159375) / 4.92892159375`, which is off by an ulp.
  if (a === b) return qty;

  const dim = DIMENSION_OF[a];
  if (dim !== DIMENSION_OF[b]) return null;

  if (dim === 'count') return a === b ? qty : null;

  return (qty * FACTORS[a]) / FACTORS[b];
}

/** `qty` expressed in the dimension's base unit (grams / millilitres / items). */
export function toBaseUnit(
  qty: number,
  unit: string | null | undefined,
): { qty: number; unit: CanonicalUnit; dimension: UnitDimension } | null {
  const canonical = normalizeUnit(unit);
  if (canonical === null || !Number.isFinite(qty)) return null;

  const dimension = DIMENSION_OF[canonical];
  if (dimension === 'count') return { qty, unit: canonical, dimension };

  return { qty: qty * FACTORS[canonical], unit: BASE_UNIT[dimension], dimension };
}

/**
 * The dimension component of `grocery_checks.item_key`
 * (PLAN.md §4: `{ingredient_id}:{unit_dimension}`).
 *
 * `count` units key on the unit itself, not on the string `"count"` — cans and
 * heads of the same ingredient are genuinely separate shopping lines, and
 * giving them one shared checkbox would tick both at once. Unknown units get
 * their slugified selves so they at least stay stable across renders.
 */
export function unitDimensionKey(unit: string | null | undefined): string {
  const canonical = normalizeUnit(unit);
  if (canonical === null) {
    return `unit:${(unit ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown'}`;
  }
  const dimension = DIMENSION_OF[canonical];
  return dimension === 'count' ? `count:${canonical}` : dimension;
}

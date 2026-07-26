/**
 * The canonical ingredient seed.
 *
 * PLAN.md §4: "Seed the canonical table with the ~120 ingredients already in
 * the artifact — they're clean, hand-classified, and cover the common cases."
 * This is the one piece of `meal-prep-planner.jsx` kept as data.
 *
 * The JSON is the source of truth; this module only puts a type on it. It is
 * NOT validated with Zod at import time — that would run 117 parses in every
 * browser bundle that happens to want the aisle list. `test/vocab.test.ts`
 * validates the file instead, which is where drift would actually be caught.
 */

import { z } from 'zod';
import rawSeed from './data/ingredient-seed.json';
import { AISLES, type Aisle } from './vocab';

export interface SeedIngredient {
  /** Lower-case canonical name. Unique — it is the `ingredients.name` key. */
  readonly name: string;
  readonly aisle: Aisle;
  /** The unit this is usually bought in, or null for things counted whole. */
  readonly defaultUnit: string | null;
}

/** Shape check used by the tests and available to the seeder. */
export const seedIngredientSchema = z.object({
  name: z.string().trim().min(1),
  aisle: z.enum(AISLES),
  defaultUnit: z.string().trim().min(1).nullable(),
});

export const ingredientSeedSchema = z.array(seedIngredientSchema);

/** All 117 hand-classified canonical ingredients, in file order. */
export const CANONICAL_INGREDIENTS: readonly SeedIngredient[] = rawSeed as SeedIngredient[];

const BY_NAME: ReadonlyMap<string, SeedIngredient> = new Map(
  CANONICAL_INGREDIENTS.map((i) => [i.name.toLowerCase(), i]),
);

export function findSeedIngredient(name: string): SeedIngredient | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

/** Every aisle that actually appears in the seed data, in store-walk order. */
export function seededAisles(): Aisle[] {
  const present = new Set(CANONICAL_INGREDIENTS.map((i) => i.aisle));
  return AISLES.filter((a) => present.has(a));
}

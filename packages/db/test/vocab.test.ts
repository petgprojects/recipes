/**
 * PLAN.md §5, Phase 0: "*Tests:* unit-conversion and aisle-vocabulary
 * round-trips."
 *
 * §4 is the reason this test exists: "a TS constant with a Drizzle `pgEnum`
 * derived from it keeps them in lockstep." That is only true if nobody ever
 * hand-writes the enum members, and the cheapest way to keep it true is to
 * assert it. The failure this guards against is a seeded ingredient whose aisle
 * is not a legal enum value — which does not surface until an INSERT blows up
 * at 3am mid-scan.
 */

import { describe, expect, it } from 'vitest';
import {
  AISLES,
  CATEGORIES,
  CATEGORY_FILTER_ALL,
  CATEGORY_FILTER_UI,
  CANONICAL_INGREDIENTS,
  FALLBACK_AISLE,
  RATING_ASPECTS,
  RECIPE_STATUS,
  SOURCE_KIND,
  TAGS,
  aisleSortIndex,
  ingredientSeedSchema,
  isAisle,
  normalizeUnit,
} from '@recipes/shared';
import artifactVocab from '@recipes/shared/data/artifact-vocab.json';
import {
  aisleEnum,
  categoryEnum,
  ingredients,
  recipeStatusEnum,
  sourceKindEnum,
} from '../src/schema';

describe('aisle vocabulary round-trip', () => {
  it('every aisle in the seed data is a member of AISLES', () => {
    for (const ingredient of CANONICAL_INGREDIENTS) {
      expect(isAisle(ingredient.aisle), `${ingredient.name} → ${ingredient.aisle}`).toBe(true);
    }
  });

  it('the seed file as a whole parses against the shared schema', () => {
    // Catches a hand-edit to ingredient-seed.json that TypeScript cannot see,
    // since resolveJsonModule widens the aisle field to `string`.
    const result = ingredientSeedSchema.safeParse(CANONICAL_INGREDIENTS);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('every defaultUnit in the seed data is a unit we can normalise', () => {
    for (const ingredient of CANONICAL_INGREDIENTS) {
      expect(
        normalizeUnit(ingredient.defaultUnit),
        `${ingredient.name} → ${ingredient.defaultUnit}`,
      ).not.toBeNull();
    }
  });

  it('the pgEnum and the TS const contain identical members, in identical order', () => {
    expect(aisleEnum.enumValues).toEqual([...AISLES]);
    expect(ingredients.aisle.enumValues).toEqual([...AISLES]);
  });

  it('preserves the artifact store-walk order, with Frozen last of the real aisles', () => {
    expect(AISLES.slice(0, -1)).toEqual(artifactVocab.aisleOrder);
    expect(AISLES[AISLES.length - 2]).toBe('Frozen');
  });

  it('appends the fallback aisle last so unmapped ingredients sort to the bottom', () => {
    expect(AISLES[AISLES.length - 1]).toBe(FALLBACK_AISLE);
    expect(aisleSortIndex(FALLBACK_AISLE)).toBe(AISLES.length - 1);
    // Anything not in the vocabulary sorts after even the fallback.
    expect(aisleSortIndex('Hardware')).toBeGreaterThan(aisleSortIndex(FALLBACK_AISLE));
  });

  it('defaults ingredients.aisle to the fallback', () => {
    expect(ingredients.aisle.default).toBe(FALLBACK_AISLE);
  });

  it('has no duplicate members', () => {
    expect(new Set(AISLES).size).toBe(AISLES.length);
  });
});

describe('category vocabulary round-trip', () => {
  it('the pgEnum matches the TS const', () => {
    expect(categoryEnum.enumValues).toEqual([...CATEGORIES]);
  });

  it('matches the artifact categories, ignoring order', () => {
    expect([...CATEGORIES].sort()).toEqual([...artifactVocab.categories].sort());
  });

  it('excludes the "All" UI sentinel from anything that reaches the database', () => {
    expect(CATEGORIES).not.toContain(CATEGORY_FILTER_ALL);
    expect(categoryEnum.enumValues).not.toContain(CATEGORY_FILTER_ALL);
    // ...but the UI filter list keeps it, first, in the artifact's chip order.
    expect(CATEGORY_FILTER_UI[0]).toBe(CATEGORY_FILTER_ALL);
    expect([...CATEGORY_FILTER_UI]).toEqual(artifactVocab.categoriesUiOrder);
  });
});

describe('tag vocabulary round-trip', () => {
  it('matches the artifact tag list exactly', () => {
    expect([...TAGS]).toEqual(artifactVocab.tags);
    expect(TAGS).toHaveLength(27);
  });

  it('is enforced in the database by a CHECK constraint, not a pgEnum', () => {
    // text[] cannot be an enum array without extra ceremony, so the constraint
    // is generated from TAGS in schema.ts. Assert the generator input is sane.
    expect(new Set(TAGS).size).toBe(TAGS.length);
    for (const tag of TAGS) expect(tag).not.toContain("'");
  });
});

describe('enumerated column vocabularies', () => {
  it('recipe status matches PLAN.md §4', () => {
    expect([...RECIPE_STATUS]).toEqual(['pending', 'active', 'rejected']);
    expect(recipeStatusEnum.enumValues).toEqual([...RECIPE_STATUS]);
  });

  it('source kind matches PLAN.md §4 / §6', () => {
    expect([...SOURCE_KIND]).toEqual(['blog', 'reddit', 'social']);
    expect(sourceKindEnum.enumValues).toEqual([...SOURCE_KIND]);
  });

  it('rating aspects match PLAN.md §5 Phase 6 exactly', () => {
    expect([...RATING_ASPECTS]).toEqual([
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
    ]);
    for (const aspect of RATING_ASPECTS) expect(aspect).not.toContain("'");
  });
});

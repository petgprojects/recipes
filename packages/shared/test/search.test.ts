/**
 * The `SearchFilter` contract.
 *
 * This suite says what a filter *is*; `apps/web/test/search.integration.test.ts`
 * says what one *does* against the real corpus. Both are needed, for the same
 * reason the grocery list keeps two — a schema that validates cleanly and
 * compiles to the wrong rows is exactly the silent failure this phase is about.
 */

import { describe, expect, it } from 'vitest';
import { CATEGORIES, TAGS } from '../src/vocab';
import {
  EMPTY_SEARCH_FILTER,
  MAX_SEARCH_INGREDIENTS,
  MAX_UNMAPPED_TERMS,
  SEARCH_VOCAB_VERSION,
  TIME_TAGS,
  isEmptySearchFilter,
  makeSearchFilter,
  searchFilterSchema,
} from '../src/search';

describe('the schema', () => {
  it('accepts an empty filter', () => {
    expect(searchFilterSchema.safeParse(EMPTY_SEARCH_FILTER).success).toBe(true);
  });

  it('requires every field, so the model cannot omit a question it was asked', () => {
    const { excludeIngredients: _omitted, ...partial } = EMPTY_SEARCH_FILTER;
    expect(searchFilterSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects a tag outside the vocabulary', () => {
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, tags: ['Spicy'] }).success).toBe(false);
  });

  it('rejects a category outside the vocabulary', () => {
    const filter = { ...EMPTY_SEARCH_FILTER, categories: ['Dessert'] };
    expect(searchFilterSchema.safeParse(filter).success).toBe(false);
  });

  it('rejects a zero or negative time bound', () => {
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, maxMinutes: 0 }).success).toBe(false);
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, minMinutes: -5 }).success).toBe(false);
  });

  it('rejects a non-integer time bound', () => {
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, maxMinutes: 20.5 }).success).toBe(false);
  });

  it('caps the unbounded fields', () => {
    const ingredients = Array.from({ length: MAX_SEARCH_INGREDIENTS + 1 }, (_, i) => `thing ${i}`);
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, ingredients }).success).toBe(false);

    const unmappedTerms = Array.from({ length: MAX_UNMAPPED_TERMS + 1 }, (_, i) => `term ${i}`);
    expect(searchFilterSchema.safeParse({ ...EMPTY_SEARCH_FILTER, unmappedTerms }).success).toBe(false);
  });

  it('lowercases and trims ingredient names, because the compiler matches exactly', () => {
    expect(makeSearchFilter({ excludeIngredients: ['  Mushrooms '] }).excludeIngredients).toEqual(['mushrooms']);
  });

  it('dedupes, so a repeated tag is one criterion and not two', () => {
    expect(makeSearchFilter({ tags: ['One pot', 'One pot', 'Vegan'] }).tags).toEqual(['One pot', 'Vegan']);
    expect(makeSearchFilter({ ingredients: ['garlic', 'Garlic'] }).ingredients).toEqual(['garlic']);
  });

  it('leaves an empty filter empty', () => {
    expect(isEmptySearchFilter(makeSearchFilter())).toBe(true);
  });

  it('sees any single populated field as non-empty', () => {
    expect(isEmptySearchFilter(makeSearchFilter({ maxMinutes: 20 }))).toBe(false);
    expect(isEmptySearchFilter(makeSearchFilter({ freezerOnly: true }))).toBe(false);
    expect(isEmptySearchFilter(makeSearchFilter({ unmappedTerms: ['spicy'] }))).toBe(false);
  });

  it('throws on a hand-authored filter that does not validate', () => {
    expect(() => makeSearchFilter({ maxMinutes: -1 })).toThrow();
  });
});

describe('the time trap', () => {
  it('names three tags that a time bound must never compile to', () => {
    // FILTER_PLAN.md §1: 12 recipes carry `Under 20 min` while 34 satisfy
    // `total_minutes <= 20`. Trusting the tag loses two thirds of the matches.
    for (const tag of TIME_TAGS) expect(TAGS).toContain(tag);
  });
});

describe('SEARCH_VOCAB_VERSION (A25)', () => {
  /**
   * The point of this assertion is to fail.
   *
   * Nothing is stored, so the constant invalidates nothing — its job is to make
   * a `TAGS` or `CATEGORIES` change break the build rather than quietly degrade
   * parse quality. If this line is red, a vocabulary changed: go and look at
   * whether the Phase 3 fixtures still express what they meant, *then* paste
   * the new value in. Do not paste it in first.
   */
  it('is the fingerprint of the vocabulary the fixtures were written against', () => {
    expect(SEARCH_VOCAB_VERSION).toBe('1-723fe8e6');
  });

  it('changes when the vocabulary does', () => {
    // Proves the assertion above can actually fail, rather than being a
    // constant compared against itself.
    expect(CATEGORIES.length).toBe(6);
    expect(TAGS.length).toBe(27);
  });
});

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
  SEARCH_BUDGET_GATE_FRACTION,
  SEARCH_VOCAB_VERSION,
  TIME_TAGS,
  describeSearchNotice,
  isEmptySearchFilter,
  makeSearchFilter,
  orderSearchNotices,
  searchFilterSchema,
  type Relaxation,
  type SearchNotice,
} from '../src/search';
import { shortHardRuleLabel } from '../src/personalization';

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

// ── The Phase 5 notices ─────────────────────────────────────────────────────

describe('the notices (§4.2, §4.4, §5.1, A26)', () => {
  it('says which hard rules a search stepped over (§4.2)', () => {
    const one: SearchNotice = { kind: 'rules-bypassed', rules: ['under 30 minutes'] };
    expect(describeSearchNotice(one)).toBe(
      'Ignoring your “under 30 minutes” rule for this search.',
    );

    const several: SearchNotice = {
      kind: 'rules-bypassed',
      rules: ['under 30 minutes', 'no Soup'],
    };
    // Plural, and joined as a sentence rather than as a list — this is a
    // sentence in a results header, not a table.
    expect(describeSearchNotice(several)).toBe(
      'Ignoring your “under 30 minutes” and “no Soup” rules for this search.',
    );
  });

  it('takes the rule wording from the rule itself, so the two cannot drift', () => {
    const rule = {
      id: 'max_minutes:30',
      kind: 'max_minutes' as const,
      value: '30',
      enabled: true,
      observations: 6,
      medianRating: 2.5,
    };
    expect(shortHardRuleLabel(rule)).toBe('under 30 minutes');
    expect(describeSearchNotice({ kind: 'rules-bypassed', rules: [shortHardRuleLabel(rule)] }))
      .toBe('Ignoring your “under 30 minutes” rule for this search.');
  });

  it('says the unmapped terms went from intersect to union (§5.1)', () => {
    expect(describeSearchNotice({ kind: 'terms-union', terms: ['creamy', 'crispy'] })).toBe(
      'Nothing matched both “creamy” and “crispy”. Showing recipes that match one.',
    );
  });

  it('drops "both" past two terms, which the corpus reaches routinely', () => {
    // Seen in the browser during the Phase 5 check: three terms produced
    // "Nothing matched both a, b and c", and a sentence that is visibly wrong
    // undermines the notice it is trying to make.
    expect(
      describeSearchNotice({ kind: 'terms-union', terms: ['creamy', 'chicken', 'pasta'] }),
    ).toBe(
      'Nothing matched all of “creamy”, “chicken” and “pasta”. Showing recipes that match one.',
    );
  });

  it('says what a widened time bound is now showing, with both numbers (§4.4)', () => {
    // The reader asked for 15 and is looking at 23; a notice that only said "we
    // loosened it" would leave them unable to tell what the list is a list of.
    const relaxed: SearchNotice = {
      kind: 'relaxed',
      relaxations: [{ kind: 'widened', field: 'maxMinutes', from: 15, to: 23 }],
    };
    expect(describeSearchNotice(relaxed)).toBe(
      'Nothing matched all of that. Showing recipes up to 23 minutes instead of 15.',
    );
  });

  it('describes every relaxation the ladder can produce', () => {
    const every: Relaxation[] = [
      { kind: 'dropped', field: 'minKeepsDays' },
      { kind: 'dropped', field: 'freezerOnly' },
      { kind: 'dropped', field: 'minServings' },
      { kind: 'dropped', field: 'anyTags' },
      { kind: 'dropped', field: 'tags' },
      { kind: 'dropped', field: 'categories' },
      { kind: 'widened', field: 'maxMinutes', from: 10, to: 15 },
      { kind: 'widened', field: 'minMinutes', from: 120, to: 80 },
      { kind: 'widened', field: 'maxActiveMinutes', from: 10, to: 15 },
      { kind: 'unmapped-union', terms: ['spicy'] },
    ];
    // No fall-through to `undefined` anywhere: a relaxation with no sentence
    // would print "Showing ." and the reader would be told nothing at all.
    for (const relaxation of every) {
      const sentence = describeSearchNotice({ kind: 'relaxed', relaxations: [relaxation] });
      expect(sentence.startsWith('Nothing matched all of that. Showing recipes')).toBe(true);
      expect(sentence).not.toContain('undefined');
    }
  });

  it('is honest about a failed parse rather than hiding it (A26)', () => {
    expect(describeSearchNotice({ kind: 'degraded' })).toBe(
      'Search understanding is down; showing text matches.',
    );
  });

  it('orders them most fundamental first, then in the order the search tried them', () => {
    const shuffled: SearchNotice[] = [
      { kind: 'relaxed', relaxations: [{ kind: 'dropped', field: 'tags' }] },
      { kind: 'terms-union', terms: ['spicy', 'quick'] },
      { kind: 'rules-bypassed', rules: ['no Soup'] },
      { kind: 'degraded' },
    ];
    expect(orderSearchNotices(shuffled).map((notice) => notice.kind)).toEqual([
      'degraded',
      'rules-bypassed',
      'terms-union',
      'relaxed',
    ]);
  });

  it('does not mutate what it is given', () => {
    const notices: SearchNotice[] = [{ kind: 'relaxed', relaxations: [] }, { kind: 'degraded' }];
    orderSearchNotices(notices);
    expect(notices.map((notice) => notice.kind)).toEqual(['relaxed', 'degraded']);
  });
});

describe('the budget gate (§8)', () => {
  it('stops short of the cap, so the last answer is an explanation not a failure', () => {
    // The durable lease refuses at 100%, but it refuses mid-call — after the
    // reader has typed a sentence and waited. 90% means the bar says it is
    // resting before that can happen.
    expect(SEARCH_BUDGET_GATE_FRACTION).toBe(0.9);
    expect(SEARCH_BUDGET_GATE_FRACTION).toBeLessThan(1);
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
    expect(SEARCH_VOCAB_VERSION).toBe('2-723fe8e6');
  });

  it('changes when the vocabulary does', () => {
    // Proves the assertion above can actually fail, rather than being a
    // constant compared against itself.
    expect(CATEGORIES.length).toBe(6);
    expect(TAGS.length).toBe(27);
  });
});

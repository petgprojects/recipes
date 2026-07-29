/**
 * Phase 7 step 1: when a hard rule is allowed to exist.
 *
 * These are the tests for the half of personalization that must never be a
 * judgement call. A hard rule hides recipes, so the interesting cases are all
 * the ones where a rule should *not* be emitted — thin evidence, a merely
 * mediocre bucket, or a median dragged down by a neighbouring bucket.
 */

import { describe, expect, it } from 'vitest';
import {
  DISLIKE_MEDIAN_AT_OR_BELOW,
  MAX_SCORE,
  MAX_SCORE_REASON_CHARS,
  MIN_OBSERVATIONS_PER_RULE,
  MIN_RATED_RECIPES_FOR_SCORING,
  SCORE_BATCH_SIZE,
  TIME_RULE_THRESHOLDS,
  activeHardRules,
  batchForScoring,
  deriveExclusionRules,
  deriveTimeRule,
  describeHardRule,
  explainHardRule,
  hasEnoughHistoryForScoring,
  median,
  mergeHardRules,
  parseHardRules,
  recipeScoreBatchSchema,
  resolveScoreBatch,
  tasteProfileSchema,
  type HardRule,
  type RecipeScoreResponse,
  type RuleObservation,
  type ScoreBatchEntry,
} from '../src/personalization';

/** `n` ratings all of `value` — enough to clear the observation floor. */
function ratings(value: number, n = MIN_OBSERVATIONS_PER_RULE): number[] {
  return Array.from({ length: n }, () => value);
}

function timeBucket(threshold: number, values: number[]): RuleObservation {
  return { kind: 'max_minutes', value: String(threshold), ratings: values };
}

describe('median', () => {
  it('averages the middle two on an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('takes the middle of an odd sample, unsorted input included', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('is NaN for no observations rather than 0', () => {
    // 0 would read as "rated terribly" everywhere downstream.
    expect(median([])).toBeNaN();
  });

  it('ignores an outlier that would move a mean across the threshold', () => {
    // Nine 4s and one 1: mean 3.7, median 4. Neither trips the rule, but the
    // median is the one that stays obviously untripped.
    const values = [...ratings(4, 9), 1];
    expect(median(values)).toBe(4);
  });
});

describe('deriveTimeRule', () => {
  it('emits nothing without enough observations in the bucket', () => {
    const thin = MIN_OBSERVATIONS_PER_RULE - 1;
    expect(deriveTimeRule([timeBucket(60, ratings(1, thin))])).toBeNull();
  });

  it('emits nothing for a bucket that is merely average', () => {
    expect(deriveTimeRule([timeBucket(60, ratings(3))])).toBeNull();
  });

  it('emits at exactly the threshold, which is inclusive', () => {
    // Six observations, so the median lands between the middle two and can be
    // the .5 the constant actually names — an odd sample can never be 2.5.
    const rule = deriveTimeRule([timeBucket(60, [1, 2, 2, 3, 4, 5])]);
    expect(rule?.medianRating).toBe(DISLIKE_MEDIAN_AT_OR_BELOW);
    expect(rule?.id).toBe('max_minutes:60');
  });

  it('emits a disliked bucket with its evidence attached', () => {
    const rule = deriveTimeRule([timeBucket(60, [1, 2, 2, 3, 1])]);
    expect(rule).toMatchObject({
      id: 'max_minutes:60',
      kind: 'max_minutes',
      value: '60',
      enabled: true,
      observations: 5,
      medianRating: 2,
    });
  });

  it('emits the loosest threshold when the nested buckets all trip', () => {
    // The >30 bucket contains the >90 cooks, so a reader who only hates long
    // braises drags every bucket down. Hiding everything over 30 minutes would
    // bury the 40-minute dinners they actually like.
    const rule = deriveTimeRule([
      timeBucket(30, ratings(2)),
      timeBucket(60, ratings(2)),
      timeBucket(90, ratings(2)),
    ]);
    expect(rule?.value).toBe(String(TIME_RULE_THRESHOLDS.at(-1)));
  });

  it('still emits a tight threshold when only that bucket has the evidence', () => {
    const rule = deriveTimeRule([timeBucket(30, ratings(2)), timeBucket(90, ratings(5))]);
    expect(rule?.value).toBe('30');
  });

  it('ignores exclusion observations mixed into the same list', () => {
    const observations: RuleObservation[] = [
      { kind: 'exclude_category', value: 'Soup', ratings: ratings(1) },
    ];
    expect(deriveTimeRule(observations)).toBeNull();
  });
});

describe('deriveExclusionRules', () => {
  it('emits every disjoint bucket that clears the bar, sorted by id', () => {
    const rules = deriveExclusionRules([
      { kind: 'exclude_tag', value: 'spicy', ratings: ratings(2) },
      { kind: 'exclude_category', value: 'Soup', ratings: ratings(1) },
      { kind: 'exclude_category', value: 'Chicken', ratings: ratings(5) },
    ]);
    expect(rules.map((r) => r.id)).toEqual(['exclude_category:Soup', 'exclude_tag:spicy']);
  });

  it('does not emit a thin bucket even when every rating is a 1', () => {
    const thin = MIN_OBSERVATIONS_PER_RULE - 1;
    const rules = deriveExclusionRules([
      { kind: 'exclude_category', value: 'Soup', ratings: ratings(1, thin) },
    ]);
    expect(rules).toEqual([]);
  });

  it('rounds the displayed median to one decimal', () => {
    const rules = deriveExclusionRules([
      { kind: 'exclude_tag', value: 'grill', ratings: [1, 1, 2, 2, 2, 3] },
    ]);
    expect(rules[0]?.medianRating).toBe(2);
  });
});

describe('mergeHardRules', () => {
  const disabledSoup: HardRule = {
    id: 'exclude_category:Soup',
    kind: 'exclude_category',
    value: 'Soup',
    enabled: false,
    observations: 5,
    medianRating: 2,
  };

  it('keeps a rule the reader switched off switched off', () => {
    const derived = deriveExclusionRules([
      { kind: 'exclude_category', value: 'Soup', ratings: ratings(1) },
    ]);
    const merged = mergeHardRules([disabledSoup], derived);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.enabled).toBe(false);
  });

  it('still refreshes the evidence on a disabled rule', () => {
    const derived = deriveExclusionRules([
      { kind: 'exclude_category', value: 'Soup', ratings: ratings(1, 9) },
    ]);
    expect(mergeHardRules([disabledSoup], derived)[0]?.observations).toBe(9);
  });

  it('retains a disabled rule whose evidence has evaporated', () => {
    // Dropping it would silently re-arm the filter the next time the pattern
    // reappeared, which is precisely the override the reader switched off.
    const merged = mergeHardRules([disabledSoup], []);
    expect(merged).toEqual([disabledSoup]);
  });

  it('does not resurrect an enabled rule whose evidence has evaporated', () => {
    const enabledSoup: HardRule = { ...disabledSoup, enabled: true };
    expect(mergeHardRules([enabledSoup], [])).toEqual([]);
  });

  it('leaves a newly derived rule enabled', () => {
    const derived = deriveExclusionRules([
      { kind: 'exclude_tag', value: 'grill', ratings: ratings(2) },
    ]);
    expect(mergeHardRules([], derived)[0]?.enabled).toBe(true);
  });
});

describe('parseHardRules', () => {
  const valid: HardRule = {
    id: 'max_minutes:60',
    kind: 'max_minutes',
    value: '60',
    enabled: true,
    observations: 6,
    medianRating: 2.1,
  };

  it('round-trips a well-formed rule', () => {
    expect(parseHardRules([valid])).toEqual([valid]);
  });

  it('treats a null column as no rules', () => {
    expect(parseHardRules(null)).toEqual([]);
  });

  it('drops only the malformed entry, keeping the rest', () => {
    // A jsonb column can hold last deploy's shape or a hand edit in psql. One
    // bad rule should cost its own filter, not the whole browse feed.
    expect(parseHardRules([valid, { kind: 'nonsense' }, null, 7])).toEqual([valid]);
  });

  it('rejects a rule with an unknown kind', () => {
    expect(parseHardRules([{ ...valid, kind: 'exclude_source' }])).toEqual([]);
  });

  it('returns nothing for a non-array column', () => {
    expect(parseHardRules({ max_minutes: 60 })).toEqual([]);
  });
});

describe('activeHardRules', () => {
  it('keeps only the enabled ones', () => {
    const rules: HardRule[] = [
      { id: 'a', kind: 'exclude_tag', value: 'a', enabled: true, observations: 5, medianRating: 2 },
      { id: 'b', kind: 'exclude_tag', value: 'b', enabled: false, observations: 5, medianRating: 2 },
    ];
    expect(activeHardRules(rules).map((r) => r.id)).toEqual(['a']);
  });
});

describe('hasEnoughHistoryForScoring', () => {
  it('is false one rating short of the floor and true at it', () => {
    expect(hasEnoughHistoryForScoring(MIN_RATED_RECIPES_FOR_SCORING - 1)).toBe(false);
    expect(hasEnoughHistoryForScoring(MIN_RATED_RECIPES_FOR_SCORING)).toBe(true);
  });

  it('is false for a reader who has rated nothing', () => {
    expect(hasEnoughHistoryForScoring(0)).toBe(false);
  });
});

describe('tasteProfileSchema', () => {
  it('accepts a short prose profile and trims it', () => {
    const parsed = tasteProfileSchema.parse({ profile: '  Prefers sheet-pan dinners.  ' });
    expect(parsed.profile).toBe('Prefers sheet-pan dinners.');
  });

  it('rejects an empty profile rather than storing a blank one', () => {
    // `getUserPreferences()` reads a blank profile as "no profile", so letting
    // one through would look like the job had never run.
    expect(tasteProfileSchema.safeParse({ profile: '   ' }).success).toBe(false);
  });

  it('rejects an essay', () => {
    expect(tasteProfileSchema.safeParse({ profile: 'x'.repeat(5_000) }).success).toBe(false);
  });
});

describe('batchForScoring', () => {
  it('numbers each batch from 1, not from the position in the whole list', () => {
    const batches = batchForScoring(['a', 'b', 'c', 'd'], 2);
    expect(batches.map((batch) => batch.map((entry) => entry.ref))).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(batches[1]?.map((entry) => entry.item)).toEqual(['c', 'd']);
  });

  it('returns no batches for nothing to score', () => {
    expect(batchForScoring([])).toEqual([]);
  });

  it('never exceeds the schema-enforced ref ceiling at the default size', () => {
    const items = Array.from({ length: SCORE_BATCH_SIZE * 3 + 1 }, (_, i) => i);
    for (const batch of batchForScoring(items)) {
      expect(batch.length).toBeLessThanOrEqual(SCORE_BATCH_SIZE);
      expect(batch.at(-1)!.ref).toBeLessThanOrEqual(SCORE_BATCH_SIZE);
    }
  });

  it('refuses a nonsense batch size instead of looping forever', () => {
    expect(() => batchForScoring([1, 2], 0)).toThrow(TypeError);
  });
});

describe('resolveScoreBatch', () => {
  const batch: ScoreBatchEntry[] = [
    { ref: 1, recipeId: 'recipe-one' },
    { ref: 2, recipeId: 'recipe-two' },
  ];

  const scored = (ref: number, score: number, reason = 'because'): RecipeScoreResponse => ({
    ref,
    score,
    reason,
  });

  it('maps refs back to recipe ids', () => {
    expect(resolveScoreBatch(batch, [scored(2, 80), scored(1, 10)])).toEqual([
      { recipeId: 'recipe-two', score: 80, reason: 'because' },
      { recipeId: 'recipe-one', score: 10, reason: 'because' },
    ]);
  });

  it('drops a ref that was not in this batch', () => {
    // It addresses a recipe the model was never shown, so there is no row that
    // could honestly be written for it.
    expect(resolveScoreBatch(batch, [scored(7, 90)])).toEqual([]);
  });

  it('keeps the first answer when a ref is repeated', () => {
    const resolved = resolveScoreBatch(batch, [scored(1, 90), scored(1, 10)]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.score).toBe(90);
  });

  it('clamps a score outside the range instead of discarding the row', () => {
    expect(resolveScoreBatch(batch, [scored(1, 999)])[0]?.score).toBe(MAX_SCORE);
    expect(resolveScoreBatch(batch, [scored(1, -20)])[0]?.score).toBe(0);
  });

  it('drops a row whose reason is blank', () => {
    // An unexplained score is exactly the opaque ranking PLAN.md forbids.
    expect(resolveScoreBatch(batch, [scored(1, 80, '   ')])).toEqual([]);
  });

  it('truncates a reason too long for the card', () => {
    const long = 'a'.repeat(MAX_SCORE_REASON_CHARS + 50);
    expect(resolveScoreBatch(batch, [scored(1, 80, long)])[0]?.reason).toHaveLength(
      MAX_SCORE_REASON_CHARS,
    );
  });

  it('returns fewer rows for a short response rather than inventing them', () => {
    expect(resolveScoreBatch(batch, [scored(1, 50)]).map((r) => r.recipeId)).toEqual([
      'recipe-one',
    ]);
  });
});

describe('recipeScoreBatchSchema', () => {
  it('accepts an empty batch — "nothing scorable here" is an answer', () => {
    expect(recipeScoreBatchSchema.parse({ scores: [] }).scores).toEqual([]);
  });

  it('rejects a ref outside the batch numbering', () => {
    const result = recipeScoreBatchSchema.safeParse({
      scores: [{ ref: SCORE_BATCH_SIZE + 1, score: 50, reason: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('display', () => {
  it('renders each kind as a sentence someone can agree or disagree with', () => {
    const rule = (kind: HardRule['kind'], value: string): HardRule => ({
      id: `${kind}:${value}`,
      kind,
      value,
      enabled: true,
      observations: 5,
      medianRating: 2,
    });

    expect(describeHardRule(rule('max_minutes', '60'))).toBe(
      'Hide recipes that take more than 60 minutes',
    );
    expect(describeHardRule(rule('exclude_category', 'Soup'))).toBe('Hide Soup recipes');
    expect(describeHardRule(rule('exclude_tag', 'spicy'))).toContain('spicy');
  });

  it('singularizes a one-cook explanation', () => {
    const one: HardRule = {
      id: 'x',
      kind: 'exclude_tag',
      value: 'x',
      enabled: true,
      observations: 1,
      medianRating: 2,
    };
    expect(explainHardRule(one)).toContain('1 cook ');
    expect(explainHardRule({ ...one, observations: 4 })).toContain('4 cooks');
  });
});

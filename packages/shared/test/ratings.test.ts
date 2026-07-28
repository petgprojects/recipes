/**
 * The Phase 6 wire contract: what a valid cook log looks like on the way in.
 *
 * The database enforces the same two bounds (`cook_logs_rating_range`,
 * `cook_logs_aspects_vocab`), so these are the client-side mirror of those
 * constraints — a bad request should fail here, as a 400, rather than reach
 * the database and fail as a 503.
 */

import { describe, expect, it } from 'vitest';
import { RATING_ASPECTS } from '../src/vocab';
import {
  MAX_NOTES_LENGTH,
  MAX_RATING,
  MIN_RATING,
  cookLogCreateSchema,
  cookLogIdSchema,
  recipeIdQuerySchema,
} from '../src/ratings';

const SHEET_PAN = '11111111-1111-4111-8111-111111111111';

describe('cookLogCreateSchema', () => {
  it('accepts a full entry', () => {
    const parsed = cookLogCreateSchema.parse({
      recipeId: SHEET_PAN,
      rating: 4,
      aspects: ['quick', 'would_repeat'],
      notes: 'Needed 10 more minutes at 400°.',
    });

    expect(parsed).toEqual({
      recipeId: SHEET_PAN,
      rating: 4,
      aspects: ['quick', 'would_repeat'],
      notes: 'Needed 10 more minutes at 400°.',
    });
  });

  it('defaults aspects to empty and notes to null', () => {
    const parsed = cookLogCreateSchema.parse({ recipeId: SHEET_PAN, rating: 5 });
    expect(parsed.aspects).toEqual([]);
    expect(parsed.notes).toBeNull();
  });

  it('rejects a non-uuid recipe id', () => {
    expect(
      cookLogCreateSchema.safeParse({ recipeId: 'sheetpan-chili', rating: 3 }).success,
    ).toBe(false);
  });

  it('rejects a rating outside 1-5', () => {
    expect(cookLogCreateSchema.safeParse({ recipeId: SHEET_PAN, rating: 0 }).success).toBe(false);
    expect(
      cookLogCreateSchema.safeParse({ recipeId: SHEET_PAN, rating: MAX_RATING + 1 }).success,
    ).toBe(false);
    expect(
      cookLogCreateSchema.safeParse({ recipeId: SHEET_PAN, rating: MIN_RATING }).success,
    ).toBe(true);
  });

  it('rejects a fractional rating', () => {
    expect(cookLogCreateSchema.safeParse({ recipeId: SHEET_PAN, rating: 3.5 }).success).toBe(
      false,
    );
  });

  it('rejects an aspect outside the fixed vocabulary', () => {
    expect(
      cookLogCreateSchema.safeParse({
        recipeId: SHEET_PAN,
        rating: 3,
        aspects: ['delicious'],
      }).success,
    ).toBe(false);
  });

  it('accepts every real aspect', () => {
    expect(
      cookLogCreateSchema.safeParse({
        recipeId: SHEET_PAN,
        rating: 3,
        aspects: [...RATING_ASPECTS],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty-string note but accepts a null one', () => {
    expect(
      cookLogCreateSchema.safeParse({ recipeId: SHEET_PAN, rating: 3, notes: '' }).success,
    ).toBe(false);
    expect(
      cookLogCreateSchema.parse({ recipeId: SHEET_PAN, rating: 3, notes: null }).notes,
    ).toBeNull();
  });

  it('rejects a note past the length cap', () => {
    expect(
      cookLogCreateSchema.safeParse({
        recipeId: SHEET_PAN,
        rating: 3,
        notes: 'x'.repeat(MAX_NOTES_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

/**
 * Both of these guard a value that is interpolated into a `uuid` column
 * comparison. Skipping either turns a malformed request into
 * `invalid input syntax for type uuid` — which `withUser()` reports as a 503
 * ("the database is down, retry") for a request that can never succeed, with
 * the failed statement echoed back to the caller.
 */
describe('uuid path and query guards', () => {
  it('accepts a real uuid', () => {
    expect(cookLogIdSchema.safeParse(SHEET_PAN).success).toBe(true);
    expect(recipeIdQuerySchema.safeParse(SHEET_PAN).success).toBe(true);
  });

  it('rejects a malformed id before it can reach SQL', () => {
    for (const bad of ['not-a-uuid', '', '../../etc/passwd', "' or 1=1 --"]) {
      expect(cookLogIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('rejects an absent query param', () => {
    // `searchParams.get()` returns null, not undefined, when the key is missing.
    expect(recipeIdQuerySchema.safeParse(null).success).toBe(false);
  });
});

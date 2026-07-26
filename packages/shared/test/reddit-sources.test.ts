import { describe, expect, it } from 'vitest';
import { findRedditSource, REDDIT_SOURCES } from '../src/reddit-sources';

describe('canonical Reddit sources', () => {
  it('ships one disabled adapter covering the two approved communities', () => {
    expect(REDDIT_SOURCES).toEqual([
      expect.objectContaining({
        slug: 'reddit-meal-prep',
        baseUrl: 'https://www.reddit.com',
        enabled: false,
        subreddits: ['MealPrepSunday', 'EatCheapAndHealthy'],
      }),
    ]);
  });

  it('finds the adapter independent of www spelling and path', () => {
    expect(
      findRedditSource('https://reddit.com/r/MealPrepSunday/')?.slug,
    ).toBe('reddit-meal-prep');
  });

  it('does not accept a lookalike host', () => {
    expect(findRedditSource('https://reddit.example')).toBeNull();
  });
});

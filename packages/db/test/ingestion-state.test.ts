import { describe, expect, it } from 'vitest';
import { recipes, scanRuns, sources } from '../src/schema';

describe('Phase 1 persisted HTTP and telemetry state', () => {
  it('keeps feed and page conditional-GET validators distinct', () => {
    expect(sources.feedEtag.name).toBe('feed_etag');
    expect(sources.feedLastModified.name).toBe('feed_last_modified');
    expect(recipes.pageEtag.name).toBe('page_etag');
    expect(recipes.pageLastModified.name).toBe('page_last_modified');
  });

  it('counts no-Recipe pages separately from found/new recipes', () => {
    expect(scanRuns.noRecipeCount.name).toBe('no_recipe');
    expect(scanRuns.noRecipeCount.default).toBe(0);
    expect(scanRuns.noRecipeCount.notNull).toBe(true);
  });
});

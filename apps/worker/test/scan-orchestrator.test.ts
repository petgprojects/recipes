import { describe, expect, it, vi } from 'vitest';
import type { RecipeIngredient } from '@recipes/shared';
import type { FetchOk, FetchResult } from '../src/scanner/fetcher';
import type { ExtractionResult, RecipeDraft } from '../src/scanner/jsonld';
import {
  createScanOrchestrator,
  type ScannableSource,
  type ScanOrchestrationDependencies,
} from '../src/scan/orchestrator';

const SOURCE: ScannableSource = {
  id: 'source-1',
  name: 'Test Kitchen',
  baseUrl: 'https://example.com',
  feedUrl: 'https://example.com/feed',
  feedEtag: '"feed-old"',
  feedLastModified: null,
  crawlDelayS: 2,
  lastScannedAt: new Date('2026-07-25T03:00:00.000Z'),
};

describe('Phase 1 scan orchestration', () => {
  it('counts 304s, inserts and no-Recipe pages separately while continuing after a bad URL', async () => {
    const finished = vi.fn<ScanOrchestrationDependencies['finishSourceScan']>();
    const markSeen = vi
      .fn<ScanOrchestrationDependencies['markRecipeSeen']>()
      .mockResolvedValue(true);
    const persistedUrls: string[] = [];
    const fetchPage = vi.fn<ScanOrchestrationDependencies['fetchPage']>(
      async (_source, item, validators) => {
        if (item.url.includes('unchanged')) {
          expect(validators).toMatchObject({ etag: '"page-old"' });
          return notModified(item.url, '"page-fresh"');
        }
        if (item.url.includes('broken')) {
          return fetchError(item.url, 'upstream exploded');
        }
        return okPage(
          item.url,
          item.url.includes('roundup') ? 'no-recipe' : 'recipe',
        );
      },
    );

    const dependencies = baseDependencies({
      finishSourceScan: finished,
      markRecipeSeen: markSeen,
      fetchPage,
      async discover() {
        return {
          urls: [
            { url: 'https://example.com/unchanged/?utm_source=feed' },
            { url: 'https://example.com/new/' },
            { url: 'https://example.com/roundup/' },
            { url: 'https://example.com/broken/' },
            // Proves the URL after the failure still runs.
            { url: 'https://example.com/later/' },
          ],
          via: ['feed'],
          feedUnchanged: false,
          feedEtag: '"feed-new"',
          feedLastModified: 'Sun, 26 Jul 2026 07:00:00 GMT',
          warnings: [],
        };
      },
      async loadPageValidators() {
        return [
          {
            sourceUrl: 'https://example.com/unchanged',
            etag: '"page-old"',
            lastModified: null,
          },
        ];
      },
      async persistRecipe(input) {
        persistedUrls.push(input.draft.sourceUrl);
        return input.draft.sourceUrl.includes('/new')
          ? {
              outcome: 'inserted',
              recipeId: 'recipe-new',
              sourceUrl: input.draft.sourceUrl,
            }
          : {
              outcome: 'unchanged',
              recipeId: 'recipe-later',
              sourceUrl: input.draft.sourceUrl,
            };
      },
    });

    const summary = await createScanOrchestrator(dependencies).scanSource(SOURCE);

    expect(summary).toMatchObject({
      status: 'partial',
      found: 3,
      newCount: 1,
      noRecipeCount: 1,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect(summary.error).toContain('upstream exploded');
    expect(markSeen).toHaveBeenCalledWith(
      'https://example.com/unchanged/?utm_source=feed',
      { etag: '"page-fresh"', lastModified: null },
      expect.any(Date),
    );
    expect(persistedUrls).toEqual([
      'https://example.com/new/',
      'https://example.com/later/',
    ]);
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        retryRequired: true,
        found: 3,
        newCount: 1,
        noRecipeCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        discovery: expect.objectContaining({ feedEtag: '"feed-new"' }),
      }),
    );
  });

  it('finishes a source run as error without advancing discovery state when discovery fails', async () => {
    const finished = vi.fn<ScanOrchestrationDependencies['finishSourceScan']>();
    const dependencies = baseDependencies({
      finishSourceScan: finished,
      async discover() {
        throw new Error('feed and sitemap unavailable');
      },
    });

    const summary = await createScanOrchestrator(dependencies).scanSource(SOURCE);

    expect(summary).toMatchObject({
      status: 'error',
      found: 0,
      newCount: 0,
      noRecipeCount: 0,
    });
    expect(summary.error).toContain('feed and sitemap unavailable');
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        retryRequired: true,
        discovery: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
  });

  it('records non-fatal discovery/image warnings without pinning the source checkpoint', async () => {
    const finished = vi.fn<ScanOrchestrationDependencies['finishSourceScan']>();
    const dependencies = baseDependencies({
      finishSourceScan: finished,
      async discover() {
        return {
          urls: [{ url: 'https://example.com/recipe/' }],
          via: ['sitemap'],
          feedUnchanged: false,
          feedEtag: null,
          feedLastModified: null,
          warnings: ['feed contained no candidate recipe URLs'],
        };
      },
      async cacheImage() {
        return { outcome: 'failed', error: 'image CDN omitted content-type' };
      },
    });

    const summary = await createScanOrchestrator(dependencies).scanSource(SOURCE);

    expect(summary.status).toBe('partial');
    expect(summary.error).toContain('feed contained no candidate');
    expect(summary.error).toContain('image CDN omitted content-type');
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        retryRequired: false,
      }),
    );
  });

  it('keeps an empty warned discovery eligible for retry', async () => {
    const finished = vi.fn<ScanOrchestrationDependencies['finishSourceScan']>();
    const dependencies = baseDependencies({
      finishSourceScan: finished,
      async discover() {
        return {
          urls: [],
          via: [],
          feedUnchanged: false,
          feedEtag: null,
          feedLastModified: null,
          warnings: ['sitemap https://example.com/sitemap.xml: HTTP 403'],
        };
      },
    });

    const summary = await createScanOrchestrator(dependencies).scanSource(SOURCE);

    expect(summary.status).toBe('partial');
    expect(summary.error).toContain('HTTP 403');
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        retryRequired: true,
      }),
    );
  });

  it('finalizes telemetry before propagating a shutdown abort for pg-boss retry', async () => {
    const controller = new AbortController();
    const finished = vi.fn<ScanOrchestrationDependencies['finishSourceScan']>();
    const dependencies = baseDependencies({
      finishSourceScan: finished,
      async discover() {
        controller.abort(new Error('worker stopping'));
        return {
          urls: [{ url: 'https://example.com/recipe/' }],
          via: ['feed'],
          feedUnchanged: false,
          feedEtag: '"feed-new"',
          feedLastModified: null,
          warnings: [],
        };
      },
    });

    await expect(
      createScanOrchestrator(dependencies).scanSource(SOURCE, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('worker stopping');

    expect(dependencies.fetchPage).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        retryRequired: true,
        error: expect.stringContaining('scan interrupted: worker stopping'),
        discovery: expect.objectContaining({ feedEtag: '"feed-new"' }),
      }),
    );
  });

  it('continues to later sources after a source-level failure', async () => {
    const secondSource = {
      ...SOURCE,
      id: 'source-2',
      name: 'Second Kitchen',
      baseUrl: 'https://second.example',
    };
    const dependencies = baseDependencies({
      async loadEnabledSources() {
        return [SOURCE, secondSource];
      },
      async discover(source) {
        if (source.id === SOURCE.id) throw new Error('first source failed');
        return {
          urls: [{ url: 'https://second.example/recipe/' }],
          via: ['feed'],
          feedUnchanged: false,
          feedEtag: null,
          feedLastModified: null,
          warnings: [],
        };
      },
    });

    const summary = await createScanOrchestrator(dependencies).scanAllSources();

    expect(summary.sources.map((source) => source.status)).toEqual([
      'error',
      'success',
    ]);
    expect(summary.found).toBe(1);
    expect(dependencies.beginSourceScan).toHaveBeenCalledTimes(2);
  });
});

function baseDependencies(
  overrides: Partial<ScanOrchestrationDependencies> = {},
): ScanOrchestrationDependencies {
  let clock = Date.parse('2026-07-26T07:00:00.000Z');
  const ingredients: RecipeIngredient[] = [
    {
      position: 0,
      rawText: '1 onion',
      ingredientId: null,
      qty: 1,
      unit: null,
      note: null,
      optional: false,
    },
  ];

  return {
    now: () => {
      const value = new Date(clock);
      clock += 1_000;
      return value;
    },
    loadEnabledSources: vi.fn(async () => [SOURCE]),
    beginSourceScan: vi.fn(async (sourceId) => `run-${sourceId}`),
    finishSourceScan: vi.fn(async () => undefined),
    discover: vi.fn<ScanOrchestrationDependencies['discover']>(async () => ({
      urls: [],
      via: ['feed'],
      feedUnchanged: false,
      feedEtag: null,
      feedLastModified: null,
      warnings: [],
    })),
    loadPageValidators: vi.fn(async () => []),
    fetchPage: vi.fn(async (_source, item) => okPage(item.url, 'recipe')),
    extract: vi.fn((html) => extraction(html === 'recipe')),
    toDraft: vi.fn((result, sourceUrl) =>
      result.found ? draft(sourceUrl) : null,
    ),
    normalizeIngredients: vi.fn(async () => ingredients),
    cacheImage: vi.fn<ScanOrchestrationDependencies['cacheImage']>(
      async () => ({ outcome: 'skipped', reason: 'no-url' }),
    ),
    persistRecipe: vi.fn<ScanOrchestrationDependencies['persistRecipe']>(
      async (input) => ({
        outcome: 'inserted',
        recipeId: 'recipe-1',
        sourceUrl: input.draft.sourceUrl,
      }),
    ),
    markRecipeSeen: vi.fn(async () => true),
    ...overrides,
  };
}

function okPage(url: string, body: string): FetchOk {
  return {
    outcome: 'ok',
    url,
    finalUrl: url,
    statusCode: 200,
    body,
    etag: '"page-new"',
    lastModified: null,
    contentType: 'text/html',
    bytes: body.length,
    attempts: 1,
    fetchedAt: new Date('2026-07-26T07:00:00.000Z'),
  };
}

function notModified(url: string, etag: string): FetchResult {
  return {
    outcome: 'notModified',
    url,
    statusCode: 304,
    etag,
    lastModified: null,
    attempts: 1,
    fetchedAt: new Date('2026-07-26T07:00:00.000Z'),
  };
}

function fetchError(url: string, message: string): FetchResult {
  return {
    outcome: 'error',
    url,
    reason: 'http',
    statusCode: 503,
    message,
    attempts: 3,
    retryable: true,
  };
}

function extraction(found: boolean): ExtractionResult {
  return {
    found,
    recipe: found
      ? {
          title: 'Test recipe',
          description: null,
          imageUrl: null,
          imageUrls: [],
          servings: 4,
          yieldText: '4 servings',
          totalMinutes: 30,
          prepMinutes: 10,
          cookMinutes: 20,
          activeMinutes: 10,
          ingredients: ['1 onion'],
          instructions: [{ name: null, text: 'Cook.' }],
          rating: null,
          author: null,
          publishedAt: null,
          keywords: [],
          recipeCategory: [],
          recipeCuisine: [],
          raw: { '@type': 'Recipe' },
          contentHash: 'hash',
          missing: [],
        }
      : null,
    missing: [],
    stats: { blocks: 1, malformed: 0, nodes: 1, recipeNodes: found ? 1 : 0 },
  };
}

function draft(sourceUrl: string): RecipeDraft {
  return {
    sourceUrl,
    contentHash: `hash-${sourceUrl}`,
    title: 'Test recipe',
    slug: 'test-recipe',
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 4,
    imageUrl: null,
    author: null,
    sourceRating: null,
    sourceRatingCount: null,
    instructions: [{ name: null, text: 'Cook.' }],
    rawJsonld: { '@type': 'Recipe' },
    publishedAt: null,
    ingredients: [{ position: 0, rawText: '1 onion' }],
    missing: [],
  };
}

import { describe, expect, it, vi } from 'vitest';
import {
  BLOG_SOURCES,
  REDDIT_SOURCES,
  type RecipeIngredient,
} from '@recipes/shared';
import type { CacheRecipeImageResult } from '../src/storage/images';
import type { RecipeDraft } from '../src/scanner/jsonld';
import {
  createRedditScanOrchestrator,
  type RedditScanOrchestratorDependencies,
  type RedditScannableSource,
} from '../src/reddit/orchestrator';
import type { RedditRouteResult } from '../src/reddit/routing';
import type { RedditClient, RedditPost } from '../src/reddit/types';

const REDDIT_SOURCE: RedditScannableSource = {
  id: 'reddit-source',
  name: 'Reddit meal prep',
  enabled: true,
  lastScannedAt: new Date('2026-07-25T03:00:00.000Z'),
  definition: { ...REDDIT_SOURCES[0], enabled: true },
};

const CLIENT: RedditClient = {
  async listNew() {
    return { posts: [], after: null };
  },
  async topComments() {
    return [];
  },
};

describe('Reddit scan orchestration', () => {
  it('returns a clean empty summary without credential or telemetry access when disabled', async () => {
    const createClient = vi.fn(() => {
      throw new Error('credentials must not be read');
    });
    const beginSourceScan = vi.fn(async () => 'unexpected');
    const dependencies = baseDependencies({
      async loadSources() {
        return [{ ...REDDIT_SOURCE, enabled: false }];
      },
      createClient,
      beginSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary).toMatchObject({
      sourceCount: 0,
      sources: [],
      found: 0,
      newCount: 0,
      noRecipeCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(beginSourceScan).not.toHaveBeenCalled();
    expect(dependencies.finishSourceScan).not.toHaveBeenCalled();
  });

  it('records missing credentials as a source-local error and preserves the checkpoint', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      createClient() {
        throw new Error('Reddit source is enabled but credentials are missing');
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('credentials are missing'),
    });
    expect(dependencies.discoverPosts).not.toHaveBeenCalled();
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        retryRequired: true,
        checkpointAt: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
  });

  it('persists external links under their blog source and self-posts under Reddit', async () => {
    const external = post('external');
    const self = post('self');
    const routePost = vi.fn<RedditScanOrchestratorDependencies['routePost']>(
      async (item, _source, _client, context) => {
        await context.onUsage(
          item.id === 'external'
            ? { tokensIn: 10, tokensOut: 2, costUsd: 0.001 }
            : { tokensIn: 20, tokensOut: 4, costUsd: 0.002 },
        );
        return item.id === 'external'
          ? recipeRoute('external-jsonld', draft(item.permalink), BLOG_SOURCES[0])
          : recipeRoute('reddit-llm', draft(item.permalink), null);
      },
    );
    const persistedSourceIds: string[] = [];
    const persistRecipe =
      vi.fn<RedditScanOrchestratorDependencies['persistRecipe']>(
        async (input) => {
          persistedSourceIds.push(input.sourceId);
          return {
            outcome:
              input.sourceId === 'budget-source' ? 'inserted' : 'unchanged',
            recipeId: `recipe-${input.sourceId}`,
            sourceUrl: input.draft.sourceUrl,
          };
        },
      );
    const cacheImage =
      vi.fn<RedditScanOrchestratorDependencies['cacheImage']>(
        async (): Promise<CacheRecipeImageResult> => ({
          outcome: 'cached',
          image: {
            localPath: 'image.webp',
            width: 800,
            height: 600,
            bytes: 123,
            reused: false,
          },
        }),
      );
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return {
          posts: [external, self],
          crossedCheckpoint: true,
          truncated: false,
          pages: 2,
        };
      },
      routePost,
      async resolveBlogSourceId(source) {
        return source.slug === 'budget-bytes' ? 'budget-source' : null;
      },
      cacheImage,
      persistRecipe,
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary).toMatchObject({
      sourceCount: 1,
      found: 2,
      newCount: 1,
      noRecipeCount: 0,
      tokensIn: 30,
      tokensOut: 6,
      costUsd: 0.003,
      sources: [
        expect.objectContaining({
          status: 'success',
          found: 2,
          newCount: 1,
        }),
      ],
    });
    expect(persistedSourceIds).toEqual(['budget-source', 'reddit-source']);
    expect(dependencies.normalizeIngredients).toHaveBeenCalledTimes(2);
    expect(cacheImage).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherSource: expect.objectContaining({ slug: 'budget-bytes' }),
      }),
    );
    expect(persistRecipe).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.objectContaining({ localPath: 'image.webp' }),
      }),
    );
    const finished = finishSourceScan.mock.calls[0]?.[0];
    expect(finished?.checkpointAt).toEqual(finished?.scanStartedAt);
    expect(finished?.retryRequired).toBe(false);
  });

  it('counts a definitive no-recipe but preserves the checkpoint when discovery is truncated', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return {
          posts: [post('roundup')],
          crossedCheckpoint: false,
          truncated: true,
          pages: 10,
        };
      },
      async routePost() {
        return {
          outcome: 'not-recipe',
          reason: 'roundup',
          warnings: [],
        };
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'partial',
      noRecipeCount: 1,
      error: expect.stringContaining('before reaching its checkpoint'),
    });
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointAt: null,
        retryRequired: true,
        noRecipeCount: 1,
      }),
    );
  });

  it('records an API failure as an error without routing any post', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        throw new Error('Reddit API 503');
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Reddit API 503'),
    });
    expect(dependencies.routePost).not.toHaveBeenCalled();
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointAt: null, retryRequired: true }),
    );
  });

  it('keeps usage from a failed LLM route and leaves the post retryable', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return discovered(post('llm-failure'));
      },
      async routePost(_post, _source, _client, context) {
        await context.onUsage({
          tokensIn: 120,
          tokensOut: 15,
          costUsd: 0.004,
        });
        throw new Error('structured output invalid after repair');
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'partial',
      found: 0,
      tokensIn: 120,
      tokensOut: 15,
      costUsd: 0.004,
      error: expect.stringContaining('structured output invalid'),
    });
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointAt: null,
        tokensIn: 120,
        tokensOut: 15,
        costUsd: 0.004,
      }),
    );
  });

  it('treats external fetch warnings as retry-required even after a definitive post decision', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return discovered(post('fetch-failure'));
      },
      async routePost() {
        return {
          outcome: 'not-recipe',
          reason: 'post body had no recipe',
          warnings: ['external https://example.test: upstream 503'],
        };
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'partial',
      noRecipeCount: 1,
      error: expect.stringContaining('upstream 503'),
    });
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointAt: null, retryRequired: true }),
    );
  });

  it('continues telemetry after a persistence failure and preserves the checkpoint', async () => {
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return discovered(post('write-failure'));
      },
      async routePost(item) {
        return recipeRoute('reddit-llm', draft(item.permalink), null);
      },
      async persistRecipe() {
        throw new Error('database write failed');
      },
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'partial',
      found: 1,
      newCount: 0,
      error: expect.stringContaining('database write failed'),
    });
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointAt: null, retryRequired: true }),
    );
  });

  it('persists without an image but keeps an image failure retryable', async () => {
    const persistRecipe =
      vi.fn<RedditScanOrchestratorDependencies['persistRecipe']>(
        async (input) => ({
          outcome: 'inserted',
          recipeId: 'recipe-1',
          sourceUrl: input.draft.sourceUrl,
        }),
      );
    const finishSourceScan =
      vi.fn<RedditScanOrchestratorDependencies['finishSourceScan']>(
        async () => undefined,
      );
    const dependencies = baseDependencies({
      async discoverPosts() {
        return discovered(post('image-failure'));
      },
      async routePost(item) {
        return recipeRoute('reddit-llm', draft(item.permalink), null);
      },
      async cacheImage() {
        return { outcome: 'failed', error: 'image CDN timeout' };
      },
      persistRecipe,
      finishSourceScan,
    });

    const summary = await createRedditScanOrchestrator(dependencies).scanAll();

    expect(summary.sources[0]).toMatchObject({
      status: 'partial',
      found: 1,
      newCount: 1,
      error: expect.stringContaining('image CDN timeout'),
    });
    expect(persistRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ image: null }),
    );
    expect(finishSourceScan).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointAt: null, retryRequired: true }),
    );
  });
});

function baseDependencies(
  overrides: Partial<RedditScanOrchestratorDependencies> = {},
): RedditScanOrchestratorDependencies {
  let clock = Date.parse('2026-07-26T12:00:00.000Z');
  const ingredient: RecipeIngredient = {
    position: 0,
    rawText: '1 cup lentils',
    ingredientId: null,
    qty: 1,
    unit: 'cup',
    note: null,
    optional: false,
  };

  return {
    now() {
      const value = new Date(clock);
      clock += 1_000;
      return value;
    },
    loadSources: vi.fn(async () => [REDDIT_SOURCE]),
    beginSourceScan: vi.fn(async () => 'reddit-run'),
    finishSourceScan: vi.fn(async () => undefined),
    createClient: vi.fn(() => CLIENT),
    discoverPosts: vi.fn(async () => ({
      posts: [],
      crossedCheckpoint: true,
      truncated: false,
      pages: 1,
    })),
    routePost: vi.fn<RedditScanOrchestratorDependencies['routePost']>(
      async () => ({
        outcome: 'not-recipe',
        reason: 'none',
        warnings: [],
      }),
    ),
    resolveBlogSourceId: vi.fn(async () => 'blog-source'),
    normalizeIngredients: vi.fn(async () => [ingredient]),
    cacheImage: vi.fn<RedditScanOrchestratorDependencies['cacheImage']>(
      async () => ({
        outcome: 'skipped',
        reason: 'no-url',
      }),
    ),
    persistRecipe: vi.fn<RedditScanOrchestratorDependencies['persistRecipe']>(
      async (input) => ({
        outcome: 'inserted',
        recipeId: 'recipe-1',
        sourceUrl: input.draft.sourceUrl,
      }),
    ),
    ...overrides,
  };
}

function discovered(postItem: RedditPost) {
  return {
    posts: [postItem],
    crossedCheckpoint: true,
    truncated: false,
    pages: 1,
  };
}

function recipeRoute(
  method: Extract<
    RedditRouteResult,
    { outcome: 'recipe' }
  >['method'],
  recipeDraft: RecipeDraft,
  publisherSource: (typeof BLOG_SOURCES)[number] | null,
): RedditRouteResult {
  return {
    outcome: 'recipe',
    method,
    draft: recipeDraft,
    publisherSource,
    warnings: [],
  };
}

function post(id: string): RedditPost {
  return {
    id,
    subreddit: 'MealPrepSunday',
    permalink: `https://www.reddit.com/r/MealPrepSunday/comments/${id}/lunches/`,
    title: `Post ${id}`,
    selfText: 'One cup lentils, cooked and portioned.',
    selfTextHtml: null,
    url: `https://www.reddit.com/r/MealPrepSunday/comments/${id}/lunches/`,
    createdAt: new Date('2026-07-26T10:00:00.000Z'),
    score: 50,
    isSelf: true,
  };
}

function draft(sourceUrl: string): RecipeDraft {
  return {
    sourceUrl,
    contentHash: `hash-${sourceUrl}`,
    title: 'Lentil Lunches',
    slug: 'lentil-lunches',
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 5,
    imageUrl: 'https://images.example/lentils.jpg',
    author: null,
    sourceRating: null,
    sourceRatingCount: null,
    instructions: [{ name: null, text: 'Cook and portion.' }],
    rawJsonld: null,
    publishedAt: new Date('2026-07-26T10:00:00.000Z'),
    ingredients: [{ position: 0, rawText: '1 cup lentils' }],
    missing: [],
  };
}

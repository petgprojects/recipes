import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REDDIT_SOURCES } from '@recipes/shared';
import type { FetchOk } from '../src/scanner/fetcher';
import { extractConfiguredBlogLinks } from '../src/reddit/links';
import {
  routeRedditPost,
  type LlmRecipeCandidate,
  type RedditLlmExtractor,
} from '../src/reddit/routing';
import type { RedditPost } from '../src/reddit/types';

const htmlFixtures = join(import.meta.dirname, 'fixtures', 'html-fallback');
const html = (name: string) =>
  readFileSync(join(htmlFixtures, name), 'utf8');
const redditSource = REDDIT_SOURCES[0];

describe('deterministic Reddit link-outs', () => {
  it('keeps configured recipe URLs in stable order and rejects other targets', () => {
    const item = post({
      url: 'https://www.budgetbytes.com/first-recipe/?utm_source=reddit',
      selfText:
        'Duplicate https://budgetbytes.com/first-recipe/ and evil https://evil.example/recipe/',
      selfTextHtml:
        '<a href="https://www.seriouseats.com/tartiflette-recipe-5217300">good</a>' +
        '<a href="https://www.budgetbytes.com/category/recipes/">category</a>',
      isSelf: false,
    });

    expect(
      extractConfiguredBlogLinks(item).map(({ url, source }) => [
        url,
        source.slug,
      ]),
    ).toEqual([
      ['https://budgetbytes.com/first-recipe', 'budget-bytes'],
      [
        'https://seriouseats.com/tartiflette-recipe-5217300',
        'serious-eats',
      ],
    ]);
  });
});

describe('Reddit recipe routing', () => {
  it('uses external JSON-LD without calling either LLM path', async () => {
    const llm = llmMock();
    const loadTopComments = vi.fn(async () => []);
    const item = post({
      url: 'https://www.budgetbytes.com/weeknight-beans/',
      isSelf: false,
    });

    const result = await routeRedditPost(item, redditSource, {
      fetchExternal: async (url) =>
        okPage(url, html('insertable-jsonld.html')),
      loadTopComments,
      llm,
    });

    expect(result).toMatchObject({
      outcome: 'recipe',
      method: 'external-jsonld',
      publisherSource: expect.objectContaining({ slug: 'budget-bytes' }),
      draft: expect.objectContaining({ title: 'Weeknight Beans' }),
    });
    expect(llm.extractRecipe).not.toHaveBeenCalled();
    expect(llm.extractRecipeFromPost).not.toHaveBeenCalled();
    expect(loadTopComments).not.toHaveBeenCalled();
  });

  it('uses guarded HTML fallback for a configured external recipe page', async () => {
    const llm = llmMock();
    vi.mocked(llm.extractRecipe).mockResolvedValue({
      outcome: 'recipe',
      recipe: candidate('Chickpea Meal Prep'),
    });
    const item = post({
      url: 'https://www.budgetbytes.com/chickpea-meal-prep/',
      isSelf: false,
    });

    const result = await routeRedditPost(item, redditSource, {
      fetchExternal: async (url) =>
        okPage(url, html('visible-recipe-card.html')),
      loadTopComments: async () => [],
      llm,
    });

    expect(result).toMatchObject({
      outcome: 'recipe',
      method: 'external-html-llm',
      draft: expect.objectContaining({
        sourceUrl: 'https://budgetbytes.com/chickpea-meal-prep',
        rawJsonld: null,
      }),
    });
    expect(llm.extractRecipe).toHaveBeenCalledTimes(1);
    expect(llm.extractRecipeFromPost).not.toHaveBeenCalled();
  });

  it('prepares a bounded post/comment prompt when no external recipe succeeds', async () => {
    const llm = llmMock();
    vi.mocked(llm.extractRecipeFromPost).mockResolvedValue({
      outcome: 'recipe',
      recipe: candidate('Lentil Lunch Bowls'),
    });
    const item = post({
      title: 'Five lentil lunches',
      selfText: 'I cooked one cup of lentils and divided it into five boxes.',
    });

    const result = await routeRedditPost(item, redditSource, {
      fetchExternal: vi.fn(),
      async loadTopComments() {
        return [
          {
            id: 'comment-1',
            author: 'cook',
            body: 'Simmer for twenty minutes.',
            score: 30,
          },
        ];
      },
      llm,
    });

    expect(result).toMatchObject({
      outcome: 'recipe',
      method: 'reddit-llm',
      publisherSource: null,
      draft: expect.objectContaining({
        sourceUrl: item.permalink,
        publishedAt: item.createdAt,
      }),
    });
    expect(llm.extractRecipeFromPost).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: item.permalink,
        prompt: expect.stringContaining('Simmer for twenty minutes.'),
      }),
    );
  });

  it('does not send a linked roundup through external HTML fallback', async () => {
    const llm = llmMock();
    vi.mocked(llm.extractRecipeFromPost).mockResolvedValue({
      outcome: 'not-recipe',
      reason: 'roundup only',
    });
    const item = post({
      url: 'https://www.budgetbytes.com/fifteen-lunches/',
      isSelf: false,
    });

    const result = await routeRedditPost(item, redditSource, {
      fetchExternal: async (url) => okPage(url, html('roundup.html')),
      loadTopComments: async () => [],
      llm,
    });

    expect(result).toMatchObject({
      outcome: 'not-recipe',
      reason: 'roundup only',
    });
    expect(llm.extractRecipe).not.toHaveBeenCalled();
    expect(llm.extractRecipeFromPost).toHaveBeenCalledTimes(1);
  });
});

function llmMock(): RedditLlmExtractor {
  return {
    extractRecipe: vi.fn(async () => ({
      outcome: 'not-recipe' as const,
      reason: 'none',
    })),
    extractRecipeFromPost: vi.fn(async () => ({
      outcome: 'not-recipe' as const,
      reason: 'none',
    })),
  };
}

function candidate(title: string): LlmRecipeCandidate {
  return {
    title,
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 4,
    instructions: [{ name: null, text: 'Cook and portion.' }],
    ingredients: ['1 cup lentils'],
  };
}

function post(overrides: Partial<RedditPost> = {}): RedditPost {
  return {
    id: 'post-1',
    subreddit: 'MealPrepSunday',
    permalink:
      'https://www.reddit.com/r/MealPrepSunday/comments/post1/lunches/',
    title: 'Meal prep lunches',
    selfText: '',
    selfTextHtml: null,
    url: 'https://www.reddit.com/r/MealPrepSunday/comments/post1/lunches/',
    createdAt: new Date('2026-07-26T10:00:00.000Z'),
    score: 50,
    isSelf: true,
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
    etag: null,
    lastModified: null,
    contentType: 'text/html',
    bytes: body.length,
    attempts: 1,
    fetchedAt: new Date('2026-07-26T10:00:00.000Z'),
  };
}

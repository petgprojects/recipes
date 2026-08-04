import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from '@recipes/db/operators';
import {
  recipes,
  scanRuns,
  sources,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  createPostgresRedditScanOrchestrator,
} from '../src/reddit/postgres';
import type {
  RedditClient,
  RedditCredentials,
  RedditPost,
} from '../src/reddit/types';
import type {
  StructuredOutputCallOptions,
  StructuredOutputClient,
  StructuredOutputTask,
} from '@recipes/shared/llm';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const TEST_SOURCE_URL = 'https://reddit.com';
const TEST_POST_URL =
  'https://www.reddit.com/r/MealPrepSunday/comments/phase2runtime/lentil_lunches/';
const CANONICAL_POST_URL =
  'https://reddit.com/r/MealPrepSunday/comments/phase2runtime/lentil_lunches';

let db: Database;
let close: (() => Promise<void>) | undefined;
let sourceId: string | undefined;
let runId: string | undefined;

integration('Reddit Postgres runtime composition', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 6 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });

    // Clear by source row, not by one exact URL: a post now yields several
    // recipes whose `source_url`s carry a `?recipe=` marker, and a cleanup that
    // knows only the bare permalink leaves rows behind — which then blocks the
    // `sources` delete on its foreign key.
    await deleteTestRecipes();
    await db.delete(sources).where(eq(sources.baseUrl, TEST_SOURCE_URL));
    const [source] = await db
      .insert(sources)
      .values({
        name: 'Reddit runtime integration',
        kind: 'reddit',
        baseUrl: TEST_SOURCE_URL,
        enabled: true,
        crawlDelayS: 0,
      })
      .returning({ id: sources.id });
    if (source === undefined) throw new Error('could not create Reddit test source');
    sourceId = source.id;
  });

  afterAll(async () => {
    if (db) {
      await deleteTestRecipes();
      if (runId !== undefined) {
        await db.delete(scanRuns).where(eq(scanRuns.id, runId));
      }
      await db.delete(sources).where(eq(sources.baseUrl, TEST_SOURCE_URL));
    }
    await close?.();
  });

  async function deleteTestRecipes(): Promise<void> {
    const existing = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.baseUrl, TEST_SOURCE_URL));
    for (const source of existing) {
      await db.delete(recipes).where(eq(recipes.sourceId, source.id));
    }
  }

  it('runs an enabled source through discovery, comments, LLM accounting, and persistence', async () => {
    const credentials: RedditCredentials = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      userAgent: 'recipes-integration/1.0 by u/test',
    };
    const loadCredentials = vi.fn(() => credentials);
    const redditClient: RedditClient = {
      async listNew() {
        return { posts: [testPost()], after: null };
      },
      async topComments() {
        return [
          {
            id: 'comment-1',
            author: 'prep-cook',
            body: 'Portion into five containers.',
            score: 25,
          },
        ];
      },
    };
    const createClient = vi.fn(
      (_source: unknown, received: RedditCredentials) => {
        expect(received).toEqual(credentials);
        return redditClient;
      },
    );
    const llmClient: StructuredOutputClient = {
      async complete<T>(
        task: StructuredOutputTask<T>,
        options?: StructuredOutputCallOptions,
      ): Promise<T> {
        const context = {
          taskName: task.name,
          attempt: 'initial' as const,
        };
        await options?.beforeRequest?.(context);
        try {
          await options?.onUsage?.(
            {
              tokensIn: 100,
              tokensOut: 20,
              totalTokens: 120,
              cachedTokensIn: 0,
              costUsd: 0.0001,
              costSource: 'provider',
            },
            {
              ...context,
              responseId: 'reddit-runtime-response',
              model: 'test-model',
            },
          );
          // Two recipes in one post: the shape that proves the disambiguated
          // `source_url` survives the unique index, which is the whole reason
          // routing rewrites it.
          return {
            found: true,
            reason: 'The post contains two complete batch recipes.',
            recipes: [
              {
                title: 'Lentil Lunches',
                total_minutes: 35,
                active_minutes: 10,
                servings: 5,
                ingredients: ['1 cup lentils', '2 cups vegetable broth'],
                instructions: [
                  { name: null, text: 'Simmer the lentils and portion.' },
                ],
                image_url: null,
                author: null,
                published_at: null,
              },
              {
                title: 'Overnight Oats',
                total_minutes: 480,
                active_minutes: 5,
                servings: 4,
                ingredients: ['2 cups rolled oats', '2 cups milk'],
                instructions: [
                  { name: null, text: 'Combine and refrigerate overnight.' },
                ],
                image_url: null,
                author: null,
                published_at: null,
              },
            ],
          } as T;
        } finally {
          await options?.afterRequest?.(context);
        }
      },
    };
    const scanner = createPostgresRedditScanOrchestrator({
      db,
      client: llmClient,
      imageOutputDir: '/tmp/recipes-reddit-runtime-images',
      dailyBudgetUsd: 1,
      discoveryLimit: 10,
      loadCredentials,
      createClient,
      now: () => new Date('2099-07-26T12:00:00.000Z'),
    });

    const summary = await scanner.scanAll();
    runId = summary.sources[0]?.runId;

    expect(summary).toMatchObject({
      sourceCount: 1,
      found: 2,
      newCount: 2,
      noRecipeCount: 0,
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.0001,
      sources: [
        expect.objectContaining({
          status: 'success',
          found: 2,
          newCount: 2,
        }),
      ],
    });
    expect(loadCredentials).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();

    // Both rows exist, under one post, distinguished only by `?recipe=`.
    const stored = await db
      .select({
        sourceId: recipes.sourceId,
        sourceUrl: recipes.sourceUrl,
        title: recipes.title,
        status: recipes.status,
      })
      .from(recipes)
      .where(eq(recipes.sourceId, sourceId!))
      .orderBy(asc(recipes.title));
    expect(stored).toEqual([
      {
        sourceId,
        sourceUrl: `${CANONICAL_POST_URL}?recipe=lentil-lunches`,
        title: 'Lentil Lunches',
        status: 'pending',
      },
      {
        sourceId,
        sourceUrl: `${CANONICAL_POST_URL}?recipe=overnight-oats`,
        title: 'Overnight Oats',
        status: 'pending',
      },
    ]);

    const [run] = await db
      .select({
        status: scanRuns.status,
        found: scanRuns.found,
        newCount: scanRuns.newCount,
        tokensIn: scanRuns.tokensIn,
        tokensOut: scanRuns.tokensOut,
        costUsd: scanRuns.costUsd,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, runId!));
    expect(run).toEqual({
      status: 'success',
      found: 2,
      newCount: 2,
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.0001,
    });
  });
});

function testPost(): RedditPost {
  return {
    id: 'phase2runtime',
    subreddit: 'MealPrepSunday',
    permalink: TEST_POST_URL,
    title: 'Lentil lunches for the week',
    selfText: 'Cook one cup of lentils in two cups of broth.',
    selfTextHtml: null,
    url: TEST_POST_URL,
    createdAt: new Date('2099-07-25T12:00:00.000Z'),
    score: 50,
    isSelf: true,
  };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from '@recipes/db/operators';
import { recipes, scanRuns, sources } from '@recipes/db/schema';
import { PgBoss } from 'pg-boss';
import type { Database } from '@recipes/db/client';
import { ensureScanQueue, SCAN_QUEUE_OPTIONS } from '../src/jobs/queue';
import { withScanAdvisoryLock } from '../src/jobs/advisory-lock';
import { createPostgresScanOrchestrator } from '../src/scan/postgres';
import { recordLlmUsage } from '../src/enrichment/postgres';
import { PoliteFetcher } from '../src/scanner/fetcher';
import type { RecipeDraft } from '../src/scanner/jsonld';
import type { ScannableSource } from '../src/scan/orchestrator';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const TEST_PAGE =
  'https://www.budgetbytes.com/__phase-1-scan-lifecycle-integration__/';
const CANONICAL_TEST_PAGE =
  'https://budgetbytes.com/__phase-1-scan-lifecycle-integration__';
const FALLBACK_TEST_PAGE =
  'https://www.budgetbytes.com/__phase-2-html-fallback-integration__/';
const CANONICAL_FALLBACK_TEST_PAGE =
  'https://budgetbytes.com/__phase-2-html-fallback-integration__';

let db: Database;
let sqlClient: Awaited<
  ReturnType<typeof import('@recipes/db/client')['createClient']>
>['client'];
let source: ScannableSource;
let originalSourceState: {
  feedEtag: string | null;
  feedLastModified: string | null;
  lastScannedAt: Date | null;
};
const createdRunIds: string[] = [];

integration('Phase 1 queue, lock and telemetry', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 4 });
    db = connection.db;
    sqlClient = connection.client;

    const [row] = await db
      .select({
        id: sources.id,
        name: sources.name,
        baseUrl: sources.baseUrl,
        feedUrl: sources.feedUrl,
        feedEtag: sources.feedEtag,
        feedLastModified: sources.feedLastModified,
        crawlDelayS: sources.crawlDelayS,
        lastScannedAt: sources.lastScannedAt,
      })
      .from(sources)
      .where(eq(sources.baseUrl, 'https://www.budgetbytes.com'))
      .limit(1);
    if (row === undefined) {
      throw new Error('Run migrations and db:seed before this integration test');
    }
    source = row;
    originalSourceState = {
      feedEtag: row.feedEtag,
      feedLastModified: row.feedLastModified,
      lastScannedAt: row.lastScannedAt,
    };
    await db.delete(recipes).where(eq(recipes.sourceUrl, CANONICAL_TEST_PAGE));
    await db
      .delete(recipes)
      .where(eq(recipes.sourceUrl, CANONICAL_FALLBACK_TEST_PAGE));
  });

  afterAll(async () => {
    if (db) {
      await db.delete(recipes).where(eq(recipes.sourceUrl, CANONICAL_TEST_PAGE));
      await db
        .delete(recipes)
        .where(eq(recipes.sourceUrl, CANONICAL_FALLBACK_TEST_PAGE));
      for (const runId of createdRunIds) {
        await db.delete(scanRuns).where(eq(scanRuns.id, runId));
      }
      if (source && originalSourceState) {
        await db
          .update(sources)
          .set(originalSourceState)
          .where(eq(sources.id, source.id));
      }
    }
    await sqlClient?.end({ timeout: 5 });
  });

  it('sets up the exclusive pg-boss queue idempotently with bounded retries', async () => {
    const boss = new PgBoss(databaseUrl!);
    const queueName = `scan-lifecycle-test-${process.pid}-${Date.now()}`;
    await boss.start();
    try {
      await ensureScanQueue(boss, queueName);
      await ensureScanQueue(boss, queueName);
      const queue = await boss.getQueue(queueName);
      expect(queue).toMatchObject({
        name: queueName,
        policy: 'exclusive',
        retryLimit: SCAN_QUEUE_OPTIONS.retryLimit,
        retryDelay: SCAN_QUEUE_OPTIONS.retryDelay,
        retryBackoff: true,
        retryDelayMax: SCAN_QUEUE_OPTIONS.retryDelayMax,
      });
      await boss.deleteQueue(queueName);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  }, 20_000);

  it('holds the advisory lock on a reserved connection for the whole scan', async () => {
    let release!: () => void;
    const held = withScanAdvisoryLock(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done');
        }),
      sqlClient,
    );

    // The first call reserves and acquires before it invokes the task.
    while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      withScanAdvisoryLock(async () => 'must not run', sqlClient),
    ).resolves.toEqual({ acquired: false });
    release();
    await expect(held).resolves.toEqual({ acquired: true, value: 'done' });
  });

  it('persists zero-cost telemetry and keeps failed pages eligible for the next scan', async () => {
    const fetcher = new PoliteFetcher({
      respectRobots: false,
      sleep: async () => undefined,
      fetchImpl: fakeSourceFetch,
    });
    const scanner = createPostgresScanOrchestrator({
      db,
      fetcher,
      imageOutputDir: '/tmp/recipes-scan-lifecycle-images',
      discoveryLimit: 10,
      now: advancingClock(),
    });

    const summary = await scanner.scanSource(source);
    createdRunIds.push(summary.runId);

    expect(summary).toMatchObject({
      status: 'success',
      found: 1,
      newCount: 1,
      noRecipeCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
    });

    const [run] = await db
      .select()
      .from(scanRuns)
      .where(eq(scanRuns.id, summary.runId));
    expect(run).toMatchObject({
      status: 'success',
      found: 1,
      newCount: 1,
      noRecipeCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);

    const [updatedSource] = await db
      .select({
        id: sources.id,
        name: sources.name,
        baseUrl: sources.baseUrl,
        feedUrl: sources.feedUrl,
        feedEtag: sources.feedEtag,
        feedLastModified: sources.feedLastModified,
        crawlDelayS: sources.crawlDelayS,
        lastScannedAt: sources.lastScannedAt,
      })
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(updatedSource).toMatchObject({
      feedEtag: '"integration-feed"',
      feedLastModified: 'Sun, 26 Jul 2099 07:00:00 GMT',
    });
    expect(updatedSource?.lastScannedAt).toBeInstanceOf(Date);

    if (updatedSource === undefined) throw new Error('source disappeared');
    const successfulBoundary = updatedSource.lastScannedAt;
    const failingScanner = createPostgresScanOrchestrator({
      db,
      fetcher: new PoliteFetcher({
        respectRobots: false,
        sleep: async () => undefined,
        fetchImpl: fakeFailingPageFetch,
      }),
      imageOutputDir: '/tmp/recipes-scan-lifecycle-images',
      discoveryLimit: 10,
      now: advancingClock(),
    });
    const partial = await failingScanner.scanSource(updatedSource);
    createdRunIds.push(partial.runId);
    expect(partial.status).toBe('partial');
    expect(partial.error).toContain('HTTP 503');

    const [afterPartial] = await db
      .select({
        feedEtag: sources.feedEtag,
        feedLastModified: sources.feedLastModified,
        lastScannedAt: sources.lastScannedAt,
      })
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(afterPartial).toEqual({
      feedEtag: null,
      feedLastModified: null,
      lastScannedAt: successfulBoundary,
    });
  });

  it('persists paid HTML-fallback usage into the source scan row', async () => {
    const scanner = createPostgresScanOrchestrator({
      db,
      fetcher: new PoliteFetcher({
        respectRobots: false,
        sleep: async () => undefined,
        fetchImpl: fakeFallbackSourceFetch,
      }),
      imageOutputDir: '/tmp/recipes-scan-lifecycle-images',
      discoveryLimit: 10,
      now: advancingClock(),
      async htmlFallback(input) {
        expect(input.extraction.found).toBe(false);
        return {
          outcome: 'recipe',
          draft: fallbackDraft(input.pageUrl),
          usage: {
            tokensIn: 321,
            tokensOut: 45,
            costUsd: 0.000456,
          },
        };
      },
    });

    const summary = await scanner.scanSource(source);
    createdRunIds.push(summary.runId);

    expect(summary).toMatchObject({
      status: 'success',
      found: 1,
      newCount: 1,
      noRecipeCount: 0,
      tokensIn: 321,
      tokensOut: 45,
      costUsd: 0.000456,
    });

    const [run] = await db
      .select()
      .from(scanRuns)
      .where(eq(scanRuns.id, summary.runId));
    expect(run).toMatchObject({
      status: 'success',
      tokensIn: 321,
      tokensOut: 45,
      costUsd: 0.000456,
    });
  });

  it('does not erase durable fallback usage when paid extraction later throws', async () => {
    const scanner = createPostgresScanOrchestrator({
      db,
      fetcher: new PoliteFetcher({
        respectRobots: false,
        sleep: async () => undefined,
        fetchImpl: fakeFallbackSourceFetch,
      }),
      imageOutputDir: '/tmp/recipes-scan-lifecycle-images',
      discoveryLimit: 10,
      now: advancingClock(),
      async htmlFallback(input) {
        await recordLlmUsage(db, input.runId, {
          tokensIn: 654,
          tokensOut: 32,
          costUsd: 0.000789,
        });
        throw new Error('malformed paid fallback response');
      },
    });

    const summary = await scanner.scanSource(source);
    createdRunIds.push(summary.runId);

    expect(summary).toMatchObject({
      status: 'partial',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect(summary.error).toContain('malformed paid fallback response');

    const [run] = await db
      .select({
        status: scanRuns.status,
        tokensIn: scanRuns.tokensIn,
        tokensOut: scanRuns.tokensOut,
        costUsd: scanRuns.costUsd,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, summary.runId));
    expect(run).toEqual({
      status: 'partial',
      tokensIn: 654,
      tokensOut: 32,
      costUsd: 0.000789,
    });
  });
});

const fakeSourceFetch: typeof fetch = async (input) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes('/feed')) {
    return new Response(
      `<?xml version="1.0"?>
       <rss version="2.0"><channel><item>
         <title>Lifecycle integration recipe</title>
         <link>${TEST_PAGE}</link>
         <pubDate>Sun, 26 Jul 2099 07:00:00 GMT</pubDate>
       </item></channel></rss>`,
      {
        status: 200,
        headers: {
          'content-type': 'application/rss+xml',
          etag: '"integration-feed"',
          'last-modified': 'Sun, 26 Jul 2099 07:00:00 GMT',
        },
      },
    );
  }
  if (url.includes('__phase-1-scan-lifecycle-integration__')) {
    return new Response(
      `<html><head><script type="application/ld+json">
       {
         "@context":"https://schema.org",
         "@type":"Recipe",
         "name":"Lifecycle Integration Recipe",
         "recipeIngredient":["1 onion"],
         "recipeInstructions":[{"@type":"HowToStep","text":"Cook the onion."}],
         "recipeYield":"4 servings"
       }
       </script></head><body></body></html>`,
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          etag: '"integration-page"',
        },
      },
    );
  }
  return new Response('not found', { status: 404 });
};

const fakeFailingPageFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes('/feed')) return fakeSourceFetch(input, init);
  if (url.includes('__phase-1-scan-lifecycle-integration__')) {
    return new Response('temporary page failure', { status: 503 });
  }
  return new Response('not found', { status: 404 });
};

const fakeFallbackSourceFetch: typeof fetch = async (input) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes('/feed')) {
    return new Response(
      `<?xml version="1.0"?>
       <rss version="2.0"><channel><item>
         <title>Fallback integration recipe</title>
         <link>${FALLBACK_TEST_PAGE}</link>
         <pubDate>Sun, 26 Jul 2099 08:00:00 GMT</pubDate>
       </item></channel></rss>`,
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    );
  }
  if (url.includes('__phase-2-html-fallback-integration__')) {
    return new Response(
      '<html><body><article><h1>Fallback Recipe</h1><p>Visible recipe text.</p></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }
  return new Response('not found', { status: 404 });
};

function fallbackDraft(sourceUrl: string): RecipeDraft {
  return {
    sourceUrl,
    contentHash: 'fallback-content-hash',
    title: 'Fallback Integration Recipe',
    slug: 'fallback-integration-recipe',
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 4,
    imageUrl: null,
    author: null,
    sourceRating: null,
    sourceRatingCount: null,
    instructions: [{ name: null, text: 'Cook the onion.' }],
    rawJsonld: null,
    publishedAt: new Date('2099-07-26T08:00:00.000Z'),
    ingredients: [{ position: 0, rawText: '1 onion' }],
    missing: [],
  };
}

function advancingClock(): () => Date {
  let time = Date.parse('2026-07-26T07:00:00.000Z');
  return () => {
    const now = new Date(time);
    time += 1_000;
    return now;
  };
}

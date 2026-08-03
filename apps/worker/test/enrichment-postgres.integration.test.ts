import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from '@recipes/db/operators';
import {
  recipeIngredients,
  recipes,
  scanRuns,
  sources,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  getDailyLlmUsage,
  recordLlmUsage,
} from '@recipes/db/llm-budget';
import {
  beginEnrichmentRun,
  completeRecipeEnrichment,
  finishEnrichmentRun,
  loadNextPendingRecipe,
} from '../src/enrichment/postgres';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const URL_PREFIX = 'https://budgetbytes.com/__phase-2-persistence-';
const TEST_URLS = [
  `${URL_PREFIX}pending`,
  `${URL_PREFIX}accepted`,
  `${URL_PREFIX}rejected`,
  `${URL_PREFIX}stale`,
] as const;

let db: Database;
let close: (() => Promise<void>) | undefined;
let sourceId: string;
const runIds: string[] = [];

integration('Phase 2 enrichment persistence', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 8 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });

    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.baseUrl, 'https://www.budgetbytes.com'))
      .limit(1);
    if (source === undefined) {
      throw new Error('Run migrations and db:seed before this integration test');
    }
    sourceId = source.id;
    await db.delete(recipes).where(inArray(recipes.sourceUrl, TEST_URLS));
  });

  afterAll(async () => {
    if (db) {
      await db.delete(recipes).where(inArray(recipes.sourceUrl, TEST_URLS));
      if (runIds.length > 0) {
        await db.delete(scanRuns).where(inArray(scanRuns.id, runIds));
      }
    }
    await close?.();
  });

  it('loads the oldest pending recipe with ordered deterministic ingredients', async () => {
    const recipeId = await insertPendingRecipe(
      TEST_URLS[0],
      'pending-hash',
      new Date('1900-01-01T00:00:00.000Z'),
      ['2 carrots', '1 onion'],
    );

    const pending = await loadNextPendingRecipe(db);

    expect(pending).toMatchObject({
      id: recipeId,
      contentHash: 'pending-hash',
      sourceUrl: TEST_URLS[0],
      title: 'Persistence pending',
      totalMinutes: 30,
      servings: 4,
      ingredients: [
        { position: 0, rawText: '2 carrots' },
        { position: 1, rawText: '1 onion' },
      ],
    });
  });

  it('atomically completes accepted and rejected recipes and rejects stale answers', async () => {
    const acceptedId = await insertPendingRecipe(
      TEST_URLS[1],
      'accepted-hash',
      new Date('1900-01-02T00:00:00.000Z'),
    );
    const rejectedId = await insertPendingRecipe(
      TEST_URLS[2],
      'rejected-hash',
      new Date('1900-01-03T00:00:00.000Z'),
    );
    const staleId = await insertPendingRecipe(
      TEST_URLS[3],
      'stale-hash-v1',
      new Date('1900-01-04T00:00:00.000Z'),
    );

    await expect(
      completeRecipeEnrichment(db, {
        recipeId: acceptedId,
        expectedContentHash: 'accepted-hash',
        outcome: 'accepted',
        blurb: '  Five lunches from one comforting pot.  ',
        fields: {
          keeps_days: 4,
          freezer_months: 2,
          category: 'Vegetarian',
          tags: ['One pot', 'Big batch'],
        },
      }),
    ).resolves.toEqual({ outcome: 'completed', recipeId: acceptedId });

    await expect(
      completeRecipeEnrichment(db, {
        recipeId: rejectedId,
        expectedContentHash: 'rejected-hash',
        outcome: 'rejected',
        reason: '  A single-serve cocktail is not meal prep.  ',
      }),
    ).resolves.toEqual({ outcome: 'completed', recipeId: rejectedId });

    await db
      .update(recipes)
      .set({ contentHash: 'stale-hash-v2' })
      .where(eq(recipes.id, staleId));
    await expect(
      completeRecipeEnrichment(db, {
        recipeId: staleId,
        expectedContentHash: 'stale-hash-v1',
        outcome: 'accepted',
        blurb: 'Must not land.',
        fields: {
          keeps_days: 3,
          freezer_months: null,
          category: 'Chicken',
          tags: [],
        },
      }),
    ).resolves.toEqual({ outcome: 'stale', recipeId: staleId });

    const rows = await db
      .select({
        id: recipes.id,
        status: recipes.status,
        blurb: recipes.blurb,
        keepsDays: recipes.keepsDays,
        freezerMonths: recipes.freezerMonths,
        category: recipes.category,
        tags: recipes.tags,
        rejectionReason: recipes.rejectionReason,
      })
      .from(recipes)
      .where(inArray(recipes.id, [acceptedId, rejectedId, staleId]));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(acceptedId)).toMatchObject({
      status: 'active',
      blurb: 'Five lunches from one comforting pot.',
      keepsDays: 4,
      freezerMonths: 2,
      category: 'Vegetarian',
      tags: ['One pot', 'Big batch'],
      rejectionReason: null,
    });
    expect(byId.get(rejectedId)).toMatchObject({
      status: 'rejected',
      blurb: null,
      keepsDays: null,
      freezerMonths: null,
      category: null,
      tags: [],
      rejectionReason: 'A single-serve cocktail is not meal prep.',
    });
    expect(byId.get(staleId)).toMatchObject({
      status: 'pending',
      blurb: null,
      category: null,
      rejectionReason: null,
    });

    await expect(
      db
        .update(recipes)
        .set({ status: 'rejected', rejectionReason: null })
        .where(eq(recipes.id, staleId)),
    ).rejects.toThrow();
    await expect(
      db
        .update(recipes)
        .set({ status: 'active', blurb: null, category: null })
        .where(eq(recipes.id, staleId)),
    ).rejects.toThrow();
  });

  it('persists atomic usage increments, daily spend, and final lifecycle state', async () => {
    const previousDayRun = await beginEnrichmentRun(
      db,
      new Date('2099-07-25T23:59:00.000Z'),
    );
    const currentRun = await beginEnrichmentRun(
      db,
      new Date('2099-07-26T10:00:00.000Z'),
    );
    runIds.push(previousDayRun, currentRun);

    await recordLlmUsage(db, previousDayRun, 'scan', {
      tokensIn: 9_999,
      tokensOut: 999,
      costUsd: 0.9,
    });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        recordLlmUsage(db, currentRun, 'scan', {
          tokensIn: 100,
          tokensOut: 25,
          costUsd: 0.0005,
        }),
      ),
    );

    const usage = await getDailyLlmUsage(
      db,
      'scan',
      new Date('2099-07-26T20:00:00.000Z'),
    );
    expect(usage).toMatchObject({
      dayStartedAt: new Date('2099-07-26T00:00:00.000Z'),
      dayEndsAt: new Date('2099-07-27T00:00:00.000Z'),
      tokensIn: 2_000,
      tokensOut: 500,
    });
    expect(usage.costUsd).toBeCloseTo(0.01, 8);

    const finishedAt = new Date('2099-07-26T10:05:00.000Z');
    await finishEnrichmentRun(db, {
      runId: currentRun,
      status: 'success',
      processedCount: 2,
      finishedAt,
    });
    await finishEnrichmentRun(db, {
      runId: previousDayRun,
      status: 'partial',
      processedCount: 1,
      error: 'daily budget reached',
      finishedAt: new Date('2099-07-25T23:59:30.000Z'),
    });

    const [run] = await db
      .select()
      .from(scanRuns)
      .where(eq(scanRuns.id, currentRun));
    expect(run).toMatchObject({
      sourceId: null,
      status: 'success',
      found: 2,
      tokensIn: 2_000,
      tokensOut: 500,
      finishedAt,
      error: null,
    });
    expect(run?.costUsd).toBeCloseTo(0.01, 8);
  });
});

async function insertPendingRecipe(
  sourceUrl: string,
  contentHash: string,
  firstSeenAt: Date,
  ingredients: readonly string[] = ['1 onion'],
): Promise<string> {
  const slug = sourceUrl.slice(URL_PREFIX.length);
  const [recipe] = await db
    .insert(recipes)
    .values({
      sourceId,
      sourceUrl,
      contentHash,
      title: `Persistence ${slug}`,
      slug: `persistence-${slug}`,
      totalMinutes: 30,
      activeMinutes: 10,
      servings: 4,
      instructions: [{ name: null, text: 'Cook it.' }],
      rawJsonld: { '@type': 'Recipe', name: `Persistence ${slug}` },
      status: 'pending',
      firstSeenAt,
      lastSeenAt: firstSeenAt,
    })
    .returning({ id: recipes.id });
  if (recipe === undefined) throw new Error('test recipe insert returned no row');

  await db.insert(recipeIngredients).values(
    ingredients.map((rawText, position) => ({
      recipeId: recipe.id,
      position,
      rawText,
      qty: 1,
      unit: null,
      note: null,
      optional: false,
    })),
  );
  return recipe.id;
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from '@recipes/db/operators';
import { recipeIngredients, recipes, sources } from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import type { RecipeDraft } from '../src/scanner/jsonld';
import { markRecipeSeen, persistRecipeDraft } from '../src/storage/recipes';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const TEST_URL = 'https://www.budgetbytes.com/__storage-integration-recipe__/?utm_source=test';
const CANONICAL_TEST_URL = 'https://budgetbytes.com/__storage-integration-recipe__';

let db: Database;
let close: (() => Promise<void>) | undefined;
let sourceId: string;

integration('transactional recipe persistence', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 1 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });

    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.baseUrl, 'https://www.budgetbytes.com'))
      .limit(1);
    if (source === undefined) throw new Error('Run migrations and db:seed before this integration test');
    sourceId = source.id;
    await db.delete(recipes).where(eq(recipes.sourceUrl, CANONICAL_TEST_URL));
  });

  afterAll(async () => {
    if (db) await db.delete(recipes).where(eq(recipes.sourceUrl, CANONICAL_TEST_URL));
    await close?.();
  });

  it('inserts, touches unchanged content, replaces changed ingredients, and rolls back failures', async () => {
    const firstSeen = new Date('2026-07-26T12:00:00.000Z');
    const seenAgain = new Date('2026-07-26T13:00:00.000Z');
    const changedAt = new Date('2026-07-26T14:00:00.000Z');
    const touchedAt = new Date('2026-07-26T15:00:00.000Z');

    const inserted = await persistRecipeDraft(db, {
      sourceId,
      draft: draft('hash-v1', 'Original title', ['1 onion', '2 carrots']),
      ingredients: [ingredient(0, '1 onion'), ingredient(1, '2 carrots')],
      validators: { etag: '"v1"', lastModified: 'Sun, 26 Jul 2026 12:00:00 GMT' },
      seenAt: firstSeen,
    });
    expect(inserted.outcome).toBe('inserted');
    expect(inserted.sourceUrl).toBe(CANONICAL_TEST_URL);

    const unchanged = await persistRecipeDraft(db, {
      sourceId,
      // Same hash is authoritative: these changed values must not land.
      draft: draft('hash-v1', 'Ignored title', ['9 ignored things']),
      ingredients: [ingredient(0, '9 ignored things')],
      validators: { etag: '"v1b"' },
      seenAt: seenAgain,
    });
    expect(unchanged.outcome).toBe('unchanged');

    let [row] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.sourceUrl, CANONICAL_TEST_URL));
    expect(row).toMatchObject({
      id: inserted.recipeId,
      title: 'Original title',
      contentHash: 'hash-v1',
      pageEtag: '"v1b"',
      firstSeenAt: firstSeen,
      lastSeenAt: seenAgain,
    });
    expect(await ingredientTexts(inserted.recipeId)).toEqual(['1 onion', '2 carrots']);

    const changed = await persistRecipeDraft(db, {
      sourceId,
      draft: draft('hash-v2', 'Updated title', ['3 potatoes']),
      ingredients: [ingredient(0, '3 potatoes')],
      validators: { etag: '"v2"' },
      seenAt: changedAt,
    });
    expect(changed).toMatchObject({ outcome: 'updated', recipeId: inserted.recipeId });
    expect(await ingredientTexts(inserted.recipeId)).toEqual(['3 potatoes']);

    await expect(
      persistRecipeDraft(db, {
        sourceId,
        draft: draft('hash-bad', 'Must roll back', ['duplicate a', 'duplicate b']),
        ingredients: [ingredient(0, 'duplicate a'), ingredient(0, 'duplicate b')],
        seenAt: new Date('2026-07-26T14:30:00.000Z'),
      }),
    ).rejects.toThrow();
    [row] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.sourceUrl, CANONICAL_TEST_URL));
    expect(row?.contentHash).toBe('hash-v2');
    expect(row?.title).toBe('Updated title');
    expect(await ingredientTexts(inserted.recipeId)).toEqual(['3 potatoes']);

    await expect(
      markRecipeSeen(db, TEST_URL, { etag: '"v3"' }, touchedAt),
    ).resolves.toBe(true);
    [row] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.sourceUrl, CANONICAL_TEST_URL));
    expect(row?.firstSeenAt).toEqual(firstSeen);
    expect(row?.lastSeenAt).toEqual(touchedAt);
    expect(row?.pageEtag).toBe('"v3"');
  });
});

function draft(hash: string, title: string, rawIngredients: string[]): RecipeDraft {
  return {
    sourceUrl: TEST_URL,
    contentHash: hash,
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 4,
    imageUrl: 'https://images.example/recipe.jpg',
    author: 'Test Author',
    sourceRating: 4.5,
    sourceRatingCount: 12,
    instructions: [{ name: null, text: 'Cook it.' }],
    rawJsonld: { '@type': 'Recipe', name: title },
    publishedAt: new Date('2026-07-25T00:00:00.000Z'),
    ingredients: rawIngredients.map((rawText, position) => ({ position, rawText })),
    missing: [],
  };
}

function ingredient(position: number, rawText: string) {
  return {
    position,
    rawText,
    ingredientId: null,
    qty: 1,
    unit: null,
    note: null,
    optional: false,
  };
}

async function ingredientTexts(recipeId: string): Promise<string[]> {
  const rows = await db
    .select({ rawText: recipeIngredients.rawText })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(recipeIngredients.position);
  return rows.map((item) => item.rawText);
}

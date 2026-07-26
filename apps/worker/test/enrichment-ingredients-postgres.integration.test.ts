import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from '@recipes/db/operators';
import {
  ingredientAliases,
  ingredients,
  recipeIngredients,
  recipes,
  sources,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  applyIngredientMappings,
  loadUnmappedIngredientLines,
  type IngredientMappingDecision,
  type ParsedIngredientLineRef,
} from '../src/enrichment/ingredients-postgres';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const TEST_URL = 'https://budgetbytes.com/__phase-2-ingredient-mapping__';
const CHICKEN_INPUT = 'phase2 boneless chicken test';
const NEW_INPUT = 'phase2 moon greens leaves';
const NEW_CANONICAL = 'phase2 moon greens';
const CONFLICT_INPUT = 'phase2 retained conflict alias';
const CONFLICT_CANONICAL = 'phase2 must not be inserted';
const INVALID_INPUT = 'phase2 invalid aisle input';
const INVALID_CANONICAL = 'phase2 invalid aisle canonical';
const SHARED_INPUT_ONE = 'phase2 shared leafy alias one';
const SHARED_INPUT_TWO = 'phase2 shared leafy alias two';
const SHARED_CANONICAL = 'phase2 shared leafy canonical';
const TEST_ALIASES = [
  CHICKEN_INPUT,
  NEW_INPUT,
  NEW_CANONICAL,
  CONFLICT_INPUT,
  INVALID_INPUT,
  INVALID_CANONICAL,
  SHARED_INPUT_ONE,
  SHARED_INPUT_TWO,
  SHARED_CANONICAL,
] as const;
const TEST_CANONICALS = [
  NEW_CANONICAL,
  CONFLICT_CANONICAL,
  INVALID_CANONICAL,
  SHARED_CANONICAL,
] as const;

let db: Database;
let close: (() => Promise<void>) | undefined;
let sourceId: string;
let recipeId: string;
let chickenId: string;
let onionId: string;
let chickenAisle: string;

integration('Phase 2 semantic ingredient persistence', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 4 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });

    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.baseUrl, 'https://www.budgetbytes.com'))
      .limit(1);
    const [chicken] = await db
      .select({ id: ingredients.id, aisle: ingredients.aisle })
      .from(ingredients)
      .where(eq(ingredients.name, 'chicken breast'))
      .limit(1);
    const [onion] = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(eq(ingredients.name, 'yellow onion'))
      .limit(1);
    if (source === undefined || chicken === undefined || onion === undefined) {
      throw new Error('Run migrations and db:seed before this integration test');
    }
    sourceId = source.id;
    chickenId = chicken.id;
    chickenAisle = chicken.aisle;
    onionId = onion.id;

    await cleanup();
    const [inserted] = await db
      .insert(recipes)
      .values({
        sourceId,
        sourceUrl: TEST_URL,
        contentHash: 'ingredient-mapping-hash',
        title: 'Ingredient mapping persistence',
        slug: 'ingredient-mapping-persistence',
        instructions: [{ name: null, text: 'Cook it.' }],
        status: 'pending',
      })
      .returning({ id: recipes.id });
    if (inserted === undefined) throw new Error('test recipe insert returned no row');
    recipeId = inserted.id;

    await db.insert(recipeIngredients).values([
      line(0, '2 lb phase2 boneless chicken test'),
      line(1, '1 bunch phase2 moon greens leaves'),
      line(2, '1 tsp phase2 retained conflict alias'),
      line(3, '3 lb phase2 boneless chicken test'),
      line(4, '1 cup phase2 invalid aisle input'),
    ]);
    await db.insert(ingredientAliases).values({
      ingredientId: onionId,
      alias: CONFLICT_INPUT,
    });
    // Simulate a line that changed state after its parsed reference was made.
    await db
      .update(recipeIngredients)
      .set({ ingredientId: chickenId })
      .where(
        and(
          eq(recipeIngredients.recipeId, recipeId),
          eq(recipeIngredients.position, 3),
        ),
      );
  });

  afterAll(async () => {
    if (db) await cleanup();
    await close?.();
  });

  it('loads unmapped lines in a stable bounded order', async () => {
    const first = await loadUnmappedIngredientLines(db, 10);
    const second = await loadUnmappedIngredientLines(db, 10);

    expect(first).toEqual(second);
    expect(first).toEqual(
      [...first].sort(
        (left, right) =>
          compare(left.recipeId, right.recipeId) ||
          left.position - right.position,
      ),
    );
    expect(first.length).toBeGreaterThan(0);
    await expect(loadUnmappedIngredientLines(db, 0)).rejects.toThrow(RangeError);
  });

  it('reuses exact canonicals, creates normalized canonicals, retains alias owners, and is idempotent', async () => {
    const decisions: IngredientMappingDecision[] = [
      {
        inputName: '  Phase2 Boneless Chicken Test ',
        canonicalName: ' Chicken Breast ',
        // Existing canonical metadata is authoritative; this must be ignored.
        aisle: 'Produce',
      },
      {
        inputName: 'Phase2 Moon Greens Leaves',
        canonicalName: ' Phase2 Moon Greens ',
        aisle: 'Produce',
      },
      {
        inputName: CONFLICT_INPUT,
        canonicalName: CONFLICT_CANONICAL,
        aisle: 'Pantry',
      },
    ];
    const refs: ParsedIngredientLineRef[] = [
      ref(0, '2 lb phase2 boneless chicken test', CHICKEN_INPUT),
      ref(1, '1 bunch phase2 moon greens leaves', NEW_INPUT),
      ref(2, '1 tsp phase2 retained conflict alias', CONFLICT_INPUT),
      ref(3, '3 lb phase2 boneless chicken test', CHICKEN_INPUT),
    ];

    await expect(
      applyIngredientMappings(db, decisions, refs),
    ).resolves.toEqual({
      learnedCount: 2,
      mappedCount: 3,
      staleCount: 1,
      conflictCount: 1,
    });

    const [created] = await db
      .select({ id: ingredients.id, aisle: ingredients.aisle })
      .from(ingredients)
      .where(eq(ingredients.name, NEW_CANONICAL));
    expect(created).toMatchObject({ aisle: 'Produce' });
    if (created === undefined) throw new Error('new canonical was not inserted');

    const rows = await db
      .select({
        position: recipeIngredients.position,
        ingredientId: recipeIngredients.ingredientId,
      })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, recipeId))
      .orderBy(recipeIngredients.position);
    expect(rows).toEqual([
      { position: 0, ingredientId: chickenId },
      { position: 1, ingredientId: created.id },
      { position: 2, ingredientId: onionId },
      { position: 3, ingredientId: chickenId },
      { position: 4, ingredientId: null },
    ]);

    const aliases = await db
      .select({
        alias: ingredientAliases.alias,
        ingredientId: ingredientAliases.ingredientId,
      })
      .from(ingredientAliases)
      .where(inArray(ingredientAliases.alias, [
        CHICKEN_INPUT,
        NEW_INPUT,
        NEW_CANONICAL,
        CONFLICT_INPUT,
      ]));
    expect(aliases).toEqual(
      expect.arrayContaining([
        { alias: CHICKEN_INPUT, ingredientId: chickenId },
        { alias: NEW_INPUT, ingredientId: created.id },
        { alias: NEW_CANONICAL, ingredientId: created.id },
        { alias: CONFLICT_INPUT, ingredientId: onionId },
      ]),
    );

    const [unchangedChicken] = await db
      .select({ aisle: ingredients.aisle })
      .from(ingredients)
      .where(eq(ingredients.id, chickenId));
    expect(unchangedChicken?.aisle).toBe(chickenAisle);
    const conflictCanonical = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(eq(ingredients.name, CONFLICT_CANONICAL));
    expect(conflictCanonical).toEqual([]);

    await expect(
      applyIngredientMappings(db, decisions, refs),
    ).resolves.toEqual({
      learnedCount: 0,
      mappedCount: 0,
      staleCount: 4,
      conflictCount: 0,
    });
  });

  it('rejects an uncontrolled aisle before changing canonical or recipe state', async () => {
    const invalidDecision = {
      inputName: INVALID_INPUT,
      canonicalName: INVALID_CANONICAL,
      aisle: 'Hardware',
    } as unknown as IngredientMappingDecision;
    const invalidRef = ref(
      4,
      '1 cup phase2 invalid aisle input',
      INVALID_INPUT,
    );

    await expect(
      applyIngredientMappings(db, [invalidDecision], [invalidRef]),
    ).rejects.toThrow('Invalid ingredient aisle');

    const [lineAfter] = await db
      .select({ ingredientId: recipeIngredients.ingredientId })
      .from(recipeIngredients)
      .where(
        and(
          eq(recipeIngredients.recipeId, recipeId),
          eq(recipeIngredients.position, 4),
        ),
      );
    expect(lineAfter?.ingredientId).toBeNull();
    const invalidCanonical = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(eq(ingredients.name, INVALID_CANONICAL));
    expect(invalidCanonical).toEqual([]);
  });

  it('teaches several input aliases to one new canonical when aisles agree', async () => {
    await db.insert(recipeIngredients).values([
      line(5, `1 cup ${SHARED_INPUT_ONE}`),
      line(6, `2 cups ${SHARED_INPUT_TWO}`),
    ]);
    const decisions: IngredientMappingDecision[] = [
      {
        inputName: SHARED_INPUT_ONE,
        canonicalName: SHARED_CANONICAL,
        aisle: 'Produce',
      },
      {
        inputName: SHARED_INPUT_TWO,
        canonicalName: SHARED_CANONICAL,
        aisle: 'Produce',
      },
    ];

    await expect(
      applyIngredientMappings(db, decisions, [
        ref(5, `1 cup ${SHARED_INPUT_ONE}`, SHARED_INPUT_ONE),
        ref(6, `2 cups ${SHARED_INPUT_TWO}`, SHARED_INPUT_TWO),
      ]),
    ).resolves.toEqual({
      learnedCount: 2,
      mappedCount: 2,
      staleCount: 0,
      conflictCount: 0,
    });

    const [canonical] = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(eq(ingredients.name, SHARED_CANONICAL));
    expect(canonical).toBeDefined();
    const aliases = await db
      .select({
        alias: ingredientAliases.alias,
        ingredientId: ingredientAliases.ingredientId,
      })
      .from(ingredientAliases)
      .where(
        inArray(ingredientAliases.alias, [
          SHARED_INPUT_ONE,
          SHARED_INPUT_TWO,
        ]),
      );
    expect(aliases).toEqual(
      expect.arrayContaining([
        { alias: SHARED_INPUT_ONE, ingredientId: canonical?.id },
        { alias: SHARED_INPUT_TWO, ingredientId: canonical?.id },
      ]),
    );
  });

  it('rejects conflicting aisles for one proposed canonical before writing', async () => {
    const decisions: IngredientMappingDecision[] = [
      {
        inputName: 'phase2 aisle conflict one',
        canonicalName: 'phase2 aisle conflict canonical',
        aisle: 'Produce',
      },
      {
        inputName: 'phase2 aisle conflict two',
        canonicalName: 'phase2 aisle conflict canonical',
        aisle: 'Pantry',
      },
    ];

    await expect(
      applyIngredientMappings(db, decisions, []),
    ).rejects.toThrow('Conflicting aisles');
  });
});

function line(position: number, rawText: string) {
  return {
    recipeId,
    position,
    rawText,
    ingredientId: null,
    qty: 1,
    unit: null,
    note: null,
    optional: false,
  };
}

function ref(
  position: number,
  rawText: string,
  parsedName: string,
): ParsedIngredientLineRef {
  return { recipeId, position, rawText, parsedName };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function cleanup(): Promise<void> {
  await db.delete(recipes).where(eq(recipes.sourceUrl, TEST_URL));
  await db
    .delete(ingredientAliases)
    .where(inArray(ingredientAliases.alias, TEST_ALIASES));
  await db
    .delete(ingredients)
    .where(inArray(ingredients.name, TEST_CANONICALS));
}

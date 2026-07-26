import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FUZZY_AMBIGUITY_MARGIN,
  DEFAULT_FUZZY_MATCH_THRESHOLD,
  createIngredientMatcher,
  type AliasCandidate,
  type IngredientAliasRepository,
} from '../src/ingredients/matcher';
import { normalizeIngredientLines } from '../src/ingredients/normalize';

const candidate = (
  ingredientId: string,
  canonicalName: string,
  alias: string,
  similarity: number,
): AliasCandidate => ({ ingredientId, canonicalName, alias, similarity });

class MemoryAliases implements IngredientAliasRepository {
  readonly exact = new Map<string, AliasCandidate>();
  fuzzy: AliasCandidate[] = [];
  remembered: Array<{ alias: string; ingredientId: string }> = [];
  conflict: AliasCandidate | null = null;
  fuzzyCalls = 0;

  async findExact(alias: string): Promise<AliasCandidate | null> {
    return this.exact.get(alias) ?? null;
  }

  async findFuzzy(): Promise<readonly AliasCandidate[]> {
    this.fuzzyCalls += 1;
    return this.fuzzy;
  }

  async remember(alias: string, ingredientId: string): Promise<void> {
    this.remembered.push({ alias, ingredientId });
    const learned =
      this.conflict ??
      candidate(
        ingredientId,
        this.fuzzy.find((item) => item.ingredientId === ingredientId)?.canonicalName ?? 'unknown',
        alias,
        1,
      );
    this.exact.set(alias, learned);
  }
}

describe('createIngredientMatcher — exact matching', () => {
  it('normalises with the same key as the seed and gives exact aliases precedence', async () => {
    const repository = new MemoryAliases();
    repository.exact.set(
      'chicken breast',
      candidate('chicken-id', 'chicken breast', 'chicken breast', 1),
    );
    repository.fuzzy = [candidate('wrong-id', 'chicken broth', 'chicken broth', 0.99)];

    await expect(createIngredientMatcher(repository).match('  Chicken   Breast ')).resolves.toEqual({
      ingredientId: 'chicken-id',
      canonicalName: 'chicken breast',
      matchedAlias: 'chicken breast',
      strategy: 'exact',
      similarity: 1,
    });
    expect(repository.fuzzyCalls).toBe(0);
    expect(repository.remembered).toEqual([]);
  });

  it('returns null for an empty normalized name without querying', async () => {
    const repository = new MemoryAliases();
    await expect(createIngredientMatcher(repository).match('   ')).resolves.toBeNull();
    expect(repository.fuzzyCalls).toBe(0);
  });
});

describe('createIngredientMatcher — conservative fuzzy matching', () => {
  it('uses explicit conservative defaults', () => {
    expect(DEFAULT_FUZZY_MATCH_THRESHOLD).toBe(0.78);
    expect(DEFAULT_FUZZY_AMBIGUITY_MARGIN).toBe(0.08);
  });

  it('accepts a clear fuzzy winner, writes the alias, and reports fuzzy provenance', async () => {
    const repository = new MemoryAliases();
    repository.fuzzy = [
      candidate('broth-id', 'chicken broth', 'chicken broth', 0.8),
      candidate('chicken-id', 'chicken breast', 'chicken breast', 0.91),
    ];

    await expect(createIngredientMatcher(repository).match('Chicken Breasts')).resolves.toEqual({
      ingredientId: 'chicken-id',
      canonicalName: 'chicken breast',
      matchedAlias: 'chicken breast',
      strategy: 'fuzzy',
      similarity: 0.91,
    });
    expect(repository.remembered).toEqual([
      { alias: 'chicken breasts', ingredientId: 'chicken-id' },
    ]);
    expect(repository.exact.get('chicken breasts')?.ingredientId).toBe('chicken-id');
  });

  it('does not treat several aliases for the same ingredient as ambiguity', async () => {
    const repository = new MemoryAliases();
    repository.fuzzy = [
      candidate('tomato-id', 'diced tomatoes', 'diced tomato', 0.93),
      candidate('tomato-id', 'diced tomatoes', 'diced tomatoes', 0.9),
      candidate('paste-id', 'tomato paste', 'tomato paste', 0.82),
    ];

    await expect(createIngredientMatcher(repository).match('diced tomatos')).resolves.toMatchObject({
      ingredientId: 'tomato-id',
      strategy: 'fuzzy',
    });
    expect(repository.remembered).toHaveLength(1);
  });

  it('rejects an ambiguous winner and performs no writeback', async () => {
    const repository = new MemoryAliases();
    repository.fuzzy = [
      candidate('red-id', 'red onion', 'red onion', 0.91),
      candidate('yellow-id', 'yellow onion', 'yellow onion', 0.86),
    ];

    await expect(createIngredientMatcher(repository).match('onion')).resolves.toBeNull();
    expect(repository.remembered).toEqual([]);
  });

  it('rejects a score at the threshold and performs no writeback', async () => {
    const repository = new MemoryAliases();
    repository.fuzzy = [
      candidate('bean-id', 'black beans', 'black beans', DEFAULT_FUZZY_MATCH_THRESHOLD),
    ];

    await expect(createIngredientMatcher(repository).match('black bean')).resolves.toBeNull();
    expect(repository.remembered).toEqual([]);
  });

  it('leaves an unmapped miss alone', async () => {
    const repository = new MemoryAliases();
    await expect(createIngredientMatcher(repository).match('dragon fruit powder')).resolves.toBeNull();
    expect(repository.remembered).toEqual([]);
  });

  it('honors the unique alias row learned by a concurrent worker', async () => {
    const repository = new MemoryAliases();
    repository.fuzzy = [candidate('first-id', 'first choice', 'first choice', 0.94)];
    repository.conflict = candidate('winner-id', 'concurrent winner', 'input alias', 1);

    await expect(createIngredientMatcher(repository).match('input alias')).resolves.toEqual({
      ingredientId: 'winner-id',
      canonicalName: 'concurrent winner',
      matchedAlias: 'input alias',
      strategy: 'exact',
      similarity: 1,
    });
  });

  it('validates threshold options rather than silently accepting nonsense', () => {
    const repository = new MemoryAliases();
    expect(() => createIngredientMatcher(repository, { fuzzyThreshold: 1.1 })).toThrow(RangeError);
    expect(() => createIngredientMatcher(repository, { ambiguityMargin: -0.1 })).toThrow(RangeError);
  });
});

describe('normalizeIngredientLines', () => {
  it('produces recipe_ingredients-ready rows while preserving unmapped lines', async () => {
    const match = vi.fn(async (name: string) =>
      name.toLowerCase() === 'black beans'
        ? {
            ingredientId: 'bean-id',
            canonicalName: 'black beans',
            matchedAlias: 'black beans',
            strategy: 'exact' as const,
            similarity: 1,
          }
        : null,
    );

    await expect(
      normalizeIngredientLines(
        ['1 (15-ounce) can black beans', 'Salt to taste', '2 cups mystery greens (optional)'],
        { match },
      ),
    ).resolves.toEqual([
      {
        position: 0,
        rawText: '1 (15-ounce) can black beans',
        ingredientId: 'bean-id',
        qty: 1,
        unit: 'can',
        note: '15-ounce',
        optional: false,
      },
      {
        position: 1,
        rawText: 'Salt to taste',
        ingredientId: null,
        qty: null,
        unit: null,
        note: 'to taste',
        optional: false,
      },
      {
        position: 2,
        rawText: '2 cups mystery greens (optional)',
        ingredientId: null,
        qty: 2,
        unit: 'cups',
        note: null,
        optional: true,
      },
    ]);
  });

  it('deduplicates matching by normalized alias key within a batch', async () => {
    const match = vi.fn(async () => null);
    await normalizeIngredientLines(['1 cup Olive Oil', '2 tbsp olive   oil'], { match });
    expect(match).toHaveBeenCalledTimes(1);
  });

  it('skips unusable blank lines but keeps original source positions', async () => {
    const match = vi.fn(async () => null);
    await expect(normalizeIngredientLines(['flour', '  ', 'salt'], { match })).resolves.toEqual([
      expect.objectContaining({ position: 0, rawText: 'flour' }),
      expect.objectContaining({ position: 2, rawText: 'salt' }),
    ]);
  });
});

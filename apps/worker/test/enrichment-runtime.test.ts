import { describe, expect, it, vi } from 'vitest';
import { createEnrichmentJobRunner } from '../src/enrichment/runtime';
import type { IngredientBackfillSummary } from '../src/enrichment/ingredients-orchestrator';
import type { EnrichmentRunSummary } from '../src/enrichment/orchestrator';

describe('Phase 2 enrichment job runner', () => {
  it('requests a bounded queue retry for a stale recipe race', async () => {
    const recipes = {
      run: vi.fn(async () =>
        recipeSummary({
          status: 'partial',
          staleCount: 1,
          error: 'recipe changed while enrichment was running',
        }),
      ),
    };
    const ingredients = {
      run: vi.fn(async () => ingredientSummary()),
    };
    const runner = createEnrichmentJobRunner({
      recipes,
      ingredients,
      hasUnmappedIngredients: vi.fn(async () => true),
    });

    await expect(
      runner.run(new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'partial',
      retryRequired: true,
      budgetExhausted: false,
      ingredients: null,
      error: 'recipe changed while enrichment was running',
    });
    expect(ingredients.run).not.toHaveBeenCalled();
  });

  it('surfaces an ingredient-only partial so pg-boss retries it', async () => {
    const ingredient = ingredientSummary({
      status: 'partial',
      staleRows: 1,
      remainingRows: 1,
      error: 'ingredient row changed during mapping',
    });
    const ingredients = { run: vi.fn(async () => ingredient) };
    const runner = createEnrichmentJobRunner({
      recipes: { run: vi.fn(async () => recipeSummary()) },
      ingredients,
      hasUnmappedIngredients: vi.fn(async () => true),
    });
    const signal = new AbortController().signal;

    await expect(runner.run(signal)).resolves.toMatchObject({
      status: 'partial',
      retryRequired: true,
      budgetExhausted: false,
      ingredients: ingredient,
      error: 'ingredient row changed during mapping',
    });
    expect(ingredients.run).toHaveBeenCalledWith({ signal });
  });

  it('keeps a budget partial durable without immediately retrying the same cap', async () => {
    const runner = createEnrichmentJobRunner({
      recipes: { run: vi.fn(async () => recipeSummary()) },
      ingredients: {
        run: vi.fn(async () =>
          ingredientSummary({
            status: 'partial',
            budgetExhausted: true,
            remainingRows: 20,
            error: 'daily budget exhausted',
          }),
        ),
      },
      hasUnmappedIngredients: vi.fn(async () => true),
    });

    await expect(
      runner.run(new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'partial',
      retryRequired: false,
      budgetExhausted: true,
      error: 'daily budget exhausted',
    });
  });

  it('propagates interruption so pg-boss leaves the job retryable', async () => {
    const stopping = new Error('worker stopping');
    const runner = createEnrichmentJobRunner({
      recipes: { run: vi.fn(async () => recipeSummary()) },
      ingredients: { run: vi.fn(async () => { throw stopping; }) },
      hasUnmappedIngredients: vi.fn(async () => true),
    });

    await expect(
      runner.run(new AbortController().signal),
    ).rejects.toBe(stopping);
  });
});

function recipeSummary(
  overrides: Partial<EnrichmentRunSummary> = {},
): EnrichmentRunSummary {
  return {
    runId: 'recipe-run',
    startedAt: new Date('2026-07-26T12:00:00.000Z'),
    finishedAt: new Date('2026-07-26T12:01:00.000Z'),
    status: 'success',
    attemptedCount: 0,
    completedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    staleCount: 0,
    budgetExhausted: false,
    error: null,
    ...overrides,
  };
}

function ingredientSummary(
  overrides: Partial<IngredientBackfillSummary> = {},
): IngredientBackfillSummary {
  return {
    runId: 'ingredient-run',
    startedAt: new Date('2026-07-26T12:01:00.000Z'),
    finishedAt: new Date('2026-07-26T12:02:00.000Z'),
    status: 'success',
    attemptedNames: 0,
    mappedRows: 0,
    learnedAliases: 0,
    staleRows: 0,
    conflicts: 0,
    remainingRows: 0,
    unparseableRows: 0,
    budgetExhausted: false,
    error: null,
    ...overrides,
  };
}

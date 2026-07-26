import { describe, expect, it, vi } from 'vitest';
import type {
  CompleteRecipeEnrichmentResult,
  PendingRecipeForEnrichment,
} from '../src/enrichment/postgres';
import {
  createEnrichmentOrchestrator,
  type EnrichmentOrchestratorDependencies,
} from '../src/enrichment/orchestrator';

describe('pending-recipe enrichment orchestrator', () => {
  it('processes accepted and explicitly rejected recipes sequentially', async () => {
    const accepted = recipe('accepted', 'hash-accepted');
    const rejected = recipe('rejected', 'hash-rejected');
    const dependencies = baseDependencies([accepted, rejected]);
    vi.mocked(dependencies.classifySuitability).mockImplementation(
      async (pending) =>
        pending.id === rejected.id
          ? { is_meal_prep: false, reason: 'It is a cocktail.' }
          : { is_meal_prep: true, reason: 'Makes several lunches.' },
    );

    const summary = await createEnrichmentOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      runId: 'run-1',
      status: 'success',
      attemptedCount: 2,
      completedCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
      staleCount: 0,
      budgetExhausted: false,
      error: null,
    });
    expect(dependencies.deriveFields).toHaveBeenCalledOnce();
    expect(dependencies.writeBlurb).toHaveBeenCalledOnce();
    expect(dependencies.completeRecipe).toHaveBeenNthCalledWith(1, {
      recipeId: accepted.id,
      expectedContentHash: accepted.contentHash,
      outcome: 'accepted',
      fields: {
        keeps_days: 4,
        freezer_months: 2,
        category: 'Vegetarian',
        tags: ['One pot'],
      },
      blurb: 'Five lunches from one pot.',
    });
    expect(dependencies.completeRecipe).toHaveBeenNthCalledWith(2, {
      recipeId: rejected.id,
      expectedContentHash: rejected.contentHash,
      outcome: 'rejected',
      reason: 'It is a cocktail.',
    });
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'success',
        processedCount: 2,
        error: null,
      }),
    );
  });

  it('stops the run after a stale write instead of spinning on the same oldest row', async () => {
    const pending = recipe('stale', 'hash-v1');
    const dependencies = baseDependencies([pending, pending, pending]);
    vi.mocked(dependencies.completeRecipe).mockResolvedValue({
      outcome: 'stale',
      recipeId: pending.id,
    });

    const summary = await createEnrichmentOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      attemptedCount: 1,
      completedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      staleCount: 1,
      budgetExhausted: false,
      error: expect.stringContaining('changed while enrichment was running'),
    });
    expect(dependencies.loadNextPending).toHaveBeenCalledOnce();
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        processedCount: 0,
      }),
    );
  });

  it('treats an injected typed budget error as a clean partial stop', async () => {
    const pending = recipe('budget', 'hash-budget');
    const dependencies: EnrichmentOrchestratorDependencies = {
      ...baseDependencies([pending]),
      isBudgetExceeded: (error: unknown) =>
        error instanceof BudgetExceededError,
    };
    vi.mocked(dependencies.classifySuitability).mockRejectedValue(
      new BudgetExceededError('daily LLM budget exhausted'),
    );

    const summary = await createEnrichmentOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      attemptedCount: 1,
      completedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      staleCount: 0,
      budgetExhausted: true,
      error: 'daily LLM budget exhausted',
    });
    expect(dependencies.completeRecipe).not.toHaveBeenCalled();
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        processedCount: 0,
        error: 'daily LLM budget exhausted',
      }),
    );
  });

  it('finalizes telemetry before rethrowing a task failure', async () => {
    const pending = recipe('task-failure', 'hash-task-failure');
    const dependencies = baseDependencies([pending]);
    vi.mocked(dependencies.deriveFields).mockRejectedValue(
      new Error('derive provider unavailable'),
    );

    await expect(
      createEnrichmentOrchestrator(dependencies).run(),
    ).rejects.toThrow('derive provider unavailable');

    expect(dependencies.completeRecipe).not.toHaveBeenCalled();
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'error',
        processedCount: 0,
        error: 'derive provider unavailable',
      }),
    );
  });

  it('finalizes telemetry before rethrowing a persistence failure', async () => {
    const pending = recipe('db-failure', 'hash-db-failure');
    const dependencies = baseDependencies([pending]);
    vi.mocked(dependencies.completeRecipe).mockRejectedValue(
      new Error('database connection lost'),
    );

    await expect(
      createEnrichmentOrchestrator(dependencies).run(),
    ).rejects.toThrow('database connection lost');

    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        processedCount: 0,
        error: 'database connection lost',
      }),
    );
  });

  it('passes the abort signal to tasks, finalizes, then rethrows shutdown aborts', async () => {
    const pending = recipe('abort', 'hash-abort');
    const dependencies = baseDependencies([pending]);
    const controller = new AbortController();
    vi.mocked(dependencies.classifySuitability).mockImplementation(
      async (_recipe, context) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort(new Error('worker stopping'));
        return { is_meal_prep: true, reason: 'Suitable.' };
      },
    );

    await expect(
      createEnrichmentOrchestrator(dependencies).run({
        signal: controller.signal,
      }),
    ).rejects.toThrow('worker stopping');

    expect(dependencies.deriveFields).not.toHaveBeenCalled();
    expect(dependencies.completeRecipe).not.toHaveBeenCalled();
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        processedCount: 0,
        error: 'worker stopping',
      }),
    );
  });
});

function baseDependencies(
  pendingRecipes: readonly PendingRecipeForEnrichment[],
): EnrichmentOrchestratorDependencies {
  const queue = [...pendingRecipes];
  let time = Date.parse('2026-07-26T12:00:00.000Z');

  return {
    beginRun: vi.fn(async () => 'run-1'),
    loadNextPending: vi.fn(async () => queue.shift() ?? null),
    classifySuitability: vi.fn<
      EnrichmentOrchestratorDependencies['classifySuitability']
    >(async () => ({
      is_meal_prep: true,
      reason: 'Makes several lunches.',
    })),
    deriveFields: vi.fn<
      EnrichmentOrchestratorDependencies['deriveFields']
    >(async () => ({
      keeps_days: 4,
      freezer_months: 2,
      category: 'Vegetarian',
      tags: ['One pot'],
    })),
    writeBlurb: vi.fn<
      EnrichmentOrchestratorDependencies['writeBlurb']
    >(async () => 'Five lunches from one pot.'),
    completeRecipe: vi.fn(
      async (input): Promise<CompleteRecipeEnrichmentResult> => ({
        outcome: 'completed',
        recipeId: input.recipeId,
      }),
    ),
    finishRun: vi.fn(async () => undefined),
    isBudgetExceeded: () => false,
    now: () => {
      const value = new Date(time);
      time += 1_000;
      return value;
    },
  };
}

function recipe(
  id: string,
  contentHash: string,
): PendingRecipeForEnrichment {
  return {
    id,
    contentHash,
    sourceUrl: `https://example.com/${id}`,
    title: `Recipe ${id}`,
    totalMinutes: 30,
    activeMinutes: 10,
    servings: 4,
    author: 'Test Cook',
    sourceRating: 4.5,
    sourceRatingCount: 10,
    instructions: [{ name: null, text: 'Cook it.' }],
    rawJsonld: { '@type': 'Recipe' },
    publishedAt: new Date('2026-07-25T00:00:00.000Z'),
    firstSeenAt: new Date('2026-07-26T00:00:00.000Z'),
    ingredients: [
      {
        position: 0,
        rawText: '1 onion',
        qty: 1,
        unit: null,
        note: null,
        optional: false,
      },
    ],
  };
}

class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

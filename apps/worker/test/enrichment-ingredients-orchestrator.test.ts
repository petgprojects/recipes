import { describe, expect, it, vi } from 'vitest';
import type { IngredientMappingOutput } from '@recipes/shared';
import {
  createIngredientBackfillOrchestrator,
  type IngredientBackfillDependencies,
} from '../src/enrichment/ingredients-orchestrator';
import type { UnmappedIngredientLine } from '../src/enrichment/ingredients-postgres';

describe('semantic ingredient backfill orchestrator', () => {
  it('parses, groups, maps, and applies sequential bounded batches', async () => {
    const dependencies = baseDependencies([
      [
        line('recipe-1', 0, '1 cup Olive Oil'),
        line('recipe-1', 1, '2 tbsp olive   oil'),
        line('recipe-1', 2, '2 cups black beans'),
      ],
      [line('recipe-2', 0, '1 tsp salt')],
      [],
    ]);
    vi.mocked(dependencies.loadCanonicalIngredients)
      .mockResolvedValueOnce([
        { name: 'olive oil', aisle: 'Pantry' },
        { name: 'salt', aisle: 'Spices' },
      ])
      .mockResolvedValueOnce([
        { name: 'black beans', aisle: 'Canned & Jarred' },
        { name: 'olive oil', aisle: 'Pantry' },
        { name: 'salt', aisle: 'Spices' },
      ]);
    vi.mocked(dependencies.mapIngredients)
      .mockResolvedValueOnce({
        decisions: [
          {
            input_name: 'black beans',
            action: 'new',
            canonical_name: 'black beans',
            aisle: 'Canned & Jarred',
          },
          {
            input_name: 'olive oil',
            action: 'existing',
            canonical_name: 'olive oil',
            aisle: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        decisions: [
          {
            input_name: 'salt',
            action: 'existing',
            canonical_name: 'salt',
            aisle: null,
          },
        ],
      });
    vi.mocked(dependencies.applyMappings)
      .mockResolvedValueOnce({
        learnedCount: 2,
        mappedCount: 3,
        staleCount: 0,
        conflictCount: 0,
      })
      .mockResolvedValueOnce({
        learnedCount: 0,
        mappedCount: 1,
        staleCount: 0,
        conflictCount: 0,
      });

    const summary = await createIngredientBackfillOrchestrator(
      dependencies,
      { batchSize: 10 },
    ).run();

    expect(summary).toMatchObject({
      runId: 'run-ingredients',
      status: 'success',
      attemptedNames: 3,
      mappedRows: 4,
      learnedAliases: 2,
      staleRows: 0,
      conflicts: 0,
      remainingRows: 0,
      unparseableRows: 0,
      budgetExhausted: false,
      error: null,
    });
    expect(dependencies.loadUnmappedLines).toHaveBeenCalledTimes(3);
    expect(dependencies.loadUnmappedLines).toHaveBeenCalledWith(10_000);
    expect(dependencies.mapIngredients).toHaveBeenNthCalledWith(
      1,
      {
        unknownNames: ['black beans', 'olive oil'],
        canonicalIngredients: [
          { name: 'olive oil', aisle: 'Pantry' },
          { name: 'salt', aisle: 'Spices' },
        ],
      },
      { runId: 'run-ingredients', signal: undefined },
    );
    expect(dependencies.applyMappings).toHaveBeenNthCalledWith(
      1,
      [
        {
          inputName: 'black beans',
          canonicalName: 'black beans',
          aisle: 'Canned & Jarred',
        },
        {
          inputName: 'olive oil',
          canonicalName: 'olive oil',
          aisle: 'Pantry',
        },
      ],
      [
        expect.objectContaining({
          recipeId: 'recipe-1',
          position: 0,
          parsedName: 'olive oil',
        }),
        expect.objectContaining({
          recipeId: 'recipe-1',
          position: 1,
          parsedName: 'olive oil',
        }),
        expect.objectContaining({
          recipeId: 'recipe-1',
          position: 2,
          parsedName: 'black beans',
        }),
      ],
    );
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        processedCount: 4,
        error: null,
      }),
    );
  });

  it('maps parseable rows once, then stops partial on an unparseable row', async () => {
    const dependencies = baseDependencies([
      [
        line('recipe-empty', 0, '   '),
        line('recipe-empty', 1, '1 cup olive oil'),
      ],
      [line('recipe-empty', 0, '   ')],
    ]);
    vi.mocked(dependencies.countRemaining).mockResolvedValue(1);
    vi.mocked(dependencies.loadCanonicalIngredients).mockResolvedValue([
      { name: 'olive oil', aisle: 'Pantry' },
    ]);
    vi.mocked(dependencies.mapIngredients).mockResolvedValue({
      decisions: [
        {
          input_name: 'olive oil',
          action: 'existing',
          canonical_name: 'olive oil',
          aisle: null,
        },
      ],
    });
    vi.mocked(dependencies.applyMappings).mockResolvedValue({
      learnedCount: 0,
      mappedCount: 1,
      staleCount: 0,
      conflictCount: 0,
    });

    const summary =
      await createIngredientBackfillOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      attemptedNames: 1,
      mappedRows: 1,
      remainingRows: 1,
      unparseableRows: 1,
      error: expect.stringContaining('could not be parsed'),
    });
    expect(dependencies.loadUnmappedLines).toHaveBeenCalledTimes(2);
    expect(dependencies.applyMappings).toHaveBeenCalledOnce();
  });

  it('stops partial when a batch makes zero mapping progress', async () => {
    const dependencies = baseDependencies([
      [line('recipe-zero', 0, '1 cup olive oil')],
    ]);
    vi.mocked(dependencies.countRemaining).mockResolvedValue(1);
    vi.mocked(dependencies.applyMappings).mockResolvedValue({
      learnedCount: 1,
      mappedCount: 0,
      staleCount: 0,
      conflictCount: 0,
    });

    const summary =
      await createIngredientBackfillOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      mappedRows: 0,
      learnedAliases: 1,
      remainingRows: 1,
      error: 'ingredient mapping made zero row progress',
    });
    expect(dependencies.loadUnmappedLines).toHaveBeenCalledOnce();
  });

  it('stops partial and reports stale rows and alias conflicts', async () => {
    const dependencies = baseDependencies([
      [
        line('recipe-conflict', 0, '1 cup olive oil'),
        line('recipe-conflict', 1, '1 tsp salt'),
      ],
    ]);
    vi.mocked(dependencies.countRemaining).mockResolvedValue(1);
    vi.mocked(dependencies.applyMappings).mockResolvedValue({
      learnedCount: 0,
      mappedCount: 1,
      staleCount: 1,
      conflictCount: 1,
    });

    const summary =
      await createIngredientBackfillOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      mappedRows: 1,
      staleRows: 1,
      conflicts: 1,
      remainingRows: 1,
      error: expect.stringContaining('1 stale row(s) and 1 alias conflict(s)'),
    });
    expect(dependencies.loadUnmappedLines).toHaveBeenCalledOnce();
  });

  it('finalizes a typed budget exhaustion as partial without applying', async () => {
    const dependencies: IngredientBackfillDependencies = {
      ...baseDependencies([
        [line('recipe-budget', 0, '1 cup olive oil')],
      ]),
      isBudgetExceeded: (error: unknown) =>
        error instanceof BudgetExceededError,
    };
    vi.mocked(dependencies.countRemaining).mockResolvedValue(1);
    vi.mocked(dependencies.mapIngredients).mockRejectedValue(
      new BudgetExceededError('daily ingredient mapping budget exhausted'),
    );

    const summary =
      await createIngredientBackfillOrchestrator(dependencies).run();

    expect(summary).toMatchObject({
      status: 'partial',
      attemptedNames: 1,
      mappedRows: 0,
      remainingRows: 1,
      budgetExhausted: true,
      error: 'daily ingredient mapping budget exhausted',
    });
    expect(dependencies.applyMappings).not.toHaveBeenCalled();
    expect(dependencies.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        processedCount: 0,
      }),
    );
  });

  it('finalizes telemetry before rethrowing task and abort failures', async () => {
    const failed = baseDependencies([
      [line('recipe-failure', 0, '1 cup olive oil')],
    ]);
    vi.mocked(failed.loadCanonicalIngredients).mockRejectedValue(
      new Error('canonical query failed'),
    );

    await expect(
      createIngredientBackfillOrchestrator(failed).run(),
    ).rejects.toThrow('canonical query failed');
    expect(failed.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        processedCount: 0,
        error: 'canonical query failed',
      }),
    );

    const controller = new AbortController();
    const aborted = baseDependencies([
      [line('recipe-abort', 0, '1 cup olive oil')],
    ]);
    vi.mocked(aborted.mapIngredients).mockImplementation(
      async (_input, context) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort(new Error('worker stopping'));
        return defaultOutput(_input.unknownNames);
      },
    );

    await expect(
      createIngredientBackfillOrchestrator(aborted).run({
        signal: controller.signal,
      }),
    ).rejects.toThrow('worker stopping');
    expect(aborted.applyMappings).not.toHaveBeenCalled();
    expect(aborted.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        processedCount: 0,
        error: 'worker stopping',
      }),
    );
  });
});

function baseDependencies(
  batches: readonly (readonly UnmappedIngredientLine[])[],
): IngredientBackfillDependencies {
  const pending = batches.map((batch) => [...batch]);
  let time = Date.parse('2026-07-26T12:00:00.000Z');
  return {
    beginRun: vi.fn(async () => 'run-ingredients'),
    finishRun: vi.fn(async () => undefined),
    loadUnmappedLines: vi.fn(async () => pending.shift() ?? []),
    countRemaining: vi.fn(async () => 0),
    loadCanonicalIngredients: vi.fn<
      IngredientBackfillDependencies['loadCanonicalIngredients']
    >(async () => [
      { name: 'olive oil', aisle: 'Pantry' },
      { name: 'salt', aisle: 'Spices' },
    ]),
    mapIngredients: vi.fn<
      IngredientBackfillDependencies['mapIngredients']
    >(async (input) => defaultOutput(input.unknownNames)),
    applyMappings: vi.fn<
      IngredientBackfillDependencies['applyMappings']
    >(async (_decisions, refs) => ({
      learnedCount: 0,
      mappedCount: refs.length,
      staleCount: 0,
      conflictCount: 0,
    })),
    isBudgetExceeded: () => false,
    now: () => {
      const value = new Date(time);
      time += 1_000;
      return value;
    },
  };
}

function defaultOutput(
  names: readonly string[],
): IngredientMappingOutput {
  return {
    decisions: names.map((name) => ({
      input_name: name,
      action: 'new' as const,
      canonical_name: name,
      aisle: 'Pantry' as const,
    })),
  };
}

function line(
  recipeId: string,
  position: number,
  rawText: string,
): UnmappedIngredientLine {
  return { recipeId, position, rawText };
}

class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

import { afterAll, describe, expect, it } from 'vitest';
import { db, scanRuns } from '@recipes/db';
import { eq } from '@recipes/db/operators';
import {
  LlmBudgetExceededError,
  createBudgetedLlmCallOptions,
} from '../src/enrichment/budget';
import { beginEnrichmentRun } from '../src/enrichment/postgres';

const createdRunIds: string[] = [];

afterAll(async () => {
  if (createdRunIds.length === 0) return;
  for (const runId of createdRunIds) {
    await db.delete(scanRuns).where(eq(scanRuns.id, runId));
  }
});

describe('durable LLM budget hooks', () => {
  it('records provider usage before blocking the next request at the cap', async () => {
    const budgetDay = new Date('2099-03-14T12:00:00.000Z');
    const runId = await beginEnrichmentRun(db, budgetDay);
    createdRunIds.push(runId);
    const hooks = createBudgetedLlmCallOptions({
      db,
      runId,
      dailyBudgetUsd: 0.0001,
      now: () => budgetDay,
    });

    await hooks.beforeRequest?.({
      taskName: 'test_task',
      attempt: 'initial',
    });
    await hooks.onUsage?.(
      {
        tokensIn: 100,
        tokensOut: 20,
        totalTokens: 120,
        cachedTokensIn: 0,
        costUsd: 0.000123,
        costSource: 'provider',
      },
      {
        taskName: 'test_task',
        attempt: 'initial',
        responseId: 'test-response',
        model: 'test-model',
      },
    );
    await hooks.afterRequest?.({
      taskName: 'test_task',
      attempt: 'initial',
    });

    await expect(
      hooks.beforeRequest?.({
        taskName: 'test_task',
        attempt: 'repair',
      }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);

    const [run] = await db
      .select({
        tokensIn: scanRuns.tokensIn,
        tokensOut: scanRuns.tokensOut,
        costUsd: scanRuns.costUsd,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, runId));
    expect(run).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.000123,
    });
  });

  it('serializes concurrent preflights through committed usage', async () => {
    const budgetDay = new Date('2099-03-15T12:00:00.000Z');
    const firstRunId = await beginEnrichmentRun(db, budgetDay);
    const secondRunId = await beginEnrichmentRun(db, budgetDay);
    createdRunIds.push(firstRunId, secondRunId);
    const first = createBudgetedLlmCallOptions({
      db,
      runId: firstRunId,
      dailyBudgetUsd: 0.001,
      now: () => budgetDay,
    });
    const second = createBudgetedLlmCallOptions({
      db,
      runId: secondRunId,
      dailyBudgetUsd: 0.001,
      now: () => budgetDay,
    });
    const context = {
      taskName: 'concurrent_budget_test',
      attempt: 'initial' as const,
    };

    await first.beforeRequest?.(context);
    const secondPreflight = second.beforeRequest?.(context);
    if (secondPreflight === undefined) {
      throw new Error('missing second budget preflight');
    }

    const stateBeforeRelease = await Promise.race([
      secondPreflight.then(
        () => 'admitted',
        () => 'rejected',
      ),
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 50),
      ),
    ]);
    expect(stateBeforeRelease).toBe('pending');

    await first.onUsage?.(
      {
        tokensIn: 500,
        tokensOut: 100,
        totalTokens: 600,
        cachedTokensIn: 0,
        costUsd: 0.0012,
        costSource: 'provider',
      },
      {
        ...context,
        responseId: 'concurrent-response',
        model: 'test-model',
      },
    );
    await first.afterRequest?.(context);

    await expect(secondPreflight).rejects.toMatchObject({
      name: 'LlmBudgetExceededError',
      spentUsd: 0.0012,
      limitUsd: 0.001,
    });
  });
});

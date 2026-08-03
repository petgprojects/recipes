import { afterAll, describe, expect, it } from 'vitest';
import { db, scanRuns } from '@recipes/db';
import { and, eq, gte, lt } from '@recipes/db/operators';
import {
  LlmBudgetExceededError,
  createBudgetedLlmCallOptions,
  getDailyLlmUsage,
  getOrCreateDailySearchRun,
  recordLlmUsage,
} from '@recipes/db/llm-budget';
import { beginEnrichmentRun } from '../src/enrichment/postgres';

const createdRunIds: string[] = [];

afterAll(async () => {
  if (createdRunIds.length === 0) return;
  for (const runId of new Set(createdRunIds)) {
    await db.delete(scanRuns).where(eq(scanRuns.id, runId));
  }
});

describe('durable LLM budget hooks', () => {
  it('records provider usage before blocking the next same-kind request at the cap', async () => {
    const budgetDay = new Date('2099-03-14T12:00:00.000Z');
    const runId = await beginEnrichmentRun(db, budgetDay);
    createdRunIds.push(runId);
    const hooks = createBudgetedLlmCallOptions({
      db,
      runId,
      kind: 'scan',
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

  it('serializes concurrent same-kind preflights through committed usage', async () => {
    const budgetDay = new Date('2099-03-15T12:00:00.000Z');
    const firstRunId = await beginEnrichmentRun(db, budgetDay);
    const secondRunId = await beginEnrichmentRun(db, budgetDay);
    createdRunIds.push(firstRunId, secondRunId);
    const first = createBudgetedLlmCallOptions({
      db,
      runId: firstRunId,
      kind: 'scan',
      dailyBudgetUsd: 0.001,
      now: () => budgetDay,
    });
    const second = createBudgetedLlmCallOptions({
      db,
      runId: secondRunId,
      kind: 'scan',
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

  it('does not block a search preflight behind an active scan lease', async () => {
    const budgetDay = new Date('2099-03-16T12:00:00.000Z');
    const scanRunId = await beginEnrichmentRun(db, budgetDay);
    const searchRunId = await getOrCreateDailySearchRun(db, budgetDay);
    createdRunIds.push(scanRunId, searchRunId);
    const scan = createBudgetedLlmCallOptions({
      db,
      runId: scanRunId,
      kind: 'scan',
      dailyBudgetUsd: 1,
      now: () => budgetDay,
    });
    const search = createBudgetedLlmCallOptions({
      db,
      runId: searchRunId,
      kind: 'search',
      // The scan pot is already over this limit. Search must still be admitted.
      dailyBudgetUsd: 0.1,
      now: () => budgetDay,
    });
    const context = {
      taskName: 'independent_budget_test',
      attempt: 'initial' as const,
    };

    await scan.beforeRequest?.(context);
    const searchPreflight = search.beforeRequest?.(context);
    if (searchPreflight === undefined) {
      throw new Error('missing search budget preflight');
    }
    const stateWhileScanHeld = await Promise.race([
      searchPreflight.then(() => 'admitted' as const),
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 100),
      ),
    ]);

    await scan.afterRequest?.(context);
    await searchPreflight;
    await search.afterRequest?.(context);
    expect(stateWhileScanHeld).toBe('admitted');
  });

  it('creates one successful UTC-day search accumulator and bumps finished_at', async () => {
    const firstAt = new Date('2099-03-17T00:00:01.000Z');
    const firstRunId = await getOrCreateDailySearchRun(db, firstAt);
    createdRunIds.push(firstRunId);

    const sameDayTimes = [
      new Date('2099-03-17T06:00:00.000Z'),
      new Date('2099-03-17T23:59:59.000Z'),
      ...Array.from(
        { length: 12 },
        (_, index) => new Date(`2099-03-17T12:00:${String(index).padStart(2, '0')}.000Z`),
      ),
    ];
    const sameDayIds = await Promise.all(
      sameDayTimes.map((at) => getOrCreateDailySearchRun(db, at)),
    );
    expect(new Set([firstRunId, ...sameDayIds])).toEqual(new Set([firstRunId]));

    const nextDayRunId = await getOrCreateDailySearchRun(
      db,
      new Date('2099-03-18T00:00:00.000Z'),
    );
    createdRunIds.push(nextDayRunId);
    expect(nextDayRunId).not.toBe(firstRunId);

    const rows = await db
      .select()
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.kind, 'search'),
          gte(scanRuns.startedAt, new Date('2099-03-17T00:00:00.000Z')),
          lt(scanRuns.startedAt, new Date('2099-03-19T00:00:00.000Z')),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === firstRunId)).toMatchObject({
      sourceId: null,
      kind: 'search',
      startedAt: firstAt,
      finishedAt: new Date('2099-03-17T23:59:59.000Z'),
      status: 'success',
      found: 0,
      newCount: 0,
      noRecipeCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
    });
    expect(rows.find((row) => row.id === nextDayRunId)).toMatchObject({
      kind: 'search',
      startedAt: new Date('2099-03-18T00:00:00.000Z'),
      finishedAt: new Date('2099-03-18T00:00:00.000Z'),
      status: 'success',
    });
  });

  it('isolates daily usage by kind and rejects a mismatched usage write', async () => {
    const budgetDay = new Date('2099-03-19T12:00:00.000Z');
    const scanRunId = await beginEnrichmentRun(db, budgetDay);
    const searchRunId = await getOrCreateDailySearchRun(db, budgetDay);
    createdRunIds.push(scanRunId, searchRunId);

    await recordLlmUsage(db, scanRunId, 'scan', {
      tokensIn: 1_000,
      tokensOut: 100,
      costUsd: 0.2,
    });
    const search = createBudgetedLlmCallOptions({
      db,
      runId: searchRunId,
      kind: 'search',
      dailyBudgetUsd: 1,
      now: () => budgetDay,
    });
    const context = {
      taskName: 'search_accounting_test',
      attempt: 'initial' as const,
    };
    await search.beforeRequest?.(context);
    await search.onUsage?.(
      {
        tokensIn: 200,
        tokensOut: 20,
        totalTokens: 220,
        cachedTokensIn: 0,
        costUsd: 0.03,
        costSource: 'provider',
      },
      {
        ...context,
        responseId: 'search-accounting-response',
        model: 'test-model',
      },
    );
    await search.afterRequest?.(context);

    const [scanUsage, searchUsage] = await Promise.all([
      getDailyLlmUsage(db, 'scan', budgetDay),
      getDailyLlmUsage(db, 'search', budgetDay),
    ]);
    expect(scanUsage).toMatchObject({
      tokensIn: 1_000,
      tokensOut: 100,
      costUsd: 0.2,
    });
    expect(searchUsage).toMatchObject({
      tokensIn: 200,
      tokensOut: 20,
      costUsd: 0.03,
    });

    const scanAfterSearch = createBudgetedLlmCallOptions({
      db,
      runId: scanRunId,
      kind: 'scan',
      // Scan's own $0.20 fits; leaking search's $0.03 would reject it.
      dailyBudgetUsd: 0.21,
      now: () => budgetDay,
    });
    await scanAfterSearch.beforeRequest?.(context);
    await scanAfterSearch.afterRequest?.(context);

    await expect(
      recordLlmUsage(db, searchRunId, 'scan', {
        tokensIn: 9_999,
        tokensOut: 999,
        costUsd: 9.99,
      }),
    ).rejects.toThrow(/missing or mismatched scan run/);
    expect(await getDailyLlmUsage(db, 'search', budgetDay)).toMatchObject({
      tokensIn: 200,
      tokensOut: 20,
      costUsd: 0.03,
    });
  });
});

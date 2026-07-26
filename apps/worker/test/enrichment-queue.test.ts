import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'pg-boss';
import {
  ENRICHMENT_QUEUE,
  ENRICHMENT_QUEUE_OPTIONS,
  createEnrichmentJob,
  createEnrichmentJobHandler,
  ensureEnrichmentQueue,
  type EnrichmentJob,
} from '../src/jobs/enrichment-queue';

describe('enrichment queue', () => {
  it('creates the exclusive queue with bounded retry settings', async () => {
    const createQueue = vi.fn(async () => undefined);
    await ensureEnrichmentQueue({ createQueue });
    expect(createQueue).toHaveBeenCalledWith(
      ENRICHMENT_QUEUE,
      ENRICHMENT_QUEUE_OPTIONS,
    );
  });

  it('validates the job and passes pg-boss cancellation through', async () => {
    const runEnrichment = vi.fn(async () => jobSummary());
    const controller = new AbortController();
    const job = {
      id: 'job-1',
      data: createEnrichmentJob(
        'bootstrap',
        new Date('2026-07-26T10:00:00.000Z'),
      ),
      signal: controller.signal,
    } as Job<EnrichmentJob>;

    const result = await createEnrichmentJobHandler({
      runEnrichment,
    })([job]);

    expect(result.recipe.acceptedCount).toBe(1);
    expect(runEnrichment).toHaveBeenCalledWith(controller.signal);
  });

  it('rejects a retry-required partial so pg-boss applies bounded retries', async () => {
    const runEnrichment = vi.fn(async () =>
      jobSummary({
        status: 'partial',
        retryRequired: true,
        error: 'ingredient row changed during mapping',
      }),
    );
    const job = {
      id: 'job-retry',
      data: createEnrichmentJob('bootstrap'),
      signal: new AbortController().signal,
    } as Job<EnrichmentJob>;

    await expect(
      createEnrichmentJobHandler({ runEnrichment })([job]),
    ).rejects.toThrow(/pg-boss will retry/);
  });

  it('acknowledges a budget partial without retrying the same UTC-day cap', async () => {
    const expected = jobSummary({
      status: 'partial',
      retryRequired: false,
      budgetExhausted: true,
      error: 'daily budget exhausted',
    });
    const job = {
      id: 'job-budget',
      data: createEnrichmentJob('bootstrap'),
      signal: new AbortController().signal,
    } as Job<EnrichmentJob>;

    await expect(
      createEnrichmentJobHandler({
        runEnrichment: vi.fn(async () => expected),
      })([job]),
    ).resolves.toBe(expected);
  });

  it('rejects malformed producer payloads before spending', async () => {
    const runEnrichment = vi.fn();
    const job = {
      id: 'job-bad',
      data: { trigger: 'surprise', requestedAt: 'not-a-date' },
      signal: new AbortController().signal,
    } as unknown as Job<EnrichmentJob>;

    await expect(
      createEnrichmentJobHandler({ runEnrichment })([job]),
    ).rejects.toThrow();
    expect(runEnrichment).not.toHaveBeenCalled();
  });
});

function jobSummary(overrides: Record<string, unknown> = {}) {
  return {
    recipe: {
      runId: 'run-1',
      startedAt: new Date('2026-07-26T10:00:00.000Z'),
      finishedAt: new Date('2026-07-26T10:01:00.000Z'),
      status: 'success' as const,
      attemptedCount: 1,
      completedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      staleCount: 0,
      budgetExhausted: false,
      error: null,
    },
    ingredients: null,
    status: 'success' as const,
    budgetExhausted: false,
    retryRequired: false,
    error: null,
    ...overrides,
  };
}

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'pg-boss';
import {
  PERSONALIZATION_QUEUE,
  PERSONALIZATION_QUEUE_OPTIONS,
  createPersonalizationJob,
  createPersonalizationJobHandler,
  ensurePersonalizationQueue,
  type PersonalizationJob,
} from '../src/jobs/personalization-queue';
import type { PersonalizationPassSummary } from '../src/personalization/runtime';

describe('personalization queue', () => {
  it('creates the exclusive queue with bounded retry settings', async () => {
    const createQueue = vi.fn(async () => undefined);
    await ensurePersonalizationQueue({ createQueue });
    expect(createQueue).toHaveBeenCalledWith(
      PERSONALIZATION_QUEUE,
      PERSONALIZATION_QUEUE_OPTIONS,
    );
  });

  it('validates the job and passes pg-boss cancellation through', async () => {
    const runPersonalization = vi.fn(async () => passSummary());
    const controller = new AbortController();
    const job = {
      id: 'job-1',
      data: createPersonalizationJob('post-enrichment', new Date('2026-07-28T02:00:00.000Z')),
      signal: controller.signal,
    } as Job<PersonalizationJob>;

    const result = await createPersonalizationJobHandler({ runPersonalization })([job]);

    expect(result.status).toBe('success');
    expect(runPersonalization).toHaveBeenCalledWith(controller.signal);
  });

  it('retries a pass that failed for a reader', async () => {
    const summary = passSummary({
      status: 'partial',
      failures: [{ userId: 'reader-1', error: 'history query failed' }],
      error: '1 reader(s) failed: history query failed',
    });
    const job = {
      id: 'job-fail',
      data: createPersonalizationJob('post-enrichment'),
      signal: new AbortController().signal,
    } as Job<PersonalizationJob>;

    await expect(
      createPersonalizationJobHandler({
        runPersonalization: vi.fn(async () => summary),
      })([job]),
    ).rejects.toThrow(/pg-boss will retry/);
  });

  it('acknowledges a budget stop rather than retrying the same daily cap', async () => {
    const summary = passSummary({
      status: 'partial',
      budgetExhausted: true,
      failures: [{ userId: 'reader-2', error: 'unrelated' }],
      error: 'daily LLM budget reached before every reader was personalized',
    });
    const job = {
      id: 'job-budget',
      data: createPersonalizationJob('post-enrichment'),
      signal: new AbortController().signal,
    } as Job<PersonalizationJob>;

    await expect(
      createPersonalizationJobHandler({
        runPersonalization: vi.fn(async () => summary),
      })([job]),
    ).resolves.toBe(summary);
  });

  it('rejects a malformed producer payload before spending', async () => {
    const runPersonalization = vi.fn();
    const job = {
      id: 'job-bad',
      data: { trigger: 'whenever', requestedAt: 'not-a-date' },
      signal: new AbortController().signal,
    } as unknown as Job<PersonalizationJob>;

    await expect(
      createPersonalizationJobHandler({ runPersonalization })([job]),
    ).rejects.toThrow();
    expect(runPersonalization).not.toHaveBeenCalled();
  });
});

function passSummary(
  overrides: Partial<PersonalizationPassSummary> = {},
): PersonalizationPassSummary {
  return {
    runId: 'run-1',
    startedAt: new Date('2026-07-28T02:00:00.000Z'),
    finishedAt: new Date('2026-07-28T02:03:00.000Z'),
    status: 'success',
    users: [
      {
        userId: 'reader-1',
        rules: 2,
        disabledRules: 0,
        ratedRecipes: 8,
        profile: 'updated',
        considered: 40,
        scored: 40,
        batches: 2,
      },
    ],
    failures: [],
    budgetExhausted: false,
    error: null,
    ...overrides,
  };
}

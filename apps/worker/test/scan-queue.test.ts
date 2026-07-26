import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'pg-boss';
import { createAllSourcesScanJob } from '@recipes/shared/scan-jobs';
import { createScanJobHandler } from '../src/jobs/queue';
import type { AllSourcesScanSummary } from '../src/scan/orchestrator';

describe('all-sources scan job handler', () => {
  it('does not start a scan when the global advisory lock is already held', async () => {
    const runScan = vi.fn(async () => summary('success'));
    const handler = createScanJobHandler({
      runScan,
      withLock: async () => ({ acquired: false }),
    });

    await expect(handler([job()])).resolves.toEqual({ skipped: 'locked' });
    expect(runScan).not.toHaveBeenCalled();
  });

  it('throws when every source fails so pg-boss applies its bounded retry policy', async () => {
    const handler = createScanJobHandler({
      runScan: async () => summary('error'),
      withLock: async (task) => ({ acquired: true, value: await task() }),
    });

    await expect(handler([job()])).rejects.toThrow(
      'all 1 source scans failed',
    );
  });
});

function job(): Job<ReturnType<typeof createAllSourcesScanJob>> {
  return {
    id: 'job-1',
    name: 'scan-all-sources',
    data: createAllSourcesScanJob(
      'manual',
      new Date('2026-07-26T07:00:00.000Z'),
    ),
    expireInSeconds: 60,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
  };
}

function summary(status: 'success' | 'error'): AllSourcesScanSummary {
  const at = new Date('2026-07-26T07:00:00.000Z');
  return {
    startedAt: at,
    finishedAt: at,
    sourceCount: 1,
    found: 0,
    newCount: 0,
    noRecipeCount: 0,
    sources: [
      {
        sourceId: 'source-1',
        sourceName: 'Test',
        runId: 'run-1',
        status,
        found: 0,
        newCount: 0,
        noRecipeCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        error: status === 'error' ? 'failed' : null,
      },
    ],
  };
}

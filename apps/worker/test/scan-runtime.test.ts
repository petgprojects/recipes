import { describe, expect, it, vi } from 'vitest';
import { enqueueBootstrapScanIfNeeded } from '../src/jobs/runtime';

describe('bootstrap scan scheduling', () => {
  it('enqueues exactly once when no completed scan exists', async () => {
    const enqueue = vi.fn(async () => 'job-1');
    await expect(
      enqueueBootstrapScanIfNeeded({
        enabled: true,
        hasCompletedScan: async () => false,
        enqueue,
      }),
    ).resolves.toBe('job-1');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith('bootstrap');
  });

  it('does not enqueue after any completed scan', async () => {
    const enqueue = vi.fn(async () => 'must-not-run');
    await expect(
      enqueueBootstrapScanIfNeeded({
        enabled: true,
        hasCompletedScan: async () => true,
        enqueue,
      }),
    ).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows startup smoke tests to disable bootstrap without querying telemetry', async () => {
    const hasCompletedScan = vi.fn(async () => false);
    const enqueue = vi.fn(async () => 'must-not-run');
    await expect(
      enqueueBootstrapScanIfNeeded({
        enabled: false,
        hasCompletedScan,
        enqueue,
      }),
    ).resolves.toBeUndefined();
    expect(hasCompletedScan).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

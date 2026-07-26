import { describe, expect, it } from 'vitest';
import {
  ALL_SOURCES_SCAN_JOB_SCHEMA,
  ALL_SOURCES_SCAN_QUEUE,
  createAllSourcesScanJob,
} from '../src/scan-jobs';

describe('all-sources scan queue contract', () => {
  it('provides a stable queue name and serializable payload', () => {
    expect(ALL_SOURCES_SCAN_QUEUE).toBe('scan-all-sources');
    const job = createAllSourcesScanJob(
      'manual',
      new Date('2026-07-26T07:00:00.000Z'),
    );
    expect(ALL_SOURCES_SCAN_JOB_SCHEMA.parse(job)).toEqual({
      trigger: 'manual',
      requestedAt: '2026-07-26T07:00:00.000Z',
    });
  });

  it('rejects unknown producers and invalid timestamps', () => {
    expect(() =>
      ALL_SOURCES_SCAN_JOB_SCHEMA.parse({
        trigger: 'unknown',
        requestedAt: 'not-a-date',
      }),
    ).toThrow();
  });
});

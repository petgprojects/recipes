import { z } from 'zod';

/**
 * Stable, client-safe contract for requesting one deterministic scan across
 * every enabled source. Producers such as the future `/ops` route import this
 * module without importing the worker or opening a database connection.
 */
export const ALL_SOURCES_SCAN_QUEUE = 'scan-all-sources';

export const ALL_SOURCES_SCAN_JOB_SCHEMA = z.object({
  trigger: z.enum(['bootstrap', 'cron', 'manual']),
  requestedAt: z.iso.datetime(),
});

export type AllSourcesScanJob = z.infer<typeof ALL_SOURCES_SCAN_JOB_SCHEMA>;

export function createAllSourcesScanJob(
  trigger: AllSourcesScanJob['trigger'],
  requestedAt = new Date(),
): AllSourcesScanJob {
  return {
    trigger,
    requestedAt: requestedAt.toISOString(),
  };
}

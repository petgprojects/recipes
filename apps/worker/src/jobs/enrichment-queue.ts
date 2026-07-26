import { PgBoss, type Job } from 'pg-boss';
import { z } from 'zod';
import type { EnrichmentJobRunSummary } from '../enrichment/runtime';
import type { ScanQueueLogger } from './queue';

export const ENRICHMENT_QUEUE = 'enrich-pending-recipes';

export const ENRICHMENT_QUEUE_OPTIONS = {
  policy: 'exclusive',
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 15 * 60,
  expireInSeconds: 6 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  heartbeatSeconds: 60,
  notify: true,
} as const;

const enrichmentJobSchema = z.object({
  trigger: z.enum(['bootstrap', 'post-scan', 'manual']),
  requestedAt: z.iso.datetime(),
});

export type EnrichmentJob = z.infer<typeof enrichmentJobSchema>;

export interface StartEnrichmentQueueOptions {
  readonly databaseUrl: string;
  readonly runEnrichment: (
    signal: AbortSignal,
  ) => Promise<EnrichmentJobRunSummary>;
  readonly logger?: ScanQueueLogger;
  readonly boss?: PgBoss;
}

export interface EnrichmentQueueRuntime {
  readonly boss: PgBoss;
  enqueue(
    trigger: EnrichmentJob['trigger'],
    requestedAt?: Date,
  ): Promise<string | null>;
  stop(): Promise<void>;
}

export function createEnrichmentJob(
  trigger: EnrichmentJob['trigger'],
  requestedAt = new Date(),
): EnrichmentJob {
  return {
    trigger,
    requestedAt: requestedAt.toISOString(),
  };
}

export function createEnrichmentJobHandler(options: {
  readonly runEnrichment: (
    signal: AbortSignal,
  ) => Promise<EnrichmentJobRunSummary>;
  readonly logger?: ScanQueueLogger;
}) {
  return async (jobs: Job<EnrichmentJob>[]): Promise<EnrichmentJobRunSummary> => {
    const job = jobs[0];
    if (job === undefined) {
      throw new Error('pg-boss delivered an empty enrichment batch');
    }
    const payload = enrichmentJobSchema.parse(job.data);
    options.logger?.info(
      `starting ${payload.trigger} enrichment job ${job.id} requested ${payload.requestedAt}`,
    );
    const summary = await options.runEnrichment(job.signal);
    if (summary.retryRequired) {
      throw new Error(
        `Phase 2 enrichment remained partial: ` +
          `${summary.error ?? 'retry requested'}; pg-boss will retry`,
      );
    }
    options.logger?.info(
      `finished enrichment job ${job.id}: ${summary.recipe.acceptedCount} accepted, ` +
        `${summary.recipe.rejectedCount} rejected, ${summary.recipe.staleCount} stale, ` +
        `${summary.ingredients?.mappedRows ?? 0} ingredient rows mapped` +
        (summary.budgetExhausted ? ', daily budget reached' : ''),
    );
    return summary;
  };
}

export async function ensureEnrichmentQueue(
  boss: Pick<PgBoss, 'createQueue'>,
): Promise<void> {
  await boss.createQueue(ENRICHMENT_QUEUE, ENRICHMENT_QUEUE_OPTIONS);
}

export async function startEnrichmentQueue(
  options: StartEnrichmentQueueOptions,
): Promise<EnrichmentQueueRuntime> {
  const boss =
    options.boss ??
    new PgBoss({
      connectionString: options.databaseUrl,
      useListenNotify: true,
    });
  boss.on('error', (error) => {
    options.logger?.error('pg-boss enrichment error', error);
  });

  await boss.start();
  try {
    await ensureEnrichmentQueue(boss);
    await boss.work<EnrichmentJob>(
      ENRICHMENT_QUEUE,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
        notifyPollingIntervalSeconds: 30,
      },
      createEnrichmentJobHandler(options),
    );
  } catch (error) {
    await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    boss,
    enqueue(trigger, requestedAt = new Date()) {
      return boss.send(
        ENRICHMENT_QUEUE,
        createEnrichmentJob(trigger, requestedAt),
      );
    },
    stop() {
      stopping ??= boss.stop({
        graceful: true,
        timeout: 15_000,
      });
      return stopping;
    },
  };
}

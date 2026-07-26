import { PgBoss, type Job } from 'pg-boss';
import {
  ALL_SOURCES_SCAN_JOB_SCHEMA,
  ALL_SOURCES_SCAN_QUEUE,
  createAllSourcesScanJob,
  type AllSourcesScanJob,
} from '@recipes/shared/scan-jobs';
import type { AllSourcesScanSummary } from '../scan/orchestrator';
import {
  withScanAdvisoryLock,
  type AdvisoryLockResult,
} from './advisory-lock';

export const SCAN_QUEUE_OPTIONS = {
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

export interface ScanQueueLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface CreateScanJobHandlerOptions {
  readonly runScan: (signal: AbortSignal) => Promise<AllSourcesScanSummary>;
  readonly withLock?: <T>(task: () => Promise<T>) => Promise<AdvisoryLockResult<T>>;
  readonly logger?: ScanQueueLogger;
}

export function createScanJobHandler(options: CreateScanJobHandlerOptions) {
  const lock = options.withLock ?? withScanAdvisoryLock;

  return async (jobs: Job<AllSourcesScanJob>[]): Promise<AllSourcesScanSummary | { skipped: 'locked' }> => {
    const job = jobs[0];
    if (job === undefined) throw new Error('pg-boss delivered an empty scan batch');
    const payload = ALL_SOURCES_SCAN_JOB_SCHEMA.parse(job.data);
    options.logger?.info(
      `starting ${payload.trigger} scan job ${job.id} requested ${payload.requestedAt}`,
    );

    const locked = await lock(() => options.runScan(job.signal));
    if (!locked.acquired) {
      options.logger?.info(
        `skipping scan job ${job.id}: advisory lock is held by another worker`,
      );
      return { skipped: 'locked' };
    }

    const summary = locked.value;
    if (
      summary.sourceCount > 0 &&
      summary.sources.every((source) => source.status === 'error')
    ) {
      throw new Error(
        `all ${summary.sourceCount} source scans failed; pg-boss will retry`,
      );
    }
    options.logger?.info(
      `finished scan job ${job.id}: ${summary.found} found, ${summary.newCount} new, ` +
        `${summary.noRecipeCount} no Recipe`,
    );
    return summary;
  };
}

export interface StartScanQueueOptions extends CreateScanJobHandlerOptions {
  readonly databaseUrl: string;
  readonly queueName?: string;
  readonly boss?: PgBoss;
}

export interface ScanQueueRuntime {
  readonly boss: PgBoss;
  enqueue(
    trigger: AllSourcesScanJob['trigger'],
    requestedAt?: Date,
  ): Promise<string | null>;
  stop(): Promise<void>;
}

export async function ensureScanQueue(
  boss: Pick<PgBoss, 'createQueue'>,
  queueName = ALL_SOURCES_SCAN_QUEUE,
): Promise<void> {
  // pg-boss's create_queue function is idempotent and refreshes the inherited
  // queue options, so every process starts from the same bounded retry policy.
  await boss.createQueue(queueName, SCAN_QUEUE_OPTIONS);
}

export async function startScanQueue(
  options: StartScanQueueOptions,
): Promise<ScanQueueRuntime> {
  const queueName = options.queueName ?? ALL_SOURCES_SCAN_QUEUE;
  const boss = options.boss ?? new PgBoss({
    connectionString: options.databaseUrl,
    useListenNotify: true,
  });
  boss.on('error', (error) => {
    options.logger?.error('pg-boss error', error);
  });

  await boss.start();
  try {
    await ensureScanQueue(boss, queueName);
    await boss.work<AllSourcesScanJob>(
      queueName,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
        notifyPollingIntervalSeconds: 30,
      },
      createScanJobHandler(options),
    );
  } catch (error) {
    await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    boss,
    enqueue(trigger, requestedAt = new Date()) {
      return boss.send(queueName, createAllSourcesScanJob(trigger, requestedAt));
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

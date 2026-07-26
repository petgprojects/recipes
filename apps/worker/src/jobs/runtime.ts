import type { AllSourcesScanSummary } from '../scan/orchestrator';
import {
  startScanQueue,
  type ScanQueueLogger,
  type ScanQueueRuntime,
} from './queue';
import {
  startScanSchedule,
  type ScanScheduleRuntime,
} from './schedule';

export interface StartScanJobsOptions {
  readonly databaseUrl: string;
  readonly cronSchedule: string;
  readonly cronTimezone: string;
  readonly bootstrapEnabled: boolean;
  readonly runScan: (signal: AbortSignal) => Promise<AllSourcesScanSummary>;
  readonly hasCompletedScan: () => Promise<boolean>;
  readonly logger?: ScanQueueLogger;
}

export interface ScanJobsRuntime {
  readonly queue: ScanQueueRuntime;
  readonly schedule: ScanScheduleRuntime;
  readonly bootstrapJobId: string | null | undefined;
  stop(): Promise<void>;
}

export interface EnqueueBootstrapOptions {
  readonly enabled: boolean;
  readonly hasCompletedScan: () => Promise<boolean>;
  readonly enqueue: ScanQueueRuntime['enqueue'];
  readonly logger?: ScanQueueLogger;
}

export async function enqueueBootstrapScanIfNeeded(
  options: EnqueueBootstrapOptions,
): Promise<string | null | undefined> {
  if (!options.enabled) {
    options.logger?.info('bootstrap scan disabled by SCAN_BOOTSTRAP_ENABLED=false');
    return undefined;
  }
  if (await options.hasCompletedScan()) return undefined;

  // The all-sources queue uses pg-boss's global `exclusive` policy, so this
  // check-then-send remains safe when several worker processes start together:
  // one enqueue wins and every other producer receives null.
  const jobId = await options.enqueue('bootstrap');
  options.logger?.info(
    jobId === null
      ? 'bootstrap scan already queued or active'
      : `fresh database bootstrap scan enqueued as job ${jobId}`,
  );
  return jobId;
}

export async function startScanJobs(
  options: StartScanJobsOptions,
): Promise<ScanJobsRuntime> {
  const queue = await startScanQueue({
    databaseUrl: options.databaseUrl,
    runScan: options.runScan,
    logger: options.logger,
  });

  let schedule: ScanScheduleRuntime;
  try {
    schedule = startScanSchedule({
      schedule: options.cronSchedule,
      timezone: options.cronTimezone,
      enqueue: queue.enqueue,
      logger: options.logger,
    });
  } catch (error) {
    await queue.stop();
    throw error;
  }

  let bootstrapJobId: string | null | undefined;
  try {
    bootstrapJobId = await enqueueBootstrapScanIfNeeded({
      enabled: options.bootstrapEnabled,
      hasCompletedScan: options.hasCompletedScan,
      enqueue: queue.enqueue,
      logger: options.logger,
    });
  } catch (error) {
    await schedule.stop();
    await queue.stop();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    queue,
    schedule,
    bootstrapJobId,
    stop() {
      stopping ??= (async () => {
        // Stop producers first, then let pg-boss drain/abort its active handler.
        await schedule.stop();
        await queue.stop();
      })();
      return stopping;
    },
  };
}

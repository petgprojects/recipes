import cron, { type ScheduledTask } from 'node-cron';
import type { AllSourcesScanJob } from '@recipes/shared/scan-jobs';
import type { ScanQueueLogger } from './queue';

export interface StartScanScheduleOptions {
  readonly schedule: string;
  readonly timezone: string;
  readonly enqueue: (
    trigger: AllSourcesScanJob['trigger'],
    requestedAt?: Date,
  ) => Promise<string | null>;
  readonly logger?: ScanQueueLogger;
}

export interface ScanScheduleRuntime {
  readonly task: ScheduledTask;
  stop(): Promise<void>;
}

export function startScanSchedule(
  options: StartScanScheduleOptions,
): ScanScheduleRuntime {
  if (!cron.validate(options.schedule)) {
    throw new Error(`Invalid SCAN_CRON_SCHEDULE: ${options.schedule}`);
  }

  const task = cron.schedule(
    options.schedule,
    async (context) => {
      const jobId = await options.enqueue('cron', context.triggeredAt);
      options.logger?.info(
        jobId === null
          ? 'daily scan already queued or active; cron enqueue coalesced'
          : `daily scan enqueued as job ${jobId}`,
      );
    },
    {
      name: 'recipes-daily-scan',
      timezone: options.timezone,
      noOverlap: true,
    },
  );
  task.on('execution:failed', (context) => {
    options.logger?.error('daily scan enqueue failed', context.execution?.error);
  });

  let stopping: Promise<void> | undefined;
  return {
    task,
    stop() {
      stopping ??= (async () => {
        await task.stop();
        await task.destroy();
      })();
      return stopping;
    },
  };
}

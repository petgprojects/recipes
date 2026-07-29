/**
 * The durable queue behind the nightly personalization pass.
 *
 * Structurally the enrichment queue, and for the same reasons: `exclusive`, so
 * a cron tick that lands while last night's pass is still running coalesces
 * instead of running two passes over the same readers; bounded retries, because
 * a failed pass should be tried again but not forever; and a long expiry,
 * because a corpus-wide rescore is minutes of provider calls, not seconds.
 *
 * What schedules it is not a second cron. Personalization is the last link of
 * the nightly chain — scan, then Phase 2 enrichment, then this — because
 * scoring a recipe before enrichment has given it a category, tags and a blurb
 * would score it on a blank. `apps/worker/src/index.ts` owns that wiring.
 */

import { PgBoss, type Job } from 'pg-boss';
import { z } from 'zod';
import type { PersonalizationPassSummary } from '../personalization/runtime';
import type { ScanQueueLogger } from './queue';

export const PERSONALIZATION_QUEUE = 'personalize-readers';

export const PERSONALIZATION_QUEUE_OPTIONS = {
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

const personalizationJobSchema = z.object({
  trigger: z.enum(['post-enrichment', 'post-scan', 'manual']),
  requestedAt: z.iso.datetime(),
});

export type PersonalizationJob = z.infer<typeof personalizationJobSchema>;

export function createPersonalizationJob(
  trigger: PersonalizationJob['trigger'],
  requestedAt = new Date(),
): PersonalizationJob {
  return { trigger, requestedAt: requestedAt.toISOString() };
}

export interface CreatePersonalizationJobHandlerOptions {
  readonly runPersonalization: (
    signal: AbortSignal,
  ) => Promise<PersonalizationPassSummary>;
  readonly logger?: ScanQueueLogger;
}

export function createPersonalizationJobHandler(
  options: CreatePersonalizationJobHandlerOptions,
) {
  return async (
    jobs: Job<PersonalizationJob>[],
  ): Promise<PersonalizationPassSummary> => {
    const job = jobs[0];
    if (job === undefined) {
      throw new Error('pg-boss delivered an empty personalization batch');
    }
    const payload = personalizationJobSchema.parse(job.data);
    options.logger?.info(
      `starting ${payload.trigger} personalization job ${job.id} requested ${payload.requestedAt}`,
    );

    const summary = await options.runPersonalization(job.signal);

    const scored = summary.users.reduce((total, user) => total + user.scored, 0);
    options.logger?.info(
      `finished personalization job ${job.id}: ${summary.users.length} reader(s), ` +
        `${scored} recipe score(s) written` +
        (summary.failures.length === 0 ? '' : `, ${summary.failures.length} failed`) +
        (summary.budgetExhausted ? ', daily budget reached' : ''),
    );

    // A reader-level failure is durable and retryable; a budget stop is not,
    // because the next attempt meets the same UTC-day cap. Same split as the
    // enrichment handler.
    if (summary.failures.length > 0 && !summary.budgetExhausted) {
      throw new Error(
        `personalization failed for ${summary.failures.length} reader(s): ` +
          `${summary.failures[0]!.error}; pg-boss will retry`,
      );
    }

    return summary;
  };
}

export async function ensurePersonalizationQueue(
  boss: Pick<PgBoss, 'createQueue'>,
): Promise<void> {
  await boss.createQueue(PERSONALIZATION_QUEUE, PERSONALIZATION_QUEUE_OPTIONS);
}

export interface StartPersonalizationQueueOptions
  extends CreatePersonalizationJobHandlerOptions {
  readonly databaseUrl: string;
  readonly boss?: PgBoss;
}

export interface PersonalizationQueueRuntime {
  readonly boss: PgBoss;
  enqueue(
    trigger: PersonalizationJob['trigger'],
    requestedAt?: Date,
  ): Promise<string | null>;
  stop(): Promise<void>;
}

export async function startPersonalizationQueue(
  options: StartPersonalizationQueueOptions,
): Promise<PersonalizationQueueRuntime> {
  const boss =
    options.boss ??
    new PgBoss({ connectionString: options.databaseUrl, useListenNotify: true });
  boss.on('error', (error) => {
    options.logger?.error('pg-boss personalization error', error);
  });

  await boss.start();
  try {
    await ensurePersonalizationQueue(boss);
    await boss.work<PersonalizationJob>(
      PERSONALIZATION_QUEUE,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 2,
        notifyPollingIntervalSeconds: 30,
      },
      createPersonalizationJobHandler(options),
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
        PERSONALIZATION_QUEUE,
        createPersonalizationJob(trigger, requestedAt),
      );
    },
    stop() {
      stopping ??= boss.stop({ graceful: true, timeout: 15_000 });
      return stopping;
    },
  };
}

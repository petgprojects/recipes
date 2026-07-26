import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, db, ingredients, sql } from '@recipes/db';
import { env } from '@recipes/shared/env';
import { startScanJobs, type ScanJobsRuntime } from './jobs/runtime';
import {
  createPostgresScanOrchestrator,
  hasCompletedScan,
} from './scan/postgres';

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

const logger = {
  info: log,
  error(message: string, error?: unknown) {
    console.error(`[worker] ${new Date().toISOString()} ${message}`, error ?? '');
  },
};

async function checkDatabase(): Promise<{ ingredients: number }> {
  const ping = await client`select 1 as ok`;
  if (ping[0]?.ok !== 1) throw new Error('`select 1` did not return 1');

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(ingredients);
  return { ingredients: row?.count ?? 0 };
}

function safeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export interface WorkerRuntime {
  readonly jobs: ScanJobsRuntime;
  stop(): Promise<void>;
}

export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  log('starting…');
  log(`node        ${process.version}`);
  log(`NODE_ENV    ${env.NODE_ENV}`);
  log(`database    ${safeDatabaseUrl(env.DATABASE_URL)}`);

  const { ingredients: seeded } = await checkDatabase();
  const scanner = createPostgresScanOrchestrator({
    db,
    imageOutputDir: env.RECIPE_IMAGES_DIR,
    discoveryLimit: env.SCAN_DISCOVERY_LIMIT,
    log,
  });

  const jobs = await startScanJobs({
    databaseUrl: env.DATABASE_URL,
    cronSchedule: env.SCAN_CRON_SCHEDULE,
    cronTimezone: env.SCAN_CRON_TIMEZONE,
    bootstrapEnabled: env.SCAN_BOOTSTRAP_ENABLED,
    runScan: (signal) => scanner.scanAllSources({ signal }),
    hasCompletedScan: () => hasCompletedScan(db),
    logger,
  });

  log('──────────────────────────────────────────────────────────');
  log('  recipes worker — deterministic Phase 1 ingestion');
  log(`  database reachable, ${seeded} canonical ingredients seeded`);
  log(
    `  daily scan: ${env.SCAN_CRON_SCHEDULE} (${env.SCAN_CRON_TIMEZONE}); ` +
      `next ${jobs.schedule.task.getNextRun()?.toISOString() ?? 'unknown'}`,
  );
  log('  pg-boss queue ready; zero LLM calls/tokens/cost');
  log('──────────────────────────────────────────────────────────');

  let stopping: Promise<void> | undefined;
  return {
    jobs,
    stop() {
      stopping ??= (async () => {
        try {
          await jobs.stop();
        } finally {
          await client.end({ timeout: 5 });
        }
        log('scan scheduler, pg-boss, and database pool stopped');
      })();
      return stopping;
    },
  };
}

async function runWorkerProcess(): Promise<void> {
  const runtime = await startWorkerRuntime();
  const signal = await waitForTerminationSignal();
  log(`${signal} received — shutting down`);
  await runtime.stop();
}

function waitForTerminationSignal(): Promise<'SIGTERM' | 'SIGINT'> {
  return new Promise((resolve) => {
    const finish = (signal: 'SIGTERM' | 'SIGINT') => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInterrupt);
      resolve(signal);
    };
    const onTerm = () => finish('SIGTERM');
    const onInterrupt = () => finish('SIGINT');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInterrupt);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runWorkerProcess().catch(async (error: unknown) => {
    logger.error('fatal', error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  });
}

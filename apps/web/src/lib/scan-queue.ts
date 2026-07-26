import { PgBoss } from 'pg-boss';
import {
  ALL_SOURCES_SCAN_QUEUE,
  createAllSourcesScanJob,
} from '@recipes/shared/scan-jobs';
import { env } from '@recipes/shared/env';

interface ScanQueueGlobal {
  __recipesScanQueueProducer?: Promise<PgBoss>;
}

const producerGlobal = globalThis as ScanQueueGlobal;

async function startProducer(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // The worker owns migrations, queue policy, supervision, and scheduling.
    // This process only needs the lightweight producer API.
    createSchema: false,
    migrate: false,
    schedule: false,
    supervise: false,
  });
  boss.on('error', (error) => {
    console.error('[web:scan-queue] pg-boss error', error);
  });
  await boss.start();
  return boss;
}

async function getProducer(): Promise<PgBoss> {
  producerGlobal.__recipesScanQueueProducer ??= startProducer().catch((error) => {
    producerGlobal.__recipesScanQueueProducer = undefined;
    throw error;
  });
  return producerGlobal.__recipesScanQueueProducer;
}

/**
 * Returns null when pg-boss's queue-level `exclusive` policy coalesces this
 * request with a job that is already queued or active.
 */
export async function enqueueManualScan(): Promise<string | null> {
  const boss = await getProducer();
  return boss.send(ALL_SOURCES_SCAN_QUEUE, createAllSourcesScanJob('manual'));
}

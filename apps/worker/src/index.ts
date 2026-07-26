/**
 * Worker entrypoint — Phase 0 skeleton.
 *
 * Phase 1 turns this into the crawl loop: `scanner/` (RSS + sitemap discovery,
 * polite fetching, JSON-LD extraction), `jobs/` (pg-boss handlers and the
 * node-cron schedule behind a Postgres advisory lock), `llm/` (Phase 2). None of
 * that exists yet, and this file deliberately does not pretend otherwise.
 *
 * What it *does* do matters for the compose stack:
 *
 *   1. validates the environment at import time (importing `@recipes/shared/env`
 *      IS the boot check — PLAN.md §3 "fails fast at boot ... rather than
 *      throwing at 3am mid-scan");
 *   2. proves the database is actually reachable from this container, so a green
 *      `docker compose ps` means something;
 *   3. stays alive. A skeleton that exits 0 would make compose either mark the
 *      service dead or, with a restart policy, crash-loop it — noise that hides
 *      real failures for the whole of Phase 1;
 *   4. shuts down gracefully on SIGTERM/SIGINT, closing the pool. `docker
 *      compose down` should not leave Postgres reaping abandoned backends, and
 *      Phase 1 will hang its "finish the in-flight job" logic off this same hook.
 */

import { client, db, ingredients, sql } from '@recipes/db';
import { env } from '@recipes/shared/env';

const HEARTBEAT_MS = 60_000;

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

/** Round-trip the database and report what Phase 0 seeded. */
async function checkDatabase(): Promise<{ ingredients: number }> {
  const ping = await client`select 1 as ok`;
  if (ping[0]?.ok !== 1) throw new Error('`select 1` did not return 1');

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(ingredients);
  return { ingredients: row?.count ?? 0 };
}

/**
 * Redacts the password so the banner is safe in `docker compose logs`, which
 * people paste into issues.
 */
function safeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

let heartbeat: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — shutting down`);

  if (heartbeat) clearInterval(heartbeat);

  // Phase 1: drain pg-boss and release the scan advisory lock here, before the
  // pool closes.
  try {
    await client.end({ timeout: 5 });
    log('database pool closed');
  } catch (error: unknown) {
    console.error('[worker] error closing database pool:', error);
  }

  process.exit(0);
}

async function main(): Promise<void> {
  log('starting…');
  log(`node        ${process.version}`);
  log(`NODE_ENV    ${env.NODE_ENV}`);
  log(`database    ${safeDatabaseUrl(env.DATABASE_URL)}`);

  const { ingredients: seeded } = await checkDatabase();

  log('──────────────────────────────────────────────────────────');
  log('  recipes worker — Phase 0 skeleton');
  log(`  database reachable, ${seeded} canonical ingredients seeded`);
  log('  no scanner, no cron, no job queue yet — that is Phase 1');
  log('  idle; waiting for SIGTERM/SIGINT');
  log('──────────────────────────────────────────────────────────');

  // This interval is what keeps the process alive — deliberately *not*
  // `unref()`d, since a pending promise alone does not hold the event loop open
  // and the container would exit 0 the moment `main()` awaited. Phase 1 replaces
  // it with pg-boss's own long-lived subscription.
  heartbeat = setInterval(() => {
    log(`idle — uptime ${Math.round(process.uptime())}s`);
  }, HEARTBEAT_MS);

  // Never resolves; `shutdown()` calls `process.exit` instead.
  await new Promise<never>(() => {});
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error: unknown) => {
  console.error('[worker] fatal:', error);
  // Non-zero so compose/`restart: unless-stopped` retries a transient database
  // outage instead of silently sitting there having done nothing.
  process.exit(1);
});

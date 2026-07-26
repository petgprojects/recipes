/**
 * GET /api/health
 *
 * PLAN.md §5 Phase 0 exit criterion is "migrated schema, seeded ingredients,
 * health check green" — so this endpoint does a real database round-trip rather
 * than returning a static `{ok: true}`. A health check that reports 200 while
 * the database is unreachable is worse than no health check at all, so:
 *
 *   200  → `select 1` succeeded AND the seeded `ingredients` table was counted.
 *   503  → anything failed, with the error message in the body.
 *
 * `ingredients` is the right migration/seed sentinel because it is populated
 * before the worker starts. `recipes` is counted too so Phase 1 crawl progress
 * is visible without turning ingestion completeness into a liveness condition.
 */

import { NextResponse } from 'next/server';
import { client, db, ingredients, recipes, sql } from '@recipes/db';

// A health check must never be prerendered or cached — it reports on right now.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EXPECTED_SEED_INGREDIENTS = 1;

export async function GET() {
  const startedAt = Date.now();

  try {
    // 1. Liveness of the connection itself, independent of any table existing.
    const ping = await client`select 1 as ok`;
    if (ping[0]?.ok !== 1) throw new Error('`select 1` did not return 1');

    // 2. Proof the schema is migrated and the Phase 0 seed ran.
    const [[ingredientRow], [recipeRow]] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(ingredients),
      db.select({ count: sql<number>`count(*)::int` }).from(recipes),
    ]);

    const ingredientCount = ingredientRow?.count ?? 0;
    const seeded = ingredientCount >= EXPECTED_SEED_INGREDIENTS;

    return NextResponse.json(
      {
        status: seeded ? 'ok' : 'degraded',
        phase: 2,
        timestamp: new Date().toISOString(),
        database: {
          reachable: true,
          migrated: true,
          seeded,
          ingredients: ingredientCount,
          // Every recipe arrives from the deterministic Phase 1 crawl.
          recipes: recipeRow?.count ?? 0,
          latencyMs: Date.now() - startedAt,
        },
      },
      {
        // Migrated but unseeded is a real problem (the ingredient matcher has no
        // head start), so it is not a green check either.
        status: seeded ? 200 : 503,
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error: unknown) {
    return NextResponse.json(
      {
        status: 'error',
        phase: 2,
        timestamp: new Date().toISOString(),
        database: {
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - startedAt,
        },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

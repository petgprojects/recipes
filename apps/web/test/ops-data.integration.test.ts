import { afterEach, describe, expect, it } from 'vitest';
import { db, inArray, scanRuns, sql } from '@recipes/db';
import { loadOpsSnapshot } from '../src/lib/ops-data';

const createdRunIds: string[] = [];

afterEach(async () => {
  if (createdRunIds.length === 0) return;
  await db.delete(scanRuns).where(inArray(scanRuns.id, createdRunIds.splice(0)));
});

describe('operations snapshot scan kinds', () => {
  it('labels search and all-source scan rows while keeping total UTC spend unfiltered', async () => {
    const now = new Date();
    const nearEndOfUtcDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
    ));
    const rows = await db
      .insert(scanRuns)
      .values([
        {
          kind: 'scan',
          status: 'success',
          startedAt: nearEndOfUtcDay,
          finishedAt: nearEndOfUtcDay,
          tokensIn: 111,
          tokensOut: 11,
          costUsd: 0.012345,
        },
        {
          kind: 'search',
          status: 'success',
          startedAt: new Date(nearEndOfUtcDay.getTime() + 1),
          finishedAt: new Date(nearEndOfUtcDay.getTime() + 1),
          tokensIn: 222,
          tokensOut: 22,
          costUsd: 0.023456,
        },
      ])
      .returning({ id: scanRuns.id, kind: scanRuns.kind });
    createdRunIds.push(...rows.map((row) => row.id));

    const snapshot = await loadOpsSnapshot();
    const byId = new Map(snapshot.recentScans.map((run) => [run.id, run]));

    expect(byId.get(rows[0]!.id)).toMatchObject({
      kind: 'scan',
      sourceName: 'All sources',
    });
    expect(byId.get(rows[1]!.id)).toMatchObject({
      kind: 'search',
      sourceName: 'Search',
      costUsd: 0.023456,
    });

    const [expectedUtcSpend] = await db
      .select({
        tokensIn: sql<number>`coalesce(sum(${scanRuns.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${scanRuns.tokensOut}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${scanRuns.costUsd}), 0)::double precision`,
      })
      .from(scanRuns)
      .where(
        sql`${scanRuns.startedAt} >= (
          date_trunc('day', now() at time zone 'UTC')
          at time zone 'UTC'
        )`,
      );

    expect(snapshot.llmToday).toEqual(expectedUtcSpend);
  });
});

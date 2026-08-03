import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from '@recipes/db/operators';
import { scanRuns } from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import { hasCompletedScan } from '../src/scan/postgres';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

let db: Database;
let sqlClient: Awaited<
  ReturnType<typeof import('@recipes/db/client')['createClient']>
>['client'];

integration('Postgres scan bootstrap state', () => {
  beforeAll(async () => {
    const { createClient } = await import('@recipes/db/client');
    const connection = createClient({ url: databaseUrl, max: 1 });
    db = connection.db;
    sqlClient = connection.client;
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  it('ignores successful search accumulators and accepts completed scan runs', async () => {
    const rollback = new Error('rollback completed-scan fixture');

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(scanRuns)
          .set({ kind: 'search' })
          .where(
            and(
              eq(scanRuns.kind, 'scan'),
              inArray(scanRuns.status, ['success', 'partial']),
            ),
          );
        await tx.insert(scanRuns).values({
          kind: 'search',
          status: 'success',
          finishedAt: new Date(),
        });

        expect(await hasCompletedScan(tx as unknown as Database)).toBe(false);

        await tx.insert(scanRuns).values({
          kind: 'scan',
          status: 'partial',
          finishedAt: new Date(),
        });

        expect(await hasCompletedScan(tx as unknown as Database)).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

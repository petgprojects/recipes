import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { BLOG_SOURCES } from '@recipes/shared';
import type { Database } from '../src/client';
import { sources } from '../src/schema';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

let db: Database;
let close: (() => Promise<void>) | undefined;

integration('Phase 1 source seed', () => {
  beforeAll(async () => {
    const { createClient } = await import('../src/client');
    const connection = createClient({ url: databaseUrl, max: 1 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });
  });

  afterAll(async () => {
    await close?.();
  });

  it('is idempotent and keeps all eight canonical sources enabled', async () => {
    const { seed } = await import('../src/seed');
    const first = await seed(db, 'test');
    const before = await canonicalRows();
    const second = await seed(db, 'test');
    const after = await canonicalRows();

    expect(first.sources).toBe(8);
    expect(second.sources).toBe(8);
    expect(after).toEqual(before);
    expect(after).toHaveLength(8);
    expect(after.every((source) => source.enabled)).toBe(true);
    expect(after.find((source) => source.name === 'Serious Eats')?.enabled).toBe(true);
  });
});

async function canonicalRows() {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      baseUrl: sources.baseUrl,
      enabled: sources.enabled,
    })
    .from(sources)
    .where(inArray(sources.baseUrl, BLOG_SOURCES.map((source) => source.baseUrl)))
    .orderBy(sources.baseUrl);
}

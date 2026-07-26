import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { BLOG_SOURCES, REDDIT_SOURCES } from '@recipes/shared';
import type { Database } from '../src/client';
import { sources } from '../src/schema';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

let db: Database;
let close: (() => Promise<void>) | undefined;

integration('canonical source seed', () => {
  beforeAll(async () => {
    const { createClient } = await import('../src/client');
    const connection = createClient({ url: databaseUrl, max: 1 });
    db = connection.db;
    close = async () => connection.client.end({ timeout: 5 });
  });

  afterAll(async () => {
    await close?.();
  });

  afterEach(async () => {
    await db
      .update(sources)
      .set({ enabled: false })
      .where(eq(sources.baseUrl, REDDIT_SOURCES[0].baseUrl));
  });

  it('is idempotent, keeps all eight blogs enabled, and seeds Reddit disabled', async () => {
    const { seed } = await import('../src/seed');
    await seed(db, 'test');
    await db
      .update(sources)
      .set({ enabled: false })
      .where(eq(sources.baseUrl, REDDIT_SOURCES[0].baseUrl));
    const first = await seed(db, 'test');
    const before = await canonicalRows();
    const second = await seed(db, 'test');
    const after = await canonicalRows();

    expect(first.sources).toBe(9);
    expect(second.sources).toBe(9);
    expect(after).toEqual(before);
    expect(after).toHaveLength(9);
    expect(after.filter((source) => source.kind === 'blog')).toHaveLength(8);
    expect(
      after
        .filter((source) => source.kind === 'blog')
        .every((source) => source.enabled),
    ).toBe(true);
    expect(after.find((source) => source.name === 'Serious Eats')?.enabled).toBe(true);
    expect(after.find((source) => source.kind === 'reddit')?.enabled).toBe(false);
  });

  it('does not overwrite a manual Reddit enabled flag on reseed', async () => {
    const { seed } = await import('../src/seed');
    await seed(db, 'test');
    const redditBaseUrl = REDDIT_SOURCES[0].baseUrl;

    await db
      .update(sources)
      .set({ enabled: true })
      .where(eq(sources.baseUrl, redditBaseUrl));
    await seed(db, 'test');

    const [reddit] = await db
      .select({ enabled: sources.enabled })
      .from(sources)
      .where(eq(sources.baseUrl, redditBaseUrl));
    expect(reddit?.enabled).toBe(true);

  });
});

async function canonicalRows() {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      kind: sources.kind,
      baseUrl: sources.baseUrl,
      enabled: sources.enabled,
    })
    .from(sources)
    .where(
      inArray(sources.baseUrl, [
        ...BLOG_SOURCES.map((source) => source.baseUrl),
        ...REDDIT_SOURCES.map((source) => source.baseUrl),
      ]),
    )
    .orderBy(sources.baseUrl);
}

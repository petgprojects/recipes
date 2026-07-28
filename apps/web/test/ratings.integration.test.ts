/**
 * `apps/web/src/lib/ratings.ts` against the real database.
 *
 * `packages/shared/test/ratings.test.ts` is the wire-schema spec — a bad
 * rating or an off-vocabulary aspect never reaches SQL. This suite covers what
 * that one can't: the foreign-key guard against a deleted recipe, ownership on
 * delete, and that `cook_logs_aspects_vocab` really is live in this database
 * and not just in the migration file.
 *
 * Requires the Compose database and `DATABASE_URL`, like the other
 * integration suites in this repo.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { createCookLog, deleteCookLog, listCookLogs } from '../src/lib/ratings';

async function scratchUser(label: string): Promise<string> {
  const email = `ratings-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  return row!.id;
}

async function dropUser(userId: string): Promise<void> {
  // `cook_logs.user_id` cascades, so this takes the logged entries with it.
  await db.execute(sql`delete from users where id = ${userId}::uuid`);
}

let recipeId: string;
const userIds: string[] = [];

beforeAll(async () => {
  const [row] = (await db.execute(sql`
    select id::text as id from recipes where status = 'active' order by id limit 1
  `)) as unknown as { id: string }[];
  recipeId = row!.id;
});

afterEach(async () => {
  while (userIds.length > 0) await dropUser(userIds.pop()!);
});

describe('cook logs in SQL', () => {
  it('has a recipe to test against', () => {
    expect(recipeId).toBeTypeOf('string');
  });

  it('starts empty for a user who has never cooked anything', async () => {
    const userId = await scratchUser('empty');
    userIds.push(userId);

    expect(await listCookLogs(userId, recipeId)).toEqual([]);
  });

  it('logs a cook and reads it back', async () => {
    const userId = await scratchUser('log');
    userIds.push(userId);

    const { result, logs } = await createCookLog(userId, {
      recipeId,
      rating: 4,
      aspects: ['quick', 'would_repeat'],
      notes: 'Extra garlic next time.',
    });

    expect(result).toBe('created');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      recipeId,
      rating: 4,
      aspects: ['quick', 'would_repeat'],
      notes: 'Extra garlic next time.',
    });
    expect(typeof logs[0]!.id).toBe('string');
    expect(typeof logs[0]!.cookedAt).toBe('string');

    expect(await listCookLogs(userId, recipeId)).toEqual(logs);
  });

  it('lists newest first and keeps two users apart', async () => {
    const alice = await scratchUser('alice');
    const bob = await scratchUser('bob');
    userIds.push(alice, bob);

    await createCookLog(alice, { recipeId, rating: 2, aspects: [], notes: null });
    await createCookLog(alice, { recipeId, rating: 5, aspects: [], notes: null });
    await createCookLog(bob, { recipeId, rating: 1, aspects: [], notes: null });

    const aliceLogs = await listCookLogs(alice, recipeId);
    expect(aliceLogs.map((log) => log.rating)).toEqual([5, 2]);

    const bobLogs = await listCookLogs(bob, recipeId);
    expect(bobLogs).toHaveLength(1);
    expect(bobLogs[0]!.rating).toBe(1);
  });

  it('rejects a cook log against a recipe that does not exist', async () => {
    const userId = await scratchUser('unknown-recipe');
    userIds.push(userId);

    const { result, logs } = await createCookLog(userId, {
      recipeId: '00000000-0000-4000-8000-000000000000',
      rating: 3,
      aspects: [],
      notes: null,
    });

    expect(result).toBe('unknown-recipe');
    expect(logs).toEqual([]);
  });

  it('deletes only the owning user\'s entry', async () => {
    const alice = await scratchUser('delete-alice');
    const bob = await scratchUser('delete-bob');
    userIds.push(alice, bob);

    const { logs: aliceLogs } = await createCookLog(alice, {
      recipeId,
      rating: 3,
      aspects: [],
      notes: null,
    });
    const { logs: bobLogs } = await createCookLog(bob, {
      recipeId,
      rating: 3,
      aspects: [],
      notes: null,
    });
    const aliceLogId = aliceLogs[0]!.id;
    const bobLogId = bobLogs[0]!.id;

    // Bob's id doesn't belong to Alice, so this must not remove Bob's entry.
    const afterWrongDelete = await deleteCookLog(alice, bobLogId, recipeId);
    expect(afterWrongDelete.map((log) => log.id)).toContain(aliceLogId);

    const afterRealDelete = await deleteCookLog(alice, aliceLogId, recipeId);
    expect(afterRealDelete).toEqual([]);
    expect(await listCookLogs(bob, recipeId)).toHaveLength(1);
  });

  it('still enforces the aspect vocabulary at the database, not just in Zod', async () => {
    const userId = await scratchUser('bad-vocab');
    userIds.push(userId);

    await expect(
      db.execute(sql`
        insert into cook_logs (user_id, recipe_id, rating, aspects)
        values (${userId}::uuid, ${recipeId}::uuid, 3, array['delicious'])
      `),
    ).rejects.toThrow();
  });

  it('still enforces the rating range at the database', async () => {
    const userId = await scratchUser('bad-rating');
    userIds.push(userId);

    await expect(
      db.execute(sql`
        insert into cook_logs (user_id, recipe_id, rating)
        values (${userId}::uuid, ${recipeId}::uuid, 7)
      `),
    ).rejects.toThrow();
  });
});

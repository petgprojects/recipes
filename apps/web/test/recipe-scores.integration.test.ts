/**
 * Phase 7 step 3 as browse actually sees it: `recipe_scores` joined into
 * `listRecipes()`.
 *
 * The worker suite proves the scores get written. This one proves the feed
 * reads them — for the right reader, in the right order, and without changing
 * anything at all for a reader who has none. That last case is the one that
 * would go unnoticed: a scoring join that quietly reshuffled the signed-out
 * feed would break the server render's agreement with the poller, and the
 * symptom is a page that flickers rather than an error.
 *
 * Requires the Compose database and `DATABASE_URL`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { NEUTRAL_SCORE } from '@recipes/shared/personalization';
import { getRecipeDetail, listRecipes } from '../src/lib/recipes';

const userIds: string[] = [];
let corpus: { id: string }[] = [];
let signedOutOrder: string[] = [];

beforeAll(async () => {
  corpus = (await db.execute(sql`
    select id::text as id from recipes where status = 'active' order by id limit 5
  `)) as unknown as { id: string }[];
  signedOutOrder = (await listRecipes({ limit: 500 })).map((row) => row.id);
});

afterEach(async () => {
  while (userIds.length > 0) {
    await db.execute(sql`delete from users where id = ${userIds.pop()!}::uuid`);
  }
});

async function scratchUser(label: string): Promise<string> {
  const email = `scores-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  userIds.push(row!.id);
  return row!.id;
}

async function score(
  userId: string,
  recipeId: string,
  value: number,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    insert into recipe_scores (user_id, recipe_id, score, reason)
    values (${userId}::uuid, ${recipeId}::uuid, ${value}, ${reason})
  `);
}

describe('a reader with no scores', () => {
  it('sees the same feed signed out as before Phase 7 joined anything', async () => {
    expect((await listRecipes({ limit: 500, userId: null })).map((r) => r.id)).toEqual(
      signedOutOrder,
    );
  });

  it('sees the same feed signed in but unscored — the cold-start order', async () => {
    const userId = await scratchUser('cold');
    expect((await listRecipes({ limit: 500, userId })).map((r) => r.id)).toEqual(signedOutOrder);
  });

  it('carries null score fields rather than omitting them', async () => {
    const [row] = await listRecipes({ limit: 1, userId: null });
    expect(row).toMatchObject({ score: null, scoreReason: null });
  });
});

describe('a reader with scores', () => {
  it('puts a high score above a low one regardless of publication date', async () => {
    const userId = await scratchUser('ordered');
    const [first, second] = corpus;
    await score(userId, first!.id, 99, 'everything you like');
    await score(userId, second!.id, 1, 'nothing you like');

    const rows = await listRecipes({ limit: 500, userId });
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.scoreReason).toBe('everything you like');
    expect(rows.at(-1)!.id).toBe(second!.id);
  });

  it('sorts an unscored recipe as neutral, not as last', async () => {
    // An unscored recipe is unknown, not bad — the same principle as A20's
    // null-keeping `WHERE` clauses. A new arrival must not be buried under
    // every recipe last night's pass happened to reach.
    const userId = await scratchUser('neutral');
    await score(userId, corpus[0]!.id, NEUTRAL_SCORE + 20, 'above neutral');
    await score(userId, corpus[1]!.id, NEUTRAL_SCORE - 20, 'below neutral');

    const rows = await listRecipes({ limit: 500, userId });
    const positions = new Map(rows.map((row, index) => [row.id, index]));
    const unscored = rows.find((row) => row.score === null);

    expect(unscored).toBeDefined();
    expect(positions.get(corpus[0]!.id)!).toBeLessThan(positions.get(unscored!.id)!);
    expect(positions.get(unscored!.id)!).toBeLessThan(positions.get(corpus[1]!.id)!);
  });

  it('never shows one reader another reader’s score', async () => {
    const alice = await scratchUser('alice');
    const bob = await scratchUser('bob');
    await score(alice, corpus[0]!.id, 99, 'alice loves this');

    const bobsFeed = await listRecipes({ limit: 500, userId: bob });
    expect(bobsFeed.every((row) => row.score === null)).toBe(true);
    expect(bobsFeed.map((row) => row.id)).toEqual(signedOutOrder);
  });

  it('carries the same score onto the detail row', async () => {
    const userId = await scratchUser('detail');
    await score(userId, corpus[0]!.id, 77, 'because you like sheet-pan dinners');

    const detail = await getRecipeDetail(corpus[0]!.id, { userId });
    expect(detail).toMatchObject({ score: 77, scoreReason: 'because you like sheet-pan dinners' });

    // Signed out, the same recipe has no score at all.
    const anonymous = await getRecipeDetail(corpus[0]!.id);
    expect(anonymous).toMatchObject({ score: null, scoreReason: null });
  });
});

/**
 * `apps/worker/src/personalization/hard-rules.ts` against the real database.
 *
 * `packages/shared/test/personalization.test.ts` is the spec for *when* a rule
 * is warranted, and it runs without a database. This suite covers the half
 * that one cannot: that the evidence-gathering SQL buckets real recipes the
 * way the pure layer assumes — nested time buckets, disjoint categories,
 * overlapping tags — and that persistence preserves a reader's override.
 *
 * Every user here is a scratch user dropped afterwards, so the synthetic cook
 * logs never outlive the test. Requires the Compose database and
 * `DATABASE_URL`, like the other integration suites.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { parseHardRules } from '@recipes/shared/personalization';
import {
  deriveHardRulesForUser,
  gatherObservations,
} from '../src/personalization/hard-rules';

interface RecipeRow {
  id: string;
  total_minutes: number | null;
  category: string | null;
  tags: string[];
}

async function scratchUser(label: string): Promise<string> {
  const email = `hardrules-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  return row!.id;
}

async function dropUser(userId: string): Promise<void> {
  // `cook_logs.user_id` and `user_preferences.user_id` both cascade.
  await db.execute(sql`delete from users where id = ${userId}::uuid`);
}

async function logCook(userId: string, recipeId: string, rating: number): Promise<void> {
  await db.execute(sql`
    insert into cook_logs (user_id, recipe_id, rating)
    values (${userId}::uuid, ${recipeId}::uuid, ${rating})
  `);
}

/** Active recipes longer than `minutes`, for building a time bucket. */
async function slowRecipes(minutes: number, limit: number): Promise<RecipeRow[]> {
  return (await db.execute(sql`
    select id::text as id, total_minutes, category::text as category, tags
    from recipes
    where status = 'active' and total_minutes > ${minutes}
    order by total_minutes desc, id
    limit ${limit}
  `)) as unknown as RecipeRow[];
}

let quickRecipes: RecipeRow[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  quickRecipes = (await db.execute(sql`
    select id::text as id, total_minutes, category::text as category, tags
    from recipes
    where status = 'active' and total_minutes is not null and total_minutes <= 30
    order by id
    limit 10
  `)) as unknown as RecipeRow[];
});

afterEach(async () => {
  while (userIds.length > 0) await dropUser(userIds.pop()!);
});

describe('gathering evidence', () => {
  it('has fixture recipes on both sides of the time ladder', async () => {
    expect(quickRecipes.length).toBeGreaterThanOrEqual(5);
    expect((await slowRecipes(90, 5)).length).toBeGreaterThanOrEqual(5);
  });

  it('returns no observations at all for a user who has cooked nothing', async () => {
    const userId = await scratchUser('empty');
    userIds.push(userId);

    const observations = await gatherObservations(userId);
    expect(observations.filter((o) => o.ratings.length > 0)).toEqual([]);
  });

  it('counts one cook of a long recipe into every threshold below it', async () => {
    // The ladder is nested, which is exactly why `deriveTimeRule` emits the
    // loosest threshold. If this stops being true that reasoning is void.
    const userId = await scratchUser('nested');
    userIds.push(userId);

    const [slow] = await slowRecipes(90, 1);
    await logCook(userId, slow!.id, 1);

    const observations = await gatherObservations(userId);
    const byThreshold = new Map(
      observations.filter((o) => o.kind === 'max_minutes').map((o) => [o.value, o.ratings.length]),
    );
    expect(byThreshold.get('30')).toBe(1);
    expect(byThreshold.get('60')).toBe(1);
    expect(byThreshold.get('90')).toBe(1);
  });

  it('does not count a quick recipe into any time bucket', async () => {
    const userId = await scratchUser('quick');
    userIds.push(userId);

    await logCook(userId, quickRecipes[0]!.id, 1);

    const observations = await gatherObservations(userId);
    for (const bucket of observations.filter((o) => o.kind === 'max_minutes')) {
      expect(bucket.ratings).toEqual([]);
    }
  });

  it('buckets a cook under its category and under each of its tags', async () => {
    const userId = await scratchUser('buckets');
    userIds.push(userId);

    const recipe = quickRecipes.find((r) => r.category !== null && r.tags.length > 0);
    expect(recipe).toBeDefined();
    await logCook(userId, recipe!.id, 2);

    const observations = await gatherObservations(userId);

    const category = observations.find(
      (o) => o.kind === 'exclude_category' && o.value === recipe!.category,
    );
    expect(category?.ratings).toEqual([2]);

    for (const tag of recipe!.tags) {
      const bucket = observations.find((o) => o.kind === 'exclude_tag' && o.value === tag);
      expect(bucket?.ratings).toEqual([2]);
    }
  });

  it('keeps the evidence of two users apart', async () => {
    const alice = await scratchUser('alice');
    const bob = await scratchUser('bob');
    userIds.push(alice, bob);

    const [slow] = await slowRecipes(90, 1);
    await logCook(alice, slow!.id, 1);

    const bobs = await gatherObservations(bob);
    expect(bobs.filter((o) => o.ratings.length > 0)).toEqual([]);
  });
});

describe('deriving and storing rules', () => {
  it('writes no rules for a reader with too little history', async () => {
    const userId = await scratchUser('thin');
    userIds.push(userId);

    // Four disliked slow cooks — one short of the floor.
    for (const recipe of await slowRecipes(90, 4)) await logCook(userId, recipe.id, 1);

    const result = await deriveHardRulesForUser(userId);
    expect(result.rules.filter((r) => r.kind === 'max_minutes')).toEqual([]);
  });

  it('emits a time rule once the bucket is deep enough', async () => {
    const userId = await scratchUser('slow');
    userIds.push(userId);

    for (const recipe of await slowRecipes(90, 6)) await logCook(userId, recipe.id, 1);

    const result = await deriveHardRulesForUser(userId);
    const rule = result.rules.find((r) => r.kind === 'max_minutes');
    expect(rule?.value).toBe('90');
    expect(rule?.enabled).toBe(true);
    expect(rule?.observations).toBeGreaterThanOrEqual(6);
    expect(rule?.medianRating).toBe(1);
  });

  it('emits nothing when the same deep bucket was enjoyed', async () => {
    const userId = await scratchUser('happy');
    userIds.push(userId);

    for (const recipe of await slowRecipes(90, 6)) await logCook(userId, recipe.id, 5);

    const result = await deriveHardRulesForUser(userId);
    expect(result.rules).toEqual([]);
  });

  it('persists what it derived, readable through parseHardRules', async () => {
    const userId = await scratchUser('persist');
    userIds.push(userId);

    for (const recipe of await slowRecipes(90, 6)) await logCook(userId, recipe.id, 1);
    await deriveHardRulesForUser(userId);

    const [row] = (await db.execute(sql`
      select hard_rules from user_preferences where user_id = ${userId}::uuid
    `)) as unknown as { hard_rules: unknown }[];

    const stored = parseHardRules(row!.hard_rules);
    expect(stored.some((r) => r.id === 'max_minutes:90')).toBe(true);
  });

  it('leaves a rule the reader switched off switched off on the next run', async () => {
    const userId = await scratchUser('override');
    userIds.push(userId);

    for (const recipe of await slowRecipes(90, 6)) await logCook(userId, recipe.id, 1);
    await deriveHardRulesForUser(userId);

    // The reader disagrees and flips the switch. Targeted by id, not by array
    // index: six cooks of six slow recipes also earn category and tag rules,
    // and the stored array is sorted by id, so index 0 is not the time rule.
    await db.execute(sql`
      update user_preferences
      set hard_rules = (
        select jsonb_agg(
          case when rule->>'id' = 'max_minutes:90'
            then jsonb_set(rule, '{enabled}', 'false')
            else rule
          end
        )
        from jsonb_array_elements(hard_rules) as rule
      )
      where user_id = ${userId}::uuid
    `);

    const again = await deriveHardRulesForUser(userId);
    expect(again.rules.find((r) => r.id === 'max_minutes:90')?.enabled).toBe(false);
    expect(again.disabled).toBe(1);
    // The reader disabled one rule, not all of them.
    expect(again.rules.some((r) => r.enabled)).toBe(true);
  });

  it('does not touch the profile column that step 2 owns', async () => {
    const userId = await scratchUser('profile');
    userIds.push(userId);

    await db.execute(sql`
      insert into user_preferences (user_id, profile)
      values (${userId}::uuid, ${'"prefers sheet-pan dinners"'}::jsonb)
    `);
    for (const recipe of await slowRecipes(90, 6)) await logCook(userId, recipe.id, 1);

    await deriveHardRulesForUser(userId);

    const [row] = (await db.execute(sql`
      select profile from user_preferences where user_id = ${userId}::uuid
    `)) as unknown as { profile: unknown }[];
    expect(row!.profile).toBe('prefers sheet-pan dinners');
  });
});

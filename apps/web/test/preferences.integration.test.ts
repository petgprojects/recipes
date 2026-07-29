/**
 * `apps/web/src/lib/preferences.ts` and the hard-rule filter, against the real
 * database.
 *
 * `packages/shared/test/personalization.test.ts` says when a rule may exist.
 * This suite says what one *does* once it exists: that the `WHERE` clause
 * removes what the rule describes, keeps rows whose column is null, and that a
 * rule the reader switched off stops filtering immediately.
 *
 * The null cases are the ones worth having. A recipe whose `total_minutes`
 * Phase 2 could not derive has not been disliked — it is unknown — and a filter
 * that hid it would let missing data act as a preference.
 *
 * Requires the Compose database and `DATABASE_URL`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import type { HardRule } from '@recipes/shared/personalization';
import { getUserPreferences, setHardRuleEnabled } from '../src/lib/preferences';
import { listRecipes } from '../src/lib/recipes';

function rule(partial: Pick<HardRule, 'kind' | 'value'>): HardRule {
  return {
    id: `${partial.kind}:${partial.value}`,
    kind: partial.kind,
    value: partial.value,
    enabled: true,
    observations: 6,
    medianRating: 2,
  };
}

async function scratchUser(label: string): Promise<string> {
  const email = `prefs-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  return row!.id;
}

async function dropUser(userId: string): Promise<void> {
  await db.execute(sql`delete from users where id = ${userId}::uuid`);
}

const userIds: string[] = [];
let allActive = 0;

beforeAll(async () => {
  allActive = (await listRecipes({ limit: 500 })).length;
});

afterEach(async () => {
  while (userIds.length > 0) await dropUser(userIds.pop()!);
});

describe('reading preferences', () => {
  it('is empty for a signed-out reader without touching the database', async () => {
    expect(await getUserPreferences(null)).toEqual({ rules: [], profile: null });
  });

  it('is empty for a user the nightly job has never visited', async () => {
    const userId = await scratchUser('never');
    userIds.push(userId);

    expect(await getUserPreferences(userId)).toEqual({ rules: [], profile: null });
  });

  it('drops a malformed stored rule rather than the whole set', async () => {
    const userId = await scratchUser('malformed');
    userIds.push(userId);

    const good = rule({ kind: 'exclude_tag', value: 'spicy' });
    await db.execute(sql`
      insert into user_preferences (user_id, hard_rules)
      values (${userId}::uuid, ${JSON.stringify([good, { kind: 'from-an-older-deploy' }])}::jsonb)
    `);

    const { rules } = await getUserPreferences(userId);
    expect(rules).toEqual([good]);
  });
});

describe('the filter', () => {
  it('removes nothing when there are no rules', async () => {
    expect((await listRecipes({ limit: 500, hardRules: [] })).length).toBe(allActive);
  });

  it('removes nothing when the only rule is switched off', async () => {
    const off = { ...rule({ kind: 'max_minutes', value: '30' }), enabled: false };
    expect((await listRecipes({ limit: 500, hardRules: [off] })).length).toBe(allActive);
  });

  it('hides recipes over the time limit', async () => {
    const rows = await listRecipes({ limit: 500, hardRules: [rule({ kind: 'max_minutes', value: '60' })] });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(allActive);
    for (const row of rows) {
      expect(row.totalMinutes === null || row.totalMinutes <= 60).toBe(true);
    }
  });

  it('keeps a recipe whose time is unknown', async () => {
    // Missing data is not a preference. If Phase 2 could not derive a time, a
    // time rule has said nothing about that recipe.
    const [{ n }] = (await db.execute(sql`
      select count(*)::int as n from recipes where status = 'active' and total_minutes is null
    `)) as unknown as { n: number }[];

    const rows = await listRecipes({ limit: 500, hardRules: [rule({ kind: 'max_minutes', value: '30' })] });
    expect(rows.filter((r) => r.totalMinutes === null).length).toBe(n);
  });

  it('hides an excluded category and keeps every other one', async () => {
    const rows = await listRecipes({
      limit: 500,
      hardRules: [rule({ kind: 'exclude_category', value: 'Soup' })],
    });

    expect(rows.some((r) => r.category === 'Soup')).toBe(false);
    expect(rows.some((r) => r.category === 'Chicken')).toBe(true);
  });

  it('hides an excluded tag without touching recipes that lack it', async () => {
    const tagged = await listRecipes({ limit: 500 });
    const withTag = tagged.filter((r) => r.tags.includes('One pot')).length;
    expect(withTag).toBeGreaterThan(0);

    const rows = await listRecipes({
      limit: 500,
      hardRules: [rule({ kind: 'exclude_tag', value: 'One pot' })],
    });
    expect(rows.length).toBe(allActive - withTag);
    expect(rows.some((r) => r.tags.includes('One pot'))).toBe(false);
  });

  it('applies two rules together, not just the first', async () => {
    const rows = await listRecipes({
      limit: 500,
      hardRules: [
        rule({ kind: 'max_minutes', value: '60' }),
        rule({ kind: 'exclude_category', value: 'Soup' }),
      ],
    });

    for (const row of rows) {
      expect(row.totalMinutes === null || row.totalMinutes <= 60).toBe(true);
      expect(row.category).not.toBe('Soup');
    }
  });

  it('ignores a rule whose value is not a number', async () => {
    const broken = { ...rule({ kind: 'max_minutes', value: 'sixty' }) };
    expect((await listRecipes({ limit: 500, hardRules: [broken] })).length).toBe(allActive);
  });
});

describe('the switch', () => {
  async function seed(userId: string, rules: HardRule[]): Promise<void> {
    await db.execute(sql`
      insert into user_preferences (user_id, hard_rules)
      values (${userId}::uuid, ${JSON.stringify(rules)}::jsonb)
    `);
  }

  it('turns a rule off and answers with the whole list', async () => {
    const userId = await scratchUser('off');
    userIds.push(userId);
    const soup = rule({ kind: 'exclude_category', value: 'Soup' });
    const time = rule({ kind: 'max_minutes', value: '60' });
    await seed(userId, [soup, time]);

    const result = await setHardRuleEnabled(userId, soup.id, false);
    expect(result.result).toBe('ok');
    if (result.result !== 'ok') return;

    expect(result.rules).toHaveLength(2);
    expect(result.rules.find((r) => r.id === soup.id)?.enabled).toBe(false);
    expect(result.rules.find((r) => r.id === time.id)?.enabled).toBe(true);
  });

  it('stops filtering as soon as it is switched off', async () => {
    const userId = await scratchUser('unfilter');
    userIds.push(userId);
    const soup = rule({ kind: 'exclude_category', value: 'Soup' });
    await seed(userId, [soup]);

    const before = await getUserPreferences(userId);
    expect((await listRecipes({ limit: 500, hardRules: before.rules })).some((r) => r.category === 'Soup')).toBe(false);

    await setHardRuleEnabled(userId, soup.id, false);

    const after = await getUserPreferences(userId);
    expect((await listRecipes({ limit: 500, hardRules: after.rules })).some((r) => r.category === 'Soup')).toBe(true);
  });

  it('turns one back on again', async () => {
    const userId = await scratchUser('backon');
    userIds.push(userId);
    const soup = { ...rule({ kind: 'exclude_category', value: 'Soup' }), enabled: false };
    await seed(userId, [soup]);

    const result = await setHardRuleEnabled(userId, soup.id, true);
    expect(result.result === 'ok' && result.rules[0]?.enabled).toBe(true);
  });

  it('reports an id the reader does not have rather than no-opping', async () => {
    const userId = await scratchUser('unknown');
    userIds.push(userId);
    await seed(userId, [rule({ kind: 'exclude_category', value: 'Soup' })]);

    expect(await setHardRuleEnabled(userId, 'max_minutes:999', false)).toEqual({
      result: 'unknown-rule',
    });
  });

  it('cannot flip the rule of another reader', async () => {
    const alice = await scratchUser('alice');
    const bob = await scratchUser('bob');
    userIds.push(alice, bob);

    const soup = rule({ kind: 'exclude_category', value: 'Soup' });
    await seed(alice, [soup]);

    // Bob has no rules at all, so Alice's id is unknown to him.
    expect(await setHardRuleEnabled(bob, soup.id, false)).toEqual({ result: 'unknown-rule' });
    expect((await getUserPreferences(alice)).rules[0]?.enabled).toBe(true);
  });

  it('leaves the profile column alone', async () => {
    const userId = await scratchUser('profile');
    userIds.push(userId);
    const soup = rule({ kind: 'exclude_category', value: 'Soup' });
    await db.execute(sql`
      insert into user_preferences (user_id, hard_rules, profile)
      values (${userId}::uuid, ${JSON.stringify([soup])}::jsonb, ${'"likes sheet-pan dinners"'}::jsonb)
    `);

    await setHardRuleEnabled(userId, soup.id, false);

    expect((await getUserPreferences(userId)).profile).toBe('likes sheet-pan dinners');
  });
});

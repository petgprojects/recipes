/**
 * Phase 7 steps 2 and 3 against the real database.
 *
 * The provider is faked here on purpose — `llm-personalization-tasks.test.ts`
 * covers the prompt boundary and `packages/shared/test/personalization.test.ts`
 * covers the judgement. What is left, and what only a database can show, is
 * that the history query, the cold-start gate, the two-writers-one-row upsert
 * and the score table behave as the rest of the code assumes.
 *
 * Every user is a scratch user dropped afterwards; `cook_logs`,
 * `user_preferences` and `recipe_scores` all cascade from `users`. Requires the
 * Compose database and `DATABASE_URL`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { MIN_RATED_RECIPES_FOR_SCORING } from '@recipes/shared/personalization';
import type {
  StructuredOutputCallOptions,
  StructuredOutputClient,
  StructuredOutputTask,
} from '../src/llm';
import { beginEnrichmentRun } from '../src/enrichment';
import { deriveProfileForUser, loadCookHistory } from '../src/personalization/profile';
import {
  loadRecipesToScore,
  saveRecipeScores,
  scoreRecipesForUser,
} from '../src/personalization/scoring';
import { runPersonalizationForUser } from '../src/personalization/runtime';

interface RecipeRow {
  id: string;
  title: string;
}

let corpus: RecipeRow[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  corpus = (await db.execute(sql`
    select id::text as id, title from recipes where status = 'active' order by id limit 30
  `)) as unknown as RecipeRow[];
});

afterEach(async () => {
  while (userIds.length > 0) {
    await db.execute(sql`delete from users where id = ${userIds.pop()!}::uuid`);
  }
});

async function scratchUser(label: string): Promise<string> {
  const email = `profile-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  userIds.push(row!.id);
  return row!.id;
}

async function logCook(
  userId: string,
  recipeId: string,
  rating: number,
  options: { aspects?: string[]; notes?: string; cookedAt?: string } = {},
): Promise<void> {
  // `sql` expands a JS array into a parameter *list*, which is not an array
  // literal — hence the explicit `{…}` text.
  const aspects = `{${(options.aspects ?? []).join(',')}}`;
  await db.execute(sql`
    insert into cook_logs (user_id, recipe_id, rating, aspects, notes, cooked_at)
    values (
      ${userId}::uuid,
      ${recipeId}::uuid,
      ${rating},
      ${aspects}::text[],
      ${options.notes ?? null},
      coalesce(${options.cookedAt ?? null}::timestamptz, now())
    )
  `);
}

/** Enough distinct rated recipes to clear the cold-start floor. */
async function ratedHistory(userId: string, rating = 4): Promise<void> {
  for (const recipe of corpus.slice(0, MIN_RATED_RECIPES_FOR_SCORING)) {
    await logCook(userId, recipe.id, rating);
  }
}

describe('loadCookHistory', () => {
  it('is empty for a reader who has cooked nothing', async () => {
    const userId = await scratchUser('empty');
    await expect(loadCookHistory(userId)).resolves.toEqual({ ratedRecipes: 0, logs: [] });
  });

  it('counts distinct recipes, not cook logs', async () => {
    // Someone who cooked one chili five times has told us one thing about
    // themselves, five times. The cold-start floor must not be cleared by it.
    const userId = await scratchUser('repeat');
    for (let i = 0; i < MIN_RATED_RECIPES_FOR_SCORING; i += 1) {
      await logCook(userId, corpus[0]!.id, 5);
    }

    const history = await loadCookHistory(userId);
    expect(history.ratedRecipes).toBe(1);
    expect(history.logs).toHaveLength(MIN_RATED_RECIPES_FOR_SCORING);
  });

  it('returns the most recent cooks first, with the fields the prompt needs', async () => {
    const userId = await scratchUser('recent');
    await logCook(userId, corpus[0]!.id, 2, {
      cookedAt: '2020-01-01T00:00:00Z',
      aspects: ['bland'],
      notes: 'needed salt',
    });
    await logCook(userId, corpus[1]!.id, 5, { cookedAt: '2026-01-01T00:00:00Z' });

    const history = await loadCookHistory(userId);
    expect(history.logs.map((log) => log.rating)).toEqual([5, 2]);
    expect(history.logs[1]).toMatchObject({
      title: corpus[0]!.title,
      rating: 2,
      aspects: ['bland'],
      notes: 'needed salt',
    });
  });
});

describe('deriveProfileForUser', () => {
  it('makes no provider call below the cold-start floor and writes nothing', async () => {
    const userId = await scratchUser('cold');
    for (const recipe of corpus.slice(0, MIN_RATED_RECIPES_FOR_SCORING - 1)) {
      await logCook(userId, recipe.id, 1);
    }
    const fake = fakeClient([]);

    const result = await deriveProfileForUser({ client: fake.client, userId });
    expect(result.status).toBe('cold-start');
    expect(fake.calls).toEqual([]);
    expect(await storedProfile(userId)).toBeUndefined();
  });

  it('writes the profile once the floor is cleared', async () => {
    const userId = await scratchUser('warm');
    await ratedHistory(userId);
    const fake = fakeClient([{ profile: 'Likes fast sheet-pan dinners.' }]);

    const result = await deriveProfileForUser({ client: fake.client, userId });
    expect(result).toMatchObject({
      status: 'written',
      profile: 'Likes fast sheet-pan dinners.',
      changed: true,
    });
    expect(await storedProfile(userId)).toBe('Likes fast sheet-pan dinners.');
  });

  it('reports an unchanged profile as unchanged, so scores are not thrown away', async () => {
    const userId = await scratchUser('same');
    await ratedHistory(userId);
    const fake = fakeClient([{ profile: 'Likes soup.' }, { profile: 'Likes soup.' }]);

    await deriveProfileForUser({ client: fake.client, userId });
    const second = await deriveProfileForUser({ client: fake.client, userId });
    expect(second).toMatchObject({ status: 'written', changed: false });
  });

  it('does not touch the hard_rules column that step 1 owns', async () => {
    // The mirror of the step-1 suite's `profile` test. Three writers share this
    // row and each owns one column.
    const userId = await scratchUser('rules');
    await ratedHistory(userId);
    await db.execute(sql`
      insert into user_preferences (user_id, hard_rules)
      values (${userId}::uuid, ${JSON.stringify([
        {
          id: 'max_minutes:60',
          kind: 'max_minutes',
          value: '60',
          enabled: false,
          observations: 6,
          medianRating: 2,
        },
      ])}::jsonb)
    `);

    await deriveProfileForUser({
      client: fakeClient([{ profile: 'Likes soup.' }]).client,
      userId,
    });

    const [row] = (await db.execute(sql`
      select hard_rules, profile from user_preferences where user_id = ${userId}::uuid
    `)) as unknown as { hard_rules: { id: string; enabled: boolean }[]; profile: unknown }[];
    expect(row!.hard_rules).toHaveLength(1);
    expect(row!.hard_rules[0]).toMatchObject({ id: 'max_minutes:60', enabled: false });
    expect(row!.profile).toBe('Likes soup.');
  });
});

describe('scoring', () => {
  it('offers only unscored recipes by default, and everything on a refresh', async () => {
    const userId = await scratchUser('unscored');
    await saveRecipeScores(userId, [
      { recipeId: corpus[0]!.id, score: 90, reason: 'already scored' },
    ]);

    const unscored = await loadRecipesToScore(userId, { limit: 400 });
    expect(unscored.some((row) => row.id === corpus[0]!.id)).toBe(false);

    const all = await loadRecipesToScore(userId, { refreshAll: true, limit: 400 });
    expect(all.some((row) => row.id === corpus[0]!.id)).toBe(true);
  });

  it('overwrites a score in place rather than inserting a second row', async () => {
    const userId = await scratchUser('upsert');
    await saveRecipeScores(userId, [{ recipeId: corpus[0]!.id, score: 10, reason: 'first' }]);
    await saveRecipeScores(userId, [{ recipeId: corpus[0]!.id, score: 80, reason: 'second' }]);

    const rows = (await db.execute(sql`
      select score, reason from recipe_scores where user_id = ${userId}::uuid
    `)) as unknown as { score: number; reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: 80, reason: 'second' });
  });

  it('scores a batch end to end, mapping refs back onto recipe ids', async () => {
    const userId = await scratchUser('batch');
    const fake = fakeClient([
      {
        scores: [
          { ref: 1, score: 91, reason: 'Sheet-pan, which you rate highly' },
          { ref: 2, score: 22, reason: 'A long braise' },
          { ref: 3, score: 50, reason: 'Nothing in your profile applies' },
        ],
      },
    ]);

    const result = await scoreRecipesForUser({
      client: fake.client,
      userId,
      profile: 'Likes fast sheet-pan dinners.',
      limit: 3,
    });
    expect(result).toMatchObject({ considered: 3, scored: 3, batches: 1 });

    // Which three recipes the run picked is whatever was newest at that
    // instant, so the assertion is against the batch the model was actually
    // shown rather than a second query — another suite inserting a recipe
    // mid-run must not be able to fail this.
    const sent = JSON.parse(
      between(fake.calls[0]!.userPrompt, '<scoring_data>', '</scoring_data>'),
    ) as { recipes: { ref: number; title: string }[] };
    const titleByRef = new Map(sent.recipes.map((recipe) => [recipe.ref, recipe.title]));

    const rows = (await db.execute(sql`
      select s.score, s.reason, r.title
      from recipe_scores s join recipes r on r.id = s.recipe_id
      where s.user_id = ${userId}::uuid
      order by s.score desc
    `)) as unknown as { score: number; reason: string; title: string }[];

    // ref 1 → 91, ref 3 → 50, ref 2 → 22: the ids follow the refs, not the
    // order the response happened to arrive in.
    expect(rows.map((row) => normalize(row.title))).toEqual([
      titleByRef.get(1),
      titleByRef.get(3),
      titleByRef.get(2),
    ]);
    expect(rows[0]!.reason).toBe('Sheet-pan, which you rate highly');
  });

  it('leaves a recipe unscored when the response skips it, instead of guessing', async () => {
    const userId = await scratchUser('short');
    const fake = fakeClient([{ scores: [{ ref: 1, score: 70, reason: 'ok' }] }]);

    const result = await scoreRecipesForUser({
      client: fake.client,
      userId,
      profile: 'Likes soup.',
      limit: 3,
    });
    // Three were offered and one came back: the other two keep no row at all,
    // so the next run picks them up.
    expect(result).toMatchObject({ considered: 3, scored: 1 });
    const [counted] = (await db.execute(sql`
      select count(*)::int as n from recipe_scores where user_id = ${userId}::uuid
    `)) as unknown as { n: number }[];
    expect(counted!.n).toBe(1);
  });
});

describe('runPersonalizationForUser', () => {
  it('derives hard rules even for a reader too cold to score', async () => {
    // Rules are free and must keep being re-derived; the model half is what the
    // floor gates.
    const userId = await scratchUser('cold-pass');
    await logCook(userId, corpus[0]!.id, 1);
    const fake = fakeClient([]);

    const summary = await runPersonalizationForUser({
      client: fake.client,
      userId,
      dailyBudgetUsd: 1,
      runId: await beginEnrichmentRun(db),
    });

    expect(summary).toMatchObject({ profile: 'cold-start', scored: 0, batches: 0 });
    expect(fake.calls).toEqual([]);
    const [row] = (await db.execute(sql`
      select hard_rules from user_preferences where user_id = ${userId}::uuid
    `)) as unknown as { hard_rules: unknown }[];
    expect(row!.hard_rules).toEqual([]);
  });
});

async function storedProfile(userId: string): Promise<unknown> {
  const [row] = (await db.execute(sql`
    select profile from user_preferences where user_id = ${userId}::uuid
  `)) as unknown as { profile: unknown }[];
  return row?.profile;
}

function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not find ${start}...${end}`);
  return value.slice(from + start.length, to);
}

/** The same collapsing the prompt's fact serializer applies to a title. */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fakeClient(outputs: unknown[]): {
  readonly client: StructuredOutputClient;
  readonly calls: StructuredOutputTask<unknown>[];
} {
  const remaining = [...outputs];
  const calls: StructuredOutputTask<unknown>[] = [];
  return {
    calls,
    client: {
      async complete<T>(
        task: StructuredOutputTask<T>,
        _options?: StructuredOutputCallOptions,
      ): Promise<T> {
        calls.push(task as StructuredOutputTask<unknown>);
        if (remaining.length === 0) throw new Error('fake LLM output queue exhausted');
        return remaining.shift() as T;
      },
    },
  };
}

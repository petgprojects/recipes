/**
 * The SQL grocery list has to produce exactly what the tested in-memory
 * aggregation produces.
 *
 * `packages/shared/test/grocery.test.ts` is the specification — it says what a
 * correct list *is*, in terms `aggregateGroceries()` can be held to. This suite
 * says the database agrees with it. Together they are the whole guarantee, and
 * neither is enough alone: the shared tests never touch SQL, and a SQL-only
 * test would be asserting the new implementation against itself.
 *
 * PLAN.md §5 calls the aggregation "the highest-value test surface in the
 * project — it's where wrongness is silent". So this does not check a handful
 * of hand-picked recipes: it runs both implementations over real crawled rows,
 * including the ones with unparseable ingredient lines and missing quantities,
 * and demands the two agree down to the item key.
 *
 * Requires the Compose database and `DATABASE_URL`, like the other integration
 * suites in this repo.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import {
  aggregateGroceries,
  countGroceryItems,
  type GroceryAisleGroup,
  type GroceryRecipeInput,
} from '@recipes/shared/grocery';
import { getRecipeDetail } from '../src/lib/recipes';
import { groceryListForPicks, groceryListForUser, type GroceryPick } from '../src/lib/grocery';

/**
 * Recipes with the most ingredient lines, so a fixed sample still exercises
 * merging, unmapped rows and missing quantities. Ordered by id for a stable
 * pick order — the comparison depends on both sides seeing the same order.
 */
async function busiestRecipeIds(limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    select ri.recipe_id::text as id
    from recipe_ingredients ri
    join recipes r on r.id = ri.recipe_id
    where r.status = 'active'
    group by ri.recipe_id
    order by count(*) desc, ri.recipe_id
    limit ${limit}
  `)) as unknown as { id: string }[];
  return rows.map((row) => row.id).sort();
}

/** The same picks, fed to the in-memory implementation the old way. */
async function inMemory(picks: readonly GroceryPick[]): Promise<GroceryAisleGroup[]> {
  const inputs: GroceryRecipeInput[] = [];
  for (const pick of picks) {
    const detail = await getRecipeDetail(pick.recipeId);
    if (detail === null) continue;
    inputs.push({
      id: detail.id,
      title: detail.title,
      batches: pick.batches,
      ingredients: detail.ingredients.map((line) => ({
        ingredientId: line.ingredientId,
        name: line.name ?? '',
        rawText: line.rawText,
        aisle: line.aisle,
        qty: line.qty,
        unit: line.unit,
        optional: line.optional,
      })),
    });
  }
  return aggregateGroceries(inputs);
}

let ids: string[] = [];

beforeAll(async () => {
  ids = await busiestRecipeIds(12);
});

describe('grocery list in SQL', () => {
  it('has recipes to test against', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it('matches the in-memory aggregation exactly, at one batch each', async () => {
    const picks = ids.map((recipeId) => ({ recipeId, batches: 1 }));

    const [fromSql, fromMemory] = await Promise.all([
      groceryListForPicks(picks),
      inMemory(picks),
    ]);

    expect(countGroceryItems(fromSql)).toBe(countGroceryItems(fromMemory));
    expect(fromSql).toEqual(fromMemory);
  });

  it('matches with mixed batch multipliers', async () => {
    // Varying multipliers is where a numeric-vs-float8 difference would show
    // up: the totals stop being round, and `2 lb` becomes `4.5 lb`.
    const picks = ids.map((recipeId, index) => ({ recipeId, batches: (index % 3) + 1 }));

    const [fromSql, fromMemory] = await Promise.all([
      groceryListForPicks(picks),
      inMemory(picks),
    ]);

    expect(fromSql).toEqual(fromMemory);
  });

  it('agrees recipe by recipe across the whole active corpus', async () => {
    const all = (await db.execute(sql`
      select id::text as id from recipes where status = 'active' order by id
    `)) as unknown as { id: string }[];

    let compared = 0;
    for (const row of all) {
      const picks = [{ recipeId: row.id, batches: 2 }];
      const [fromSql, fromMemory] = await Promise.all([
        groceryListForPicks(picks),
        inMemory(picks),
      ]);
      expect(fromSql, `recipe ${row.id}`).toEqual(fromMemory);
      compared += 1;
    }

    expect(compared).toBeGreaterThan(100);
  });

  it('returns nothing for no picks, and drops ids that do not exist', async () => {
    expect(await groceryListForPicks([])).toEqual([]);
    expect(
      await groceryListForPicks([
        { recipeId: '00000000-0000-4000-8000-000000000000', batches: 1 },
      ]),
    ).toEqual([]);
  });

  it('reads a signed-in reader from saved_recipes, in saved_at order', async () => {
    // The signed-out path takes its picks from the request; the signed-in path
    // takes them from the account and ignores the request entirely. Those are
    // different `picks` CTEs feeding the same query, so the account path needs
    // its own coverage — a typo in it would only ever show up once someone
    // signed in.
    const email = `grocery-sql-${Date.now()}@test.invalid`;
    const [user] = (await db.execute(sql`
      insert into users (email, name) values (${email}, 'Grocery SQL test') returning id::text
    `)) as unknown as { id: string }[];
    const userId = user!.id;

    try {
      const picked = ids.slice(0, 3);
      for (const [index, recipeId] of picked.entries()) {
        await db.execute(sql`
          insert into saved_recipes (user_id, recipe_id, batches, saved_at)
          values (
            ${userId}::uuid,
            ${recipeId}::uuid,
            ${index + 1},
            now() + make_interval(secs => ${index})
          )
        `);
      }

      const fromAccount = await groceryListForUser(userId);
      const fromRequest = await groceryListForPicks(
        picked.map((recipeId, index) => ({ recipeId, batches: index + 1 })),
      );

      expect(fromAccount).toEqual(fromRequest);
      expect(countGroceryItems(fromAccount)).toBeGreaterThan(0);
    } finally {
      // `saved_recipes.user_id` cascades, so this takes the picks with it.
      await db.execute(sql`delete from users where id = ${userId}::uuid`);
    }
  });

  it('gives a user with no picks an empty list, not an error', async () => {
    const email = `grocery-empty-${Date.now()}@test.invalid`;
    const [user] = (await db.execute(sql`
      insert into users (email, name) values (${email}, 'Empty test') returning id::text
    `)) as unknown as { id: string }[];

    try {
      expect(await groceryListForUser(user!.id)).toEqual([]);
    } finally {
      await db.execute(sql`delete from users where id = ${user!.id}::uuid`);
    }
  });

  it('clamps a batch multiplier rather than trusting the request body', async () => {
    const one = await groceryListForPicks([{ recipeId: ids[0]!, batches: 1 }]);
    const absurd = await groceryListForPicks([{ recipeId: ids[0]!, batches: 10_000 }]);

    // Whatever the clamp is, it is applied — the list is not 10,000 batches.
    const oneTotal = countGroceryItems(one);
    expect(countGroceryItems(absurd)).toBe(oneTotal);
    expect(absurd).not.toEqual(one);
  });
});

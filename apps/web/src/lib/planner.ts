/**
 * `saved_recipes` and `grocery_checks`, server-side.
 *
 * The counterpart to `@recipes/shared/planner`: that module owns the shapes and
 * the merge semantics and is pure, this one owns the SQL. Same split as
 * `@recipes/shared/grocery` and `lib/recipes.ts` — the rules are testable
 * without a database, the queries live next to the app that runs them.
 *
 * Everything here takes an explicit `userId`. None of it reaches for the
 * session: the route handler resolves the user once via `getCurrentUser()` and
 * passes it down, so there is exactly one place where "who is this" is decided.
 */

import { and, db, eq, groceryChecks, inArray, recipes, savedRecipes } from '@recipes/db';
import {
  clampBatches,
  plannerAdditions,
  type PlannerImport,
  type PlannerState,
} from '@recipes/shared/planner';

export async function readPlannerState(userId: string): Promise<PlannerState> {
  const [savedRows, checkedRows] = await Promise.all([
    db
      .select({ recipeId: savedRecipes.recipeId, batches: savedRecipes.batches })
      .from(savedRecipes)
      .where(eq(savedRecipes.userId, userId)),
    db
      .select({ itemKey: groceryChecks.itemKey })
      .from(groceryChecks)
      .where(eq(groceryChecks.userId, userId)),
  ]);

  return {
    saved: Object.fromEntries(savedRows.map((row) => [row.recipeId, row.batches])),
    checked: Object.fromEntries(checkedRows.map((row) => [row.itemKey, true as const])),
  };
}

/**
 * Filter a set of recipe ids down to the ones that still exist.
 *
 * `saved_recipes.recipe_id` is a foreign key, so a pick made against a recipe
 * that has since been deleted would abort the whole insert. That is the wrong
 * failure: the reader's other picks are fine and should still land.
 */
async function existingRecipeIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(inArray(recipes.id, [...ids]));

  return new Set(rows.map((row) => row.id));
}

export type SetSavedResult = 'saved' | 'removed' | 'unknown-recipe';

/**
 * Pick a recipe, change its batch count, or unpick it (`batches === null`).
 *
 * One entry point for all three because the client's `toggleSaved` and
 * `setBatches` are the same row from the database's point of view, and keeping
 * them together means the upsert semantics are written once.
 */
export async function setSavedRecipe(
  userId: string,
  recipeId: string,
  batches: number | null,
): Promise<SetSavedResult> {
  if (batches === null) {
    await db
      .delete(savedRecipes)
      .where(and(eq(savedRecipes.userId, userId), eq(savedRecipes.recipeId, recipeId)));
    return 'removed';
  }

  const known = await existingRecipeIds([recipeId]);
  if (!known.has(recipeId)) return 'unknown-recipe';

  await db
    .insert(savedRecipes)
    .values({ userId, recipeId, batches: clampBatches(batches) })
    .onConflictDoUpdate({
      target: [savedRecipes.userId, savedRecipes.recipeId],
      // `saved_at` deliberately stays put: bumping it on every stepper click
      // would reorder the picks list under someone adjusting a batch count.
      set: { batches: clampBatches(batches) },
    });

  return 'saved';
}

export async function clearSavedRecipes(userId: string): Promise<void> {
  await db.delete(savedRecipes).where(eq(savedRecipes.userId, userId));
}

export async function setGroceryCheck(
  userId: string,
  itemKey: string,
  checked: boolean,
): Promise<void> {
  if (!checked) {
    await db
      .delete(groceryChecks)
      .where(and(eq(groceryChecks.userId, userId), eq(groceryChecks.itemKey, itemKey)));
    return;
  }

  // No foreign key to validate against — `item_key` is a free string precisely
  // so it survives an ingredient being merged away (PLAN.md §4).
  await db.insert(groceryChecks).values({ userId, itemKey }).onConflictDoNothing({
    target: [groceryChecks.userId, groceryChecks.itemKey],
  });
}

export async function clearGroceryChecks(userId: string): Promise<void> {
  await db.delete(groceryChecks).where(eq(groceryChecks.userId, userId));
}

export interface ImportResult {
  /** Picks written — zero on a re-run, which is the expected case. */
  savedAdded: number;
  /** Check-offs written. Counted apart from picks so the UI can name them. */
  checkedAdded: number;
  /** Picks dropped because the recipe no longer exists. */
  skipped: number;
  state: PlannerState;
}

/**
 * The one-time first-sign-in migration (PLAN.md §5, Phase 4).
 *
 * Additive and idempotent: {@link plannerAdditions} decides what is genuinely
 * new, and `ON CONFLICT DO NOTHING` covers the case where two tabs sign in at
 * once and both decide the same row is new.
 */
export async function importPlannerState(
  userId: string,
  local: PlannerImport,
): Promise<ImportResult> {
  const before = await readPlannerState(userId);
  const additions = plannerAdditions(before, local);

  const wantedRecipeIds = Object.keys(additions.saved);
  const known = await existingRecipeIds(wantedRecipeIds);
  const savedValues = wantedRecipeIds
    .filter((recipeId) => known.has(recipeId))
    .map((recipeId) => ({ userId, recipeId, batches: additions.saved[recipeId]! }));

  const checkedValues = Object.keys(additions.checked).map((itemKey) => ({ userId, itemKey }));

  if (savedValues.length > 0 || checkedValues.length > 0) {
    await db.transaction(async (tx) => {
      if (savedValues.length > 0) {
        await tx.insert(savedRecipes).values(savedValues).onConflictDoNothing({
          target: [savedRecipes.userId, savedRecipes.recipeId],
        });
      }
      if (checkedValues.length > 0) {
        await tx.insert(groceryChecks).values(checkedValues).onConflictDoNothing({
          target: [groceryChecks.userId, groceryChecks.itemKey],
        });
      }
    });
  }

  return {
    savedAdded: savedValues.length,
    checkedAdded: checkedValues.length,
    skipped: wantedRecipeIds.length - savedValues.length,
    state: await readPlannerState(userId),
  };
}

/**
 * `cook_logs`, server-side.
 *
 * The counterpart to `@recipes/shared/ratings`: that module owns the shape and
 * the wire schema and is pure, this one owns the SQL. Same split as
 * `@recipes/shared/planner` and `lib/planner.ts`.
 *
 * Everything here takes an explicit `userId`, resolved once by the route
 * handler via `getCurrentUser()` — rating requires an account (unlike the
 * grocery list), so there is no signed-out path to support here.
 */

import { and, cookLogs, db, desc, eq, recipes } from '@recipes/db';
import type { CookLogCreate, CookLogEntry } from '@recipes/shared/ratings';
import type { RatingAspect } from '@recipes/shared/vocab';

function toEntry(row: typeof cookLogs.$inferSelect): CookLogEntry {
  return {
    id: row.id,
    recipeId: row.recipeId,
    rating: row.rating,
    aspects: row.aspects as RatingAspect[],
    notes: row.notes,
    cookedAt: row.cookedAt.toISOString(),
  };
}

/** One reader's cook logs for one recipe, newest first. */
export async function listCookLogs(userId: string, recipeId: string): Promise<CookLogEntry[]> {
  const rows = await db
    .select()
    .from(cookLogs)
    .where(and(eq(cookLogs.userId, userId), eq(cookLogs.recipeId, recipeId)))
    .orderBy(desc(cookLogs.cookedAt));

  return rows.map(toEntry);
}

export type CreateCookLogResult = 'created' | 'unknown-recipe';

/**
 * Log a cook. `cook_logs.recipe_id` is a foreign key, so an id for a recipe
 * that no longer exists would otherwise abort with a database error rather
 * than the 400 a bad request deserves — checked explicitly first, same reason
 * `setSavedRecipe` in `lib/planner.ts` checks before it inserts.
 */
export async function createCookLog(
  userId: string,
  input: CookLogCreate,
): Promise<{ result: CreateCookLogResult; logs: CookLogEntry[] }> {
  const [recipe] = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.id, input.recipeId));

  if (recipe === undefined) return { result: 'unknown-recipe', logs: [] };

  await db.insert(cookLogs).values({
    userId,
    recipeId: input.recipeId,
    rating: input.rating,
    aspects: input.aspects,
    notes: input.notes,
  });

  return { result: 'created', logs: await listCookLogs(userId, input.recipeId) };
}

/**
 * Remove one of this reader's own cook logs (a misclicked star rating).
 * Scoped to `userId` as well as `id`, so one reader can never delete another's
 * entry by guessing an id. Silently a no-op if `id` does not belong to them —
 * same as deleting something already gone.
 */
export async function deleteCookLog(
  userId: string,
  id: string,
  recipeId: string,
): Promise<CookLogEntry[]> {
  await db.delete(cookLogs).where(and(eq(cookLogs.id, id), eq(cookLogs.userId, userId)));
  return listCookLogs(userId, recipeId);
}

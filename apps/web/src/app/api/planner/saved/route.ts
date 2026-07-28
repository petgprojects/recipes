/**
 * PATCH  /api/planner/saved  — pick, re-batch or unpick one recipe.
 * DELETE /api/planner/saved  — clear every pick ("Clear all" in the picks list).
 *
 * PATCH takes `{recipeId, batches}` in the body rather than putting the id in
 * the path, so that the check-off route next door can key on an `item_key` that
 * legitimately contains `:` and `/` without either route needing to think about
 * URL encoding. `batches: null` is the unpick.
 */

import { savedPatchSchema } from '@recipes/shared/planner';
import { clearSavedRecipes, readPlannerState, setSavedRecipe } from '@/lib/planner';
import { badRequest, jsonOk, parseBody, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PATCH(request: Request) {
  const body = await parseBody(request, savedPatchSchema);
  if ('response' in body) return body.response;

  return withUser(async (user) => {
    const result = await setSavedRecipe(user.id, body.data.recipeId, body.data.batches);
    if (result === 'unknown-recipe') {
      return badRequest(`No recipe ${body.data.recipeId}.`);
    }
    return jsonOk(await readPlannerState(user.id));
  });
}

export async function DELETE() {
  return withUser(async (user) => {
    await clearSavedRecipes(user.id);
    return jsonOk(await readPlannerState(user.id));
  });
}

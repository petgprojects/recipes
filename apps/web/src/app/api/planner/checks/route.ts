/**
 * PATCH  /api/planner/checks  — tick or untick one grocery line.
 * DELETE /api/planner/checks  — clear every tick ("Start over" on the receipt).
 *
 * `item_key` is a free string on purpose (PLAN.md §4) so it survives an
 * ingredient being merged away, which means there is nothing to validate it
 * against beyond shape and length.
 */

import { checkPatchSchema } from '@recipes/shared/planner';
import { clearGroceryChecks, readPlannerState, setGroceryCheck } from '@/lib/planner';
import { jsonOk, parseBody, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PATCH(request: Request) {
  const body = await parseBody(request, checkPatchSchema);
  if ('response' in body) return body.response;

  return withUser(async (user) => {
    await setGroceryCheck(user.id, body.data.itemKey, body.data.checked);
    return jsonOk(await readPlannerState(user.id));
  });
}

export async function DELETE() {
  return withUser(async (user) => {
    await clearGroceryChecks(user.id);
    return jsonOk(await readPlannerState(user.id));
  });
}

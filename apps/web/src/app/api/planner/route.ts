/**
 * GET /api/planner — the signed-in reader's picks and check-offs.
 *
 * Returns exactly the two shapes the client already holds in `localStorage`
 * (`{recipeId: batches}` and `{itemKey: true}`), so the planner store can swap
 * backends without the components noticing. 401 when signed out; the client
 * treats that as "use `localStorage`", not as an error.
 */

import { readPlannerState } from '@/lib/planner';
import { jsonOk, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return withUser(async (user) => {
    const state = await readPlannerState(user.id);
    return jsonOk({ user: { id: user.id, email: user.email, name: user.name, image: user.image }, ...state });
  });
}

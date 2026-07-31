/**
 * The grocery list (PLAN.md §5, Phase 5).
 *
 * `POST` rather than `GET` because a signed-out reader's picks are not on the
 * server: they live in this browser's `localStorage`, so they travel in the
 * body. Signing in does not change the request the client makes — it changes
 * which picks the server believes. An account's `saved_recipes` wins over
 * whatever the body says, the same way the sign-in migration lets the account
 * win every conflict (PROGRESS.md amendment A17); otherwise two open tabs could
 * each talk the server into a different list for the same account.
 *
 * Being signed out is not an error here, so this route does not use
 * `withUser()` — a 401 would be wrong. It resolves the user if there is one and
 * carries on if there is not.
 */

import { NextResponse } from 'next/server';
import { groceryRequestSchema } from '@recipes/shared/planner';
import { getCurrentUser } from '@/lib/current-user';
import { groceryListForPicks, groceryListForUser } from '@/lib/grocery';
import { parseBody, unavailable } from '@/lib/planner-route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const parsed = await parseBody(request, groceryRequestSchema);
  if ('response' in parsed) return parsed.response;

  try {
    const user = await getCurrentUser();
    const groups =
      user === null
        ? await groceryListForPicks(parsed.data.picks)
        : await groceryListForUser(user.id);

    return NextResponse.json(groups, { headers: { 'cache-control': 'no-store' } });
  } catch (error: unknown) {
    // A 503 rather than an empty list, for the same reason `/api/recipes`
    // does it: "nothing to buy" and "we could not read your picks" must not
    // look alike to someone about to leave for the shop.
    return unavailable(error);
  }
}

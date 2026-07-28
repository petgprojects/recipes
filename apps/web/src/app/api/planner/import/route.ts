/**
 * POST /api/planner/import — the one-time first-sign-in migration.
 *
 * PLAN.md §5, Phase 4: "One-time migration of existing `localStorage` state
 * into the account on first sign-in — don't make the user lose their picks."
 *
 * Additive and idempotent (see `plannerAdditions` in `@recipes/shared/planner`),
 * so the client is free to be pessimistic about whether it has already run.
 * The response is the full merged state plus how much actually landed, which is
 * what lets the UI say "brought over 6 picks" rather than guessing.
 */

import { plannerImportSchema } from '@recipes/shared/planner';
import { importPlannerState } from '@/lib/planner';
import { jsonOk, parseBody, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  const body = await parseBody(request, plannerImportSchema);
  if ('response' in body) return body.response;

  return withUser(async (user) => {
    const result = await importPlannerState(user.id, body.data);
    return jsonOk({
      savedAdded: result.savedAdded,
      checkedAdded: result.checkedAdded,
      skipped: result.skipped,
      saved: result.state.saved,
      checked: result.state.checked,
    });
  });
}

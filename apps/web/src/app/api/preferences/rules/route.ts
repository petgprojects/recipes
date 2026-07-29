/**
 * GET   /api/preferences/rules — the reader's hard rules, enabled or not.
 * PATCH /api/preferences/rules — flip one rule's switch.
 *
 * PLAN.md §5: "Show the active rules in the UI with a switch to disable each
 * one — a filter you can't see is indistinguishable from a bug." This is the
 * endpoint behind that switch.
 *
 * Rules exist only for an account, so both verbs are `withUser()`-wrapped and
 * answer 401 signed out — there is nothing to show a signed-out reader, whose
 * browse feed is unfiltered by definition. Same shape as the planner and
 * ratings routes: **every response is the complete rule list**, not just the
 * rule touched, so the client's cache update is one `setQueryData` regardless
 * of which verb produced it.
 */

import { hardRuleToggleSchema } from '@recipes/shared/personalization';
import { badRequest, jsonOk, parseBody, withUser } from '@/lib/planner-route';
import { getUserPreferences, setHardRuleEnabled } from '@/lib/preferences';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return withUser(async (user) => jsonOk((await getUserPreferences(user.id)).rules));
}

export async function PATCH(request: Request) {
  const body = await parseBody(request, hardRuleToggleSchema);
  if ('response' in body) return body.response;

  return withUser(async (user) => {
    const result = await setHardRuleEnabled(user.id, body.data.ruleId, body.data.enabled);
    // A 404 rather than a silent no-op: the switch manipulates something the
    // reader can see, so a request that changed nothing means the page is stale
    // and the client should refetch rather than render a lie.
    if (result.result === 'unknown-rule') return badRequest(`No rule ${body.data.ruleId}.`);
    return jsonOk(result.rules);
  });
}

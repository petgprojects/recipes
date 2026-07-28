/**
 * GET  /api/ratings?recipeId=<uuid> — the signed-in reader's cook logs for one
 *      recipe, newest first.
 * POST /api/ratings — log a cook: a star rating, aspect tags and a note.
 *
 * Phase 6 (PLAN.md §5, HANDOFF.md): unlike the grocery list, rating something
 * genuinely requires an account — there is no signed-out draft to reconcile on
 * a later sign-in, so 401 is the right answer here rather than a localStorage
 * fallback.
 */

import { cookLogCreateSchema, recipeIdQuerySchema } from '@recipes/shared/ratings';
import { createCookLog, listCookLogs } from '@/lib/ratings';
import { badRequest, jsonOk, parseBody, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const parsed = recipeIdQuerySchema.safeParse(new URL(request.url).searchParams.get('recipeId'));
  if (!parsed.success) return badRequest('Expected a `recipeId` query param.');

  return withUser(async (user) => jsonOk(await listCookLogs(user.id, parsed.data)));
}

export async function POST(request: Request) {
  const body = await parseBody(request, cookLogCreateSchema);
  if ('response' in body) return body.response;

  return withUser(async (user) => {
    const { result, logs } = await createCookLog(user.id, body.data);
    if (result === 'unknown-recipe') return badRequest(`No recipe ${body.data.recipeId}.`);
    return jsonOk(logs);
  });
}

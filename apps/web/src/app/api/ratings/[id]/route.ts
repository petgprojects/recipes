/**
 * DELETE /api/ratings/:id?recipeId=<uuid> — remove one misentered cook log.
 *
 * `recipeId` travels as a query param, not read back off the deleted row, so
 * this can answer with the same "whole list for this recipe" shape GET and
 * POST already do — the client updates one cache entry no matter which of the
 * three requests came back. The delete itself is scoped to `id` and the
 * signed-in user in `lib/ratings.ts`; an `id` that isn't theirs matches no row
 * and this responds exactly as it would for one already gone.
 */

import { recipeIdQuerySchema } from '@recipes/shared/ratings';
import { deleteCookLog } from '@/lib/ratings';
import { badRequest, jsonOk, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = recipeIdQuerySchema.safeParse(new URL(request.url).searchParams.get('recipeId'));
  if (!parsed.success) return badRequest('Expected a `recipeId` query param.');

  return withUser(async (user) => jsonOk(await deleteCookLog(user.id, id, parsed.data)));
}

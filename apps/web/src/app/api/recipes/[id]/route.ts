/**
 * GET /api/recipes/:id — one recipe with its steps and ingredient lines.
 *
 * The detail sheet and the grocery list both need ingredients, and the browse
 * feed deliberately does not carry them: 235 recipes × ~20 lines is a payload
 * nobody should poll every five minutes. The client fetches this per recipe it
 * actually opens or saves, and TanStack Query caches the result, so opening the
 * same sheet twice costs one request.
 *
 * `?status=all` exists for `/ops`-style inspection of a rejected or pending
 * row. Browse clients get active rows only.
 */

import { NextResponse } from 'next/server';
import { RECIPE_STATUS } from '@recipes/shared';
import { getRecipeDetail, isRecipeStatus } from '@/lib/recipes';
import type { RecipeStatus } from '@recipes/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: `Invalid recipe id: ${id}` }, { status: 400 });
  }

  let status: RecipeStatus | null = 'active';
  const statusRaw = new URL(request.url).searchParams.get('status');
  if (statusRaw !== null && statusRaw !== '') {
    if (statusRaw === 'all') status = null;
    else if (isRecipeStatus(statusRaw)) status = statusRaw;
    else {
      return NextResponse.json(
        {
          error: `Invalid \`status\`: ${statusRaw}. Expected one of ${RECIPE_STATUS.join(', ')} or "all".`,
        },
        { status: 400 },
      );
    }
  }

  try {
    const recipe = await getRecipeDetail(id, { status });
    if (recipe === null) {
      return NextResponse.json(
        { error: 'Recipe not found' },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      );
    }
    return NextResponse.json(recipe, { headers: { 'cache-control': 'no-store' } });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

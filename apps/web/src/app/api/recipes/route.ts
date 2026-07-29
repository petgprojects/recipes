/**
 * GET /api/recipes — the browse feed.
 *
 * Query parameters:
 *
 *   ?limit=<1..500>         page size, default 50. The planner asks for the
 *                           full active set and filters categories client-side,
 *                           exactly as the artifact did.
 *   ?status=<...|all>       defaults to `active`. Pending rows are unfinished
 *                           Phase 2 work; rejected rows stay auditable without
 *                           entering the feed.
 *   ?since=<ISO timestamp>  rows whose `last_seen_at` is strictly newer.
 *
 * **`since` is not what the "N new recipes" pill uses**, and it is worth being
 * explicit about why (PROGRESS.md amendment A13). `last_seen_at` is bumped for
 * every recipe a re-crawl re-observes, so a poll anchored to it reports the
 * whole corpus as new the moment a scan finishes; and Phase 2 publishes a
 * pending row as `active` without touching the column, so a genuinely new
 * recipe can arrive with a timestamp *behind* the client's watermark. The
 * client therefore diffs recipe ids, which is correct under both. The
 * parameter stays because "what changed since X" is still the right question
 * for any other consumer.
 *
 * The response omits `raw_jsonld`, the content hash, the HTTP validators and
 * the instruction steps — see `lib/recipes.ts`.
 *
 * A bad parameter is a 400 with a reason rather than a silently ignored filter.
 */

import { NextResponse } from 'next/server';
import { RECIPE_STATUS } from '@recipes/shared';
import { getCurrentUser } from '@/lib/current-user';
import { getUserPreferences } from '@/lib/preferences';
import {
  DEFAULT_RECIPE_LIMIT,
  MAX_RECIPE_LIMIT,
  isRecipeStatus,
  listRecipes,
  type ListRecipesOptions,
} from '@/lib/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const options: ListRecipesOptions = {};

  // ── since ────────────────────────────────────────────────────────────────
  const sinceRaw = params.get('since');
  if (sinceRaw !== null && sinceRaw !== '') {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return badRequest(`Invalid \`since\`: ${sinceRaw}. Expected an ISO 8601 timestamp.`);
    }
    options.since = parsed;
  }

  // ── limit ────────────────────────────────────────────────────────────────
  const limitRaw = params.get('limit');
  options.limit = DEFAULT_RECIPE_LIMIT;
  if (limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RECIPE_LIMIT) {
      return badRequest(
        `Invalid \`limit\`: ${limitRaw}. Expected an integer between 1 and ${MAX_RECIPE_LIMIT}.`,
      );
    }
    options.limit = parsed;
  }

  // ── status ───────────────────────────────────────────────────────────────
  const statusRaw = params.get('status');
  if (statusRaw !== null && statusRaw !== '') {
    if (statusRaw === 'all') {
      options.status = null;
    } else if (isRecipeStatus(statusRaw)) {
      options.status = statusRaw;
    } else {
      return badRequest(
        `Invalid \`status\`: ${statusRaw}. Expected one of ${RECIPE_STATUS.join(', ')} or "all".`,
      );
    }
  }

  try {
    // Resolved here rather than taken from the query string: a hard rule is a
    // filter over the reader's own feed, so it follows the session and must not
    // be something a caller can spoof or turn off by editing a URL. The
    // server-rendered page resolves them the same way — a difference between
    // the two would be a hydration mismatch.
    const userId = (await getCurrentUser())?.id ?? null;
    const { rules } = await getUserPreferences(userId);
    const rows = await listRecipes({ ...options, hardRules: rules, userId });
    return NextResponse.json(rows, { headers: { 'cache-control': 'no-store' } });
  } catch (error: unknown) {
    // Same reasoning as /api/health: do not answer 200 with an empty array when
    // the database is unreachable — "no recipes" and "no database" are very
    // different answers and the planner's poller must be able to tell them
    // apart.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

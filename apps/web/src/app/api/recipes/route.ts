/**
 * GET /api/recipes
 *
 * **This returns `[]` today and that is the correct Phase 0 result.** PLAN.md §4:
 * "Every recipe in the system arrives from a crawl ... there is no seed data to
 * special-case." Phase 1 fills the table; nothing is faked here to make the
 * endpoint look populated.
 *
 * Query parameters — both exist now because Phase 3 polls this endpoint
 * (PLAN.md §5: "TanStack Query with `refetchInterval` (~5 min) against
 * `GET /api/recipes?since=<ts>`"), and a poll parameter added after the client
 * ships is a client that has to be redeployed:
 *
 *   ?since=<ISO timestamp>  rows whose `last_seen_at` is strictly newer. That
 *                           column, not `first_seen_at`, because a re-crawl that
 *                           finds an upstream edit bumps `last_seen_at` and the
 *                           poller should see the change.
 *   ?limit=<1..200>         page size, default 50.
 *   ?status=<...|all>       defaults to `active`. Pending rows are durable
 *                           Phase 2 work, not browse-ready recipes; rejected
 *                           rows stay auditable without entering the feed.
 *
 * The response deliberately omits `raw_jsonld`, HTTP validators and the
 * content hash. Those are internal crawl/re-enrichment inputs and can contain
 * source prose; browse clients receive our fields and attribution only.
 *
 * A bad parameter is a 400 with a reason rather than a silently ignored filter.
 */

import { NextResponse } from 'next/server';
import { and, db, desc, eq, gt, recipes } from '@recipes/db';
import { RECIPE_STATUS, type RecipeStatus } from '@recipes/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  // ── since ────────────────────────────────────────────────────────────────
  const sinceRaw = params.get('since');
  let since: Date | undefined;
  if (sinceRaw !== null && sinceRaw !== '') {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return badRequest(`Invalid \`since\`: ${sinceRaw}. Expected an ISO 8601 timestamp.`);
    }
    since = parsed;
  }

  // ── limit ────────────────────────────────────────────────────────────────
  const limitRaw = params.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return badRequest(`Invalid \`limit\`: ${limitRaw}. Expected an integer between 1 and ${MAX_LIMIT}.`);
    }
    limit = parsed;
  }

  // ── status ───────────────────────────────────────────────────────────────
  const statusRaw = params.get('status');
  let statusFilter: ReturnType<typeof eq> | undefined = eq(recipes.status, 'active');
  if (statusRaw !== null && statusRaw !== '') {
    if (statusRaw === 'all') {
      statusFilter = undefined;
    } else if ((RECIPE_STATUS as readonly string[]).includes(statusRaw)) {
      statusFilter = eq(recipes.status, statusRaw as RecipeStatus);
    } else {
      return badRequest(
        `Invalid \`status\`: ${statusRaw}. Expected one of ${RECIPE_STATUS.join(', ')} or "all".`,
      );
    }
  }

  try {
    const rows = await db
      .select({
        id: recipes.id,
        sourceId: recipes.sourceId,
        sourceUrl: recipes.sourceUrl,
        title: recipes.title,
        slug: recipes.slug,
        blurb: recipes.blurb,
        totalMinutes: recipes.totalMinutes,
        activeMinutes: recipes.activeMinutes,
        servings: recipes.servings,
        keepsDays: recipes.keepsDays,
        freezerMonths: recipes.freezerMonths,
        category: recipes.category,
        tags: recipes.tags,
        imageUrl: recipes.imageUrl,
        imageLocalPath: recipes.imageLocalPath,
        imageW: recipes.imageW,
        imageH: recipes.imageH,
        imageBlurhash: recipes.imageBlurhash,
        author: recipes.author,
        sourceRating: recipes.sourceRating,
        sourceRatingCount: recipes.sourceRatingCount,
        instructions: recipes.instructions,
        status: recipes.status,
        rejectionReason: recipes.rejectionReason,
        publishedAt: recipes.publishedAt,
        firstSeenAt: recipes.firstSeenAt,
        lastSeenAt: recipes.lastSeenAt,
      })
      .from(recipes)
      .where(and(statusFilter, since ? gt(recipes.lastSeenAt, since) : undefined))
      .orderBy(desc(recipes.lastSeenAt))
      .limit(limit);

    return NextResponse.json(rows, { headers: { 'cache-control': 'no-store' } });
  } catch (error: unknown) {
    // Same reasoning as /api/health: do not answer 200 with an empty array when
    // the database is unreachable — "no recipes" and "no database" are very
    // different answers and Phase 3's poller must be able to tell them apart.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

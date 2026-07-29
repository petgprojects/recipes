/**
 * The browse and detail queries, in one place because two callers need to agree
 * on them: `/api/recipes` (what the client polls) and the server-rendered root
 * page (what the client hydrates from). A drift between those two is a
 * hydration mismatch, so they share a function rather than a resemblance.
 *
 * Everything returned here is JSON-safe — timestamps are ISO strings, numerics
 * are numbers — for exactly the same reason: the shape the server renders and
 * the shape the poller receives have to be identical.
 *
 * What is deliberately *not* returned: `raw_jsonld`, `content_hash` and the
 * HTTP validators. Those are crawl/re-enrichment inputs and can contain source
 * prose; PLAN.md §7 restricts what we display to our own fields plus
 * attribution. Instructions are detail-only, which keeps a 235-row browse
 * payload small enough to poll.
 */

import { and, db, desc, eq, gt, ingredients, recipeIngredients, recipes, sources, sql } from '@recipes/db';
import { RECIPE_STATUS, type RecipeStatus } from '@recipes/shared';
import type { HardRule } from '@recipes/shared/personalization';
import { hardRuleFilter } from './preferences';
import type { RecipeDetail, RecipeSummary } from './recipe-types';

export type { RecipeDetail, RecipeIngredientLine, RecipeSummary } from './recipe-types';

export const DEFAULT_RECIPE_LIMIT = 50;
/**
 * The browse tab renders every active recipe (235 today) and filters by
 * category in the client, exactly as the artifact did. When the corpus outgrows
 * this the answer is pagination, not a bigger number — PLAN.md §8, open
 * question 10 (retention) is the same conversation.
 */
export const MAX_RECIPE_LIMIT = 500;
export const BROWSE_LIMIT = MAX_RECIPE_LIMIT;

export interface ListRecipesOptions {
  since?: Date;
  limit?: number;
  /** `null` means every status; the default is browse-ready rows only. */
  status?: RecipeStatus | null;
  /**
   * The reader's Phase 7 hard rules, already loaded. Passed in rather than
   * resolved here so this module stays free of auth: `/api/recipes` and the
   * server-rendered page each call `getUserPreferences()` themselves and hand
   * the result over. Both *must* pass the same rules — the page's output is the
   * client's `initialData`, so a filter applied on one path and not the other
   * is a hydration mismatch.
   */
  hardRules?: HardRule[];
}

const summaryColumns = {
  id: recipes.id,
  slug: recipes.slug,
  title: recipes.title,
  blurb: recipes.blurb,
  category: recipes.category,
  tags: recipes.tags,
  totalMinutes: recipes.totalMinutes,
  activeMinutes: recipes.activeMinutes,
  servings: recipes.servings,
  keepsDays: recipes.keepsDays,
  freezerMonths: recipes.freezerMonths,
  imagePath: recipes.imageLocalPath,
  imageW: recipes.imageW,
  imageH: recipes.imageH,
  imageSourceUrl: recipes.imageUrl,
  sourceName: sources.name,
  sourceUrl: recipes.sourceUrl,
  author: recipes.author,
  sourceRating: recipes.sourceRating,
  sourceRatingCount: recipes.sourceRatingCount,
  status: recipes.status,
  publishedAt: recipes.publishedAt,
  firstSeenAt: recipes.firstSeenAt,
  lastSeenAt: recipes.lastSeenAt,
} as const;

/** The database-side shape of {@link summaryColumns}: timestamps still Dates. */
type SummaryRow = Omit<RecipeSummary, 'publishedAt' | 'firstSeenAt' | 'lastSeenAt' | 'tags'> & {
  tags: string[] | null;
  publishedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

function toSummary(row: SummaryRow): RecipeSummary {
  return {
    ...row,
    tags: row.tags ?? [],
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export function isRecipeStatus(value: string): value is RecipeStatus {
  return (RECIPE_STATUS as readonly string[]).includes(value);
}

/**
 * Browse order is PLAN.md §7's cold start: newest first, source rating as the
 * tiebreak. `published_at` can be null on a sitemap-discovered page, so those
 * rows sort by when we first saw them instead of jumping to the top.
 *
 * Phase 7 adds the reader's hard rules as a `WHERE` clause here — deliberately
 * a filter and not a ranking. A rule says "don't show me this", so a recipe it
 * matches must not appear at position 200 either.
 */
export async function listRecipes(options: ListRecipesOptions = {}): Promise<RecipeSummary[]> {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_RECIPE_LIMIT), MAX_RECIPE_LIMIT);
  const status = options.status === undefined ? 'active' : options.status;

  const rows = await db
    .select(summaryColumns)
    .from(recipes)
    .innerJoin(sources, eq(sources.id, recipes.sourceId))
    .where(
      and(
        status === null ? undefined : eq(recipes.status, status),
        options.since ? gt(recipes.lastSeenAt, options.since) : undefined,
        hardRuleFilter(options.hardRules ?? []),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${recipes.publishedAt}, ${recipes.firstSeenAt})`),
      desc(sql`coalesce(${recipes.sourceRating}, 0)`),
      desc(recipes.id),
    )
    .limit(limit);

  return rows.map(toSummary);
}

/** One recipe with its steps and ingredient lines, or `null` if there is none. */
export async function getRecipeDetail(
  id: string,
  options: { status?: RecipeStatus | null } = {},
): Promise<RecipeDetail | null> {
  const status = options.status === undefined ? 'active' : options.status;

  const [row] = await db
    .select({ ...summaryColumns, instructions: recipes.instructions })
    .from(recipes)
    .innerJoin(sources, eq(sources.id, recipes.sourceId))
    .where(and(eq(recipes.id, id), status === null ? undefined : eq(recipes.status, status)))
    .limit(1);

  if (row === undefined) return null;

  const lines = await db
    .select({
      position: recipeIngredients.position,
      rawText: recipeIngredients.rawText,
      ingredientId: recipeIngredients.ingredientId,
      name: ingredients.name,
      aisle: ingredients.aisle,
      qty: recipeIngredients.qty,
      unit: recipeIngredients.unit,
      note: recipeIngredients.note,
      optional: recipeIngredients.optional,
    })
    .from(recipeIngredients)
    .leftJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .where(eq(recipeIngredients.recipeId, id))
    .orderBy(recipeIngredients.position);

  const { instructions, ...summary } = row;
  return {
    ...toSummary(summary),
    instructions: instructions ?? [],
    ingredients: lines.map((line) => ({
      position: line.position,
      rawText: line.rawText,
      ingredientId: line.ingredientId,
      name: line.name,
      aisle: line.aisle,
      qty: line.qty,
      unit: line.unit,
      note: line.note,
      optional: line.optional,
    })),
  };
}

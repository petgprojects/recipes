/**
 * The wire shape of a recipe, shared by the server queries in `lib/recipes.ts`
 * and every client component.
 *
 * It lives in its own module so that a client component can name these types
 * without `@recipes/db` — and therefore a connection pool — being anywhere near
 * the browser bundle. `import type` is erased, but a file that cannot pull the
 * pool in is a stronger guarantee than one that merely happens not to. The one
 * import below is `@recipes/shared/search`, which is client-safe and in the
 * package barrel; the server-only `@recipes/shared/llm` and `./env` are not,
 * and must never appear here.
 *
 * Timestamps are ISO strings: the server-rendered first paint and the polled
 * JSON must be byte-identical shapes or hydration is a lottery.
 */

import type { SearchFilter, SearchNotice } from '@recipes/shared/search';

export type RecipeStatusValue = 'pending' | 'active' | 'rejected';

export interface RecipeSummary {
  id: string;
  slug: string;
  /**
   * The public link key. `id` identifies a recipe to this application;
   * `shareCode` identifies it in a URL someone pastes into a text message. Both
   * travel with the card because the share button is on the card's sheet and
   * must not need a second request to know what link to copy.
   */
  shareCode: string;
  title: string;
  blurb: string | null;
  category: string | null;
  tags: string[];
  totalMinutes: number | null;
  activeMinutes: number | null;
  servings: number | null;
  keepsDays: number | null;
  freezerMonths: number | null;
  /** Filename inside the cached-image volume; render via `/api/images/<path>`. */
  imagePath: string | null;
  imageW: number | null;
  imageH: number | null;
  /** The upstream image, kept for attribution — never rendered directly (§7). */
  imageSourceUrl: string | null;
  sourceName: string;
  sourceUrl: string;
  author: string | null;
  sourceRating: number | null;
  sourceRatingCount: number | null;
  status: RecipeStatusValue;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * The reader's Phase 7 taste score, or `null` when nothing has scored this
   * recipe for them — signed out, before the cold-start floor, or a recipe that
   * arrived since the last nightly pass. Null is not zero: it sorts as
   * `NEUTRAL_SCORE`, because an unscored recipe is unknown rather than bad.
   */
  score: number | null;
  /**
   * Why that score, in one line, shown on the card. PLAN.md §5: "an opaque
   * ranking is one you can't debug or trust."
   */
  scoreReason: string | null;
}

export interface RecipeIngredientLine {
  position: number;
  rawText: string;
  /** Null when the matcher left the row unmapped — it still renders (§4). */
  ingredientId: string | null;
  /** Canonical name when mapped, otherwise `null`; `rawText` is the fallback. */
  name: string | null;
  aisle: string | null;
  qty: number | null;
  unit: string | null;
  note: string | null;
  optional: boolean;
}

export interface RecipeInstructionStep {
  text: string;
  name?: string | null;
}

export interface RecipeDetail extends RecipeSummary {
  instructions: RecipeInstructionStep[];
  ingredients: RecipeIngredientLine[];
}

/**
 * The body of `GET /api/search` (FILTER_PLAN.md §7, Phase 5).
 *
 * `recipes` is the same `RecipeSummary` the browse feed returns, deliberately —
 * results are rendered by the same card, so a second shape that merely
 * resembled this one would drift and the symptom would be a search result
 * missing its photo or its score reason.
 *
 * `notices` is what the reader has to be told about a search that did not run
 * as typed: §4.2's bypassed rules, §5.1's union fallback, §4.4's relaxations
 * and A26's degraded parse. Ordered by the server, rendered in order by the
 * client, and never empty by accident — an empty list means the query ran
 * exactly as typed.
 *
 * `filter` is what *actually* ran, after any relaxation. It is not used to
 * render anything today; it is here because a search that returns a surprising
 * set is otherwise impossible to argue with, which is the same reason a score
 * carries its reason.
 */
export interface SearchResponse {
  query: string;
  recipes: RecipeSummary[];
  notices: SearchNotice[];
  filter: SearchFilter;
}

/** The URL of a cached photo, or `null` when there is nothing to render. */
export function recipeImageSrc(recipe: Pick<RecipeSummary, 'imagePath'>): string | null {
  return recipe.imagePath === null ? null : `/api/images/${recipe.imagePath}`;
}

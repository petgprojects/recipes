/**
 * The wire shape of a recipe, shared by the server queries in `lib/recipes.ts`
 * and every client component.
 *
 * It lives in its own module with no imports so that a client component can
 * name these types without `@recipes/db` — and therefore a connection pool —
 * being anywhere near the browser bundle. `import type` is erased, but a file
 * that cannot pull the pool in is a stronger guarantee than one that merely
 * happens not to.
 *
 * Timestamps are ISO strings: the server-rendered first paint and the polled
 * JSON must be byte-identical shapes or hydration is a lottery.
 */

export type RecipeStatusValue = 'pending' | 'active' | 'rejected';

export interface RecipeSummary {
  id: string;
  slug: string;
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

/** The URL of a cached photo, or `null` when there is nothing to render. */
export function recipeImageSrc(recipe: Pick<RecipeSummary, 'imagePath'>): string | null {
  return recipe.imagePath === null ? null : `/api/images/${recipe.imagePath}`;
}

/**
 * Transactional Phase 1 recipe persistence.
 *
 * The advisory transaction lock serialises concurrent discoveries of the same
 * canonical URL before the SELECT/INSERT boundary. Re-seeing identical content
 * only advances `last_seen_at` (and fresh HTTP validators); an upstream edit
 * replaces the deterministic recipe fields and all ingredient rows atomically.
 */

import { eq, sql } from '@recipes/db/operators';
import {
  recipeIngredients,
  recipes,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import type { RecipeIngredient } from '@recipes/shared';
import type { RecipeDraft } from '../scanner/jsonld';
import { canonicalUrlKey } from '../scanner/discover';
import type { CachedRecipeImage } from './images';

export interface PageValidators {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface PersistRecipeDraftInput {
  readonly sourceId: string;
  readonly draft: RecipeDraft;
  readonly ingredients: readonly RecipeIngredient[];
  /** Successful cache result; null means the source URL is still retained. */
  readonly image?: CachedRecipeImage | null;
  readonly validators?: PageValidators;
  readonly seenAt?: Date;
}

export type PersistRecipeDraftResult =
  | { readonly outcome: 'inserted'; readonly recipeId: string; readonly sourceUrl: string }
  | { readonly outcome: 'updated'; readonly recipeId: string; readonly sourceUrl: string }
  | { readonly outcome: 'unchanged'; readonly recipeId: string; readonly sourceUrl: string };

export async function persistRecipeDraft(
  db: Database,
  input: PersistRecipeDraftInput,
): Promise<PersistRecipeDraftResult> {
  const sourceUrl = canonicalUrlKey(input.draft.sourceUrl);
  assertCanonicalHttpUrl(sourceUrl);
  const seenAt = input.seenAt ?? new Date();

  return db.transaction(async (tx) => {
    // Postgres hashes the URL to one signed bigint lock key. The lock lasts for
    // this transaction only and prevents a same-URL unique-index race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sourceUrl}, 0))`);

    const [existing] = await tx
      .select({
        id: recipes.id,
        contentHash: recipes.contentHash,
        imageUrl: recipes.imageUrl,
        imageLocalPath: recipes.imageLocalPath,
        imageW: recipes.imageW,
        imageH: recipes.imageH,
        imageBlurhash: recipes.imageBlurhash,
      })
      .from(recipes)
      .where(eq(recipes.sourceUrl, sourceUrl))
      .limit(1)
      .for('update');

    if (existing !== undefined && existing.contentHash === input.draft.contentHash) {
      await tx
        .update(recipes)
        .set({
          lastSeenAt: seenAt,
          pageEtag: input.validators?.etag,
          pageLastModified: input.validators?.lastModified,
          ...(input.image
            ? {
                imageLocalPath: input.image.localPath,
                imageW: input.image.width,
                imageH: input.image.height,
              }
            : {}),
        })
        .where(eq(recipes.id, existing.id));
      return { outcome: 'unchanged', recipeId: existing.id, sourceUrl };
    }

    const imageFields = imageFieldsFor(input.draft.imageUrl, input.image ?? null, existing);
    if (existing === undefined) {
      const [inserted] = await tx
        .insert(recipes)
        .values({
          sourceId: input.sourceId,
          sourceUrl,
          contentHash: input.draft.contentHash,
          pageEtag: input.validators?.etag ?? null,
          pageLastModified: input.validators?.lastModified ?? null,
          title: input.draft.title,
          slug: input.draft.slug,
          totalMinutes: input.draft.totalMinutes,
          activeMinutes: input.draft.activeMinutes,
          servings: input.draft.servings,
          imageUrl: input.draft.imageUrl,
          ...imageFields,
          author: input.draft.author,
          sourceRating: input.draft.sourceRating,
          sourceRatingCount: input.draft.sourceRatingCount,
          instructions: input.draft.instructions,
          rawJsonld: input.draft.rawJsonld,
          publishedAt: input.draft.publishedAt,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        })
        .returning({ id: recipes.id });
      if (inserted === undefined) throw new Error(`insert returned no row for ${sourceUrl}`);
      await replaceIngredients(tx, inserted.id, input.ingredients);
      return { outcome: 'inserted', recipeId: inserted.id, sourceUrl };
    }

    await tx
      .update(recipes)
      .set({
        sourceId: input.sourceId,
        contentHash: input.draft.contentHash,
        pageEtag: input.validators?.etag,
        pageLastModified: input.validators?.lastModified,
        title: input.draft.title,
        slug: input.draft.slug,
        totalMinutes: input.draft.totalMinutes,
        activeMinutes: input.draft.activeMinutes,
        servings: input.draft.servings,
        imageUrl: input.draft.imageUrl,
        ...imageFields,
        author: input.draft.author,
        sourceRating: input.draft.sourceRating,
        sourceRatingCount: input.draft.sourceRatingCount,
        instructions: input.draft.instructions,
        rawJsonld: input.draft.rawJsonld,
        publishedAt: input.draft.publishedAt,
        lastSeenAt: seenAt,
      })
      .where(eq(recipes.id, existing.id));

    await replaceIngredients(tx, existing.id, input.ingredients);
    return { outcome: 'updated', recipeId: existing.id, sourceUrl };
  });
}

/**
 * A 304 still proves the upstream recipe exists. Advance `last_seen_at` and
 * rotate validators without needing an extraction draft or touching ingredients.
 */
export async function markRecipeSeen(
  db: Database,
  sourceUrl: string,
  validators: PageValidators = {},
  seenAt = new Date(),
): Promise<boolean> {
  const canonical = canonicalUrlKey(sourceUrl);
  assertCanonicalHttpUrl(canonical);
  const rows = await db
    .update(recipes)
    .set({
      lastSeenAt: seenAt,
      pageEtag: validators.etag,
      pageLastModified: validators.lastModified,
    })
    .where(eq(recipes.sourceUrl, canonical))
    .returning({ id: recipes.id });
  return rows.length > 0;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function replaceIngredients(
  tx: Transaction,
  recipeId: string,
  ingredients: readonly RecipeIngredient[],
): Promise<void> {
  await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId));
  if (ingredients.length === 0) return;
  await tx.insert(recipeIngredients).values(
    ingredients.map((ingredient): typeof recipeIngredients.$inferInsert => ({
      recipeId,
      position: ingredient.position,
      rawText: ingredient.rawText,
      ingredientId: ingredient.ingredientId,
      qty: ingredient.qty,
      unit: ingredient.unit,
      note: ingredient.note,
      optional: ingredient.optional,
    })),
  );
}

function imageFieldsFor(
  sourceImageUrl: string | null,
  cached: CachedRecipeImage | null,
  existing:
    | {
        imageUrl: string | null;
        imageLocalPath: string | null;
        imageW: number | null;
        imageH: number | null;
        imageBlurhash: string | null;
      }
    | undefined,
): {
  imageLocalPath: string | null;
  imageW: number | null;
  imageH: number | null;
  imageBlurhash: string | null;
} {
  if (cached !== null) {
    return {
      imageLocalPath: cached.localPath,
      imageW: cached.width,
      imageH: cached.height,
      imageBlurhash: null,
    };
  }
  if (existing !== undefined && existing.imageUrl === sourceImageUrl) {
    return {
      imageLocalPath: existing.imageLocalPath,
      imageW: existing.imageW,
      imageH: existing.imageH,
      imageBlurhash: existing.imageBlurhash,
    };
  }
  return {
    imageLocalPath: null,
    imageW: null,
    imageH: null,
    imageBlurhash: null,
  };
}

function assertCanonicalHttpUrl(value: string): void {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`Recipe source URL must use HTTP(S): ${value}`);
  }
}

/**
 * Share links against the real corpus.
 *
 * The unit tests in `@recipes/shared` prove the handle format is internally
 * consistent. What they cannot prove is the thing the feature actually rests
 * on — that every recipe in this database has a code, that no two share one,
 * and that the codes the database generates are the shape the parser accepts.
 * Those are three separate ways for a pasted link to 404, and none of them are
 * visible from a fixture.
 *
 * Needs `DATABASE_URL`, like every other suite in this directory.
 */

import { describe, expect, it } from 'vitest';
import { db, eq, recipes, sql } from '@recipes/db';
import { isShareCode, parseRecipeHandle, recipeHandle } from '@recipes/shared/share';
import { getRecipeByShareCode } from '../src/lib/recipes';

describe('share codes across the corpus', () => {
  it('gives every recipe a code, and no two the same one', async () => {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        codes: sql<number>`count(distinct ${recipes.shareCode})::int`,
        missing: sql<number>`count(*) filter (where ${recipes.shareCode} is null)::int`,
      })
      .from(recipes);

    expect(row).toBeDefined();
    expect(row!.total).toBeGreaterThan(0);
    expect(row!.missing).toBe(0);
    // The one that matters: a duplicate code is two recipes behind one link.
    expect(row!.codes).toBe(row!.total);
  });

  it('generates codes the parser accepts, for every row', async () => {
    const rows = await db.select({ shareCode: recipes.shareCode }).from(recipes);
    const rejected = rows.map((row) => row.shareCode).filter((code) => !isShareCode(code));
    expect(rejected).toEqual([]);
  });

  /**
   * The reason the code exists at all. `scanner/text.ts` documents slugs as
   * non-unique and the corpus has several collisions; if this ever finds none,
   * the assertion still holds and the feature is merely unexercised.
   */
  it('distinguishes recipes that share a slug', async () => {
    const collisions = await db
      .select({ slug: recipes.slug, n: sql<number>`count(*)::int` })
      .from(recipes)
      .groupBy(recipes.slug)
      .having(sql`count(*) > 1`);

    for (const collision of collisions) {
      const sharing = await db
        .select({ id: recipes.id, slug: recipes.slug, shareCode: recipes.shareCode })
        .from(recipes)
        .where(eq(recipes.slug, collision.slug));

      const handles = new Set(sharing.map((r) => recipeHandle(r.slug, r.shareCode)));
      expect(handles.size).toBe(sharing.length);
    }
  });
});

describe('getRecipeByShareCode', () => {
  it('round-trips a real recipe through its own handle', async () => {
    const [recipe] = await db
      .select({ id: recipes.id, slug: recipes.slug, shareCode: recipes.shareCode })
      .from(recipes)
      .where(eq(recipes.status, 'active'))
      .limit(1);

    expect(recipe).toBeDefined();

    const parsed = parseRecipeHandle(recipeHandle(recipe!.slug, recipe!.shareCode));
    expect(parsed?.shareCode).toBe(recipe!.shareCode);

    const found = await getRecipeByShareCode(parsed!.shareCode);
    expect(found?.id).toBe(recipe!.id);
    // The route builds its canonical redirect target out of these two, so a
    // summary missing either would send every share link to `/r/undefined`.
    expect(found?.shareCode).toBe(recipe!.shareCode);
    expect(found?.slug).toBe(recipe!.slug);
  });

  it('returns null for a well-formed code nothing owns', async () => {
    expect(await getRecipeByShareCode('zzzzzzzz')).toBeNull();
  });

  /**
   * A rejected recipe is one the Phase 2 gate turned down; a pending one has no
   * blurb and no category yet. Neither is something a link should publish, so
   * the lookup is `active`-only and the route 404s on both.
   */
  it('does not resolve a recipe that is not active', async () => {
    const [inactive] = await db
      .select({ shareCode: recipes.shareCode })
      .from(recipes)
      .where(sql`${recipes.status} <> 'active'`)
      .limit(1);

    if (inactive === undefined) return;
    expect(await getRecipeByShareCode(inactive.shareCode)).toBeNull();
  });
});

/**
 * `/r/<slug>-<code>` — a link to one recipe, on this site.
 *
 * The point of the feature: before this route existed, the only way to send
 * someone a recipe was to copy the *source's* URL out of the detail sheet,
 * which sends them to somebody else's page and loses the blurb, the parsed
 * ingredient lines and the ability to save it here in one tap.
 *
 * What renders is the planner with the sheet already open, not a second recipe
 * renderer — one recipe page and one detail sheet that drift apart is exactly
 * the failure `listRecipes()` and `summaryColumns` are shaped to avoid. It also
 * means a shared link lands somewhere with a way onward: close the sheet and
 * you are in the browse feed rather than at a dead end.
 *
 * `@recipes/shared/share` owns the handle format and the reason resolution is
 * on the code alone. Everything about that decision is documented there.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { env } from '@recipes/shared/env';
import { parseRecipeHandle, recipeShareUrl } from '@recipes/shared/share';
import { PlannerPage } from '@/components/planner-page';
import { getRecipeByShareCode } from '@/lib/recipes';
import '@/styles/artifact.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface HandleParams {
  params: Promise<{ handle: string }>;
}

/**
 * The link preview. This is half the feature: a recipe link pasted into a
 * message thread should arrive as the photo and the title, and without this it
 * arrives as "Recipe Planner — Self-hosted meal-prep recipe planner" from the
 * root layout, which tells the recipient nothing about what they were sent.
 *
 * Absolute URLs throughout, because a crawler resolves them against nothing.
 * `NEXT_PUBLIC_APP_URL` is the same origin the search transport already sends
 * as its `HTTP-Referer`, and it is what has to change when the app is deployed
 * behind a real domain.
 *
 * Deliberately no session lookup and no reader's score: this runs for crawlers,
 * and it costs one indexed row read.
 */
export async function generateMetadata({ params }: HandleParams): Promise<Metadata> {
  const parsed = parseRecipeHandle((await params).handle);
  if (parsed === null) return { title: 'Recipe not found' };

  const recipe = await getRecipeByShareCode(parsed.shareCode).catch(() => null);
  if (recipe === null) return { title: 'Recipe not found' };

  const url = recipeShareUrl(env.NEXT_PUBLIC_APP_URL, recipe.slug, recipe.shareCode);
  // Our own blurb, never the source's prose (PLAN.md §7). When Phase 2 has not
  // written one, attribution is the honest fallback — a preview that says where
  // the recipe came from is better than one that quotes a page we did not write.
  const description = recipe.blurb ?? `A recipe from ${recipe.sourceName}.`;
  const image =
    recipe.imagePath === null
      ? undefined
      : {
          url: `${env.NEXT_PUBLIC_APP_URL}/api/images/${recipe.imagePath}`,
          width: recipe.imageW ?? undefined,
          height: recipe.imageH ?? undefined,
          alt: recipe.title,
        };

  return {
    title: recipe.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title: recipe.title,
      description,
      url,
      siteName: 'Cook once, eat all week',
      images: image === undefined ? undefined : [image],
    },
    twitter: {
      // The large card only renders when there is an image to put in it;
      // claiming it without one produces a broken-looking empty box.
      card: image === undefined ? 'summary' : 'summary_large_image',
      title: recipe.title,
      description,
      images: image === undefined ? undefined : [image.url],
    },
  };
}

export default async function SharedRecipe({ params }: HandleParams) {
  const { handle } = await params;
  const parsed = parseRecipeHandle(handle);
  // A handle with no code in it cannot be a link this site produced, so it is
  // answered without touching the database. Whether a well-formed code exists
  // is `PlannerPage`'s question, because answering it needs the reader.
  if (parsed === null) notFound();

  return <PlannerPage share={{ code: parsed.shareCode, handle }} />;
}

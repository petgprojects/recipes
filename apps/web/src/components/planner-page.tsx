/**
 * The server half of the planner, shared by `/` and `/r/<handle>`.
 *
 * This was the body of `app/page.tsx` until share links needed a second route
 * that renders the same page. It is a function rather than a resemblance for
 * the reason `listRecipes()` is: whatever the server renders here becomes the
 * client's TanStack Query `initialData`, so a second copy that drifted by one
 * argument — a hard rule applied on one route and not the other — would present
 * as the feed reshuffling on load, only on shared links.
 *
 * A share link resolves **here** rather than in the route, so that opening one
 * costs the same single session lookup that opening `/` does. `getCurrentUser()`
 * is not memoised per request, and the reader's id is an argument to the recipe
 * lookup, so doing it in the route would mean resolving the session twice.
 */

import { notFound, redirect } from 'next/navigation';
import type { PlannerState } from '@recipes/shared/planner';
import type { HardRule } from '@recipes/shared/personalization';
import { recipeSharePath } from '@recipes/shared/share';
import { Planner } from '@/components/planner';
import { isAuthConfigured } from '@/lib/auth';
import { getCurrentUser } from '@/lib/current-user';
import { readPlannerState } from '@/lib/planner';
import { getUserPreferences } from '@/lib/preferences';
import { BROWSE_LIMIT, getRecipeByShareCode, listRecipes } from '@/lib/recipes';
import { getSearchAvailability } from '@/lib/search-service';
import type { RecipeSummary } from '@/lib/recipe-types';
import type { PlannerUser } from '@/lib/saved-store';

export interface PlannerPageProps {
  /** `?q=` as the server saw it. The search itself still runs on the client. */
  initialQuery?: string;
  /**
   * The share link being opened, when this is `/r/<handle>`.
   *
   * `handle` is what was in the URL and `code` is what was parsed out of it;
   * both are needed because the difference between them is the redirect. A
   * recipe whose title changed after someone shared it still resolves on the
   * code, and is then sent on to its current canonical handle rather than being
   * rendered under words that are no longer true.
   */
  share?: { code: string; handle: string };
}

export async function PlannerPage({ initialQuery = '', share }: PlannerPageProps) {
  let recipes: RecipeSummary[] = [];
  let failure: string | null = null;
  let user: PlannerUser | null = null;
  let plannerState: PlannerState | undefined;
  let hardRules: HardRule[] = [];
  let searchAvailable = false;
  let openRecipe: RecipeSummary | null = null;

  try {
    // Sequential rather than parallel on purpose: the picks read needs the user
    // id, and a failed session lookup should not leave a dangling query.
    user = await getCurrentUser();
    // Before the browse query, not alongside it: the rules are an argument to
    // it. `/api/recipes` resolves them the same way, which is what keeps this
    // render usable as the client's `initialData`.
    const preferences = await getUserPreferences(user?.id ?? null);
    hardRules = preferences.rules;

    const [rows, saved, availability, shared] = await Promise.all([
      listRecipes({ limit: BROWSE_LIMIT, hardRules, userId: user?.id ?? null }),
      user === null ? Promise.resolve(undefined) : readPlannerState(user.id),
      // §8: the bar is disabled with an explanation at the 90% gate, never
      // hidden — so the first paint has to know, rather than the reader
      // learning it by typing a query and getting a 503. Signed out there is
      // no bar to disable and no reason to read the budget.
      user === null ? Promise.resolve(null) : getSearchAvailability(),
      // **Not filtered by the reader's hard rules, deliberately.** The rules
      // shape a feed; a share link is one specific recipe someone was sent, and
      // hiding it because the recipient filters out pork would look like a
      // broken link rather than a preference. Same argument §4.2 makes for
      // search, which also ignores them.
      share === undefined
        ? Promise.resolve(null)
        : getRecipeByShareCode(share.code, { userId: user?.id ?? null }),
    ]);
    recipes = rows;
    plannerState = saved;
    searchAvailable = availability?.available ?? false;
    openRecipe = shared;
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failure !== null) {
    return (
      <div className="mp">
        <div className="mp-wrap">
          <header className="mp-head">
            <div className="mp-eyebrow">Recipe planner</div>
            <h1 className="mp-title">
              Can&apos;t reach
              <br />
              <em>the kitchen.</em>
            </h1>
            <p className="mp-sub">
              The recipe database did not answer: {failure}. Nothing has been lost — check{' '}
              <a className="mp-link" href="/ops">
                /ops
              </a>{' '}
              and reload.
            </p>
          </header>
        </div>
      </div>
    );
  }

  // Outside the `try`, and it has to be: `notFound()` and `redirect()` work by
  // throwing, so inside it they would be caught and rendered as a database
  // outage — a 200 page reading "can't reach the kitchen" where a 404 belongs.
  if (share !== undefined) {
    if (openRecipe === null) notFound();
    const canonical = recipeSharePath(openRecipe.slug, openRecipe.shareCode);
    if (canonical !== `/r/${share.handle}`) redirect(canonical);
  }

  return (
    <Planner
      initialRecipes={recipes}
      user={user}
      initialPlannerState={plannerState}
      initialHardRules={hardRules}
      authEnabled={isAuthConfigured}
      initialQuery={initialQuery}
      searchAvailable={searchAvailable}
      initialOpenRecipe={openRecipe}
    />
  );
}

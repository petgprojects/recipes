/**
 * The planner, server-rendered from the database and then kept fresh by the
 * client poller.
 *
 * The first paint is real recipes rather than a spinner: `listRecipes()` here
 * and `GET /api/recipes` there run the same query and return the same JSON
 * shape, which is what makes it safe to hand the rows straight to TanStack
 * Query as `initialData`.
 *
 * A database that is down must not render as "no recipes" — that is the same
 * distinction `/api/recipes` makes with its 503 — so the failure has its own
 * state.
 */

import type { Metadata } from 'next';
import type { PlannerState } from '@recipes/shared/planner';
import type { HardRule } from '@recipes/shared/personalization';
import { Planner } from '@/components/planner';
import { isAuthConfigured } from '@/lib/auth';
import { getCurrentUser } from '@/lib/current-user';
import { readPlannerState } from '@/lib/planner';
import { getUserPreferences } from '@/lib/preferences';
import { BROWSE_LIMIT, listRecipes } from '@/lib/recipes';
import type { RecipeSummary } from '@/lib/recipe-types';
import type { PlannerUser } from '@/lib/saved-store';
import '@/styles/artifact.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Cook once, eat all week',
  description: 'Meal-prep recipes from the sources you trust, with the grocery list written for you.',
};

export default async function Home() {
  let recipes: RecipeSummary[] = [];
  let failure: string | null = null;
  let user: PlannerUser | null = null;
  let plannerState: PlannerState | undefined;
  let hardRules: HardRule[] = [];

  try {
    // Sequential rather than parallel on purpose: the picks read needs the user
    // id, and a failed session lookup should not leave a dangling query.
    user = await getCurrentUser();
    // Before the browse query, not alongside it: the rules are an argument to
    // it. `/api/recipes` resolves them the same way, which is what keeps this
    // render usable as the client's `initialData`.
    const preferences = await getUserPreferences(user?.id ?? null);
    hardRules = preferences.rules;

    const [rows, saved] = await Promise.all([
      listRecipes({ limit: BROWSE_LIMIT, hardRules }),
      user === null ? Promise.resolve(undefined) : readPlannerState(user.id),
    ]);
    recipes = rows;
    plannerState = saved;
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

  return (
    <Planner
      initialRecipes={recipes}
      user={user}
      initialPlannerState={plannerState}
      initialHardRules={hardRules}
      authEnabled={isAuthConfigured}
    />
  );
}

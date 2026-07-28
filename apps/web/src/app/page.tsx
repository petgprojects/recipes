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
import { Planner } from '@/components/planner';
import { BROWSE_LIMIT, listRecipes } from '@/lib/recipes';
import type { RecipeSummary } from '@/lib/recipe-types';
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

  try {
    recipes = await listRecipes({ limit: BROWSE_LIMIT });
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

  return <Planner initialRecipes={recipes} />;
}

/**
 * The planner, server-rendered from the database and then kept fresh by the
 * client poller.
 *
 * The first paint is real recipes rather than a spinner: `listRecipes()` here
 * and `GET /api/recipes` there run the same query and return the same JSON
 * shape, which is what makes it safe to hand the rows straight to TanStack
 * Query as `initialData`.
 *
 * The loading itself lives in `PlannerPage`, shared with `/r/<handle>`; a
 * database that is down must not render as "no recipes", and that distinction
 * is made there, once, for both routes.
 */

import type { Metadata } from 'next';
import { PlannerPage } from '@/components/planner-page';
import { MAX_SEARCH_QUERY_CHARS } from '@recipes/shared/search';
import '@/styles/artifact.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Cook once, eat all week',
  description: 'Meal-prep recipes from the sources you trust, with the grocery list written for you.',
};

/**
 * `?q=` is the search's URL state (FILTER_PLAN.md §7, Phase 5), so it is read
 * here — that is what makes a search link shareable and the back button work.
 *
 * The **search itself is not run here.** It is a billable provider call, and a
 * crawler, a link preview or a reload would each pay for one. The server only
 * passes the string down; the client runs it once, caches it forever, and the
 * bar renders with the words already in it either way.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).q;
  const initialQuery = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''))
    .trim()
    .slice(0, MAX_SEARCH_QUERY_CHARS);

  return <PlannerPage initialQuery={initialQuery} />;
}

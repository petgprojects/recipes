/**
 * Client-side data access. Pure fetch plus TanStack Query keys — no database
 * imports, so this is safe in the browser bundle.
 */

import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RecipeDetail, RecipeSummary } from './recipe-types';

/** PLAN.md §5: "TanStack Query with `refetchInterval` (~5 min)". */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** How many browse rows the planner asks for; mirrors `MAX_RECIPE_LIMIT`. */
export const BROWSE_LIMIT = 500;

export const recipeKeys = {
  list: (limit: number) => ['recipes', 'list', limit] as const,
  detail: (id: string) => ['recipes', 'detail', id] as const,
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    // `/api/recipes` answers 503 rather than an empty list when the database is
    // unreachable, precisely so this can surface as an error instead of as
    // "you have no recipes".
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error: unknown }).error)
          : response.statusText,
      )
      .catch(() => response.statusText);
    throw new Error(`${response.status} ${detail}`);
  }
  return (await response.json()) as T;
}

export function fetchRecipes(limit = BROWSE_LIMIT): Promise<RecipeSummary[]> {
  return getJson<RecipeSummary[]>(`/api/recipes?limit=${limit}`);
}

export function fetchRecipeDetail(id: string): Promise<RecipeDetail> {
  return getJson<RecipeDetail>(`/api/recipes/${id}`);
}

/**
 * The browse feed. Polls on an interval and on window focus (PLAN.md §5); the
 * planner decides what to *show*, which is why nothing here re-sorts anything.
 */
export function useRecipesQuery(initialData: RecipeSummary[]) {
  return useQuery({
    queryKey: recipeKeys.list(BROWSE_LIMIT),
    queryFn: () => fetchRecipes(BROWSE_LIMIT),
    initialData,
    // The server already rendered this exact list; refetching it immediately on
    // mount would be a wasted round-trip on every page load.
    initialDataUpdatedAt: () => Date.now(),
    staleTime: 60_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useRecipeDetail(id: string | null) {
  return useQuery({
    queryKey: recipeKeys.detail(id ?? 'none'),
    queryFn: () => fetchRecipeDetail(id!),
    enabled: id !== null,
    // A recipe's steps and ingredients only change when the crawler re-extracts
    // an edited page; there is no value in re-fetching an open sheet.
    staleTime: POLL_INTERVAL_MS,
  });
}

/** Details for every saved recipe — the grocery list's raw material. */
export function useSavedRecipeDetails(ids: readonly string[]): UseQueryResult<RecipeDetail>[] {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: recipeKeys.detail(id),
      queryFn: () => fetchRecipeDetail(id),
      staleTime: POLL_INTERVAL_MS,
    })),
  });
}

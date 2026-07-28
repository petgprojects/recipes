/**
 * Client-side data access. Pure fetch plus TanStack Query keys — no database
 * imports, so this is safe in the browser bundle.
 */

import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CheckedMap, PlannerState, SavedMap } from '@recipes/shared/planner';
import type { RecipeDetail, RecipeSummary } from './recipe-types';

/** PLAN.md §5: "TanStack Query with `refetchInterval` (~5 min)". */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** How many browse rows the planner asks for; mirrors `MAX_RECIPE_LIMIT`. */
export const BROWSE_LIMIT = 500;

export const recipeKeys = {
  list: (limit: number) => ['recipes', 'list', limit] as const,
  detail: (id: string) => ['recipes', 'detail', id] as const,
};

/**
 * A module-level constant, not a fresh array per call like `recipeKeys` above.
 * Those are parameterised, so a new array is unavoidable; this one is not, and
 * the difference matters: it is used as a `useEffect` dependency, where a new
 * array identity on every render re-runs the effect (and its cleanup) forever.
 */
const PLANNER_STATE_KEY = ['planner', 'state'] as const;

export const plannerKeys = {
  state: () => PLANNER_STATE_KEY,
};

/**
 * Carries the status alongside the message. The planner needs to tell a 401
 * ("your session ended — stop pretending these saves are landing") apart from a
 * 503 ("the database blinked — this will retry"), and the two want very
 * different words in front of the reader.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    // Message shape preserved from Phase 3: the browse-error banner renders it.
    super(`${status} ${detail}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readError(response: Response): Promise<ApiError> {
  const detail = await response
    .json()
    .then((body: unknown) =>
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : response.statusText,
    )
    .catch(() => response.statusText);
  return new ApiError(response.status, detail);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    // `/api/recipes` answers 503 rather than an empty list when the database is
    // unreachable, precisely so this can surface as an error instead of as
    // "you have no recipes".
    throw await readError(response);
  }
  return (await response.json()) as T;
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
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

// ── Planner state (Phase 4) ─────────────────────────────────────────────────

/**
 * Every mutating planner endpoint answers with the *whole* state rather than
 * just the row it touched. That is deliberate: it makes each response a
 * complete correction of the cache, so a mutation that raced with another tab
 * self-heals on the next round-trip instead of leaving the two out of step.
 */
export interface PlannerImportResult extends PlannerState {
  savedAdded: number;
  checkedAdded: number;
  skipped: number;
}

export function fetchPlannerState(): Promise<PlannerState> {
  return getJson<PlannerState>('/api/planner');
}

/** `batches: null` unpicks. */
export function savePlannerRecipe(recipeId: string, batches: number | null): Promise<PlannerState> {
  return sendJson<PlannerState>('/api/planner/saved', 'PATCH', { recipeId, batches });
}

export function clearPlannerSaved(): Promise<PlannerState> {
  return sendJson<PlannerState>('/api/planner/saved', 'DELETE');
}

export function setPlannerCheck(itemKey: string, checked: boolean): Promise<PlannerState> {
  return sendJson<PlannerState>('/api/planner/checks', 'PATCH', { itemKey, checked });
}

export function clearPlannerChecks(): Promise<PlannerState> {
  return sendJson<PlannerState>('/api/planner/checks', 'DELETE');
}

export function importPlannerState(local: {
  saved: SavedMap;
  checked: CheckedMap;
}): Promise<PlannerImportResult> {
  return sendJson<PlannerImportResult>('/api/planner/import', 'POST', local);
}

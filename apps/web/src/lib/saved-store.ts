'use client';

/**
 * Picks and grocery check-offs — in `localStorage` signed out, in
 * `saved_recipes` / `grocery_checks` signed in.
 *
 * PLAN.md §5, Phase 4: "`saved_recipes` and `grocery_checks` move server-side"
 * and "One-time migration of existing `localStorage` state into the account on
 * first sign-in." The important half of that phase is the half the plan does
 * *not* say out loud: signing in is not a prerequisite for using the planner.
 * Signed out, this behaves exactly as it did in Phase 3.
 *
 * Both backends are hooks, so both run on every render and the choice is made
 * at the end. That is not waste — it is the rule about conditional hooks — but
 * it does mean the `localStorage` half must not *write* while the server half
 * is the live one, or signing in would start overwriting the very state the
 * first-sign-in migration reads. Hence `active`.
 *
 * The two shapes (`{recipeId: batches}`, `{itemKey: true}`) and the merge rules
 * live in `@recipes/shared/planner`, because the API routes need to agree with
 * them and this module is client-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_BATCHES,
  MIN_BATCHES,
  clampBatches,
  type CheckedMap,
  type PlannerState,
  type SavedMap,
} from '@recipes/shared/planner';
import {
  ApiError,
  clearPlannerChecks,
  clearPlannerSaved,
  fetchPlannerState,
  importPlannerState,
  plannerKeys,
  savePlannerRecipe,
  setPlannerCheck,
} from './api';

export type { CheckedMap, SavedMap };
export { MAX_BATCHES, MIN_BATCHES };

/**
 * `v2`, not the artifact's `v1`: the keys inside changed meaning. `v1` held
 * hand-authored slugs like `sheetpan-chili-chicken`; these are recipe UUIDs.
 */
export const SAVED_KEY = 'mealprep:v2:saved';
export const CHECKED_KEY = 'mealprep:v2:checked';

/**
 * Which accounts this browser has already migrated into. A list rather than a
 * flag because two people can share a browser, and the second one's first
 * sign-in deserves the same migration the first one got.
 */
export const MIGRATED_KEY = 'mealprep:v2:migrated';

const EMPTY_STATE: PlannerState = { saved: {}, checked: {} };

// ── localStorage ────────────────────────────────────────────────────────────

function readJson<T>(key: string, isValid: (value: unknown) => value is T, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isSavedMap(value: unknown): value is SavedMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function isCheckedMap(value: unknown): value is CheckedMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === true)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** What this browser is holding for a signed-out reader. */
export function readLocalPlannerState(): PlannerState {
  return {
    saved: readJson(SAVED_KEY, isSavedMap, {}),
    checked: readJson(CHECKED_KEY, isCheckedMap, {}),
  };
}

export function isEmptyPlannerState(state: PlannerState): boolean {
  return Object.keys(state.saved).length === 0 && Object.keys(state.checked).length === 0;
}

function hasMigrated(userId: string): boolean {
  return readJson(MIGRATED_KEY, isStringArray, []).includes(userId);
}

function markMigrated(userId: string): void {
  try {
    const seen = readJson(MIGRATED_KEY, isStringArray, []);
    if (seen.includes(userId)) return;
    window.localStorage.setItem(MIGRATED_KEY, JSON.stringify([...seen, userId]));
  } catch {
    // A browser that will not remember the migration ran will simply run it
    // again next time. The import is idempotent precisely so this is safe.
  }
}

// ── Public shape ────────────────────────────────────────────────────────────

/** The subset of the signed-in user this module and the header need. */
export interface PlannerUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/** What a completed first-sign-in migration brought over. */
export interface MigrationResult {
  savedAdded: number;
  checkedAdded: number;
  /** Picks whose recipe no longer exists — worth saying, not worth alarming. */
  skipped: number;
}

export interface PlannerStore {
  saved: SavedMap;
  checked: CheckedMap;
  /** True once the backing store has been read; the first render must not persist. */
  loaded: boolean;
  /** Set when a write failed, so the UI can say so rather than lying. */
  warning: string;
  /** Where these picks live right now — drives the header's wording. */
  persistence: 'local' | 'account';
  /** Non-null for one page-load after a first sign-in imported local picks. */
  migration: MigrationResult | null;
  toggleSaved: (recipeId: string) => void;
  setBatches: (recipeId: string, batches: number) => void;
  clearSaved: () => void;
  toggleChecked: (itemKey: string) => void;
  clearChecked: () => void;
}

// ── Signed-out backend ──────────────────────────────────────────────────────

function useLocalPlannerStore(active: boolean): Omit<PlannerStore, 'persistence' | 'migration'> {
  const [saved, setSaved] = useState<SavedMap>({});
  const [checked, setChecked] = useState<CheckedMap>({});
  const [loaded, setLoaded] = useState(false);
  const [warning, setWarning] = useState('');

  // Read after mount, never during render: the server has no localStorage, and
  // seeding state from it during the first client render is a hydration
  // mismatch waiting to happen.
  useEffect(() => {
    const local = readLocalPlannerState();
    setSaved(local.saved);
    setChecked(local.checked);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || !active) return;
    try {
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
      setWarning('');
    } catch {
      setWarning("Picks aren't saving right now — they'll last until you close this tab.");
    }
  }, [saved, loaded, active]);

  useEffect(() => {
    if (!loaded || !active) return;
    try {
      window.localStorage.setItem(CHECKED_KEY, JSON.stringify(checked));
    } catch {
      // Non-critical: an unsaved check-off costs a second glance at the list.
    }
  }, [checked, loaded, active]);

  const toggleSaved = useCallback((recipeId: string) => {
    setSaved((previous) => {
      const next = { ...previous };
      if (next[recipeId]) delete next[recipeId];
      else next[recipeId] = 1;
      return next;
    });
  }, []);

  const setBatches = useCallback((recipeId: string, batches: number) => {
    setSaved((previous) => ({ ...previous, [recipeId]: clampBatches(batches) }));
  }, []);

  const clearSaved = useCallback(() => setSaved({}), []);

  const toggleChecked = useCallback((itemKey: string) => {
    setChecked((previous) => {
      const next = { ...previous };
      if (next[itemKey]) delete next[itemKey];
      else next[itemKey] = true;
      return next;
    });
  }, []);

  const clearChecked = useCallback(() => setChecked({}), []);

  return {
    saved,
    checked,
    loaded,
    warning,
    toggleSaved,
    setBatches,
    clearSaved,
    toggleChecked,
    clearChecked,
  };
}

// ── Signed-in backend ───────────────────────────────────────────────────────

/**
 * Every planner mutation shares this shape: patch the cache immediately, send
 * the request, and let the server's reply — which is always the complete state
 * — be the final word.
 *
 * `scope` serialises them. Without it TanStack runs mutations concurrently, and
 * because each response overwrites the whole cache, a slow "tick item A" landing
 * after a fast "tick item B" would resurrect the pre-B state. Sharing one scope
 * id makes the queue FIFO, so the last response is always the newest.
 */
function usePlannerMutation<TArgs>(
  mutationFn: (args: TArgs) => Promise<PlannerState>,
  patch: (state: PlannerState, args: TArgs) => PlannerState,
  onFailure: (error: unknown) => void,
) {
  const queryClient = useQueryClient();
  const key = plannerKeys.state();

  return useMutation({
    scope: { id: 'planner-state' },
    mutationFn,
    async onMutate(args: TArgs) {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PlannerState>(key);
      queryClient.setQueryData<PlannerState>(key, patch(previous ?? EMPTY_STATE, args));
      return { previous };
    },
    onError(error, _args, context) {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
      onFailure(error);
    },
    onSuccess(state) {
      queryClient.setQueryData<PlannerState>(key, state);
    },
  });
}

function useServerPlannerStore(
  user: PlannerUser | null,
  initialState: PlannerState | undefined,
): Omit<PlannerStore, 'persistence'> {
  const queryClient = useQueryClient();
  const key = plannerKeys.state();
  const [warning, setWarning] = useState('');
  const [migration, setMigration] = useState<MigrationResult | null>(null);

  const onFailure = useCallback((error: unknown) => {
    setWarning(
      error instanceof ApiError && error.status === 401
        ? 'Your session ended, so that change was not saved. Sign in again to keep your picks.'
        : "That change didn't save. Check your connection and try again.",
    );
  }, []);

  const query = useQuery({
    queryKey: key,
    queryFn: fetchPlannerState,
    enabled: user !== null,
    initialData: user !== null ? initialState : undefined,
    // The server rendered this exact state; a refetch on mount is a wasted
    // round-trip on every page load, same reasoning as the browse feed.
    initialDataUpdatedAt: () => Date.now(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const state = query.data ?? EMPTY_STATE;

  const saveRecipe = usePlannerMutation(
    ({ recipeId, batches }: { recipeId: string; batches: number | null }) =>
      savePlannerRecipe(recipeId, batches),
    (previous, { recipeId, batches }) => {
      const saved = { ...previous.saved };
      if (batches === null) delete saved[recipeId];
      else saved[recipeId] = batches;
      return { ...previous, saved };
    },
    onFailure,
  );

  const clearSavedMutation = usePlannerMutation<void>(
    () => clearPlannerSaved(),
    (previous) => ({ ...previous, saved: {} }),
    onFailure,
  );

  const setCheck = usePlannerMutation(
    ({ itemKey, checked }: { itemKey: string; checked: boolean }) =>
      setPlannerCheck(itemKey, checked),
    (previous, { itemKey, checked }) => {
      const next = { ...previous.checked };
      if (checked) next[itemKey] = true;
      else delete next[itemKey];
      return { ...previous, checked: next };
    },
    onFailure,
  );

  const clearChecksMutation = usePlannerMutation<void>(
    () => clearPlannerChecks(),
    (previous) => ({ ...previous, checked: {} }),
    onFailure,
  );

  // ── First sign-in migration ───────────────────────────────────────────────
  // Guarded three ways, because "run exactly once" is the whole requirement:
  // a per-user marker in localStorage across page loads, a ref against React
  // re-running the effect, and an idempotent server endpoint against both
  // failing at once (two tabs signing in together).
  const migrating = useRef(false);
  const userId = user?.id ?? null;

  // Depends on the *id*, not the user object: `user` is rebuilt by the server
  // render on every navigation, and an unstable dependency here re-runs the
  // effect continuously. There is deliberately no cleanup — an unmount must not
  // abandon an in-flight import, because the marker is written when the request
  // resolves and a discarded response would leave the account migrated but the
  // cache stale, with nothing to trigger a retry.
  useEffect(() => {
    if (userId === null || migrating.current) return;
    if (hasMigrated(userId)) return;

    const local = readLocalPlannerState();
    if (isEmptyPlannerState(local)) {
      markMigrated(userId);
      return;
    }

    migrating.current = true;

    importPlannerState(local)
      .then((result) => {
        markMigrated(userId);
        queryClient.setQueryData<PlannerState>(plannerKeys.state(), {
          saved: result.saved,
          checked: result.checked,
        });
        if (result.savedAdded + result.checkedAdded > 0) {
          setMigration({
            savedAdded: result.savedAdded,
            checkedAdded: result.checkedAdded,
            skipped: result.skipped,
          });
        }
      })
      .catch(() => {
        // Left unmarked on purpose: a failed migration should be retried on the
        // next load rather than silently swallowing someone's picks.
        migrating.current = false;
      });
  }, [userId, queryClient]);

  const toggleSaved = useCallback(
    (recipeId: string) => {
      const current = queryClient.getQueryData<PlannerState>(key)?.saved ?? {};
      saveRecipe.mutate({ recipeId, batches: current[recipeId] === undefined ? 1 : null });
    },
    [saveRecipe, queryClient, key],
  );

  const setBatches = useCallback(
    (recipeId: string, batches: number) => {
      saveRecipe.mutate({ recipeId, batches: clampBatches(batches) });
    },
    [saveRecipe],
  );

  const toggleChecked = useCallback(
    (itemKey: string) => {
      const current = queryClient.getQueryData<PlannerState>(key)?.checked ?? {};
      setCheck.mutate({ itemKey, checked: current[itemKey] === undefined });
    },
    [setCheck, queryClient, key],
  );

  const clearSaved = useCallback(() => clearSavedMutation.mutate(), [clearSavedMutation]);
  const clearChecked = useCallback(() => clearChecksMutation.mutate(), [clearChecksMutation]);

  const readWarning =
    query.isError && query.error instanceof ApiError && query.error.status === 401
      ? 'Your session ended. Sign in again to see the picks saved to your account.'
      : query.isError
        ? "Couldn't load your saved picks. They're safe — this will retry."
        : '';

  return {
    saved: state.saved,
    checked: state.checked,
    loaded: user !== null && !query.isPending,
    warning: warning || readWarning,
    migration,
    toggleSaved,
    setBatches,
    clearSaved,
    toggleChecked,
    clearChecked,
  };
}

// ── The one the planner calls ───────────────────────────────────────────────

/**
 * @param user         the signed-in reader, or `null` for the `localStorage`
 *                     path. Server-rendered, so there is no signed-out flash.
 * @param initialState that reader's picks as of the server render, so the
 *                     picks tab is populated on first paint.
 */
export function usePlannerStore(
  user: PlannerUser | null,
  initialState?: PlannerState,
): PlannerStore {
  const signedIn = user !== null;
  const local = useLocalPlannerStore(!signedIn);
  const server = useServerPlannerStore(user, initialState);

  return useMemo(
    () =>
      signedIn
        ? { ...server, persistence: 'account' as const }
        : { ...local, persistence: 'local' as const, migration: null },
    [signedIn, server, local],
  );
}

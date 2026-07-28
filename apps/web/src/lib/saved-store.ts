/**
 * Picks and grocery check-offs, in `localStorage`.
 *
 * PLAN.md §5, Phase 3: "Saves/checks still in `localStorage` at this stage."
 * Phase 4 moves both into `saved_recipes` / `grocery_checks` and migrates
 * whatever is here on first sign-in, so the two shapes are already the shapes
 * of those tables: `{recipeId: batches}` and `{itemKey: true}`, where
 * `itemKey` is `grocery_checks.item_key` from `@recipes/shared/grocery`.
 *
 * The artifact used `window.storage`, an async host API that does not exist in
 * a browser. This is plain `localStorage`, wrapped so that a private-mode
 * quota error degrades to "your picks last until you close the tab" instead of
 * throwing inside a render.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * `v2`, not the artifact's `v1`: the keys inside changed meaning. `v1` held
 * hand-authored slugs like `sheetpan-chili-chicken`; these are recipe UUIDs.
 */
export const SAVED_KEY = 'mealprep:v2:saved';
export const CHECKED_KEY = 'mealprep:v2:checked';

export type SavedMap = Record<string, number>;
export type CheckedMap = Record<string, true>;

export const MIN_BATCHES = 1;
export const MAX_BATCHES = 4;

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

export interface PlannerStore {
  saved: SavedMap;
  checked: CheckedMap;
  /** True once localStorage has been read; the first render must not persist. */
  loaded: boolean;
  /** Set when a write failed, so the UI can say so rather than lying. */
  warning: string;
  toggleSaved: (recipeId: string) => void;
  setBatches: (recipeId: string, batches: number) => void;
  clearSaved: () => void;
  toggleChecked: (itemKey: string) => void;
  clearChecked: () => void;
}

export function usePlannerStore(): PlannerStore {
  const [saved, setSaved] = useState<SavedMap>({});
  const [checked, setChecked] = useState<CheckedMap>({});
  const [loaded, setLoaded] = useState(false);
  const [warning, setWarning] = useState('');

  // Read after mount, never during render: the server has no localStorage, and
  // seeding state from it during the first client render is a hydration
  // mismatch waiting to happen.
  useEffect(() => {
    setSaved(readJson(SAVED_KEY, isSavedMap, {}));
    setChecked(readJson(CHECKED_KEY, isCheckedMap, {}));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
      setWarning('');
    } catch {
      setWarning("Picks aren't saving right now — they'll last until you close this tab.");
    }
  }, [saved, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(CHECKED_KEY, JSON.stringify(checked));
    } catch {
      // Non-critical: an unsaved check-off costs a second glance at the list.
    }
  }, [checked, loaded]);

  const toggleSaved = useCallback((recipeId: string) => {
    setSaved((previous) => {
      const next = { ...previous };
      if (next[recipeId]) delete next[recipeId];
      else next[recipeId] = 1;
      return next;
    });
  }, []);

  const setBatches = useCallback((recipeId: string, batches: number) => {
    setSaved((previous) => ({
      ...previous,
      [recipeId]: Math.max(MIN_BATCHES, Math.min(MAX_BATCHES, Math.round(batches))),
    }));
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

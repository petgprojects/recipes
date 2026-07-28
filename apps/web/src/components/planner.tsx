'use client';

/**
 * The planner shell: the artifact's three tabs, now over live data.
 *
 * The one structural addition is the **shown / live split**. The browse list
 * the reader is scrolling (`shown`) is a snapshot; the polled query result
 * (`live`) is the truth. When the two differ, that surfaces as a pill —
 * PLAN.md §5: "Surface it as a '7 new recipes — show them' pill rather than
 * silently re-sorting the list under someone mid-scroll."
 *
 * The pill counts *ids it has never shown*, not rows newer than a timestamp.
 * `last_seen_at` moves for every recipe a re-crawl re-observes, and Phase 2
 * publishes a pending row as `active` without touching it — an id diff is
 * correct under both, and cannot announce 235 new recipes because a scan
 * finished (PROGRESS.md amendment A13).
 */

import { useCallback, useMemo, useState } from 'react';
import { CATEGORY_FILTER_ALL, CATEGORY_FILTER_UI } from '@recipes/shared/vocab';
import { countGroceryItems } from '@recipes/shared/grocery';
import type { PlannerState } from '@recipes/shared/planner';
import {
  useGroceryQuery,
  useRecipesQuery,
  useSavedRecipeDetails,
  type GroceryPick,
} from '@/lib/api';
import { usePlannerStore, type PlannerUser } from '@/lib/saved-store';
import type { RecipeSummary } from '@/lib/recipe-types';
import { AuthControls } from './auth-controls';
import { GroceryReceipt } from './grocery-receipt';
import { PicksList } from './picks-list';
import { RecipeCard } from './recipe-card';
import { RecipeSheet } from './recipe-sheet';

type Tab = 'browse' | 'picks' | 'list';

/** "1 pick" / "3 picks" — the migration notice reads as a sentence either way. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface PlannerProps {
  initialRecipes: RecipeSummary[];
  /** The signed-in reader, resolved server-side. `null` is a normal state. */
  user: PlannerUser | null;
  /** That reader's picks as of the server render; absent when signed out. */
  initialPlannerState?: PlannerState;
  /** Whether Google sign-in is configured at all (Phase 4 secrets present). */
  authEnabled: boolean;
}

export function Planner({
  initialRecipes,
  user,
  initialPlannerState,
  authEnabled,
}: PlannerProps) {
  const [tab, setTab] = useState<Tab>('browse');
  const [category, setCategory] = useState<string>(CATEGORY_FILTER_ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState<RecipeSummary[]>(initialRecipes);

  const store = usePlannerStore(user, initialPlannerState);
  const { data: live, isError, error, isFetching } = useRecipesQuery(initialRecipes);

  const shownIds = useMemo(() => new Set(shown.map((recipe) => recipe.id)), [shown]);
  const incoming = useMemo(
    () => live.filter((recipe) => !shownIds.has(recipe.id)),
    [live, shownIds],
  );
  const showIncoming = useCallback(() => {
    setShown(live);
    setTab('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [live]);

  const savedIds = useMemo(() => Object.keys(store.saved), [store.saved]);
  const savedDetails = useSavedRecipeDetails(savedIds);

  const byId = useMemo(() => {
    const map = new Map<string, RecipeSummary>();
    for (const recipe of live) map.set(recipe.id, recipe);
    for (const recipe of shown) if (!map.has(recipe.id)) map.set(recipe.id, recipe);
    return map;
  }, [live, shown]);

  /** A saved recipe may have left the browse feed; its detail still resolves. */
  const savedRecipes = useMemo(
    () =>
      savedIds
        .map((id, index) => byId.get(id) ?? savedDetails[index]?.data ?? null)
        .filter((recipe): recipe is RecipeSummary => recipe !== null),
    [savedIds, byId, savedDetails],
  );

  /**
   * Phase 5: the list is merged in SQL, so all the client sends is the picks.
   * A signed-in reader's `saved_recipes` is authoritative and the server
   * ignores this — it is sent anyway so there is one request shape either way.
   */
  const groceryPicks = useMemo<GroceryPick[]>(
    () => savedIds.map((recipeId) => ({ recipeId, batches: store.saved[recipeId] ?? 1 })),
    [savedIds, store.saved],
  );

  const groceryQuery = useGroceryQuery(groceryPicks, groceryPicks.length > 0);
  const groceries = useMemo(() => groceryQuery.data ?? [], [groceryQuery.data]);
  const itemCount = countGroceryItems(groceries);
  const groceriesLoading = groceryQuery.isPending && groceryPicks.length > 0;

  const visible = useMemo(
    () =>
      category === CATEGORY_FILTER_ALL
        ? shown
        : shown.filter((recipe) => recipe.category === category),
    [shown, category],
  );

  const totalServings = savedRecipes.reduce(
    (sum, recipe) => sum + (recipe.servings ?? 0) * (store.saved[recipe.id] ?? 1),
    0,
  );

  const sourceNames = useMemo(() => {
    const names = [...new Set(shown.map((recipe) => recipe.sourceName))].sort();
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }, [shown]);

  const open = openId === null ? null : (byId.get(openId) ?? null);
  const pickedCount = savedIds.length;

  return (
    <div className="mp">
      <div className="mp-wrap">
        <header className="mp-head">
          <div className="mp-eyebrow">
            {shown.length} recipes · sourced &amp; credited
            <span className="mp-eyebrow-end">
              <a className="mp-ops-link" href="/ops">
                Operations
              </a>
              <AuthControls user={user} enabled={authEnabled} />
            </span>
          </div>
          <h1 className="mp-title">
            Cook once.
            <br />
            <em>Eat all week.</em>
          </h1>
          <p className="mp-sub">
            Meal-prep recipes people actually make twice, crawled from{' '}
            {sourceNames === '' ? 'the sources in /ops' : sourceNames}. Pick what you want, and the
            shopping list writes itself.
          </p>
        </header>

        <nav className="mp-tabs">
          <button className="mp-tab" data-on={tab === 'browse'} onClick={() => setTab('browse')}>
            Browse
          </button>
          <button className="mp-tab" data-on={tab === 'picks'} onClick={() => setTab('picks')}>
            My picks
            {pickedCount > 0 && <span className="mp-tab-n">{pickedCount}</span>}
          </button>
          <button className="mp-tab" data-on={tab === 'list'} onClick={() => setTab('list')}>
            Grocery list
          </button>
        </nav>

        {incoming.length > 0 && (
          <button className="mp-pill" onClick={showIncoming}>
            {incoming.length} new {incoming.length === 1 ? 'recipe' : 'recipes'} — show{' '}
            {incoming.length === 1 ? 'it' : 'them'}
          </button>
        )}

        {store.migration !== null && (
          <p className="mp-note">
            Moved {countLabel(store.migration.savedAdded, 'pick')} and{' '}
            {countLabel(store.migration.checkedAdded, 'ticked item')} from this browser into your
            account.
            {store.migration.skipped > 0 &&
              ` ${countLabel(store.migration.skipped, 'pick')} could not come over — those recipes are no longer in the feed.`}
          </p>
        )}

        {store.warning !== '' && <p className="mp-note">{store.warning}</p>}
        {isError && (
          <p className="mp-note">
            Couldn&apos;t reach the recipe service ({error instanceof Error ? error.message : 'unknown error'}).
            Showing the last list that loaded; it will retry on its own.
          </p>
        )}

        {tab === 'browse' && (
          <>
            <div className="mp-chips">
              {CATEGORY_FILTER_UI.map((option) => (
                <button
                  key={option}
                  className="mp-chip"
                  data-on={category === option}
                  onClick={() => setCategory(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <div className="mp-empty">
                <h3>Nothing here yet</h3>
                <p>
                  {shown.length === 0
                    ? 'No recipes have finished ingestion. Check /ops for the last scan.'
                    : `No ${category.toLowerCase()} recipes have come through yet. The next scan may bring some.`}
                </p>
              </div>
            ) : (
              <div className="mp-grid">
                {visible.map((recipe, index) => (
                  <RecipeCard
                    key={recipe.id}
                    recipe={recipe}
                    saved={store.saved[recipe.id] !== undefined}
                    priority={index < 2}
                    onToggleSave={store.toggleSaved}
                    onOpen={setOpenId}
                  />
                ))}
              </div>
            )}
            <p className="mp-note" aria-live="polite">
              {isFetching ? 'Checking for new recipes…' : 'Checks for new recipes every few minutes.'}
            </p>
          </>
        )}

        {tab === 'picks' && (
          <PicksList
            recipes={savedRecipes}
            saved={store.saved}
            onOpen={setOpenId}
            onToggleSave={store.toggleSaved}
            onSetBatches={store.setBatches}
            onClearAll={store.clearSaved}
          />
        )}

        {tab === 'list' && (
          <GroceryReceipt
            groups={groceries}
            checked={store.checked}
            recipeCount={pickedCount}
            totalServings={totalServings}
            itemCount={itemCount}
            loading={groceriesLoading}
            error={groceryQuery.error}
            onToggle={store.toggleChecked}
            onClearChecks={store.clearChecked}
          />
        )}
      </div>

      {open !== null && (
        <RecipeSheet
          recipe={open}
          saved={store.saved[open.id] !== undefined}
          batches={store.saved[open.id] ?? 1}
          onToggleSave={store.toggleSaved}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

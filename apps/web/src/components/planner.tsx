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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_FILTER_ALL, CATEGORY_FILTER_UI } from '@recipes/shared/vocab';
import { countGroceryItems } from '@recipes/shared/grocery';
import type { PlannerState } from '@recipes/shared/planner';
import type { HardRule } from '@recipes/shared/personalization';
import {
  ApiError,
  useGroceryQuery,
  useRecipesQuery,
  useSavedRecipeDetails,
  useSearchQuery,
  type GroceryPick,
} from '@/lib/api';
import { usePlannerStore, type PlannerUser } from '@/lib/saved-store';
import type { RecipeSummary } from '@/lib/recipe-types';
import { AuthControls } from './auth-controls';
import { GroceryReceipt } from './grocery-receipt';
import { HardRules } from './hard-rules';
import { PicksList } from './picks-list';
import { RecipeCard } from './recipe-card';
import { RecipeSheet } from './recipe-sheet';
import { SearchBar } from './search-bar';

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
  /**
   * The Phase 7 hard rules already applied to `initialRecipes`. Passed so the
   * panel renders filled on the first paint rather than popping in — and so
   * what the reader sees listed is exactly what filtered the feed they got.
   */
  initialHardRules?: HardRule[];
  /** Whether Google sign-in is configured at all (Phase 4 secrets present). */
  authEnabled: boolean;
  /**
   * `?q=` as the server saw it, so a shared link renders with its query already
   * in the box (FILTER_PLAN.md §7, Phase 5). The search itself still runs on
   * the client — it is a billable call and the server render must not make one.
   */
  initialQuery?: string;
  /** False at the §8 budget gate: the bar renders disabled, never hidden. */
  searchAvailable?: boolean;
}

export function Planner({
  initialRecipes,
  user,
  initialPlannerState,
  initialHardRules = [],
  authEnabled,
  initialQuery = '',
  searchAvailable = false,
}: PlannerProps) {
  const [tab, setTab] = useState<Tab>('browse');
  const [category, setCategory] = useState<string>(CATEGORY_FILTER_ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState<RecipeSummary[]>(initialRecipes);
  const [query, setQuery] = useState<string>(initialQuery);

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

  // ── Search (FILTER_PLAN Phase 5) ──────────────────────────────────────────
  //
  // `?q=` *is* the state. It is written with the native History API rather than
  // `router.push`, which Next 15 supports and which keeps this a client-side
  // transition: the page is `force-dynamic`, so a router push would re-run the
  // whole server render — a second browse query and a second session lookup —
  // to change a string this component already has. Shareable, because the URL
  // carries it; back-button-safe, because `popstate` puts it back.
  const searchQuery = useSearchQuery(query, user !== null);

  const goToQuery = useCallback(
    (next: string) => {
      if (next === query) return;
      // **Outside the state updater, deliberately.** `pushState` is a side
      // effect, and React calls an updater function more than once — twice
      // under StrictMode in development. Inside, one search pushed two
      // identical history entries and the back button needed two presses to
      // leave a query, which is exactly the kind of thing only a browser
      // check finds.
      window.history.pushState(
        null,
        '',
        next === '' ? window.location.pathname : `?q=${encodeURIComponent(next)}`,
      );
      setQuery(next);
      // A search answers a question the chips were narrowing, so the chips
      // start over. Leaving "Soup" selected would silently hide most of the
      // results and look like the search returning almost nothing.
      setCategory(CATEGORY_FILTER_ALL);
      setTab('browse');
    },
    [query],
  );

  const clearSearch = useCallback(() => goToQuery(''), [goToQuery]);

  useEffect(() => {
    const onPopState = () => {
      setQuery(new URLSearchParams(window.location.search).get('q')?.trim() ?? '');
      setCategory(CATEGORY_FILTER_ALL);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  /**
   * Flipping a hard rule changes the feed, and that change must *not* arrive as
   * the "N new recipes" pill.
   *
   * The pill exists so a background poll cannot re-sort the list under someone
   * mid-scroll (A13). A rule switch is the opposite situation: the reader just
   * asked for this, they are looking at the panel that did it, and the recipes
   * it un-hides are not new — they are recipes we were hiding from them.
   * Announcing "10 new recipes" there would be a lie about where they came
   * from. So the next feed is adopted directly.
   */
  const adoptNextFeed = useRef(false);
  const onRulesChanged = useCallback(() => {
    adoptNextFeed.current = true;
  }, []);

  useEffect(() => {
    if (!adoptNextFeed.current) return;
    adoptNextFeed.current = false;
    setShown(live);
  }, [live]);

  const savedIds = useMemo(() => Object.keys(store.saved), [store.saved]);
  const savedDetails = useSavedRecipeDetails(savedIds);

  /**
   * Search results are in here too, and they have to be: a result the browse
   * feed is hiding — because a hard rule filtered it out, which §4.2 says a
   * search deliberately ignores — is still openable, and the sheet resolves its
   * recipe through this map.
   */
  const byId = useMemo(() => {
    const map = new Map<string, RecipeSummary>();
    for (const recipe of live) map.set(recipe.id, recipe);
    for (const recipe of shown) if (!map.has(recipe.id)) map.set(recipe.id, recipe);
    for (const recipe of searchQuery.data?.recipes ?? []) {
      if (!map.has(recipe.id)) map.set(recipe.id, recipe);
    }
    return map;
  }, [live, shown, searchQuery.data]);

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

  /**
   * What the grid is a list of: the browse feed, or the search results.
   *
   * The chips narrow *within* whichever it is (§7, Phase 5), which is why this
   * is one pipeline with two sources rather than two grids. While a search is
   * in flight the source is empty rather than the browse feed — leaving the
   * previous list under a "Searching…" label would read as the answer.
   */
  const searching = query !== '' && user !== null;
  const source = searching ? (searchQuery.data?.recipes ?? []) : shown;

  /**
   * The §8 gate, from either direction.
   *
   * The server render already knows the budget at page load, so the bar is
   * disabled before anyone types. A 503 arriving mid-session means the gate was
   * crossed while this tab was open, and it has to disable the bar too — it is
   * the same state, learned later.
   */
  const searchResting =
    !searchAvailable ||
    (searchQuery.error instanceof ApiError && searchQuery.error.status === 503);

  const visible = useMemo(
    () =>
      category === CATEGORY_FILTER_ALL
        ? source
        : source.filter((recipe) => recipe.category === category),
    [source, category],
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

        {/* Not while a search is on screen: the pill offers to replace the grid
            with the browse feed, and it would be replacing the results someone
            just asked for with a list they did not. */}
        {incoming.length > 0 && !searching && (
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
            {/* Signed-in only (§8). Unlike the grocery list there is nothing to
                migrate on a later sign-in, so this follows ratings: the
                endpoint 401s and the control is not rendered at all. */}
            {user !== null && (
              <SearchBar
                query={query}
                available={!searchResting}
                pending={searchQuery.isFetching}
                notices={searchQuery.data?.notices ?? []}
                resultCount={searchQuery.data?.recipes.length ?? null}
                // Suppressed while resting: the bar already says why in its own
                // words, and repeating it as a failure would make a budget the
                // reader cannot see look like something that broke.
                error={searchResting ? null : searchQuery.error}
                onSearch={goToQuery}
                onClear={clearSearch}
              />
            )}

            <HardRules
              signedIn={user !== null}
              initialRules={initialHardRules}
              onChanged={onRulesChanged}
            />

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
                {/* A search that found nothing is not an empty database, and
                    §4.4's ladder has already been down two rungs by the time
                    this renders — so this is the genuine empty state it ends
                    with, and the notices above say what was tried.

                    While it is still running the heading must not say
                    "Nothing matched": a search can take twenty seconds, and
                    for all of them the page would be asserting an answer it
                    does not have yet. Seen in the browser, and it is the same
                    confidently-wrong failure the notices exist to prevent. */}
                <h3>
                  {searching
                    ? searchQuery.isFetching
                      ? 'Searching…'
                      : 'Nothing matched'
                    : 'Nothing here yet'}
                </h3>
                <p>
                  {searching
                    ? searchQuery.isFetching
                      ? 'Reading your query and looking through the collection.'
                      : source.length === 0
                        ? 'No recipes match that, even after loosening it. Try fewer constraints, or a different ingredient.'
                        : `Nothing in ${category.toLowerCase()} matched. The other chips still have results.`
                    : shown.length === 0
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
            {/* The poller is still running underneath a search, but saying so
                under a list it did not produce would claim the results are
                being kept fresh. They are a snapshot of one query. */}
            {!searching && (
              <p className="mp-note" aria-live="polite">
                {isFetching
                  ? 'Checking for new recipes…'
                  : 'Checks for new recipes every few minutes.'}
              </p>
            )}
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
          signedIn={user !== null}
          onToggleSave={store.toggleSaved}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

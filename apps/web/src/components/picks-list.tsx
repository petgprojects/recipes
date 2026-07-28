'use client';

/**
 * "My picks": the saved recipes and their batch multipliers.
 *
 * The multiplier is `saved_recipes.batches` in everything but storage — Phase 4
 * moves the map server-side without this component changing.
 */

import { fmtKeeps, fmtTime } from '@recipes/shared/format';
import { MAX_BATCHES, MIN_BATCHES } from '@/lib/saved-store';
import type { RecipeSummary } from '@/lib/recipe-types';

interface PicksListProps {
  recipes: readonly RecipeSummary[];
  saved: Record<string, number>;
  onOpen: (recipeId: string) => void;
  onToggleSave: (recipeId: string) => void;
  onSetBatches: (recipeId: string, batches: number) => void;
  onClearAll: () => void;
}

export function PicksList({
  recipes,
  saved,
  onOpen,
  onToggleSave,
  onSetBatches,
  onClearAll,
}: PicksListProps) {
  if (recipes.length === 0) {
    return (
      <div className="mp-empty">
        <h3>Nothing saved yet</h3>
        <p>
          Head to Browse and save a few. Four or five recipes usually covers a week without you
          getting bored of any one of them.
        </p>
      </div>
    );
  }

  const totalServings = recipes.reduce(
    (sum, recipe) => sum + (recipe.servings ?? 0) * (saved[recipe.id] ?? 1),
    0,
  );

  return (
    <>
      <div className="mp-bar">
        <div className="mp-mini">
          {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'}
          {totalServings > 0 && ` · ${totalServings} servings`}
        </div>
        <button className="mp-mini" onClick={onClearAll}>
          Clear all
        </button>
      </div>

      <div className="mp-grid mp-grid-single">
        {recipes.map((recipe) => {
          const batches = saved[recipe.id] ?? 1;
          const keeps = fmtKeeps(recipe.keepsDays, recipe.freezerMonths);
          const time = fmtTime(recipe.totalMinutes);
          const servings = recipe.servings === null ? null : recipe.servings * batches;

          return (
            <div key={recipe.id} className="mp-row">
              <button className="mp-row-main" onClick={() => onOpen(recipe.id)}>
                <div className="mp-row-name">{recipe.title}</div>
                <div className="mp-row-meta">
                  {[time, servings === null ? '' : `${servings} servings`, keeps === '' ? '' : `keeps ${keeps}`]
                    .filter((part) => part !== '')
                    .join(' · ')}
                </div>
              </button>
              <div className="mp-step">
                <button
                  onClick={() => onSetBatches(recipe.id, batches - 1)}
                  disabled={batches <= MIN_BATCHES}
                  aria-label={`Fewer batches of ${recipe.title}`}
                >
                  −
                </button>
                <span aria-label="batches">{batches}×</span>
                <button
                  onClick={() => onSetBatches(recipe.id, batches + 1)}
                  disabled={batches >= MAX_BATCHES}
                  aria-label={`More batches of ${recipe.title}`}
                >
                  +
                </button>
              </div>
              <button
                className="mp-pick"
                data-on
                onClick={() => onToggleSave(recipe.id)}
                aria-label={`Remove ${recipe.title}`}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <p className="mp-note">
        Tap a recipe to read it. The multiplier scales that recipe&apos;s ingredients on the grocery
        list — useful when one dish is doing double duty as lunch and dinner.
      </p>
    </>
  );
}

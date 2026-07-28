'use client';

/**
 * The browse card. Structurally the artifact's `.mp-card`, with three things
 * real scraped data forced:
 *
 *   - a photo, which may not exist (see `RecipePhoto`);
 *   - `keeps` assembled from two nullable columns rather than a hand-written
 *     string, and omitted entirely when neither is known;
 *   - an optional source rating — 9 of 21 probed pages published none and The
 *     Kitchn never does (PROGRESS.md, Phase 1), so it is a line that appears
 *     rather than a line that is sometimes empty.
 */

import { fmtKeeps, fmtRating, fmtTime } from '@recipes/shared/format';
import type { RecipeSummary } from '@/lib/recipe-types';
import { RecipePhoto } from './recipe-photo';

interface RecipeCardProps {
  recipe: RecipeSummary;
  saved: boolean;
  priority?: boolean;
  onToggleSave: (recipeId: string) => void;
  onOpen: (recipeId: string) => void;
}

export function RecipeCard({ recipe, saved, priority, onToggleSave, onOpen }: RecipeCardProps) {
  const keeps = fmtKeeps(recipe.keepsDays, recipe.freezerMonths);
  const rating = fmtRating(recipe.sourceRating, recipe.sourceRatingCount);
  const time = fmtTime(recipe.totalMinutes);

  return (
    <article className="mp-card" data-on={saved}>
      <RecipePhoto recipe={recipe} variant="card" priority={priority} />

      <div className="mp-card-top">
        <div>
          <h3 className="mp-card-name">{recipe.title}</h3>
          <div className="mp-card-src">
            {recipe.sourceName}
            {rating !== '' && <span className="mp-card-rating"> · {rating}</span>}
          </div>
        </div>
        <button
          className="mp-pick"
          data-on={saved}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${recipe.title}` : `Save ${recipe.title}`}
          onClick={() => onToggleSave(recipe.id)}
        >
          ✓
        </button>
      </div>

      {recipe.blurb !== null && <p className="mp-card-blurb">{recipe.blurb}</p>}

      <div className="mp-meta">
        {time !== '' && <span>{time}</span>}
        {recipe.servings !== null && <span>{recipe.servings} servings</span>}
        {keeps !== '' && <span>keeps {keeps}</span>}
      </div>

      <div className="mp-card-acts">
        <button
          className={saved ? 'mp-btn' : 'mp-btn mp-btn-fill'}
          onClick={() => onToggleSave(recipe.id)}
        >
          {saved ? 'Remove' : 'Save it'}
        </button>
        <button className="mp-btn" onClick={() => onOpen(recipe.id)}>
          Recipe
        </button>
      </div>
    </article>
  );
}

'use client';

/**
 * The detail sheet: hero photo, ingredients, method, attribution.
 *
 * It opens on a `RecipeSummary` the browse list already has, so the sheet is
 * on screen immediately, and fills in steps and ingredient lines when
 * `/api/recipes/:id` answers. Opening a sheet, closing it and opening it again
 * costs one request — TanStack Query caches the detail.
 *
 * Two rendering rules come from real data rather than the artifact:
 *
 *   - A mapped ingredient prints its parsed amount and canonical name, with the
 *     parser's note beside it. An *unmapped* one prints its raw line whole and
 *     leaves the amount column empty — the raw text already contains the
 *     quantity, and PLAN.md §4's promise is that an unmapped row still renders.
 *   - The link out is not decoration. PLAN.md §7: display our own blurb, always
 *     show the source name, always link to the original.
 */

import { useEffect } from 'react';
import { fmtKeeps, fmtLine, fmtRating, fmtTime } from '@recipes/shared/format';
import { useRecipeDetail } from '@/lib/api';
import type { RecipeSummary } from '@/lib/recipe-types';
import { RatingForm } from './rating-form';
import { RecipePhoto } from './recipe-photo';
import { ShareButton } from './share-button';

interface RecipeSheetProps {
  recipe: RecipeSummary;
  saved: boolean;
  batches: number;
  /** Whether a cook log can be written for this recipe right now (Phase 6). */
  signedIn: boolean;
  onToggleSave: (recipeId: string) => void;
  onClose: () => void;
}

export function RecipeSheet({
  recipe,
  saved,
  batches,
  signedIn,
  onToggleSave,
  onClose,
}: RecipeSheetProps) {
  const { data, isPending, isError, error } = useRecipeDetail(recipe.id);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const keeps = fmtKeeps(recipe.keepsDays, recipe.freezerMonths);
  const rating = fmtRating(recipe.sourceRating, recipe.sourceRatingCount);
  const time = fmtTime(recipe.totalMinutes);

  return (
    <div
      className="mp-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mp-sheet" role="dialog" aria-modal="true" aria-label={recipe.title}>
        <div className="mp-grab" />
        <RecipePhoto recipe={recipe} variant="hero" priority />

        <div className="mp-card-src">
          {recipe.sourceName}
          {rating !== '' && <span className="mp-card-rating"> · {rating}</span>}
        </div>
        <h2>{recipe.title}</h2>
        {recipe.blurb !== null && <p className="mp-card-blurb">{recipe.blurb}</p>}

        <div className="mp-meta">
          {time !== '' && <span>{time}</span>}
          {recipe.servings !== null && <span>{recipe.servings} servings</span>}
          {keeps !== '' && <span>keeps {keeps}</span>}
        </div>

        {recipe.tags.length > 0 && (
          <div className="mp-tagrow">
            {recipe.tags.map((tag) => (
              <span key={tag} className="mp-tag">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mp-h3">
          Ingredients
          {saved && batches > 1 ? ` — shown at 1×, list uses ${batches}×` : ''}
        </div>
        {isPending && <p className="mp-note">Loading the ingredients…</p>}
        {isError && (
          <p className="mp-note">
            Couldn&apos;t load the ingredients ({error instanceof Error ? error.message : 'unknown error'}).
            The full recipe is on {recipe.sourceName}.
          </p>
        )}
        {data !== undefined && (
          <ul className="mp-ing">
            {data.ingredients.map((line) => {
              const mapped = line.ingredientId !== null && line.name !== null;
              return (
                <li key={line.position}>
                  <b>{mapped ? fmtLine(line.qty, line.unit) : ''}</b>
                  <span>
                    {mapped ? line.name : line.rawText}
                    {mapped && line.note !== null && line.note !== '' && (
                      <span className="mp-ing-note"> — {line.note}</span>
                    )}
                    {line.optional && <span className="mp-ing-note"> (optional)</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mp-h3">Method</div>
        {data !== undefined && data.instructions.length > 0 ? (
          <ol className="mp-steps">
            {data.instructions.map((step, index) => (
              <li key={index}>
                {step.name !== undefined && step.name !== null && step.name !== '' && (
                  <strong className="mp-step-name">{step.name}. </strong>
                )}
                {step.text}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mp-note">
            {isPending
              ? 'Loading the method…'
              : `This source published no step list we could parse. Read it on ${recipe.sourceName}.`}
          </p>
        )}

        <div className="mp-h3">Rate it</div>
        <RatingForm recipeId={recipe.id} signedIn={signedIn} />

        <p className="mp-note">
          Recipe by {recipe.author ?? recipe.sourceName}.{' '}
          <a className="mp-link" href={recipe.sourceUrl} target="_blank" rel="noreferrer noopener">
            Read the original on {recipe.sourceName} →
          </a>
        </p>

        <div className="mp-card-acts mp-card-acts-spaced">
          <button
            className={saved ? 'mp-btn' : 'mp-btn mp-btn-fill'}
            onClick={() => onToggleSave(recipe.id)}
          >
            {saved ? 'Remove from picks' : 'Save it'}
          </button>
          {/* Beside the source link above rather than instead of it. That link
              is attribution and PLAN.md §7 requires it; this one is the recipe
              as *this* site renders it — our blurb, the parsed ingredient
              lines, and a "Save it" the recipient can actually press. */}
          <ShareButton recipe={recipe} />
          <button className="mp-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

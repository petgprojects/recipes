'use client';

/**
 * The after-cooking flow (PLAN.md §5, Phase 6): a star rating, aspect tags and
 * a free-text note, logged once per cook. Lives inside the detail sheet, next
 * to the pick/unpick action — rating and picking are both things a reader does
 * while looking at one recipe.
 *
 * Signed out, there is nowhere to put this: unlike the grocery list, a cook
 * log genuinely needs an account (`/api/ratings` answers 401), so the form is
 * replaced by a sign-in prompt rather than a `localStorage` draft with nothing
 * to migrate it into.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RATING_ASPECTS, type RatingAspect } from '@recipes/shared/vocab';
import { MAX_NOTES_LENGTH } from '@recipes/shared/ratings';
import type { CookLogEntry } from '@recipes/shared/ratings';
import { ApiError, cookLogKeys, createCookLog, deleteCookLog, useCookLogsQuery } from '@/lib/api';

const ASPECT_LABELS: Record<RatingAspect, string> = {
  quick: 'Quick',
  slow: 'Slow',
  cheap: 'Cheap',
  expensive: 'Expensive',
  tasty: 'Tasty',
  bland: 'Bland',
  reheats_well: 'Reheats well',
  soggy_leftovers: 'Soggy leftovers',
  too_much_cleanup: 'Too much cleanup',
  would_repeat: 'Would repeat',
};

function fmtCookedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

interface RatingFormProps {
  recipeId: string;
  signedIn: boolean;
}

export function RatingForm({ recipeId, signedIn }: RatingFormProps) {
  const queryClient = useQueryClient();
  const key = cookLogKeys.list(recipeId);
  const query = useCookLogsQuery(recipeId, signedIn);

  const [rating, setRating] = useState(0);
  const [aspects, setAspects] = useState<RatingAspect[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState('');

  if (!signedIn) {
    return <p className="mp-note">Sign in to log how it turned out.</p>;
  }

  function toggleAspect(aspect: RatingAspect) {
    setAspects((previous) =>
      previous.includes(aspect) ? previous.filter((a) => a !== aspect) : [...previous, aspect],
    );
  }

  async function submit() {
    if (rating === 0) {
      setWarning('Pick a star rating first.');
      return;
    }
    setSubmitting(true);
    setWarning('');
    try {
      const logs = await createCookLog({
        recipeId,
        rating,
        aspects,
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      queryClient.setQueryData<CookLogEntry[]>(key, logs);
      setRating(0);
      setAspects([]);
      setNotes('');
    } catch (error) {
      setWarning(
        error instanceof ApiError && error.status === 401
          ? 'Your session ended. Sign in again to log this.'
          : "That didn't save. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    try {
      const logs = await deleteCookLog(id, recipeId);
      queryClient.setQueryData<CookLogEntry[]>(key, logs);
    } catch {
      setWarning("Couldn't remove that entry — try again.");
    }
  }

  const logs = query.data ?? [];

  return (
    <div>
      <div className="mp-stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            className="mp-star"
            data-on={value <= rating}
            aria-label={`${value} star${value === 1 ? '' : 's'}`}
            aria-pressed={value <= rating}
            onClick={() => setRating(value)}
          >
            ★
          </button>
        ))}
      </div>

      <div className="mp-chips mp-chips-wrap">
        {RATING_ASPECTS.map((aspect) => (
          <button
            key={aspect}
            type="button"
            className="mp-chip"
            data-on={aspects.includes(aspect)}
            onClick={() => toggleAspect(aspect)}
          >
            {ASPECT_LABELS[aspect]}
          </button>
        ))}
      </div>

      <textarea
        className="mp-textarea"
        placeholder="Notes — what worked, what you'd change next time…"
        value={notes}
        maxLength={MAX_NOTES_LENGTH}
        onChange={(event) => setNotes(event.target.value)}
      />

      {warning !== '' && <p className="mp-note">{warning}</p>}

      <div className="mp-card-acts">
        <button className="mp-btn mp-btn-fill" disabled={submitting} onClick={submit}>
          {submitting ? 'Saving…' : 'Log this cook'}
        </button>
      </div>

      {logs.length > 0 && (
        <ul className="mp-cooklogs">
          {logs.map((log) => (
            <li key={log.id} className="mp-cooklog">
              <div className="mp-cooklog-top">
                <b className="mp-cooklog-stars">{fmtStars(log.rating)}</b>
                <span className="mp-cooklog-date">{fmtCookedAt(log.cookedAt)}</span>
              </div>
              {log.aspects.length > 0 && (
                <div className="mp-cooklog-aspects">
                  {log.aspects.map((aspect) => ASPECT_LABELS[aspect]).join(' · ')}
                </div>
              )}
              {log.notes !== null && log.notes !== '' && (
                <p className="mp-cooklog-notes">{log.notes}</p>
              )}
              <button className="mp-cooklog-remove" onClick={() => remove(log.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

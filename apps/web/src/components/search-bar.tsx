'use client';

/**
 * The search bar (FILTER_PLAN.md §7, Phase 5).
 *
 * Presentational, deliberately: the query lives in the URL and the planner owns
 * it, because `?q=` has to survive a reload, a shared link and the back button,
 * and a value that lived in here could do none of those.
 *
 * Two behaviours here are the plan rather than taste.
 *
 * **The bar is never hidden (§8).** At the 90% budget gate it renders disabled
 * with an explanation — "Search is resting until tomorrow." A control that
 * vanishes reads as a bug, and a reader who cannot find the search box has no
 * way to learn that it exists and is simply resting.
 *
 * **Every notice is shown (§4.2, §4.4, §5.1, A26).** A relaxed criterion, a
 * bypassed rule, a fallback from intersect to union and a failed parse are all
 * things the reader would otherwise have to infer from a list of recipes that
 * is not quite what they asked for. §4.4 is explicit that saying what was
 * dropped beats an empty state; the same argument covers all four.
 */

import { useEffect, useState } from 'react';
import { describeSearchNotice, type SearchNotice } from '@recipes/shared/search';

interface SearchBarProps {
  /** The query the URL currently carries. `''` means browse, not search. */
  query: string;
  /** Whether the search budget has anything left today (§8). */
  available: boolean;
  pending: boolean;
  /** Non-empty only once results are on screen. */
  notices: SearchNotice[];
  /** `null` until a search has answered. */
  resultCount: number | null;
  error: Error | null;
  onSearch: (query: string) => void;
  onClear: () => void;
}

export function SearchBar({
  query,
  available,
  pending,
  notices,
  resultCount,
  error,
  onSearch,
  onClear,
}: SearchBarProps) {
  const [draft, setDraft] = useState(query);

  // The URL is the source of truth, so the box follows it — otherwise the back
  // button would restore the results and leave the previous words in the input.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === '') {
      onClear();
      return;
    }
    onSearch(next);
  };

  return (
    <section className="mp-search">
      <form className="mp-search-form" onSubmit={submit} role="search">
        <input
          className="mp-search-input"
          type="search"
          name="q"
          value={draft}
          disabled={!available}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Search recipes"
          placeholder={
            available
              ? 'Something quick with lots of protein…'
              : 'Search is resting until tomorrow'
          }
        />
        <button className="mp-search-go" type="submit" disabled={!available || pending}>
          {pending ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!available && (
        <p className="mp-search-note">
          Search is resting until tomorrow — today&apos;s budget for understanding queries is
          spent. Browsing and the category chips below are unaffected.
        </p>
      )}

      {available && query !== '' && (
        <div className="mp-search-state">
          <button className="mp-search-clear" type="button" onClick={onClear}>
            Clear search
          </button>
          <span className="mp-search-for">
            {pending
              ? `Searching for “${query}”…`
              : resultCount === null
                ? `“${query}”`
                : `${resultCount} ${resultCount === 1 ? 'recipe' : 'recipes'} for “${query}”`}
          </span>
        </div>
      )}

      {error !== null && (
        <p className="mp-search-note">
          {/* A 503 here is the budget gate, and the route's own words are the
              honest ones. Anything else is a genuine failure to answer. */}
          That search didn&apos;t run: {error.message}
        </p>
      )}

      {notices.length > 0 && (
        <ul className="mp-search-notices">
          {notices.map((notice) => (
            <li className="mp-search-notice" key={notice.kind}>
              {describeSearchNotice(notice)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

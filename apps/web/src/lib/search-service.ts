/**
 * One natural-language search, end to end (FILTER_PLAN.md §7, Phase 5).
 *
 * The three parts that were built separately meet here for the first time:
 * `parseSearchQuery()` from `@recipes/shared/llm` turns the sentence into a
 * `SearchFilter`, `searchRecipes()` from `./search` compiles and runs it, and
 * `@recipes/db/llm-budget` pays for the one billable step out of the
 * `kind='search'` pot. The route above this is deliberately thin — it maps the
 * outcomes here onto status codes and nothing else.
 *
 * Three things here are load-bearing and easy to get wrong.
 *
 * **Hard rules are read but never applied (§4.2).** `searchRecipes()` takes no
 * `hardRules` option, so there is nothing to forget to pass; what this module
 * does with them is *name* them, so the reader is told which of their standing
 * filters this search stepped over. A typed query is a stronger statement of
 * intent than a rule inferred from rating history, and a reader with a
 * `max_minutes: 30` rule who searches "weekend slow-cooker braise" must not get
 * silence.
 *
 * **The vocabulary is an input, and it has to be the live one (A29).** The
 * model cannot name a canonical ingredient it has not been shown, so
 * {@link activeIngredientVocabulary} sends the ~554 names on active recipes.
 * Pass nothing and both ingredient fields come back empty — silently, and
 * correctly, because an invented name matches no row.
 *
 * **A parse failure degrades in public (A26).** On a transport error, a
 * validation failure or an unconfigured provider, the query is run as plain
 * full-text search and the reader is told so. Standard advice is to hide this;
 * with an operator-sized user base a silent degradation to worse results is
 * worse than an honest notice.
 */

import { db, ingredients, recipeIngredients, recipes, sql } from '@recipes/db';
import {
  createBudgetedLlmCallOptions,
  getDailyLlmUsage,
  getOrCreateDailySearchRun,
  isLlmBudgetExceeded,
} from '@recipes/db/llm-budget';
import { env, hasEnv, requireEnv } from '@recipes/shared/env';
import { createOpenRouterClient, dropEmptyTerms, parseSearchQuery } from '@recipes/shared/llm';
import { activeHardRules, shortHardRuleLabel } from '@recipes/shared/personalization';
import {
  MAX_TERM_CHARS,
  MAX_UNMAPPED_TERMS,
  SEARCH_BUDGET_GATE_FRACTION,
  makeSearchFilter,
  searchNoticesFor,
  type SearchFilter,
} from '@recipes/shared/search';
import { getUserPreferences } from './preferences';
import { searchRecipes } from './search';
import type { SearchResponse } from './recipe-types';

/**
 * Whether search can run at all right now, and why not when it cannot.
 *
 * Read twice per page: once by the server render, so the bar is already
 * disabled on the first paint rather than only after someone types into it, and
 * once by the route on every search. One `sum()` over the day's `scan_runs`
 * rows either way.
 */
export interface SearchAvailability {
  available: boolean;
  spentUsd: number;
  limitUsd: number;
}

export async function getSearchAvailability(): Promise<SearchAvailability> {
  const limitUsd = env.SEARCH_DAILY_BUDGET_USD;
  // Kind-filtered, always (Phase 4). Reading the unfiltered total here would
  // let a heavy enrichment night close the search bar, which is the exact
  // failure the separate pot exists to prevent.
  const usage = await getDailyLlmUsage(db, 'search');
  return {
    available: usage.costUsd < limitUsd * SEARCH_BUDGET_GATE_FRACTION,
    spentUsd: usage.costUsd,
    limitUsd,
  };
}

/**
 * The canonical names that can actually change a result (A29).
 *
 * Names on at least one *active* recipe — 554 of the 789 today. A canonical no
 * live recipe uses cannot match and cannot exclude, so it is prompt cost with
 * no upside, and the measured cost is real: most of a search's ~4,400 input
 * tokens is this list.
 */
export async function activeIngredientVocabulary(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: ingredients.name })
    .from(ingredients)
    .where(
      sql`exists (
        select 1
          from ${recipeIngredients} ri
          join ${recipes} r on r.id = ri.recipe_id
         where ri.ingredient_id = ${ingredients.id}
           and r.status = 'active'
      )`,
    );
  // Sorted so the payload is byte-stable between searches, which is what makes
  // the provider's cached prefix worth anything.
  return rows.map((row) => row.name).sort();
}

/**
 * A26's fallback: the raw query as full-text terms.
 *
 * Word-split rather than sent as one long phrase, because `plainto_tsquery`
 * ANDs every lexeme it is given — one phrase would demand all of them and
 * almost always return nothing. Split, the terms are ANDed first and then ORed
 * by §5.1's own union fallback, so the degraded path reuses the widening the
 * good path already has instead of inventing a second one.
 *
 * **A word that is an English stopword has to go, and Postgres is asked which
 * ones those are.** `plainto_tsquery('english', 'with')` is the *empty* query,
 * and `@@` against an empty query is false — so one "with" surviving into the
 * term list makes the AND attempt fail outright and drags the reader through a
 * union fallback they did not need. Reimplementing the stopword list here would
 * be a second copy of a vocabulary Postgres already owns, and the grocery
 * list's own rule applies: two copies in two languages drift, and the symptom
 * is wrong output nobody can see is wrong. `numnode()` counts the nodes in a
 * parsed query, so zero is exactly "this word contributes nothing".
 *
 * One extra round trip, on a path that only runs when the parse step has
 * already failed. {@link dropEmptyTerms} then removes the meal nouns and spent
 * time words, the same as after a successful parse.
 */
export async function textFallbackFilter(query: string): Promise<SearchFilter> {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}'-]+/u)
        .filter((word) => word.length >= 3 && word.length <= MAX_TERM_CHARS),
    ),
  ];
  if (words.length === 0) return makeSearchFilter();

  const rows = (await db.execute(sql`
    select w
      from unnest(array[${sql.join(
        words.map((word) => sql`${word}`),
        sql`, `,
      )}]::text[]) as w
     where numnode(plainto_tsquery('english', w)) > 0
  `)) as unknown as { w: string }[];

  const searchable = new Set(rows.map((row) => row.w));
  const terms = words.filter((word) => searchable.has(word)).slice(0, MAX_UNMAPPED_TERMS);
  return dropEmptyTerms(makeSearchFilter({ unmappedTerms: terms }));
}

export type SearchQueryOutcome =
  | { result: 'ok'; response: SearchResponse }
  /** The §8 gate, or the durable lease refusing mid-call at 100%. */
  | { result: 'budget-exhausted' };

/**
 * Run one search for one reader.
 *
 * The caller has already validated `query` as non-empty and within
 * `MAX_SEARCH_QUERY_CHARS`; the parse step validates it again before spending
 * anything, because an empty query is a bug in the caller rather than a filter
 * worth paying for.
 */
export async function runSearchQuery(
  userId: string,
  query: string,
): Promise<SearchQueryOutcome> {
  const availability = await getSearchAvailability();
  if (!availability.available) return { result: 'budget-exhausted' };

  const preferences = await getUserPreferences(userId);

  // §4.2. Only the rules that are *on* — a switched-off rule was not filtering
  // the browse feed either, so saying it was ignored would be a lie about what
  // changed. Named, not applied: see the module header.
  const bypassedRules = activeHardRules(preferences.rules).map(shortHardRuleLabel);

  let filter: SearchFilter;
  let degraded = false;
  try {
    filter = await parseWithBudget(query, preferences.profile);
  } catch (error: unknown) {
    if (isLlmBudgetExceeded(error)) return { result: 'budget-exhausted' };
    // A26: every other failure — transport, validation, no provider configured
    // — degrades to text matching and says so, rather than 500ing at someone
    // who typed a reasonable sentence.
    console.error('[web:search] parse failed; falling back to text matching', error);
    degraded = true;
    filter = await textFallbackFilter(query);
  }

  const outcome = await searchRecipes(filter, { userId });

  return {
    result: 'ok',
    response: {
      query,
      recipes: outcome.recipes,
      notices: searchNoticesFor({
        bypassedRules,
        degraded,
        relaxations: outcome.relaxations,
      }),
      filter: outcome.effectiveFilter,
    },
  };
}

/**
 * The one billable step, charged to the `kind='search'` pot.
 *
 * The accumulator row is created lazily on the day's first search and every
 * search after it advances the same row's `finished_at` — one `scan_runs` row
 * per UTC day, `success` from creation so `/ops` never reads it as a stuck
 * scan. Advisory key 3, so a search never waits behind an enrichment preflight.
 */
async function parseWithBudget(query: string, profile: string | null): Promise<SearchFilter> {
  const apiKey = requireEnv('OPENROUTER_API_KEY');
  const runId = await getOrCreateDailySearchRun(db);

  const client = createOpenRouterClient({
    apiKey,
    baseURL: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    defaultHeaders: {
      'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
      'X-OpenRouter-Title': 'Recipe Planner',
    },
  });

  const { filter, repairedTimeTags } = await parseSearchQuery(
    client,
    {
      query,
      profile,
      ingredientVocabulary: await activeIngredientVocabulary(),
    },
    createBudgetedLlmCallOptions({
      db,
      runId,
      kind: 'search',
      dailyBudgetUsd: env.SEARCH_DAILY_BUDGET_USD,
    }),
  );

  // A31: this has never fired against the live model, and it firing means the
  // §1 time trap is being attempted and the prompt is losing that argument.
  // The reader does not need to know — the repair already fixed their search —
  // but the operator does.
  if (repairedTimeTags.length > 0) {
    console.warn(
      `[web:search] repaired time tags ${repairedTimeTags.join(', ')} into a minute bound`,
    );
  }

  return filter;
}

/** Whether a provider is configured at all — every search degrades without it. */
export function isSearchParseConfigured(): boolean {
  return hasEnv('OPENROUTER_API_KEY');
}

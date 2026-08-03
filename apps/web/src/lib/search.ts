/**
 * The search compiler: `SearchFilter` → SQL (FILTER_PLAN.md §4).
 *
 * The counterpart to `@recipes/shared/search`, which owns *what a filter is*.
 * This module owns what one *does*, and it is the whole of amendment A23's
 * safety argument: the model's output reaches the database only as values bound
 * into clauses written here, so a query can never be more expressive than this
 * file. Same split, and the same shape, as `hardRuleFilter()` in
 * `./preferences.ts` — that one has three rule kinds, this one has fourteen
 * fields.
 *
 * Two things here are easy to get backwards and silent when you do.
 *
 * **Nulls (§4.1).** `hardRuleFilter()`'s rule is "every clause keeps a row whose
 * column is null", because a rule is *inferred* from rating history and unknown
 * data has not been disliked. A typed query inverts that for anything the
 * reader affirmatively asked for: someone who searches "under 20 minutes" is
 * asking a direct question, and a recipe with no time is not a yes. So the rule
 * here is stated by direction rather than by column:
 *
 * - a **requirement** is not satisfied by unknown data — `maxMinutes`,
 *   `minServings`, `freezerOnly`, `categories` all drop a null row;
 * - an **exclusion** does not fire on unknown data — `excludeCategories` keeps
 *   a row with no category, and `excludeIngredients` keeps a recipe whose lines
 *   never mapped.
 *
 * Both halves point the same way as A18 and A20: prefer a missed filter to a
 * wrong one.
 *
 * **Time (§1).** Every time bound compiles to `total_minutes` and never to the
 * `Under 20 min` tag. 12 recipes carry that tag; 34 satisfy the column.
 */

import {
  and,
  db,
  desc,
  eq,
  recipes,
  recipeScores,
  sources,
  sql,
  type SQL,
} from '@recipes/db';
import {
  isEmptySearchFilter,
  type RelaxableField,
  type Relaxation,
  type SearchFilter,
} from '@recipes/shared/search';
import {
  BROWSE_LIMIT,
  browseTiebreakOrder,
  MAX_RECIPE_LIMIT,
  scoreJoin,
  scoreOrder,
  summaryColumns,
  toSummary,
  type SummaryRow,
} from './recipes';
import type { RecipeSummary } from './recipe-types';

export type { RecipeSummary } from './recipe-types';

// ── Fragments ───────────────────────────────────────────────────────────────

/**
 * A bound `text[]`, one parameter per element.
 *
 * Not a hand-built `'{a,b}'` literal: `sql` expands a JS array into a *parameter
 * list* rather than an array literal, and the escaping a literal would need is
 * exactly the kind of thing that works until a tag has an apostrophe in it.
 */
function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * The full-text document searched by `unmappedTerms` (§5): our title and our
 * blurb, never the source's prose.
 *
 * **This expression must stay character-for-character identical to the one in
 * `recipes_search_fts_idx`** (`0004_search.sql`, and the mirror of it in
 * `packages/db/src/schema.ts`). Postgres matches an expression index by
 * comparing parsed expressions; change the coalesce, the separator or the
 * regconfig here and the query still returns the right rows, silently, by
 * sequential scan.
 */
function ftsDocument(): SQL {
  return sql`to_tsvector('english', ${recipes.title} || ' ' || coalesce(${recipes.blurb}, ''))`;
}

// ── Criteria ────────────────────────────────────────────────────────────────

/**
 * `RelaxableField` and `Relaxation` are `@recipes/shared/search`'s, not this
 * module's, and re-exported here so the compiler's callers keep one import.
 *
 * They moved out in Phase 5 because the browser has to render what was given
 * up (§4.4: "say what was dropped"), and a type describing a notice cannot live
 * in a module that imports the database. What stays here is the ladder itself —
 * *which* field goes first and by how much a bound widens — because that is a
 * property of the query, not of the sentence about it.
 */
export type { RelaxableField, Relaxation } from '@recipes/shared/search';

/** Every criterion a filter can contribute, for `match_count` and the `WHERE`. */
type CriterionKey =
  | RelaxableField
  | 'excludeCategories'
  | 'excludeTags'
  | 'ingredients'
  | 'anyIngredients'
  | 'excludeIngredients'
  | `term:${string}`;

interface Criterion {
  key: CriterionKey;
  clause: SQL;
}

/**
 * One boolean per populated field — the criteria a row can satisfy.
 *
 * `unmappedTerms` is the single exception to "one per field": each term is its
 * own criterion, because §5.1's union fallback is only useful if a recipe
 * matching both "spicy" and "quick" outranks one matching just "spicy", and
 * `match_count` is where that ordering has to come from.
 *
 * Otherwise unweighted, per FILTER_PLAN.md §10 open question 2 — an ingredient
 * match is arguably worth more than a tag match, and that is a thing to learn
 * from the Phase 5 browser check rather than to guess at now.
 */
function criteriaFor(filter: SearchFilter): Criterion[] {
  const out: Criterion[] = [];
  const add = (key: CriterionKey, clause: SQL) => out.push({ key, clause });

  // Requirements: a null column is not a match. See the module header.
  if (filter.maxMinutes !== null) add('maxMinutes', sql`${recipes.totalMinutes} <= ${filter.maxMinutes}`);
  if (filter.minMinutes !== null) add('minMinutes', sql`${recipes.totalMinutes} >= ${filter.minMinutes}`);
  if (filter.maxActiveMinutes !== null) {
    add('maxActiveMinutes', sql`${recipes.activeMinutes} <= ${filter.maxActiveMinutes}`);
  }
  if (filter.minServings !== null) add('minServings', sql`${recipes.servings} >= ${filter.minServings}`);
  if (filter.minKeepsDays !== null) add('minKeepsDays', sql`${recipes.keepsDays} >= ${filter.minKeepsDays}`);
  // "Does it freeze?" is a direct question too, and an unknown is not a yes.
  if (filter.freezerOnly) add('freezerOnly', sql`${recipes.freezerMonths} > 0`);

  if (filter.categories.length > 0) {
    add('categories', sql`${recipes.category}::text = any(${textArray(filter.categories)})`);
  }
  if (filter.tags.length > 0) add('tags', sql`${recipes.tags} @> ${textArray(filter.tags)}`);
  // §3.1: "easy to make" is one fuzzy property several tags each partially
  // satisfy. Requiring all five would return nothing.
  if (filter.anyTags.length > 0) add('anyTags', sql`${recipes.tags} && ${textArray(filter.anyTags)}`);

  // Exclusions: an unknown column does not trip them.
  if (filter.excludeCategories.length > 0) {
    add(
      'excludeCategories',
      sql`(${recipes.category} is null or not (${recipes.category}::text = any(${textArray(filter.excludeCategories)})))`,
    );
  }
  if (filter.excludeTags.length > 0) {
    add('excludeTags', sql`not (${recipes.tags} && ${textArray(filter.excludeTags)})`);
  }

  if (filter.ingredients.length > 0) {
    add('ingredients', hasAllIngredients(filter.ingredients));
  }
  // A39, and exactly parallel to `anyTags` above: the corpus splits one food
  // across several canonical rows, so "turkey" is a disjunction over four
  // names. Requiring all four returns nothing, and naming one returns a fifth
  // of the answer.
  if (filter.anyIngredients.length > 0) {
    add('anyIngredients', hasAnyIngredient(filter.anyIngredients));
  }
  if (filter.excludeIngredients.length > 0) {
    add('excludeIngredients', sql`not ${hasAnyIngredient(filter.excludeIngredients)}`);
  }

  for (const term of filter.unmappedTerms) {
    add(`term:${term}`, sql`${ftsDocument()} @@ plainto_tsquery('english', ${term})`);
  }

  return out;
}

/**
 * Ingredient matching is exact against `ingredients.name`, in both directions.
 *
 * §3.2: it never goes through the trigram or alias path `recipe_ingredients`
 * matching uses, because the harm is asymmetric. A missed exclusion shows
 * someone a recipe they have to skip; a wrong one hides recipes they wanted and
 * gives them no way to find out — "no chicken" fuzzily excluding `chicken
 * broth` and `chicken-fried steak` is a plausible reading and a bad default.
 * Inclusion is exact for the same reason inverted: a fuzzy include would return
 * a `chicken broth` recipe for "chicken".
 *
 * `lower()` on both sides is case folding, not fuzzing — the schema already
 * lowercases the filter's names, and every canonical name in the corpus is
 * lowercase. It costs nothing and survives a capitalised name arriving later.
 *
 * `hasAnyIngredient()` serves two callers with opposite signs: `anyIngredients`
 * uses it as written, `excludeIngredients` negates it. That is not a
 * coincidence to be tidied — "any of these names is present" is exactly the
 * question both ask, and A39's whole finding is that the *inclusion* side had
 * no way to ask it.
 */
function hasAnyIngredient(names: readonly string[]): SQL {
  return sql`exists (
    select 1
      from recipe_ingredients sri
      join ingredients si on si.id = sri.ingredient_id
     where sri.recipe_id = ${recipes.id}
       and lower(si.name) = any(${textArray(names)})
  )`;
}

function hasAllIngredients(names: readonly string[]): SQL {
  return sql`(
    select count(distinct lower(si.name))
      from recipe_ingredients sri
      join ingredients si on si.id = sri.ingredient_id
     where sri.recipe_id = ${recipes.id}
       and lower(si.name) = any(${textArray(names)})
  ) = ${names.length}`;
}

// ── Compiling ───────────────────────────────────────────────────────────────

export interface CompiledSearch {
  /** The `WHERE` fragment, or `undefined` when the filter constrains nothing. */
  where: SQL | undefined;
  /** §4.3's ordering key: how many of the criteria this row satisfies. */
  matchCount: SQL<number>;
  /** How many criteria the filter carries, for "matched 3 of 5". */
  criteriaCount: number;
  keys: CriterionKey[];
}

/**
 * A filter, compiled.
 *
 * `matchCount` is deliberately computed from a *different* filter than `where`
 * in the relaxed case — see {@link searchRecipes}. That is the whole point of
 * it: once a criterion has been dropped, rows that still satisfy it should
 * outrank rows that do not, and the `WHERE` can no longer say so.
 */
export function compileSearchFilter(
  filter: SearchFilter,
  options: { mode?: TermMode } = {},
): CompiledSearch {
  const criteria = criteriaFor(filter);
  const mode = options.mode ?? 'all';

  const terms = criteria.filter((c) => c.key.startsWith('term:'));
  const structured = criteria.filter((c) => !c.key.startsWith('term:'));

  const clauses = structured.map((c) => c.clause);
  if (terms.length > 0) {
    // §5.1: unmapped terms narrow the structured set, then widen to a union.
    const joined = sql.join(terms.map((c) => c.clause), mode === 'all' ? sql` and ` : sql` or `);
    clauses.push(sql`(${joined})`);
  }

  return {
    where: clauses.length === 0 ? undefined : sql.join(clauses, sql` and `),
    matchCount: matchCountOf(criteria),
    criteriaCount: criteria.length,
    keys: criteria.map((c) => c.key),
  };
}

/**
 * A sum of boolean casts.
 *
 * Zero criteria is `0::int` and not a bare `0`, because a bare integer in an
 * `ORDER BY` is a *positional reference* to a select-list column, and position
 * zero does not exist. An empty filter is a real case — it is what the browse
 * feed compiles to — so this is a query that fails outright rather than one
 * that sorts oddly.
 */
function matchCountOf(criteria: Criterion[]): SQL<number> {
  if (criteria.length === 0) return sql<number>`0::int`;
  return sql<number>`(${sql.join(
    criteria.map((c) => sql`(coalesce(${c.clause}, false))::int`),
    sql` + `,
  )})`;
}

// ── Relaxation (§4.4) ───────────────────────────────────────────────────────

/** Two, then a genuine empty state. */
export const MAX_RELAXATION_ROUNDS = 2;

/** How far a time bound moves when it is widened rather than dropped. */
export const TIME_WIDEN_FACTOR = 1.5;

/**
 * Least costly to drop first.
 *
 * Each rung is one round and takes every field on it that the filter actually
 * sets; a rung the filter does not use is skipped rather than spent, or a query
 * of nothing but tags and categories would exhaust both rounds on fields it
 * never had. Ingredients and exclusions appear nowhere in this table on
 * purpose.
 *
 * **`anyIngredients` is not on it either, even though `anyTags` is rung 2.**
 * The two are the same *shape* and not the same kind of claim. `anyTags` is
 * fuzzy by construction — the model chose five tags to stand in for one vague
 * word like "easy", so dropping it drops an interpretation. `anyIngredients` is
 * a disjunction only because the corpus splits one food across several rows
 * (A39); the cook said "turkey" and meant turkey, and relaxing it would serve
 * them something else entirely. Same §4.4 reason `ingredients` is absent.
 */
const RELAXATION_LADDER: readonly (readonly RelaxableField[])[] = [
  ['minKeepsDays', 'freezerOnly', 'minServings'],
  ['anyTags'],
  ['maxMinutes', 'minMinutes', 'maxActiveMinutes'],
  ['tags'],
  ['categories'],
];

/** Whether a field is set at all, so an empty rung can be skipped. */
function isSet(filter: SearchFilter, field: RelaxableField): boolean {
  const value = filter[field];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  return value !== null;
}

/**
 * Apply one rung. Time bounds widen by half rather than disappearing — the
 * reader asked for 15 minutes, and 22 is a useful answer where "any duration"
 * is not. A maximum grows, a minimum shrinks; the window widens either way.
 */
function relaxRung(
  filter: SearchFilter,
  rung: readonly RelaxableField[],
): { filter: SearchFilter; relaxations: Relaxation[] } {
  const next: SearchFilter = { ...filter };
  const relaxations: Relaxation[] = [];

  for (const field of rung) {
    if (!isSet(filter, field)) continue;

    switch (field) {
      case 'maxMinutes':
      case 'maxActiveMinutes': {
        const from = filter[field] as number;
        const to = Math.ceil(from * TIME_WIDEN_FACTOR);
        next[field] = to;
        relaxations.push({ kind: 'widened', field, from, to });
        break;
      }
      case 'minMinutes': {
        const from = filter.minMinutes as number;
        const to = Math.max(1, Math.floor(from / TIME_WIDEN_FACTOR));
        next.minMinutes = to;
        relaxations.push({ kind: 'widened', field, from, to });
        break;
      }
      case 'freezerOnly':
        next.freezerOnly = false;
        relaxations.push({ kind: 'dropped', field });
        break;
      case 'minServings':
      case 'minKeepsDays':
        next[field] = null;
        relaxations.push({ kind: 'dropped', field });
        break;
      case 'anyTags':
      case 'tags':
      case 'categories':
        next[field] = [];
        relaxations.push({ kind: 'dropped', field });
        break;
    }
  }

  return { filter: next, relaxations };
}

// ── Executing ───────────────────────────────────────────────────────────────

type TermMode = 'all' | 'any';

export interface SearchOptions {
  limit?: number;
  /**
   * Whose `recipe_scores` to read for the §4.3 tiebreak, or `null`. Search is
   * signed-in-only (§8), but this stays nullable so the compiler is testable
   * without a user.
   */
  userId?: string | null;
}

export interface SearchOutcome {
  recipes: RecipeSummary[];
  /**
   * What was given up to get them, in the order it happened. Empty means the
   * filter as typed is what ran. Phase 5 turns these into the visible notices —
   * §4.4 is explicit that a relaxation the reader is not told about is worse
   * than an empty state.
   */
  relaxations: Relaxation[];
  /** The filter that actually ran, after any relaxation. */
  effectiveFilter: SearchFilter;
}

/**
 * Run a filter, relaxing until something comes back.
 *
 * **Hard rules are not applied here, on purpose (§4.2).** A typed query is a
 * stronger statement of intent than a rule inferred from rating history, and a
 * reader with a `max_minutes: 30` rule who searches "weekend slow-cooker
 * braise" would otherwise get silence and no way to tell why. Scores are *not*
 * overridden — they stay as the tiebreak, so among equally good matches the
 * reader still sees their kind of thing first. The results header saying which
 * rule was ignored is Phase 5's job; this function simply never reads them,
 * which is why it takes no `hardRules` option to forget to pass.
 *
 * Order of attempts, per §5.1 and §4.4:
 *
 * 1. the filter as typed, unmapped terms ANDed;
 * 2. the same, terms ORed — widening the fuzziest part of the query is cheaper
 *    than dropping a criterion the reader actually typed;
 * 3. up to {@link MAX_RELAXATION_ROUNDS} rungs of the ladder.
 */
export async function searchRecipes(
  filter: SearchFilter,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const limit = Math.min(Math.max(1, options.limit ?? BROWSE_LIMIT), MAX_RECIPE_LIMIT);
  // Ordering is scored against what the reader asked for, never against the
  // relaxed version — a dropped criterion still ranks the rows that met it.
  const matchCount = compileSearchFilter(filter).matchCount;

  const attempt = async (current: SearchFilter, mode: TermMode) => {
    const { where } = compileSearchFilter(current, { mode });
    return runSearch(where, matchCount, limit, options.userId ?? null);
  };

  const relaxations: Relaxation[] = [];

  let rows = await attempt(filter, 'all');
  if (rows.length > 0 || isEmptySearchFilter(filter)) {
    return { recipes: rows, relaxations, effectiveFilter: filter };
  }

  // A single term ANDs and ORs identically, so that attempt would be a repeat.
  if (filter.unmappedTerms.length > 1) {
    rows = await attempt(filter, 'any');
    if (rows.length > 0) {
      relaxations.push({ kind: 'unmapped-union', terms: [...filter.unmappedTerms] });
      return { recipes: rows, relaxations, effectiveFilter: filter };
    }
  }

  const mode: TermMode = filter.unmappedTerms.length > 1 ? 'any' : 'all';
  if (mode === 'any') relaxations.push({ kind: 'unmapped-union', terms: [...filter.unmappedTerms] });

  let current = filter;
  let rounds = 0;

  for (const rung of RELAXATION_LADDER) {
    if (rounds >= MAX_RELAXATION_ROUNDS) break;
    if (!rung.some((field) => isSet(current, field))) continue;

    const relaxed = relaxRung(current, rung);
    current = relaxed.filter;
    relaxations.push(...relaxed.relaxations);
    rounds += 1;

    rows = await attempt(current, mode);
    if (rows.length > 0) return { recipes: rows, relaxations, effectiveFilter: current };
  }

  // Two rounds spent, or nothing left that may be relaxed. A genuine empty
  // state, and the relaxations are still reported: "we tried this too".
  return { recipes: rows, relaxations, effectiveFilter: current };
}

async function runSearch(
  where: SQL | undefined,
  matchCount: SQL<number>,
  limit: number,
  userId: string | null,
): Promise<RecipeSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(recipes)
    .innerJoin(sources, eq(sources.id, recipes.sourceId))
    .leftJoin(recipeScores, scoreJoin(userId))
    .where(and(eq(recipes.status, 'active'), where))
    // §4.3: match quality first, then the reader's score, then the existing
    // browse order — so a one-criterion search degrades into something
    // recognisable rather than arbitrary.
    .orderBy(desc(matchCount), scoreOrder, ...browseTiebreakOrder)
    .limit(limit);

  return (rows as SummaryRow[]).map(toSummary);
}

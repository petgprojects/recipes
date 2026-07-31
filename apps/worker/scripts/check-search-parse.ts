/**
 * Run the thirty committed parse fixtures against the **real** model.
 *
 * ```
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-search-parse.ts --live-vocabulary
 * ```
 *
 * **This spends real money and is deliberately not a test.** `vitest.config.ts`
 * includes `test/**‍/*.test.ts` only, so nothing here can be dragged into
 * `pnpm test` by accident — a suite that calls a paid provider is a suite that
 * fails on an aeroplane, costs money on every CI run, and goes red for reasons
 * that have nothing to do with the commit under it. The offline half of this
 * pair lives in `test/llm-parse-search-query.test.ts` and proves the fixtures
 * are *valid*; this is the only thing that proves the model still *agrees*.
 * FILTER_PLAN.md §7 sets the bar at 27 of 30.
 *
 * Thirty small calls at flash pricing is a fraction of a cent, and the run
 * prints what it actually cost. It does **not** open a `scan_runs` row or touch
 * a budget: accounting is Phase 4, and a diagnostic that quietly ate the
 * following day's search budget would be a poor diagnostic.
 *
 * `--live-vocabulary` swaps the committed 90-name fixture vocabulary for the
 * canonical ingredients actually on active recipes — what Phase 5 will send.
 * The exclusion fixtures were written against the committed one, so the
 * agreement count under this flag is information rather than the exit
 * criterion, and it is labelled as such.
 */

import { client, db, ingredients, recipeIngredients, recipes, sql } from '@recipes/db';
import { env, requireEnv } from '@recipes/shared/env';
import {
  addLlmUsage,
  createOpenRouterClient,
  type LlmUsage,
  type StructuredOutputClient,
} from '../src/llm';
import { parseSearchQuery } from '../src/llm/parse-search-query';
import {
  FIXTURE_INGREDIENT_VOCABULARY,
  GROUPING_PROBES,
  SEARCH_QUERY_FIXTURES,
  assertFixturesWellFormed,
  filterDiff,
  normalizeFilter,
  type SearchQueryFixture,
} from '../test/fixtures/search-queries';

/** FILTER_PLAN.md §7, Phase 3. Kept next to the number it is compared with. */
const AGREEMENT_THRESHOLD = 27;

/** Enough to finish in a couple of minutes without hammering the provider. */
const CONCURRENCY = 4;

const ZERO_USAGE: LlmUsage = {
  tokensIn: 0,
  tokensOut: 0,
  totalTokens: 0,
  cachedTokensIn: 0,
  costUsd: 0,
  costSource: 'provider',
};

interface Outcome {
  readonly fixture: SearchQueryFixture;
  readonly diff: string[] | null;
  readonly actual: unknown;
  readonly repairedTimeTags: string[];
  readonly error: string | null;
}

async function main(): Promise<void> {
  assertFixturesWellFormed();

  const useLiveVocabulary = process.argv.includes('--live-vocabulary');
  const vocabulary = useLiveVocabulary
    ? await activeCanonicalIngredients()
    : FIXTURE_INGREDIENT_VOCABULARY;

  let usage = ZERO_USAGE;
  const provider = createOpenRouterClient({
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseURL: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    defaultHeaders: {
      'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
      'X-OpenRouter-Title': 'Recipe Planner',
    },
  });
  const counted: StructuredOutputClient = {
    complete: (task, options = {}) =>
      provider.complete(task, {
        ...options,
        onUsage: (called) => {
          usage = addLlmUsage(usage, called);
        },
      }),
  };

  console.log(
    `Model ${env.OPENROUTER_MODEL}, ${SEARCH_QUERY_FIXTURES.length} fixtures, ` +
      `${vocabulary.length} canonical ingredients ` +
      `(${useLiveVocabulary ? 'live, from the corpus' : 'committed fixture vocabulary'}).\n`,
  );

  const outcomes = await inPool(SEARCH_QUERY_FIXTURES, CONCURRENCY, async (fixture) => {
    try {
      const { filter, repairedTimeTags } = await parseSearchQuery(counted, {
        query: fixture.query,
        profile: fixture.profile,
        ingredientVocabulary: vocabulary,
      });
      return {
        fixture,
        diff: filterDiff(fixture.expected, filter),
        actual: normalizeFilter(filter),
        repairedTimeTags,
        error: null,
      } satisfies Outcome;
    } catch (error) {
      return {
        fixture,
        diff: null,
        actual: null,
        repairedTimeTags: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies Outcome;
    }
  });

  const agreed = outcomes.filter((o) => o.diff !== null && o.diff.length === 0);
  const repaired = outcomes.filter((o) => o.repairedTimeTags.length > 0);

  for (const outcome of outcomes) {
    if (outcome.diff !== null && outcome.diff.length === 0) {
      console.log(`  ok    ${outcome.fixture.query}`);
      continue;
    }
    console.log(`\n  DRIFT ${outcome.fixture.query}`);
    console.log(`        ${outcome.fixture.note}`);
    if (outcome.error !== null) {
      console.log(`        failed: ${outcome.error}`);
      continue;
    }
    for (const field of outcome.diff ?? []) {
      const expected = fieldOf(normalizeFilter(outcome.fixture.expected), field);
      const actual = fieldOf(outcome.actual, field);
      console.log(
        `        ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  // §10 open question 1: whether `anyTags` groupings should be a curated
  // constant. The scored fixtures cannot answer it — the prompt spells the
  // "easy" grouping out, so they measure instruction following. These are the
  // groupings it does not name, printed for judgement rather than scored.
  console.log('\n─── unscored grouping probes (§10 open question 1) ───');
  const probes = await inPool(GROUPING_PROBES, CONCURRENCY, async (query) => {
    try {
      const { filter } = await parseSearchQuery(counted, {
        query,
        profile: null,
        ingredientVocabulary: vocabulary,
      });
      const set = Object.entries(normalizeFilter(filter)).filter(
        ([, value]) =>
          value !== null && value !== false && (!Array.isArray(value) || value.length > 0),
      );
      return `  ${query}\n        ${JSON.stringify(Object.fromEntries(set))}`;
    } catch (error) {
      return `  ${query}\n        failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  for (const line of probes) console.log(line);

  console.log(
    `\nAgreed on ${agreed.length} of ${outcomes.length}` +
      ` (threshold ${AGREEMENT_THRESHOLD}).` +
      `\nTime-tag repairs: ${repaired.length}` +
      (repaired.length === 0
        ? ' — the §1 trap never fired.'
        : ` — ${repaired.map((o) => `"${o.fixture.query}"`).join(', ')}. The prompt is losing that argument.`) +
      `\nSpent $${usage.costUsd.toFixed(5)} over ${usage.tokensIn} in / ${usage.tokensOut} out` +
      ` (${usage.costSource}).`,
  );

  if (useLiveVocabulary) {
    console.log(
      '\nRun with --live-vocabulary: the exclusion fixtures were written against the ' +
        'committed vocabulary, so this count is information and not the §7 exit criterion.',
    );
    return;
  }
  if (agreed.length < AGREEMENT_THRESHOLD) {
    process.exitCode = 1;
  }
}

function fieldOf(filter: unknown, field: string): unknown {
  return (filter as Record<string, unknown> | null)?.[field];
}

/** The canonical names that can actually change a result — Phase 5's input. */
async function activeCanonicalIngredients(): Promise<string[]> {
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
  return rows.map((row) => row.name).sort();
}

/** Bounded concurrency, order preserved. */
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

main()
  .then(async () => {
    await client.end({ timeout: 5 });
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  });

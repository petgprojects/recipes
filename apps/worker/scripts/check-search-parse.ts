/**
 * Run the one-thousand-case committed parse stress suite against the **real** model.
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
 * The stress run applies the Phase 5 90% gate to all 1,000 cases.
 *
 * The run prints what it actually cost. It does **not** open a `scan_runs` row or touch
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
  parseSearchQuery,
  type LlmUsage,
  type StructuredOutputClient,
} from '../src/llm';
import {
  FIXTURE_INGREDIENT_VOCABULARY,
  GROUPING_PROBES,
  LEGACY_SEARCH_QUERY_FIXTURES,
  SEARCH_QUERY_FIXTURES,
  assertFixturesWellFormed,
  filterDiff,
  normalizeFilter,
  type SearchQueryFixture,
} from '../test/fixtures/search-queries';

/**
 * What to run. The full matrix is the thorough answer and costs about $0.27;
 * `--anchors` is the one to reach for after a prompt edit (A39).
 *
 * The anchors are the thirty hand-authored fixtures — the plan's own exit
 * criterion — plus every fixture that exercises a food family in either
 * direction. That pairing is deliberate: the thirty catch a prompt edit
 * *breaking* something, and the families catch it not doing the thing it was
 * written for. Around sixty calls, roughly $0.02, and short enough that it is
 * reasonable to run it after every change to the INGREDIENTS section rather
 * than once at the end.
 */
function selectFixtures(anchorsOnly: boolean): readonly SearchQueryFixture[] {
  if (!anchorsOnly) return SEARCH_QUERY_FIXTURES;
  const families = SEARCH_QUERY_FIXTURES.filter(
    (candidate) =>
      candidate.expected.anyIngredients.length > 1 ||
      candidate.expected.excludeIngredients.length > 1,
  );
  const chosen = [...LEGACY_SEARCH_QUERY_FIXTURES, ...families];
  return chosen.filter(
    (candidate, index) => chosen.findIndex((f) => f.query === candidate.query) === index,
  );
}

/** Bounded so the stress run does not hammer the provider. */
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
  const anchorsOnly = process.argv.includes('--anchors');
  const fixtures = selectFixtures(anchorsOnly);
  const threshold = Math.ceil(fixtures.length * 0.9);
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
    `Model ${env.OPENROUTER_MODEL}, ${fixtures.length} fixtures` +
      `${anchorsOnly ? ' (--anchors: the hand-authored thirty plus every food family)' : ''}, ` +
      `${vocabulary.length} canonical ingredients ` +
      `(${useLiveVocabulary ? 'live, from the corpus' : 'committed fixture vocabulary'}).\n`,
  );

  const outcomes = await inPool(fixtures, CONCURRENCY, async (fixture) => {
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

  let shownDrifts = 0;
  const driftByField = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.diff !== null && outcome.diff.length === 0) {
      console.log(`  ok    ${outcome.fixture.query}`);
      continue;
    }
    for (const field of outcome.diff ?? []) {
      driftByField.set(field, (driftByField.get(field) ?? 0) + 1);
    }
    if (shownDrifts >= 60) continue;
    shownDrifts += 1;
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

  const totalDrifts = outcomes.length - agreed.length;
  if (totalDrifts > shownDrifts) {
    console.log(`\n  ... ${totalDrifts - shownDrifts} additional drifts omitted from the detail log`);
  }
  if (driftByField.size > 0) {
    console.log(
      `\nDrift by field: ${[...driftByField.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([field, count]) => `${field}=${count}`)
        .join(', ')}`,
    );
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
      ` (threshold ${threshold}).` +
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
  if (agreed.length < threshold) {
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

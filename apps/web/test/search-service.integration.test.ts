/**
 * `apps/web/src/lib/search-service.ts` — everything Phase 5's route does apart
 * from the one billable call.
 *
 * `packages/shared/test/search.test.ts` says what a filter and a notice *are*,
 * and `./search.integration.test.ts` says what a filter *does* against the
 * corpus. This suite covers the seams between them: the vocabulary the model is
 * shown, the budget gate that decides whether a search runs at all, and the
 * fallback A26 degrades to when the parse step fails.
 *
 * The parse step itself is not exercised here — it costs money, and
 * `apps/worker/scripts/check-search-parse.ts` is the thing that measures it.
 * What is exercised is every path that decides whether we reach it.
 *
 * Requires the Compose database and `DATABASE_URL`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { getDailyLlmUsage, getOrCreateDailySearchRun } from '@recipes/db/llm-budget';
import { env } from '@recipes/shared/env';
import {
  activeHardRules,
  shortHardRuleLabel,
  type HardRule,
} from '@recipes/shared/personalization';
import {
  MAX_UNMAPPED_TERMS,
  SEARCH_BUDGET_GATE_FRACTION,
  describeSearchNotice,
  makeSearchFilter,
  searchNoticesFor,
} from '@recipes/shared/search';
import { getUserPreferences } from '../src/lib/preferences';
import { listRecipes } from '../src/lib/recipes';
import { searchRecipes } from '../src/lib/search';
import {
  activeIngredientVocabulary,
  getSearchAvailability,
  runSearchQuery,
  textFallbackFilter,
} from '../src/lib/search-service';

async function scratchUser(label: string): Promise<string> {
  const email = `search-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  return row!.id;
}

const userIds: string[] = [];

afterEach(async () => {
  while (userIds.length > 0) {
    await db.execute(sql`delete from users where id = ${userIds.pop()!}::uuid`);
  }
});

// ── The vocabulary the model is shown (A29) ─────────────────────────────────

describe('activeIngredientVocabulary', () => {
  let vocabulary: string[] = [];

  beforeAll(async () => {
    vocabulary = await activeIngredientVocabulary();
  });

  it('is the canonicals on active recipes, not every canonical in the table', async () => {
    const [all] = (await db.execute(
      sql`select count(*)::int as n from ingredients`,
    )) as unknown as { n: number }[];

    // Amendment A29: a canonical no live recipe uses cannot match and cannot
    // exclude, so sending it is prompt cost with no upside — and most of a
    // search's ~4,400 input tokens is this list.
    expect(vocabulary.length).toBeGreaterThan(0);
    expect(vocabulary.length).toBeLessThan(all!.n);
  });

  it('agrees exactly with an independent query for the same thing', async () => {
    const rows = (await db.execute(sql`
      select distinct i.name
        from ingredients i
        join recipe_ingredients ri on ri.ingredient_id = i.id
        join recipes r on r.id = ri.recipe_id
       where r.status = 'active'
    `)) as unknown as { name: string }[];

    // Sorted in JS on both sides, deliberately. Postgres orders by its own
    // collation, which puts "black eyed peas" before "blackberries" where
    // JavaScript's codepoint sort does the opposite — the same set, a different
    // order, and comparing the two orders would be testing the collation.
    expect(vocabulary).toEqual(rows.map((row) => row.name).sort());
  });

  it('is sorted and deduped, so the payload is byte-stable between searches', () => {
    expect(vocabulary).toEqual([...new Set(vocabulary)].sort());
  });
});

// ── The budget gate (§8) ────────────────────────────────────────────────────

describe('getSearchAvailability', () => {
  it('reads the search pot, not the total, and reports the configured limit', async () => {
    const availability = await getSearchAvailability();
    const search = await getDailyLlmUsage(db, 'search');

    expect(availability.limitUsd).toBe(env.SEARCH_DAILY_BUDGET_USD);
    expect(availability.spentUsd).toBe(search.costUsd);
    expect(availability.available).toBe(
      search.costUsd < env.SEARCH_DAILY_BUDGET_USD * SEARCH_BUDGET_GATE_FRACTION,
    );
  });

  it('closes at 90% and answers 503 rather than letting the lease fail mid-call', async () => {
    const before = await getSearchAvailability();
    // Only meaningful from an open budget; the corpus's normal state.
    expect(before.available).toBe(true);

    const runId = await getOrCreateDailySearchRun(db);
    // Deliberately not exactly the gate. `scan_runs.cost_usd` is
    // `numeric(12,6)`, so a JS product like 0.1 × 0.9 = 0.09000000000000001
    // rounds to 0.090000 on the way in and reads back *below* the number it was
    // written as. Real spend accumulates in ~$0.00057 steps and crosses this
    // within one search either way; a test that sat on the boundary would be
    // testing float representation rather than the gate.
    const gate = env.SEARCH_DAILY_BUDGET_USD * SEARCH_BUDGET_GATE_FRACTION;
    try {
      await db.execute(
        sql`update scan_runs set cost_usd = ${gate * 1.01} where id = ${runId}::uuid and kind = 'search'`,
      );
      expect((await getSearchAvailability()).available).toBe(false);

      // The route turns exactly that into the reader-visible 503, without
      // spending anything: no provider is reached on this path at all.
      const userId = await scratchUser('gated');
      userIds.push(userId);
      expect(await runSearchQuery(userId, 'something quick')).toEqual({
        result: 'budget-exhausted',
      });

      // Just under the gate is open again — the boundary is `>=`, not `>`.
      await db.execute(
        sql`update scan_runs set cost_usd = ${gate * 0.5} where id = ${runId}::uuid`,
      );
      expect((await getSearchAvailability()).available).toBe(true);
    } finally {
      // The accumulator is a real durable row and this test's spend was
      // fictional; put it back rather than leaving a day's budget consumed.
      await db.execute(sql`update scan_runs set cost_usd = 0 where id = ${runId}::uuid`);
    }
  });

  it('leaves the enrichment pot alone — the pots are the point (Phase 4)', async () => {
    const scanBefore = await getDailyLlmUsage(db, 'scan');
    await getSearchAvailability();
    expect((await getDailyLlmUsage(db, 'scan')).costUsd).toBe(scanBefore.costUsd);
  });
});

// ── A26's fallback ──────────────────────────────────────────────────────────

describe('textFallbackFilter', () => {
  it('splits into terms rather than sending the sentence as one', async () => {
    // `plainto_tsquery` ANDs every lexeme, so one long phrase would demand all
    // of them and return nothing. Split, §5.1's own union fallback can widen it.
    expect((await textFallbackFilter('creamy chicken pasta')).unmappedTerms).toEqual([
      'creamy',
      'chicken',
      'pasta',
    ]);
  });

  it('drops the meal nouns and spent time words the parse step drops', async () => {
    // Terms are ANDed into the `WHERE`, so a stray "dinners" narrows the search
    // by the wrong noun — the same reason `dropEmptyTerms()` exists (A31).
    expect(
      (await textFallbackFilter('quick weeknight dinners of harissa')).unmappedTerms,
    ).toEqual(['harissa']);
  });

  it('drops English stopwords, which would otherwise make the AND unsatisfiable', async () => {
    // This is the failure that is invisible without the check: "with" parses to
    // the *empty* tsquery, `@@` against an empty query is false, and the whole
    // conjunction fails however good the other terms are.
    const [empty] = (await db.execute(
      sql`select numnode(plainto_tsquery('english', 'with'))::int as n`,
    )) as unknown as { n: number }[];
    expect(empty!.n).toBe(0);

    expect((await textFallbackFilter('pasta with harissa')).unmappedTerms).toEqual([
      'pasta',
      'harissa',
    ]);
  });

  it('sets nothing but terms, because a failed parse learned nothing else', async () => {
    const filter = await textFallbackFilter('under 20 minutes and high protein');
    expect(filter.maxMinutes).toBeNull();
    expect(filter.tags).toEqual([]);
    expect(filter.categories).toEqual([]);
    expect(filter.excludeIngredients).toEqual([]);
  });

  it('stays inside the contract however long the query is', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect((await textFallbackFilter(long)).unmappedTerms.length).toBeLessThanOrEqual(
      MAX_UNMAPPED_TERMS,
    );
  });

  it('survives a query with nothing usable in it', async () => {
    expect((await textFallbackFilter('a of &&& !!')).unmappedTerms).toEqual([]);
    expect((await textFallbackFilter('meals')).unmappedTerms).toEqual([]);
  });

  it('produces a filter the compiler can actually run', async () => {
    // The degraded path is the one nobody exercises by hand, so this is the
    // check that it reaches rows at all rather than throwing at the boundary.
    const filter = await textFallbackFilter('creamy');
    const { recipes: rows } = await searchRecipes(filter);
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── The §4.2 notice, at the point it reads the database ─────────────────────

describe('the rules a search names (§4.2)', () => {
  it('is the enabled ones, phrased as the notice will say them', async () => {
    const userId = await scratchUser('rules');
    userIds.push(userId);

    await db.execute(sql`
      insert into user_preferences (user_id, hard_rules)
      values (${userId}::uuid, ${JSON.stringify([
        {
          id: 'max_minutes:30',
          kind: 'max_minutes',
          value: '30',
          enabled: true,
          observations: 6,
          medianRating: 2,
        },
        {
          id: 'exclude_category:Soup',
          kind: 'exclude_category',
          value: 'Soup',
          // Switched off, so it was not filtering the browse feed either.
          // Announcing that this search ignored it would be a lie about what
          // changed, which is why `activeHardRules()` is in the path.
          enabled: false,
          observations: 5,
          medianRating: 1.5,
        },
      ])}::jsonb)
    `);

    const { rules } = await getUserPreferences(userId);
    const bypassed = activeHardRules(rules).map(shortHardRuleLabel);
    expect(bypassed).toEqual(['under 30 minutes']);

    expect(
      searchNoticesFor({ bypassedRules: bypassed, degraded: false, relaxations: [] }).map(
        describeSearchNotice,
      ),
    ).toEqual(['Ignoring your “under 30 minutes” rule for this search.']);
  });

  it('is empty for a reader the nightly job has never visited', async () => {
    const userId = await scratchUser('norules');
    userIds.push(userId);

    const { rules } = await getUserPreferences(userId);
    expect(activeHardRules(rules)).toEqual([]);
    expect(searchNoticesFor({ bypassedRules: [], degraded: false, relaxations: [] })).toEqual([]);
  });

  it('returns recipes the same rule hides from browse — the whole point of §4.2', async () => {
    const slow: HardRule = {
      id: 'max_minutes:30',
      kind: 'max_minutes',
      value: '30',
      enabled: true,
      observations: 6,
      medianRating: 2,
    };

    // The reader's standing rule hides everything over half an hour. The query
    // asks for exactly that, and gets it — a reader who searches "weekend
    // slow-cooker braise" with a `max_minutes: 30` rule must not get silence
    // and no way to tell why.
    const browse = await listRecipes({ limit: 500, hardRules: [slow] });
    const searched = await searchRecipes(makeSearchFilter({ minMinutes: 120 }));

    expect(searched.recipes.length).toBeGreaterThan(0);
    const browseIds = new Set(browse.map((recipe) => recipe.id));
    expect(searched.recipes.every((recipe) => !browseIds.has(recipe.id))).toBe(true);
  });
});

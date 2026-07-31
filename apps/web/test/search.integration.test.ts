/**
 * The search compiler, against the real corpus.
 *
 * FILTER_PLAN.md §7 calls this the highest-value test surface in the plan, and
 * the reason is that everything here fails *silently*. A filter that compiles to
 * `Under 20 min` instead of `total_minutes <= 20` returns twelve plausible
 * recipes rather than thirty-four and looks entirely correct. A null convention
 * inverted in either direction returns a believable number of rows. Nothing
 * throws, nothing logs, and the only thing that can tell the difference is a
 * hand-written filter paired with the rows it must return.
 *
 * So the pairs below are hand-authored and the expectations are either literal
 * (the §1 exit criterion) or derived from an independent query written in SQL
 * rather than through the compiler under test.
 *
 * Requires the Compose database and `DATABASE_URL`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '@recipes/db';
import { makeSearchFilter, type SearchFilter } from '@recipes/shared/search';
import type { HardRule } from '@recipes/shared/personalization';
import { compileSearchFilter, searchRecipes } from '../src/lib/search';
import { listRecipes } from '../src/lib/recipes';

async function count(where: ReturnType<typeof sql>): Promise<number> {
  const [row] = (await db.execute(
    sql`select count(*)::int as n from recipes r where r.status = 'active' and ${where}`,
  )) as unknown as { n: number }[];
  return row!.n;
}

async function titles(filter: SearchFilter): Promise<string[]> {
  const { recipes: rows } = await searchRecipes(filter);
  return rows.map((row) => row.title).sort();
}

const userIds: string[] = [];

async function scratchUser(label: string): Promise<string> {
  const email = `search-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [row] = (await db.execute(sql`
    insert into users (email, name) values (${email}, ${label}) returning id::text
  `)) as unknown as { id: string }[];
  userIds.push(row!.id);
  return row!.id;
}

afterEach(async () => {
  while (userIds.length > 0) {
    await db.execute(sql`delete from users where id = ${userIds.pop()!}::uuid`);
  }
});

let allActive = 0;

beforeAll(async () => {
  allActive = (await listRecipes({ limit: 500 })).length;
});

// ── The exit criterion (§1, §7 Phase 2) ─────────────────────────────────────

/**
 * "Recipes that take less than 20 minutes and have lots of protein, and are
 * easy to make", decomposed onto columns exactly as FILTER_PLAN.md §1 does it.
 * This is the filter Phase 3's model has to learn to produce; here it is
 * written by hand so the compiler can be judged on its own.
 */
const EXAMPLE_QUERY_FILTER = makeSearchFilter({
  maxMinutes: 20,
  tags: ['High protein'],
  anyTags: ['Hands-off', 'One pot', 'One cleanup', 'Sheet pan', 'No cook'],
});

/** The twelve rows the hand-written SQL in §1 returns. */
const EXAMPLE_QUERY_TITLES = [
  '10-Minute Chermoula Shrimp with Spring Vegetables',
  '12-Minute Salmon and Asparagus Packet Dinner',
  'Blackened Salmon',
  'Filet Mignon (Foolproof Recipe)',
  'Garlic Butter Shrimp',
  'Garlic Butter Steak Bites',
  'Lemony Grain Bowl with Green Beans, Chickpeas, and Cottage Cheese',
  'Maple Mayo Broiled Salmon',
  'Monti Carlo’s Caribbean Cowboy Caviar',
  'Most Delicious Teriyaki Chicken',
  'Pizza Burgers',
  'Slow-Cooker Corned Beef and Cabbage (Irish Boiled Dinner)',
].sort();

describe('the example query', () => {
  it('returns exactly the twelve recipes §1 identifies', async () => {
    const outcome = await searchRecipes(EXAMPLE_QUERY_FILTER);

    expect(outcome.recipes).toHaveLength(12);
    expect(outcome.recipes.map((r) => r.title).sort()).toEqual(EXAMPLE_QUERY_TITLES);
    // Nothing was given up to get them — this is the query as typed.
    expect(outcome.relaxations).toEqual([]);
    expect(outcome.effectiveFilter).toEqual(EXAMPLE_QUERY_FILTER);
  });

  it('gets there by three criteria, each of which does real work', async () => {
    const compiled = compileSearchFilter(EXAMPLE_QUERY_FILTER);
    expect(compiled.criteriaCount).toBe(3);
    expect(compiled.keys).toEqual(['maxMinutes', 'tags', 'anyTags']);

    // Drop any one of them and the answer changes, so none is decorative.
    const withoutTime = await titles(makeSearchFilter({ ...EXAMPLE_QUERY_FILTER, maxMinutes: null }));
    const withoutTags = await titles(makeSearchFilter({ ...EXAMPLE_QUERY_FILTER, tags: [] }));
    const withoutAny = await titles(makeSearchFilter({ ...EXAMPLE_QUERY_FILTER, anyTags: [] }));

    for (const wider of [withoutTime, withoutTags, withoutAny]) {
      expect(wider.length).toBeGreaterThan(12);
    }
  });
});

// ── The time trap (§1) ──────────────────────────────────────────────────────

describe('time compiles to the column, never the tag', () => {
  it('finds every recipe under twenty minutes, not just the tagged ones', async () => {
    const byColumn = await count(sql`r.total_minutes <= 20`);
    const byTag = await count(sql`r.tags @> array['Under 20 min']::text[]`);

    // The trap, restated as data: trusting the tag loses two thirds of them.
    expect(byTag).toBeLessThan(byColumn);

    const { recipes: rows } = await searchRecipes(makeSearchFilter({ maxMinutes: 20 }));
    expect(rows).toHaveLength(byColumn);
    expect(rows.some((row) => !row.tags.includes('Under 20 min'))).toBe(true);
  });

  it('uses active_minutes for hands-on time, which is a different column', async () => {
    const expected = await count(sql`r.active_minutes <= 15`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ maxActiveMinutes: 15 }));

    expect(rows).toHaveLength(expected);
    for (const row of rows) expect(row.activeMinutes).not.toBeNull();
  });

  it('applies a minimum for a Sunday project', async () => {
    const expected = await count(sql`r.total_minutes >= 180`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ minMinutes: 180 }));

    expect(rows).toHaveLength(expected);
    for (const row of rows) expect(row.totalMinutes).toBeGreaterThanOrEqual(180);
  });
});

// ── Nulls (§4.1) ────────────────────────────────────────────────────────────

describe('nulls: a requirement is not satisfied by unknown data', () => {
  /**
   * The inversion, shown side by side rather than asserted twice.
   *
   * `hardRuleFilter()` keeps a recipe with no time under a `max_minutes` rule,
   * because that rule was *inferred* from rating history and unknown data has
   * not been disliked. The same bound *typed into a search box* drops it: the
   * reader asked a direct question and a null is not a yes. Get this backwards
   * in either direction and both paths still return a believable number of rows.
   */
  it('drops a recipe with no time, where a hard rule would have kept it', async () => {
    const noTime = await count(sql`r.total_minutes is null`);
    expect(noTime).toBeGreaterThan(0);

    const rule: HardRule = {
      id: 'max_minutes:30',
      kind: 'max_minutes',
      value: '30',
      enabled: true,
      observations: 6,
      medianRating: 2,
    };

    const ruled = await listRecipes({ limit: 500, hardRules: [rule] });
    expect(ruled.filter((row) => row.totalMinutes === null)).toHaveLength(noTime);

    const { recipes: searched } = await searchRecipes(makeSearchFilter({ maxMinutes: 30 }));
    expect(searched.filter((row) => row.totalMinutes === null)).toHaveLength(0);
  });

  it('drops a recipe whose shelf life is unknown', async () => {
    const expected = await count(sql`r.keeps_days >= 5`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ minKeepsDays: 5 }));

    expect(rows).toHaveLength(expected);
    expect(await count(sql`r.keeps_days is null`)).toBeGreaterThan(0);
    for (const row of rows) expect(row.keepsDays).not.toBeNull();
  });

  it('drops a recipe we do not know freezes', async () => {
    const expected = await count(sql`r.freezer_months > 0`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ freezerOnly: true }));

    expect(rows).toHaveLength(expected);
    expect(rows.length).toBeLessThan(allActive);
    for (const row of rows) expect(row.freezerMonths).toBeGreaterThan(0);
  });

  it('drops a recipe whose yield is unknown', async () => {
    const expected = await count(sql`r.servings >= 6`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ minServings: 6 }));

    expect(rows).toHaveLength(expected);
    for (const row of rows) expect(row.servings).not.toBeNull();
  });
});

describe('nulls: an exclusion does not fire on unknown data', () => {
  it('keeps every recipe outside an excluded category', async () => {
    const soup = await count(sql`r.category = 'Soup'`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ excludeCategories: ['Soup'] }));

    expect(rows).toHaveLength(allActive - soup);
    expect(rows.some((row) => row.category === 'Soup')).toBe(false);
  });

  it('keeps a recipe whose ingredient lines never mapped', async () => {
    // 66 active recipes carry at least one unmapped line. An exclusion resolves
    // against `ingredients.name`, so those lines cannot match it — and the
    // recipe stays. §3.2: prefer a missed exclusion to a wrong one.
    const withUnmapped = await count(
      sql`exists (select 1 from recipe_ingredients ri where ri.recipe_id = r.id and ri.ingredient_id is null)`,
    );
    expect(withUnmapped).toBeGreaterThan(0);

    const { recipes: rows } = await searchRecipes(
      makeSearchFilter({ excludeIngredients: ['a-canonical-name-nothing-has'] }),
    );
    expect(rows).toHaveLength(allActive);
  });
});

// ── Tags (§3.1) ─────────────────────────────────────────────────────────────

describe('the two flavours of tag inclusion', () => {
  it('requires all of `tags` and any of `anyTags`, and they are different queries', async () => {
    const all = await count(sql`r.tags @> array['High protein', 'One pot']::text[]`);
    const any = await count(sql`r.tags && array['High protein', 'One pot']::text[]`);
    expect(all).toBeLessThan(any);

    const conjunction = await searchRecipes(makeSearchFilter({ tags: ['High protein', 'One pot'] }));
    const disjunction = await searchRecipes(makeSearchFilter({ anyTags: ['High protein', 'One pot'] }));

    expect(conjunction.recipes).toHaveLength(all);
    expect(disjunction.recipes).toHaveLength(any);

    for (const row of conjunction.recipes) {
      expect(row.tags).toContain('High protein');
      expect(row.tags).toContain('One pot');
    }
    for (const row of disjunction.recipes) {
      expect(row.tags.includes('High protein') || row.tags.includes('One pot')).toBe(true);
    }
  });

  it('removes an excluded tag without touching recipes that lack it', async () => {
    const withTag = await count(sql`r.tags && array['One pot']::text[]`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ excludeTags: ['One pot'] }));

    expect(rows).toHaveLength(allActive - withTag);
    expect(rows.some((row) => row.tags.includes('One pot'))).toBe(false);
  });

  it('narrows to the named categories', async () => {
    const expected = await count(sql`r.category in ('Soup', 'Breakfast')`);
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ categories: ['Soup', 'Breakfast'] }));

    expect(rows).toHaveLength(expected);
    for (const row of rows) expect(['Soup', 'Breakfast']).toContain(row.category);
  });
});

// ── Ingredients (§3.2) ──────────────────────────────────────────────────────

describe('ingredients match exactly, in both directions', () => {
  const hasName = (name: string) =>
    sql`exists (
      select 1 from recipe_ingredients ri join ingredients i on i.id = ri.ingredient_id
       where ri.recipe_id = r.id and i.name = ${name}
    )`;

  it('does not let "chicken" drag in chicken broth', async () => {
    const chicken = await count(hasName('chicken'));
    const broth = await count(hasName('chicken broth'));

    // The whole point: far more recipes contain chicken *broth* than contain
    // the canonical ingredient `chicken`, and a trigram or alias path would
    // return both. §3.2 keeps them separate.
    expect(broth).toBeGreaterThan(chicken);

    const { recipes: rows } = await searchRecipes(makeSearchFilter({ ingredients: ['chicken'] }));
    expect(rows).toHaveLength(chicken);
  });

  it('requires every named ingredient, not any of them', async () => {
    const both = await count(sql`${hasName('salmon')} and ${hasName('garlic')}`);
    const either = await count(sql`${hasName('salmon')} or ${hasName('garlic')}`);
    expect(both).toBeLessThan(either);

    const { recipes: rows } = await searchRecipes(
      makeSearchFilter({ ingredients: ['salmon', 'garlic'] }),
    );
    expect(rows).toHaveLength(both);
  });

  it('removes every recipe containing an excluded ingredient', async () => {
    const mushroomy = await count(hasName('mushrooms'));
    expect(mushroomy).toBeGreaterThan(0);

    const { recipes: rows } = await searchRecipes(makeSearchFilter({ excludeIngredients: ['mushrooms'] }));
    expect(rows).toHaveLength(allActive - mushroomy);
  });

  it('matches nothing for a name the corpus does not have, rather than everything', async () => {
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ ingredients: ['unobtanium'] }));
    expect(rows).toHaveLength(0);
  });
});

// ── Unmapped terms (§5) ─────────────────────────────────────────────────────

describe('unmapped terms', () => {
  it('narrows the structured result set', async () => {
    const creamy = await count(
      sql`to_tsvector('english', r.title || ' ' || coalesce(r.blurb, '')) @@ plainto_tsquery('english', 'creamy')`,
    );
    expect(creamy).toBeGreaterThan(0);

    const alone = await searchRecipes(makeSearchFilter({ unmappedTerms: ['creamy'] }));
    expect(alone.recipes).toHaveLength(creamy);

    const narrowed = await searchRecipes(
      makeSearchFilter({ unmappedTerms: ['creamy'], categories: ['Soup'] }),
    );
    expect(narrowed.recipes.length).toBeLessThan(creamy);
    for (const row of narrowed.recipes) expect(row.category).toBe('Soup');
  });

  it('stems, which is why this is FTS and not trigram', async () => {
    // `plainto_tsquery` reduces both of these to the same lexeme.
    const a = await searchRecipes(makeSearchFilter({ unmappedTerms: ['freezing'] }));
    const b = await searchRecipes(makeSearchFilter({ unmappedTerms: ['freeze'] }));
    expect(a.recipes.map((r) => r.id)).toEqual(b.recipes.map((r) => r.id));
  });

  it('falls back to the union when the intersection is empty (§5.1)', async () => {
    const outcome = await searchRecipes(makeSearchFilter({ unmappedTerms: ['creamy', 'crispy'] }));

    // No recipe's title-plus-blurb contains both words, so the AND is empty.
    expect(outcome.recipes.length).toBeGreaterThan(0);
    expect(outcome.relaxations).toEqual([
      { kind: 'unmapped-union', terms: ['creamy', 'crispy'] },
    ]);
    // Widening the fuzziest part of the query happens *before* the ladder, so
    // nothing the reader actually typed has been dropped yet.
    expect(outcome.effectiveFilter.unmappedTerms).toEqual(['creamy', 'crispy']);
  });

  it('uses the expression index rather than scanning', async () => {
    // The silent failure this guards: change the coalesce, the separator or the
    // regconfig in `ftsDocument()` and the query still returns the right rows.
    // A transaction pins one connection so `set local` applies to the EXPLAIN.
    const where = compileSearchFilter(makeSearchFilter({ unmappedTerms: ['creamy'] })).where!;

    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return (await tx.execute(
        sql`explain (costs off) select id from recipes where ${where}`,
      )) as unknown as Record<string, string>[];
    });

    const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
    expect(text).toContain('recipes_search_fts_idx');
  });
});

// ── Relaxation (§4.4) ───────────────────────────────────────────────────────

describe('the relaxation ladder', () => {
  it('drops the least costly criterion first and says what it dropped', async () => {
    const outcome = await searchRecipes(
      makeSearchFilter({ ...EXAMPLE_QUERY_FILTER, minKeepsDays: 300 }),
    );

    expect(outcome.relaxations).toEqual([{ kind: 'dropped', field: 'minKeepsDays' }]);
    expect(outcome.recipes.map((r) => r.title).sort()).toEqual(EXAMPLE_QUERY_TITLES);
    expect(outcome.effectiveFilter.minKeepsDays).toBeNull();
    // Only the one rung was spent; the tags the reader typed are untouched.
    expect(outcome.effectiveFilter.tags).toEqual(['High protein']);
  });

  it('widens a time bound by half rather than dropping it', async () => {
    // Nothing is 8 minutes and high-protein; something is 12 minutes and
    // high-protein. "Any duration" would not have been a useful answer.
    const outcome = await searchRecipes(makeSearchFilter({ maxMinutes: 8, tags: ['High protein'] }));

    expect(outcome.relaxations).toEqual([
      { kind: 'widened', field: 'maxMinutes', from: 8, to: 12 },
    ]);
    expect(outcome.recipes.length).toBeGreaterThan(0);
    expect(outcome.effectiveFilter.maxMinutes).toBe(12);
    expect(outcome.effectiveFilter.tags).toEqual(['High protein']);
  });

  it('skips a rung the filter never used rather than spending a round on it', async () => {
    // Rungs 1 and 2 are empty here, so the first round is the time bound.
    const outcome = await searchRecipes(makeSearchFilter({ maxMinutes: 8, tags: ['High protein'] }));
    expect(outcome.relaxations[0]?.kind).toBe('widened');
  });

  it('stops after two rounds and returns a genuine empty state', async () => {
    const outcome = await searchRecipes(
      makeSearchFilter({
        maxMinutes: 1,
        minKeepsDays: 300,
        anyTags: ['No cook'],
        tags: ['High protein'],
        categories: ['Soup'],
      }),
    );

    expect(outcome.recipes).toHaveLength(0);
    expect(outcome.relaxations).toEqual([
      { kind: 'dropped', field: 'minKeepsDays' },
      { kind: 'dropped', field: 'anyTags' },
    ]);
    // Rungs 3, 4 and 5 were never reached, so the reader's time bound, tags and
    // category are all still intact in what actually ran.
    expect(outcome.effectiveFilter.maxMinutes).toBe(1);
    expect(outcome.effectiveFilter.tags).toEqual(['High protein']);
    expect(outcome.effectiveFilter.categories).toEqual(['Soup']);
  });

  it('never relaxes an exclusion, however little else is left', async () => {
    // This one relaxes for real — round 1 drops `minKeepsDays` — and the
    // exclusion has to survive it. Returning shrimp to someone who said "no
    // shrimp" because nothing else matched is worse than returning nothing.
    const outcome = await searchRecipes(
      makeSearchFilter({
        ...EXAMPLE_QUERY_FILTER,
        minKeepsDays: 300,
        excludeIngredients: ['salmon', 'shrimp'],
      }),
    );

    expect(outcome.relaxations.length).toBeGreaterThan(0);
    expect(outcome.recipes.length).toBeGreaterThan(0);
    expect(outcome.effectiveFilter.excludeIngredients).toEqual(['salmon', 'shrimp']);

    // Asserted against the ingredient rows, not the titles. A title is a bad
    // proxy for what a recipe contains in both directions, which is the same
    // observation §3.2 makes about matching on anything but the canonical name.
    const banned = (await db.execute(sql`
      select distinct ri.recipe_id::text as id
        from recipe_ingredients ri
        join ingredients i on i.id = ri.ingredient_id
       where i.name in ('salmon', 'shrimp')
    `)) as unknown as { id: string }[];
    expect(banned.length).toBeGreaterThan(0);

    const bannedIds = new Set(banned.map((row) => row.id));
    for (const row of outcome.recipes) expect(bannedIds.has(row.id)).toBe(false);
  });

  it('never relaxes an ingredient requirement into an unrelated answer', async () => {
    const outcome = await searchRecipes(
      makeSearchFilter({ ingredients: ['unobtanium'], minKeepsDays: 300, anyTags: ['No cook'] }),
    );

    expect(outcome.recipes).toHaveLength(0);
    expect(outcome.effectiveFilter.ingredients).toEqual(['unobtanium']);
  });

  it('does not relax a filter that constrains nothing', async () => {
    const outcome = await searchRecipes(makeSearchFilter());
    expect(outcome.recipes).toHaveLength(allActive);
    expect(outcome.relaxations).toEqual([]);
  });
});

// ── Ordering (§4.3) ─────────────────────────────────────────────────────────

describe('ordering', () => {
  /** How many of the *original* filter's criteria a returned row satisfies. */
  function satisfied(row: { keepsDays: number | null; freezerMonths: number | null; servings: number | null }): number {
    return (
      Number((row.keepsDays ?? 0) >= 5) +
      Number((row.freezerMonths ?? 0) > 0) +
      Number((row.servings ?? 0) >= 900)
    );
  }

  it('ranks by how much of the un-relaxed query a row still satisfies', async () => {
    // Rung 1 drops all three of these at once, so the surviving rows differ in
    // how many they met. `match_count` is computed against what the reader
    // asked for, never against the relaxed version — that is the entire reason
    // it exists.
    const outcome = await searchRecipes(
      makeSearchFilter({ minKeepsDays: 5, freezerOnly: true, minServings: 900 }),
    );

    expect(outcome.relaxations).toHaveLength(3);
    expect(outcome.recipes).toHaveLength(allActive);

    const counts = outcome.recipes.map(satisfied);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('uses the reader’s score as the tiebreak among equal matches', async () => {
    const userId = await scratchUser('score');

    const { recipes: baseline } = await searchRecipes(makeSearchFilter({ maxMinutes: 20 }));
    expect(baseline.length).toBeGreaterThan(2);

    // Every row here satisfies the single criterion, so match_count is tied and
    // the score decides. Pick two that are *not* already first and last.
    const low = baseline[0]!;
    const high = baseline[baseline.length - 1]!;

    await db.execute(sql`
      insert into recipe_scores (user_id, recipe_id, score, reason)
      values (${userId}::uuid, ${high.id}::uuid, 99, 'test'),
             (${userId}::uuid, ${low.id}::uuid, 1, 'test')
    `);

    const { recipes: ranked } = await searchRecipes(makeSearchFilter({ maxMinutes: 20 }), { userId });

    expect(ranked[0]!.id).toBe(high.id);
    expect(ranked[ranked.length - 1]!.id).toBe(low.id);
  });

  it('degrades into the browse order when there is one criterion', async () => {
    // Everything ties on match_count and nobody is signed in, so what is left
    // is exactly `listRecipes()`'s cold-start order over the same rows.
    const { recipes: rows } = await searchRecipes(makeSearchFilter({ maxMinutes: 20 }));
    const browse = (await listRecipes({ limit: 500 })).filter(
      (row) => row.totalMinutes !== null && row.totalMinutes <= 20,
    );

    expect(rows.map((row) => row.id)).toEqual(browse.map((row) => row.id));
  });
});

// ── Hard rules are overridden (§4.2) ────────────────────────────────────────

describe('hard rules', () => {
  it('cannot be applied, because the compiler never reads them', async () => {
    // §4.2 is enforced by the type rather than by a runtime check: there is no
    // option to pass rules and therefore none to forget to pass. A reader whose
    // rules would hide long recipes still gets them when they ask for one.
    const outcome = await searchRecipes(makeSearchFilter({ minMinutes: 180 }));

    expect(outcome.recipes.length).toBeGreaterThan(0);
    for (const row of outcome.recipes) expect(row.totalMinutes).toBeGreaterThanOrEqual(180);
  });
});

// ── The compiler itself ─────────────────────────────────────────────────────

describe('compileSearchFilter', () => {
  it('produces no WHERE at all for an empty filter', () => {
    const compiled = compileSearchFilter(makeSearchFilter());
    expect(compiled.where).toBeUndefined();
    expect(compiled.criteriaCount).toBe(0);
  });

  it('counts each unmapped term as its own criterion, and every other field as one', () => {
    const compiled = compileSearchFilter(
      makeSearchFilter({
        maxMinutes: 20,
        tags: ['High protein', 'One pot'],
        excludeIngredients: ['mushrooms', 'olives'],
        unmappedTerms: ['creamy', 'crispy'],
      }),
    );

    expect(compiled.keys).toEqual([
      'maxMinutes',
      'tags',
      'excludeIngredients',
      'term:creamy',
      'term:crispy',
    ]);
    expect(compiled.criteriaCount).toBe(5);
  });
});

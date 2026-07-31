/**
 * The grocery list, merged in the database (PLAN.md §5, Phase 5).
 *
 * Phase 3 built this list in the browser: the planner fetched
 * `/api/recipes/:id` once per saved recipe and folded the lines together in a
 * `useMemo`. That is one round-trip per pick, it ships every instruction step
 * of every saved recipe to build a shopping list that contains none of them,
 * and it cannot be printed by anything but the tab that computed it. This is
 * the same merge as a join and a `group by`.
 *
 * **What is here and what is not.** The query decides *which lines share a
 * line on the receipt* — the `saved_recipes × recipe_ingredients × ingredients`
 * join, the batch multiplier, `grocery_checks.item_key`, whose name and aisle
 * win, and the per-unit subtotals. It stops there. Choosing whether a total
 * prints as `1⅛ cup` or `18 tbsp`, and rendering `4½ lb`, needs the conversion
 * table in `@recipes/shared/units` and the vulgar fractions in
 * `@recipes/shared/format`; re-expressing those in SQL would give this project
 * two copies of its unit vocabulary in two languages, and they would drift.
 * So the query hands buckets to `finalizeGroceryBuckets()` and the shared
 * module finishes the job — the same function `aggregateGroceries()` ends with.
 *
 * That seam is load-bearing, so it is tested by running both implementations
 * over the same rows: `test/grocery-sql.integration.test.ts`.
 *
 * **Unit normalisation reaches SQL as generated data, not as a second
 * implementation.** {@link unitAliasValues} walks the exact alias tables
 * `normalizeUnit()` uses and emits one row per alias. Adding `dessertspoon` to
 * `units.ts` puts it in this query too, with nothing to remember.
 */

import { db, sql, type Database } from '@recipes/db';
import {
  CASE_SENSITIVE_UNIT_ALIASES,
  UNIT_ALIASES,
  unitDimensionKey,
} from '@recipes/shared/units';
import {
  finalizeGroceryBuckets,
  type GroceryAisleGroup,
  type GroceryBucketInput,
} from '@recipes/shared/grocery';
import { clampBatches, MAX_GROCERY_PICKS } from '@recipes/shared/planner';

/**
 * A pick the reader made in the browser but has not signed in to persist.
 * The signed-in path never uses this — it reads `saved_recipes` directly.
 */
export interface GroceryPick {
  readonly recipeId: string;
  readonly batches: number;
}

/** The database-side shape of one bucket, before the shared tail runs. */
interface BucketRow {
  key: string;
  identity: string;
  name: string;
  aisle: string | null;
  approximate: boolean;
  optional: boolean;
  ord: number;
  recipes: string[];
  quantified: { qty: number; unit: string | null }[];
}

/**
 * `(kind, alias, dimension_key)` for every unit spelling the app understands.
 *
 * The dimension key is not recomputed here — it is whatever `unitDimensionKey()`
 * returns for that alias, so the SQL cannot disagree with the TypeScript about
 * what `2 cans` keys on. `''` is in the table on purpose: it is how a line with
 * no written unit ("3 avocados") reaches `count:each`.
 */
function unitAliasValues() {
  const rows: { kind: 'cs' | 'ci'; alias: string; dimensionKey: string }[] = [];
  for (const alias of Object.keys(CASE_SENSITIVE_UNIT_ALIASES)) {
    rows.push({ kind: 'cs', alias, dimensionKey: unitDimensionKey(alias) });
  }
  for (const alias of Object.keys(UNIT_ALIASES)) {
    rows.push({ kind: 'ci', alias, dimensionKey: unitDimensionKey(alias) });
  }
  return sql.join(
    rows.map((row) => sql`(${row.kind}, ${row.alias}, ${row.dimensionKey})`),
    sql`, `,
  );
}

/**
 * `slugify()` from `@recipes/shared/grocery`, in SQL.
 *
 * An unmapped ingredient keys on its own text, so this has to agree with the
 * TypeScript character for character or the same shopping line would get two
 * different `grocery_checks.item_key`s depending on which code path built it —
 * and a reader's check-offs would silently stop matching their list.
 */
const RAW_TEXT_SLUG = sql`
  coalesce(
    nullif(
      left(
        btrim(
          regexp_replace(normalize(lower(ri.raw_text), NFKD), '[^a-z0-9]+', '-', 'g'),
          '-'
        ),
        80
      ),
      ''
    ),
    'unknown'
  )
`;

/**
 * The whole query. `picks` is the only part that differs between a signed-in
 * reader (their `saved_recipes` rows) and a signed-out one (the picks their
 * browser sent), which is what keeps the merge itself defined exactly once.
 */
function groceryQuery(picks: ReturnType<typeof sql>) {
  // `normalizeUnit()`: trim, try the case-sensitive table (`T` is tablespoon
  // and `t` is teaspoon — lower-casing first would triple every `t`), then
  // strip trailing periods, collapse whitespace and try the rest. A NULL unit
  // is `''`, which the case-insensitive table maps to `each`.
  const rawUnit = sql`coalesce(ri.unit, '')`;
  const ciKey = sql`
    btrim(regexp_replace(regexp_replace(lower(btrim(${rawUnit})), '\\.+$', ''), '\\s+', ' ', 'g'))
  `;

  return sql`
    with picks(recipe_id, batches, pick_order) as (${picks}),
    unit_alias(kind, alias, dimension_key) as (values ${unitAliasValues()}),
    lines as (
      select
        r.title as recipe_title,
        p.pick_order,
        p.batches,
        ri.position,
        ri.raw_text,
        ri.ingredient_id,
        -- Multiply in float8, not numeric: the client-side implementation
        -- multiplies IEEE754 doubles, and a numeric product cast afterwards
        -- rounds differently in the last bit.
        (ri.qty::float8 * p.batches) as qty,
        ri.qty is null as unquantified,
        ri.unit,
        ri.optional,
        i.name as canonical_name,
        i.aisle::text as canonical_aisle,
        coalesce(ri.ingredient_id::text, 'raw:' || ${RAW_TEXT_SLUG}) as identity,
        coalesce(
          cs.dimension_key,
          ci.dimension_key,
          -- Outside the vocabulary: key on the spelling itself, so at least it
          -- is stable across renders. Deliberately not dash-trimmed — this
          -- mirrors unitDimensionKey(), which does not trim either.
          'unit:' || coalesce(
            nullif(regexp_replace(lower(btrim(${rawUnit})), '[^a-z0-9]+', '-', 'g'), ''),
            'unknown'
          )
        ) as dimension_key
      from picks p
      join recipes r on r.id = p.recipe_id
      join recipe_ingredients ri on ri.recipe_id = p.recipe_id
      left join ingredients i on i.id = ri.ingredient_id
      left join unit_alias cs on cs.kind = 'cs' and cs.alias = btrim(${rawUnit})
      left join unit_alias ci on ci.kind = 'ci' and ci.alias = ${ciKey}
    ),
    bucketed as (
      select
        l.*,
        row_number() over (order by l.pick_order, l.position) as seq,
        l.identity
          || ':'
          || case when l.unquantified then 'unspecified' else l.dimension_key end as key
      from lines l
    )
    select
      key,
      min(identity) as identity,
      min(seq)::int as ord,
      -- A canonical name beats raw text, and the earliest mapped line decides
      -- both the name and the aisle. "ingredient_id is null" sorts false first,
      -- which puts every mapped line ahead of every unmapped one.
      (array_agg(
        coalesce(nullif(btrim(coalesce(canonical_name, '')), ''), btrim(raw_text))
        order by (ingredient_id is null), pick_order, position
      ))[1] as name,
      (array_agg(canonical_aisle order by (ingredient_id is null), pick_order, position))[1]
        as aisle,
      bool_or(unquantified) as approximate,
      bool_and(optional) as optional,
      array_agg(recipe_title order by pick_order, position) as recipes,
      coalesce(
        jsonb_agg(jsonb_build_object('qty', qty, 'unit', unit) order by pick_order, position)
          filter (where not unquantified),
        '[]'::jsonb
      ) as quantified
    from bucketed
    group by key
  `;
}

async function run(
  database: Database,
  picks: ReturnType<typeof sql>,
): Promise<GroceryAisleGroup[]> {
  const rows = (await database.execute(groceryQuery(picks))) as unknown as BucketRow[];

  return finalizeGroceryBuckets(
    rows.map(
      (row): GroceryBucketInput => ({
        key: row.key,
        identity: row.identity,
        name: row.name,
        aisle: row.aisle,
        approximate: row.approximate,
        optional: row.optional,
        order: row.ord,
        // `array_agg` keeps every contribution; the shared tail wants the
        // distinct titles in first-seen order, which is what a Set gives it.
        recipes: [...new Set(row.recipes)],
        quantified: row.quantified,
      }),
    ),
  );
}

/**
 * The signed-in list: PLAN.md §5's `saved_recipes × recipe_ingredients ×
 * ingredients` with nothing sent up from the browser.
 *
 * Pick order is `saved_at`, which is the order the picks tab shows and
 * therefore the order recipe names appear under a merged item.
 */
export function groceryListForUser(
  userId: string,
  database: Database = db,
): Promise<GroceryAisleGroup[]> {
  return run(
    database,
    sql`
      select sr.recipe_id, sr.batches, row_number() over (order by sr.saved_at, sr.recipe_id)
      from saved_recipes sr
      where sr.user_id = ${userId}::uuid
    `,
  );
}

/**
 * The signed-out list, from the picks the browser is holding in
 * `localStorage`. The planner works signed out and auth is not a gate on it
 * (PLAN.md §5, Phase 4), so this path is not a fallback — it is how most first
 * visits build a list.
 *
 * Ids that no longer exist simply produce no rows: the join drops them, which
 * is the same forgiving behaviour `importPlannerState()` has.
 */
export function groceryListForPicks(
  picks: readonly GroceryPick[],
  database: Database = db,
): Promise<GroceryAisleGroup[]> {
  if (picks.length === 0) return Promise.resolve([]);

  const values = sql.join(
    picks
      .slice(0, MAX_GROCERY_PICKS)
      .map(
        (pick, index) =>
          sql`(${pick.recipeId}::uuid, ${clampBatches(pick.batches)}::int, ${index}::int)`,
      ),
    sql`, `,
  );
  return run(database, sql`select * from (values ${values}) as t(recipe_id, batches, pick_order)`);
}

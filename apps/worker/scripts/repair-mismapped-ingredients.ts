/**
 * Undo the wrong canonical mappings the Phase 2 run learned.
 *
 * `DATABASE_URL=… corepack pnpm --filter @recipes/worker repair:ingredients`
 * `… repair:ingredients --apply` to write; without it the script only reports.
 *
 * The audit at the start of Phase 5 found that the semantic mapper sometimes
 * answered `action: "existing"` with a canonical it had no business choosing —
 * `ketchup` → `kalamata olives`, `tahini`/`tapioca flour`/`tamarind pulp` →
 * `taco seasoning`, `cauliflower` → `capers`. The provider-facing schema pins
 * `canonical_name` to an enum of the entire vocabulary, so a model that has
 * committed to `"existing"` has to emit *some* member of it, and it reaches for
 * a neighbour. `isPlausibleCanonicalMatch()` now rejects those at the source
 * (PROGRESS.md amendment A18); this repairs what the unguarded run already
 * wrote.
 *
 * Repairing means two things:
 *   1. delete the poisoned `ingredient_aliases` row, so the deterministic
 *      matcher stops answering from it — one bad alias re-maps every future
 *      line with that spelling, which is why `ketchup` was wrong eight times;
 *   2. set `recipe_ingredients.ingredient_id` back to NULL on the rows that
 *      alias claimed, which returns them to the backfill queue. The worker's
 *      next enrichment run re-maps them through the guard.
 *
 * A row is identified the same way the backfill identifies it — parse the raw
 * line, take `ingredientAliasKey()` of the parsed name — rather than by
 * matching text against `raw_text`. Anything else would either miss rows or
 * catch rows that reached the same ingredient by a different, correct alias.
 */

import { db, ingredientAliases, recipeIngredients } from '@recipes/db';
import { inArray, isNotNull, isNull, sql } from '@recipes/db/operators';
import { ingredientAliasKey } from '@recipes/shared';
import { parseIngredientLine } from '../src/ingredients/parser';

/**
 * Every alias below was read by hand against its canonical. The list is
 * deliberately literal rather than a similarity threshold: a threshold that
 * caught `ketchup` → `kalamata olives` also caught `garbanzo beans` →
 * `chickpeas`, which is correct and must survive.
 *
 * Only the mappings that are wrong about *what the item is* are here. Mappings
 * that merge a variety into its parent (`cumin seeds` → `ground cumin`,
 * `nonstick cooking spray` → `baking spray`) are left alone: they are
 * arguable, not wrong, and re-mapping them would cost provider calls to
 * probably land in the same place.
 */
const MISMAPPED_ALIASES: readonly string[] = [
  'blue cheese crumbles',
  'brandy or bourbon',
  'branzino filets',
  'burrata or fresh mozzarella cheese',
  'butter lettuce leaves',
  'chopped chives',
  'dried ground sage',
  'flaky sea salt for sprinkling',
  'grated lime zest',
  'green bell pepper',
  'green cabbage',
  'green chilies',
  'ketchup',
  'large bunch flat-leaf parsley',
  'medium head cauliflower',
  'medium head of cauliflower',
  'medium navel oranges',
  'mesclun or spring mix',
  'packed parsley leaves and tender stems',
  'shelled',
  'spanish dry-cured chorizo',
  'swiss chard',
  'tahini',
  'tamarind pulp',
  'tapioca flour',
  'tapioca starch',
  'tartar sauce or creamy dill sauce',
  'tender lettuce',
  'tequila',
  'thin fresh chinese wheat noodles or fresh thin egg pasta',
  'white wine vinegar',
];

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const targets = new Set(MISMAPPED_ALIASES.map((alias) => ingredientAliasKey(alias)));

  const aliasRows = await db
    .select({ alias: ingredientAliases.alias, ingredientId: ingredientAliases.ingredientId })
    .from(ingredientAliases)
    .where(inArray(ingredientAliases.alias, [...targets]));

  const missing = [...targets].filter(
    (alias) => !aliasRows.some((row) => row.alias === alias),
  );
  if (missing.length > 0) {
    // Not fatal — a previous run of this script, or a re-seed, may already have
    // removed them. Worth saying out loud so the list does not quietly rot.
    console.log(`aliases already absent (${missing.length}): ${missing.join(', ')}`);
  }

  const mapped = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      position: recipeIngredients.position,
      rawText: recipeIngredients.rawText,
    })
    .from(recipeIngredients)
    .where(isNotNull(recipeIngredients.ingredientId));

  const hits = mapped.filter((row) => {
    let parsed: ReturnType<typeof parseIngredientLine>;
    try {
      parsed = parseIngredientLine(row.rawText);
    } catch {
      return false;
    }
    return parsed !== null && targets.has(ingredientAliasKey(parsed.name));
  });

  console.log(`aliases to delete: ${aliasRows.length}`);
  console.log(`rows to unmap:     ${hits.length} of ${mapped.length} mapped`);
  for (const row of hits) console.log(`  ${row.rawText}`);

  if (!APPLY) {
    console.log('\ndry run — pass --apply to write');
    return;
  }

  await db.transaction(async (tx) => {
    if (aliasRows.length > 0) {
      await tx
        .delete(ingredientAliases)
        .where(inArray(ingredientAliases.alias, aliasRows.map((row) => row.alias)));
    }
    for (const row of hits) {
      await tx
        .update(recipeIngredients)
        .set({ ingredientId: null })
        .where(
          sql`${recipeIngredients.recipeId} = ${row.recipeId} and ${recipeIngredients.position} = ${row.position}`,
        );
    }
  });

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recipeIngredients)
    .where(isNull(recipeIngredients.ingredientId));

  console.log(`\napplied. rows now awaiting re-mapping: ${remaining?.count ?? 0}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

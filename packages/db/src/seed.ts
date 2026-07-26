/**
 * Idempotent seed. `corepack pnpm db:seed`.
 *
 * What gets seeded, and — just as importantly — what does not:
 *
 *   ✔ the 117 hand-classified canonical ingredients (PLAN.md §4: "Seed the
 *     canonical table with the ~120 ingredients already in the artifact");
 *   ✔ one self-alias per ingredient, so stage 2 of the matcher has exact-match
 *     hits from the very first crawl rather than sending all 117 to the LLM;
 *   ✔ a `dev@local` user, development only (§4: "`getCurrentUser()` returns it
 *     when `NODE_ENV !== 'production'` ... in production, no session means no
 *     user");
 *   ✘ no recipes and no sources. PLAN.md §8: "No seeded recipes — only the
 *     ~120 canonical ingredients." Phase 1 owns the `sources` rows, and every
 *     recipe in the system arrives from a crawl.
 *
 * Re-running is a no-op apart from refreshing aisle/default-unit if the JSON
 * changed, so this is safe to wire into container start-up.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { CANONICAL_INGREDIENTS } from '@recipes/shared';
import { createClient, type Database } from './client';
import { ingredientAliases, ingredients, users } from './schema';

export const DEV_USER_EMAIL = 'dev@local';

export interface SeedResult {
  ingredients: number;
  aliases: number;
  devUser: boolean;
}

/**
 * The alias form of a canonical name. Kept deliberately dumb — lower-case and
 * whitespace-collapsed — because the matcher's exact-match stage must use the
 * identical transform, and anything cleverer here silently stops matching.
 */
export function aliasKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function seed(db: Database, nodeEnv = process.env.NODE_ENV): Promise<SeedResult> {
  // De-duplicated by name: Postgres refuses an ON CONFLICT DO UPDATE that would
  // touch the same row twice in one statement ("cannot affect row a second
  // time"), and normalising names could in principle collapse two entries.
  const rows = [
    ...new Map(
      CANONICAL_INGREDIENTS.map((i) => [
        aliasKey(i.name),
        { name: aliasKey(i.name), aisle: i.aisle, defaultUnit: i.defaultUnit },
      ]),
    ).values(),
  ];

  return db.transaction(async (tx) => {
    // Upsert on the natural key. `set` rather than `doNothing` so an edit to
    // ingredient-seed.json (a re-classified aisle, say) actually lands.
    const inserted = await tx
      .insert(ingredients)
      .values(rows)
      .onConflictDoUpdate({
        target: ingredients.name,
        set: {
          aisle: sql`excluded.aisle`,
          defaultUnit: sql`excluded.default_unit`,
        },
      })
      .returning({ id: ingredients.id, name: ingredients.name });

    const aliasRows = inserted.map((row) => ({
      ingredientId: row.id,
      alias: aliasKey(row.name),
    }));

    const aliases = await tx
      .insert(ingredientAliases)
      .values(aliasRows)
      // An alias is unique across all ingredients; if one already points
      // somewhere (possibly somewhere the Phase 2 matcher learned), leave it.
      .onConflictDoNothing({ target: ingredientAliases.alias })
      .returning({ id: ingredientAliases.id });

    let devUser = false;
    if (nodeEnv !== 'production') {
      await tx
        .insert(users)
        .values({ email: DEV_USER_EMAIL, name: 'Dev' })
        .onConflictDoNothing({ target: users.email });
      devUser = true;
    }

    return { ingredients: inserted.length, aliases: aliases.length, devUser };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { client, db } = createClient({ max: 1 });
  seed(db)
    .then((result) => {
      console.log(
        `seeded ${result.ingredients} ingredients, ${result.aliases} new aliases` +
          (result.devUser ? `, ${DEV_USER_EMAIL} user` : ', no dev user (production)'),
      );
    })
    .catch((error: unknown) => {
      console.error('seed failed:', error);
      process.exitCode = 1;
    })
    .finally(() => client.end({ timeout: 5 }));
}

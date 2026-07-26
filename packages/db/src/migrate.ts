/**
 * Programmatic migration runner. `corepack pnpm db:migrate`.
 *
 * Ordering matters here and is worth stating explicitly: the migrator walks
 * `drizzle/meta/_journal.json` in `idx` order, so `0000_extensions` (citext,
 * pg_trgm, pgcrypto, vector) always runs before `0001_init`, which is the
 * migration that creates a `citext` column and two `gin_trgm_ops` indexes and
 * would fail outright without them. That ordering came from scaffolding the
 * extensions migration with `drizzle-kit generate --custom` *before* the schema
 * existed, so drizzle-kit itself assigned it idx 0 — nothing here depends on a
 * hand-edited journal.
 *
 * Safe to run repeatedly: drizzle records applied migrations in
 * `drizzle.__drizzle_migrations`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createClient } from './client';

/** Absolute path to the committed SQL migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(url?: string): Promise<void> {
  // max: 1 — migrations must run on a single connection, in order.
  const { client, db } = createClient({ url, max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('migration failed:', error);
      process.exit(1);
    });
}

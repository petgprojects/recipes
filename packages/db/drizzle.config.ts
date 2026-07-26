import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` diffs `src/schema.ts` against the snapshots in
 * `drizzle/meta/` and writes committed SQL. It does not connect to a database,
 * so the placeholder URL below is enough for generation; `db:studio` and
 * `drizzle-kit push` need a real `DATABASE_URL`.
 *
 * Migrations are applied by `src/migrate.ts`, not by drizzle-kit — see the note
 * there about `0000_extensions.sql` having to run before anything else.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/recipes',
  },
});

/**
 * Postgres connection + Drizzle instance.
 *
 * `DATABASE_URL` comes from `@recipes/shared/env`, which validates it at import
 * time — so a bad or missing URL fails at boot with a readable message rather
 * than as a connection error somewhere deep in the first query.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@recipes/shared/env';
import * as schema from './schema';

export type Schema = typeof schema;

export interface CreateClientOptions {
  url?: string;
  /** Pool size. Scripts (migrate, seed) want 1; long-lived services want more. */
  max?: number;
  /** Log every statement. Useful when a query result looks wrong. */
  debug?: boolean;
}

/**
 * A fresh, independent connection. Use this in one-shot scripts so they can
 * `await sql.end()` and let the process exit; use the shared `db` below in
 * anything long-lived.
 */
export function createClient(options: CreateClientOptions = {}) {
  const client = postgres(options.url ?? env.DATABASE_URL, {
    max: options.max ?? 10,
    // The extraction pipeline stores whole JSON-LD blobs; the default 30s
    // statement window is fine, but a stuck connection should not wedge a run.
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: options.debug ? undefined : () => {},
  });

  const db = drizzle(client, {
    schema,
    casing: 'snake_case',
    logger: options.debug ?? false,
  });

  return { client, db };
}

/**
 * Process-wide singleton. Cached on `globalThis` outside production because
 * Next.js dev re-evaluates modules on every edit, and a fresh pool per edit
 * exhausts `max_connections` within a few minutes.
 */
const globalForDb = globalThis as unknown as {
  __recipesDb?: ReturnType<typeof createClient>;
};

const shared = globalForDb.__recipesDb ?? createClient();
if (env.NODE_ENV !== 'production') globalForDb.__recipesDb = shared;

/** The postgres.js client, for raw SQL and `LISTEN`/advisory locks. */
export const client = shared.client;

/** The Drizzle instance. `import { db } from '@recipes/db'`. */
export const db = shared.db;

export type Database = typeof db;

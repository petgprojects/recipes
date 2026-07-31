/**
 * Barrel export for `@recipes/db`.
 *
 *   import { db, recipes, eq } from '@recipes/db';
 *
 * Importing this (or `@recipes/db/client`) opens a connection pool and
 * therefore requires a valid `DATABASE_URL`. Code that only needs table
 * definitions — a migration script, a type, a test — should import
 * `@recipes/db/schema`, which has no side effects.
 */

export * from './schema';
export { db, client, createClient, type Database, type Schema } from './client';

// Re-exported so consumers get the operator set that matches this exact
// drizzle-orm version, without adding drizzle-orm to their own package.json.
export { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';

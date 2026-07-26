/**
 * Barrel export for `@recipes/shared`.
 *
 * `./env` is intentionally absent: it validates `process.env` as a side effect
 * of being imported, so it must stay opt-in (`@recipes/shared/env`) and
 * server-only. Everything re-exported here is pure data and pure functions and
 * is safe in a client bundle.
 */

export * from './vocab';
export * from './units';
export * from './schemas';
export * from './ingredients';

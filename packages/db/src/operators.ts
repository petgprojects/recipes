/**
 * Side-effect-free Drizzle operators for worker libraries and tests that use
 * `@recipes/db/schema` without opening the process-wide database pool.
 */
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

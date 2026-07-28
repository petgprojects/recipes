/**
 * Phase 7 step 1: derive each reader's hard rules deterministically, in SQL.
 *
 * PLAN.md §5 is specific that this half must not involve the model: "These
 * become `user_preferences.hard_rules` and are applied as a **SQL filter**, not
 * a prompt — reqs.md's 'if I don't like things that take more than 1 hour,
 * don't show it' should be a `WHERE` clause, deterministic and debuggable."
 *
 * So this module only *gathers evidence*. Every decision about whether a rule
 * is warranted lives in `@recipes/shared/personalization`, which is pure and
 * unit-tested without a database. The split is the same one the grocery list
 * uses (A19): SQL counts, TypeScript decides.
 *
 * The join is on `cook_logs` — a reader's own history — so a user with no
 * ratings produces no observations, no rules, and an untouched row.
 */

import { and, cookLogs, db, eq, gt, isNotNull, recipes, sql, userPreferences } from '@recipes/db';
import {
  TIME_RULE_THRESHOLDS,
  deriveExclusionRules,
  deriveTimeRule,
  mergeHardRules,
  parseHardRules,
  type HardRule,
  type RuleObservation,
} from '@recipes/shared/personalization';

/**
 * Ratings for every cook of a recipe longer than `threshold` minutes.
 *
 * Recipes with an unknown `total_minutes` are excluded rather than treated as
 * fast: a null here means Phase 2 could not derive a time, and counting those
 * as evidence *for* a time rule would let missing data build a filter.
 */
async function timeObservations(userId: string): Promise<RuleObservation[]> {
  const buckets = await Promise.all(
    TIME_RULE_THRESHOLDS.map(async (threshold) => {
      const rows = await db
        .select({ rating: cookLogs.rating })
        .from(cookLogs)
        .innerJoin(recipes, eq(recipes.id, cookLogs.recipeId))
        .where(
          and(
            eq(cookLogs.userId, userId),
            isNotNull(recipes.totalMinutes),
            gt(recipes.totalMinutes, threshold),
          ),
        );

      return {
        kind: 'max_minutes' as const,
        value: String(threshold),
        ratings: rows.map((row) => row.rating),
      };
    }),
  );

  return buckets;
}

/** What both grouped queries below return, before the pure layer judges it. */
interface BucketRow {
  value: string;
  ratings: number[];
}

/** Ratings grouped by the cooked recipe's category. Nulls are not a bucket. */
async function categoryObservations(userId: string): Promise<RuleObservation[]> {
  const rows = (await db.execute(sql`
    select r.category::text as value, array_agg(c.rating) as ratings
    from cook_logs c
    join recipes r on r.id = c.recipe_id
    where c.user_id = ${userId} and r.category is not null
    group by r.category
  `)) as unknown as BucketRow[];

  return rows.map((row) => ({
    kind: 'exclude_category' as const,
    value: row.value,
    ratings: row.ratings,
  }));
}

/**
 * Ratings grouped by tag.
 *
 * `unnest` in a lateral join, so one cook of a recipe tagged `sheet-pan` and
 * `spicy` contributes a rating to both buckets. These buckets therefore
 * overlap each other, unlike the category ones — but each is still judged only
 * against its own evidence, and `MIN_OBSERVATIONS_PER_RULE` keeps a tag that
 * appears on two recipes from ever becoming a filter.
 */
async function tagObservations(userId: string): Promise<RuleObservation[]> {
  const rows = (await db.execute(sql`
    select t.tag as value, array_agg(c.rating) as ratings
    from cook_logs c
    join recipes r on r.id = c.recipe_id
    cross join lateral unnest(r.tags) as t(tag)
    where c.user_id = ${userId}
    group by t.tag
  `)) as unknown as BucketRow[];

  return rows.map((row) => ({
    kind: 'exclude_tag' as const,
    value: row.value,
    ratings: row.ratings,
  }));
}

export async function gatherObservations(userId: string): Promise<RuleObservation[]> {
  const [time, category, tag] = await Promise.all([
    timeObservations(userId),
    categoryObservations(userId),
    tagObservations(userId),
  ]);

  return [...time, ...category, ...tag];
}

export interface DeriveHardRulesResult {
  userId: string;
  rules: HardRule[];
  /** Rules the evidence supports but the reader has switched off. */
  disabled: number;
}

/**
 * Re-derive one reader's rules and store them.
 *
 * Writes even when the result is empty: an empty array is a real answer ("no
 * pattern strong enough to filter on") and is what clears a rule whose
 * evidence has gone away. `mergeHardRules()` is what stops that from also
 * clearing an override the reader set by hand.
 */
export async function deriveHardRulesForUser(userId: string): Promise<DeriveHardRulesResult> {
  const observations = await gatherObservations(userId);

  const timeRule = deriveTimeRule(observations);
  const derived = [...(timeRule === null ? [] : [timeRule]), ...deriveExclusionRules(observations)];

  const [existing] = await db
    .select({ hardRules: userPreferences.hardRules })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  const rules = mergeHardRules(parseHardRules(existing?.hardRules), derived);

  await db
    .insert(userPreferences)
    .values({ userId, hardRules: rules, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      // `profile` is deliberately untouched — step 2 owns that column, and the
      // two steps must not clobber each other when they run minutes apart.
      set: { hardRules: rules, updatedAt: new Date() },
    });

  return { userId, rules, disabled: rules.filter((rule) => !rule.enabled).length };
}

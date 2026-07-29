/**
 * `user_preferences`, server-side.
 *
 * The counterpart to `@recipes/shared/personalization`: that module owns what a
 * hard rule is and when one may exist, this one owns the SQL. Same split as
 * `@recipes/shared/ratings` / `lib/ratings.ts`.
 *
 * The worker *writes* rules nightly (`apps/worker/src/personalization/
 * hard-rules.ts`). The web app only reads them, plus the one write a reader can
 * make by hand: flipping a rule's switch. Those two writers touch different
 * things on purpose — the job owns the evidence, the reader owns `enabled` —
 * and `mergeHardRules()` on the job side is what keeps the reader's decision
 * from being overwritten the next night.
 */

import { db, eq, sql, userPreferences } from '@recipes/db';
import { parseHardRules, type HardRule } from '@recipes/shared/personalization';

export interface UserPreferences {
  rules: HardRule[];
  /** The Phase 7 step 2 prose profile. Null until that job has ever run. */
  profile: string | null;
}

const EMPTY: UserPreferences = { rules: [], profile: null };

function toProfile(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * A reader's stored preferences, or empty ones.
 *
 * Empty is the correct answer for a user the nightly job has never visited,
 * and it is also the correct answer signed out — which is why this is safe to
 * call unconditionally from the browse path. No row means no filtering, not an
 * error.
 */
export async function getUserPreferences(userId: string | null): Promise<UserPreferences> {
  if (userId === null) return EMPTY;

  const [row] = await db
    .select({ hardRules: userPreferences.hardRules, profile: userPreferences.profile })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (row === undefined) return EMPTY;

  return { rules: parseHardRules(row.hardRules), profile: toProfile(row.profile) };
}

export type SetHardRuleResult =
  | { result: 'ok'; rules: HardRule[] }
  | { result: 'unknown-rule' };

/**
 * Switch one rule on or off.
 *
 * Rewrites the whole array rather than patching one element by index: the
 * nightly job re-sorts by id and can insert a rule ahead of this one between a
 * page render and the click that follows it, so an index the client sent would
 * address the wrong rule. Matching on `id` is the only stable identity a rule
 * has — which is why `id` is derived from kind and value rather than generated.
 *
 * A rule id the reader does not have is `unknown-rule`, not a silent no-op: the
 * switch is a direct manipulation of something visible on screen, so a request
 * that changes nothing means the UI is out of date and should say so.
 */
export async function setHardRuleEnabled(
  userId: string,
  ruleId: string,
  enabled: boolean,
): Promise<SetHardRuleResult> {
  const current = await getUserPreferences(userId);
  if (!current.rules.some((rule) => rule.id === ruleId)) return { result: 'unknown-rule' };

  const rules = current.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule));

  await db
    .insert(userPreferences)
    .values({ userId, hardRules: rules, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      // `profile` untouched — step 2 owns that column.
      set: { hardRules: rules, updatedAt: new Date() },
    });

  return { result: 'ok', rules };
}

/**
 * The `WHERE` fragment for a set of rules, or `undefined` when nothing is on.
 *
 * Every clause is written to **keep a row whose column is null**. A rule exists
 * because of what a reader disliked about recipes we have data for; a recipe
 * whose time or category Phase 2 could not derive has not been disliked, it is
 * simply unknown, and hiding it would let missing data act as a preference.
 * Same direction as A20 throughout: a missed filter beats a wrong one.
 */
export function hardRuleFilter(rules: HardRule[]) {
  const clauses = rules
    .filter((rule) => rule.enabled)
    .map((rule) => {
      switch (rule.kind) {
        case 'max_minutes': {
          const minutes = Number(rule.value);
          if (!Number.isFinite(minutes)) return null;
          return sql`(recipes.total_minutes is null or recipes.total_minutes <= ${minutes})`;
        }
        case 'exclude_category':
          return sql`(recipes.category is null or recipes.category::text <> ${rule.value})`;
        case 'exclude_tag':
          return sql`not (recipes.tags @> array[${rule.value}]::text[])`;
      }
    })
    .filter((clause) => clause !== null);

  if (clauses.length === 0) return undefined;

  return sql.join(clauses, sql` and `);
}

/**
 * Phase 7 step 2: the soft profile, stored in `user_preferences.profile`.
 *
 * The split is the same one step 1 uses (A19, A20): **SQL gathers, TypeScript
 * decides**. This module reads a reader's cook history and persists the answer;
 * `apps/worker/src/llm/taste-profile.ts` owns the prompt and
 * `@recipes/shared/personalization` owns the cold-start rule and the output
 * contract. Nothing here judges anything.
 *
 * The one thing to know before adding a writer: **three different callers now
 * touch `user_preferences`**, and each owns exactly one column. The nightly
 * rules job owns `hard_rules`, the reader's switch owns `enabled` inside it,
 * and this owns `profile`. Every `onConflictDoUpdate` here therefore lists its
 * own column and `updated_at` — never the whole row — because the three run
 * minutes apart and a full-row upsert would silently revert whichever ran
 * first.
 */

import { cookLogs, db, desc, eq, recipes, sql, userPreferences } from '@recipes/db';
import {
  PROFILE_HISTORY_LIMIT,
  hasEnoughHistoryForScoring,
} from '@recipes/shared/personalization';
import {
  deriveTasteProfile,
  type CookLogFact,
  type StructuredOutputCallOptions,
  type StructuredOutputClient,
} from '../llm';

export interface CookHistory {
  /**
   * Distinct recipes rated, over the reader's *whole* history rather than the
   * bounded window below — the cold-start guard asks "has this person told us
   * enough about themselves", which a display limit must not answer.
   */
  ratedRecipes: number;
  /** Most recent first, bounded by `PROFILE_HISTORY_LIMIT`. */
  logs: CookLogFact[];
}

export async function loadCookHistory(userId: string): Promise<CookHistory> {
  const [counted] = await db
    .select({ ratedRecipes: sql<number>`count(distinct ${cookLogs.recipeId})::int` })
    .from(cookLogs)
    .where(eq(cookLogs.userId, userId));

  const rows = await db
    .select({
      title: recipes.title,
      totalMinutes: recipes.totalMinutes,
      category: recipes.category,
      tags: recipes.tags,
      rating: cookLogs.rating,
      aspects: cookLogs.aspects,
      notes: cookLogs.notes,
    })
    .from(cookLogs)
    .innerJoin(recipes, eq(recipes.id, cookLogs.recipeId))
    .where(eq(cookLogs.userId, userId))
    // Most recent first so the window keeps who they are *now*. `id` breaks the
    // tie because two cooks logged in the same second must not reorder between
    // one nightly run and the next — a profile that changes for no reason
    // invalidates every score derived from it.
    .orderBy(desc(cookLogs.cookedAt), desc(cookLogs.id))
    .limit(PROFILE_HISTORY_LIMIT);

  return {
    ratedRecipes: counted?.ratedRecipes ?? 0,
    logs: rows.map((row) => ({
      title: row.title,
      totalMinutes: row.totalMinutes,
      category: row.category,
      tags: row.tags ?? [],
      rating: row.rating,
      aspects: row.aspects ?? [],
      notes: row.notes,
    })),
  };
}

export type DeriveProfileResult =
  | {
      status: 'cold-start';
      ratedRecipes: number;
      profile: null;
      changed: false;
    }
  | {
      status: 'written';
      ratedRecipes: number;
      profile: string;
      /**
       * True when the stored text actually moved. Step 3 uses this to decide
       * whether existing `recipe_scores` are stale: a score is an answer to a
       * question the profile asked, so when the question changes every answer
       * has to be asked again.
       */
      changed: boolean;
    };

export interface DeriveProfileOptions {
  readonly client: StructuredOutputClient;
  readonly userId: string;
  /** Budget/accounting hooks, built fresh per provider request. */
  readonly callOptions?: () => StructuredOutputCallOptions;
}

/**
 * Re-derive one reader's profile and store it.
 *
 * Below the cold-start floor this makes **no provider call at all** and returns
 * without writing. That is deliberate: a profile written from two cooks would
 * be confidently wrong, and nothing would ever be scored against it anyway
 * (`hasEnoughHistoryForScoring()` gates both halves), so the call would be
 * bought for nothing.
 *
 * An existing profile is left alone rather than cleared when a reader falls
 * back below the floor — history only shrinks by deletion, and yesterday's
 * profile is a better answer than none.
 */
export async function deriveProfileForUser(
  options: DeriveProfileOptions,
): Promise<DeriveProfileResult> {
  const history = await loadCookHistory(options.userId);
  if (!hasEnoughHistoryForScoring(history.ratedRecipes)) {
    return { status: 'cold-start', ratedRecipes: history.ratedRecipes, profile: null, changed: false };
  }

  const profile = await deriveTasteProfile(
    options.client,
    history.logs,
    options.callOptions?.(),
  );

  const [existing] = await db
    .select({ profile: userPreferences.profile })
    .from(userPreferences)
    .where(eq(userPreferences.userId, options.userId))
    .limit(1);

  // `profile` is `jsonb`, so what comes back is `unknown` — anything at all
  // could be in that column. Only a string is a profile; everything else is
  // treated as "there wasn't one", which is also what `getUserPreferences()`
  // in the web app decides.
  const previous = typeof existing?.profile === 'string' ? existing.profile : null;

  await db
    .insert(userPreferences)
    .values({ userId: options.userId, profile, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      // `hard_rules` is deliberately untouched — step 1 owns that column, and
      // the reader's on/off switch lives inside it.
      set: { profile, updatedAt: new Date() },
    });

  return {
    status: 'written',
    ratedRecipes: history.ratedRecipes,
    profile,
    changed: previous !== profile,
  };
}

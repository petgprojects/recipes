/**
 * Phase 7 step 3: score recipes against a reader's profile, in batches.
 *
 * PLAN.md §5 asks for this "in the daily scan", and the shape of the work is
 * exactly the Phase 2 ingredient backfill's: a bounded queue of rows with
 * nothing in a column yet, twenty at a time, each batch a single stateless
 * structured-output call under the daily budget.
 *
 * Two decisions worth stating, because both are invisible when they are right:
 *
 *   - **Scoring ignores hard rules.** A recipe a rule hides is still scored.
 *     The rules are a switch a reader can flip at any moment, and a feed that
 *     came back unranked the instant they flipped one would look broken. The
 *     cost of scoring rows nobody currently sees is a few cents; the cost of
 *     the other choice is a visibly worse feed.
 *   - **A changed profile invalidates every score.** A score is an answer to
 *     the question the profile asked. When the question changes the old answers
 *     are not stale-but-usable, they are answers to a different question — so
 *     `refreshAll` rescores the corpus rather than only the new arrivals. Rows
 *     are overwritten in place and never deleted first, so the feed keeps a
 *     complete ranking throughout, including if the run stops on budget.
 */

import { and, db, desc, eq, isNull, recipeScores, recipes, sql } from '@recipes/db';
import {
  SCORE_BATCH_SIZE,
  batchForScoring,
  resolveScoreBatch,
  type ResolvedRecipeScore,
  type ScoreBatchEntry,
} from '@recipes/shared/personalization';
import {
  scoreRecipes,
  type ScorableRecipe,
  type StructuredOutputCallOptions,
  type StructuredOutputClient,
} from '../llm';

/**
 * A ceiling on one run, not on the corpus. With 235 active recipes a full
 * rescore is twelve calls; this exists so that a corpus that has grown by an
 * order of magnitude cannot turn one nightly job into an unbounded bill. What
 * is left over is simply picked up by the next run, because "unscored" is
 * durable state in the table rather than progress held in memory.
 */
export const MAX_RECIPES_SCORED_PER_RUN = 400;

type ScorableRow = Omit<ScorableRecipe, 'ref'> & { id: string };

/**
 * The recipes this run should score, newest first.
 *
 * Newest first because that is the order a reader is most likely to notice:
 * if a run stops early on budget, the recipes that got scored are the ones
 * nearest the top of the feed.
 */
export async function loadRecipesToScore(
  userId: string,
  options: { refreshAll?: boolean; limit?: number } = {},
): Promise<ScorableRow[]> {
  const limit = Math.min(options.limit ?? MAX_RECIPES_SCORED_PER_RUN, MAX_RECIPES_SCORED_PER_RUN);

  return db
    .select({
      id: recipes.id,
      title: recipes.title,
      blurb: recipes.blurb,
      category: recipes.category,
      tags: recipes.tags,
      totalMinutes: recipes.totalMinutes,
      activeMinutes: recipes.activeMinutes,
      servings: recipes.servings,
      keepsDays: recipes.keepsDays,
      freezerMonths: recipes.freezerMonths,
    })
    .from(recipes)
    .leftJoin(
      recipeScores,
      and(eq(recipeScores.recipeId, recipes.id), eq(recipeScores.userId, userId)),
    )
    .where(
      and(
        eq(recipes.status, 'active'),
        options.refreshAll === true ? undefined : isNull(recipeScores.recipeId),
      ),
    )
    .orderBy(desc(sql`coalesce(${recipes.publishedAt}, ${recipes.firstSeenAt})`), desc(recipes.id))
    .limit(limit)
    .then((rows) =>
      rows.map((row) => ({ ...row, tags: row.tags ?? [] })),
    );
}

/** Write one batch's worth of scores. Upsert, so a rescore overwrites in place. */
export async function saveRecipeScores(
  userId: string,
  scores: readonly ResolvedRecipeScore[],
): Promise<void> {
  if (scores.length === 0) return;

  const scoredAt = new Date();
  await db
    .insert(recipeScores)
    .values(
      scores.map((score) => ({
        userId,
        recipeId: score.recipeId,
        score: score.score,
        reason: score.reason,
        scoredAt,
      })),
    )
    .onConflictDoUpdate({
      target: [recipeScores.userId, recipeScores.recipeId],
      set: {
        score: sql`excluded.score`,
        reason: sql`excluded.reason`,
        scoredAt: sql`excluded.scored_at`,
      },
    });
}

export interface ScoreRecipesForUserOptions {
  readonly client: StructuredOutputClient;
  readonly userId: string;
  readonly profile: string;
  /** Rescore recipes that already have a row — see the header. */
  readonly refreshAll?: boolean;
  readonly limit?: number;
  /** Budget/accounting hooks, built fresh per provider request. */
  readonly callOptions?: () => StructuredOutputCallOptions;
  readonly signal?: AbortSignal;
}

export interface ScoreRecipesForUserResult {
  readonly userId: string;
  readonly considered: number;
  readonly scored: number;
  readonly batches: number;
}

export async function scoreRecipesForUser(
  options: ScoreRecipesForUserOptions,
): Promise<ScoreRecipesForUserResult> {
  const candidates = await loadRecipesToScore(options.userId, {
    refreshAll: options.refreshAll,
    limit: options.limit,
  });

  let scored = 0;
  let batches = 0;

  for (const batch of batchForScoring(candidates, SCORE_BATCH_SIZE)) {
    throwIfAborted(options.signal);
    batches += 1;

    const response = await scoreRecipes(
      options.client,
      {
        profile: options.profile,
        recipes: batch.map(({ ref, item }) => ({ ref, ...omitId(item) })),
      },
      options.callOptions?.(),
    );

    // The refs go back through the pure resolver rather than being trusted:
    // a short, long, duplicated or renumbered response costs rows, never
    // correctness.
    const entries: ScoreBatchEntry[] = batch.map(({ ref, item }) => ({
      ref,
      recipeId: item.id,
    }));
    const resolved = resolveScoreBatch(entries, response);
    await saveRecipeScores(options.userId, resolved);
    scored += resolved.length;
  }

  return { userId: options.userId, considered: candidates.length, scored, batches };
}

function omitId(row: ScorableRow): Omit<ScorableRecipe, 'ref'> {
  const { id: _id, ...facts } = row;
  return facts;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('personalization aborted during worker shutdown');
}

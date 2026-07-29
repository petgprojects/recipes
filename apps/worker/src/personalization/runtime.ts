/**
 * The nightly personalization pass — all three of Phase 7's steps, in order,
 * for every reader who has given us anything to work with.
 *
 * Order matters and is not arbitrary. Rules first, because they are free: they
 * are pure SQL and must keep being re-derived even for a reader far below the
 * scoring floor, or a filter would outlive the ratings that justified it. Then
 * the profile, which is the first thing that costs money and is gated by the
 * cold start. Then scoring, which needs the profile that was just written.
 *
 * Failure is per-reader. One reader's malformed history must not cost every
 * other reader their nightly run, so a failure is recorded and the pass moves
 * on — except a budget stop, which is not this reader's problem but the day's,
 * and ends the pass in the same orderly `partial` the enrichment run uses.
 */

import { db, sql } from '@recipes/db';
import {
  beginEnrichmentRun,
  createBudgetedLlmCallOptions,
  finishEnrichmentRun,
  isLlmBudgetExceeded,
} from '../enrichment';
import type { StructuredOutputClient } from '../llm';
import { deriveHardRulesForUser } from './hard-rules';
import { deriveProfileForUser } from './profile';
import { scoreRecipesForUser } from './scoring';

export interface UserPersonalizationSummary {
  readonly userId: string;
  readonly rules: number;
  readonly disabledRules: number;
  readonly ratedRecipes: number;
  /** `unavailable` means no provider is configured — steps 1 still ran. */
  readonly profile: 'unavailable' | 'cold-start' | 'unchanged' | 'updated';
  readonly considered: number;
  readonly scored: number;
  readonly batches: number;
}

export interface RunPersonalizationForUserOptions {
  /**
   * `null` when `OPENROUTER_API_KEY` is not configured. The pass still runs —
   * step 1 is pure SQL and costs nothing, and a deployment without a provider
   * key should still have working, debuggable filters. Only the model half is
   * skipped.
   */
  readonly client: StructuredOutputClient | null;
  readonly userId: string;
  readonly dailyBudgetUsd: number;
  /** The `scan_runs` row this pass's tokens and cost are attributed to. */
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export async function runPersonalizationForUser(
  options: RunPersonalizationForUserOptions,
): Promise<UserPersonalizationSummary> {
  // Fresh hooks per provider request: the budget lease is held across exactly
  // one call and refuses to be re-entered, so these objects are not reusable.
  const callOptions = () =>
    createBudgetedLlmCallOptions({
      db,
      runId: options.runId,
      dailyBudgetUsd: options.dailyBudgetUsd,
      signal: options.signal,
      now: options.now,
    });

  const rules = await deriveHardRulesForUser(options.userId);

  if (options.client === null) {
    return {
      userId: options.userId,
      rules: rules.rules.length,
      disabledRules: rules.disabled,
      ratedRecipes: 0,
      profile: 'unavailable',
      considered: 0,
      scored: 0,
      batches: 0,
    };
  }

  const profile = await deriveProfileForUser({
    client: options.client,
    userId: options.userId,
    callOptions,
  });

  if (profile.status === 'cold-start') {
    return {
      userId: options.userId,
      rules: rules.rules.length,
      disabledRules: rules.disabled,
      ratedRecipes: profile.ratedRecipes,
      profile: 'cold-start',
      considered: 0,
      scored: 0,
      batches: 0,
    };
  }

  const scores = await scoreRecipesForUser({
    client: options.client,
    userId: options.userId,
    profile: profile.profile,
    refreshAll: profile.changed,
    callOptions,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    userId: options.userId,
    rules: rules.rules.length,
    disabledRules: rules.disabled,
    ratedRecipes: profile.ratedRecipes,
    profile: profile.changed ? 'updated' : 'unchanged',
    considered: scores.considered,
    scored: scores.scored,
    batches: scores.batches,
  };
}

/**
 * Who the pass runs for.
 *
 * Readers with cook logs, obviously — plus readers who already have a
 * `user_preferences` row and may no longer have any logs. Leaving the second
 * group out would mean a reader who deleted their ratings kept the filters
 * derived from them forever, since only a run can clear a rule.
 */
export async function personalizationUserIds(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select user_id::text as user_id from cook_logs group by user_id
    union
    select user_id::text as user_id from user_preferences
    order by user_id
  `)) as unknown as { user_id: string }[];

  return rows.map((row) => row.user_id);
}

export interface PersonalizationPassSummary {
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: 'success' | 'partial';
  readonly users: UserPersonalizationSummary[];
  readonly failures: { userId: string; error: string }[];
  readonly budgetExhausted: boolean;
  readonly error: string | null;
}

export interface RunPersonalizationPassOptions {
  /** `null` runs the deterministic half only — see the per-user options. */
  readonly client: StructuredOutputClient | null;
  readonly dailyBudgetUsd: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export async function runPersonalizationPass(
  options: RunPersonalizationPassOptions,
): Promise<PersonalizationPassSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  // The same null-source `scan_runs` row the enrichment backlog opens. Sharing
  // it is what puts this pass under the same durable daily budget instead of a
  // second, independent one that could together spend twice the cap.
  const runId = await beginEnrichmentRun(db, startedAt);

  const users: UserPersonalizationSummary[] = [];
  const failures: { userId: string; error: string }[] = [];
  let budgetExhausted = false;
  let fatal: unknown = null;

  try {
    for (const userId of await personalizationUserIds()) {
      throwIfAborted(options.signal);
      try {
        users.push(
          await runPersonalizationForUser({
            client: options.client,
            userId,
            dailyBudgetUsd: options.dailyBudgetUsd,
            runId,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
        );
      } catch (error) {
        if (isLlmBudgetExceeded(error)) {
          budgetExhausted = true;
          break;
        }
        failures.push({ userId, error: errorMessage(error) });
      }
    }
  } catch (error) {
    fatal = error;
  }

  const status =
    fatal !== null || budgetExhausted || failures.length > 0 ? 'partial' : 'success';
  const error =
    fatal !== null
      ? errorMessage(fatal)
      : budgetExhausted
        ? 'daily LLM budget reached before every reader was personalized'
        : failures.length > 0
          ? `${failures.length} reader(s) failed: ${failures[0]!.error}`
          : null;

  const finishedAt = now();
  await finishEnrichmentRun(db, {
    runId,
    status,
    processedCount: users.length,
    finishedAt,
    error,
  });

  // An abort is worker shutdown, and pg-boss should hand the job to the next
  // attempt rather than see it succeed with half the readers done.
  if (fatal !== null) throw fatal;

  return {
    runId,
    startedAt,
    finishedAt,
    status,
    users,
    failures,
    budgetExhausted,
    error,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('personalization aborted during worker shutdown');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

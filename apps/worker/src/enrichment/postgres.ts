/**
 * Postgres persistence for the Phase 2 enrichment worker.
 *
 * `recipes.status = 'pending'` is the durable work queue checkpoint. pg-boss
 * guarantees one enrichment handler at a time; these helpers make each recipe
 * completion and every usage increment independently durable, so a process
 * restart repeats at most the current recipe.
 */

import {
  and,
  asc,
  eq,
  gte,
  isNull,
  lt,
  sql,
} from '@recipes/db/operators';
import {
  recipeIngredients,
  recipes,
  scanRuns,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  derivedFieldsSchema,
  type DerivedFields,
  type InstructionStep,
  type ScanRunStatus,
} from '@recipes/shared';

export interface PendingRecipeIngredient {
  readonly position: number;
  readonly rawText: string;
  readonly qty: number | null;
  readonly unit: string | null;
  readonly note: string | null;
  readonly optional: boolean;
}

/**
 * The deterministic facts needed by the Phase 2 tasks. The content hash must
 * be passed back to `completeRecipeEnrichment`; it prevents an answer produced
 * from old facts from landing after a concurrent rescan.
 */
export interface PendingRecipeForEnrichment {
  readonly id: string;
  readonly contentHash: string | null;
  readonly sourceUrl: string;
  readonly title: string;
  readonly totalMinutes: number | null;
  readonly activeMinutes: number | null;
  readonly servings: number | null;
  readonly author: string | null;
  readonly sourceRating: number | null;
  readonly sourceRatingCount: number | null;
  readonly instructions: InstructionStep[];
  readonly rawJsonld: unknown;
  readonly publishedAt: Date | null;
  readonly firstSeenAt: Date;
  readonly ingredients: readonly PendingRecipeIngredient[];
}

/**
 * Loads one stable next item without claiming it. The enrichment pg-boss queue
 * is globally exclusive, so a database lease would add a second recovery
 * mechanism without improving correctness.
 */
export async function loadNextPendingRecipe(
  db: Database,
): Promise<PendingRecipeForEnrichment | null> {
  const [recipe] = await db
    .select({
      id: recipes.id,
      contentHash: recipes.contentHash,
      sourceUrl: recipes.sourceUrl,
      title: recipes.title,
      totalMinutes: recipes.totalMinutes,
      activeMinutes: recipes.activeMinutes,
      servings: recipes.servings,
      author: recipes.author,
      sourceRating: recipes.sourceRating,
      sourceRatingCount: recipes.sourceRatingCount,
      instructions: recipes.instructions,
      rawJsonld: recipes.rawJsonld,
      publishedAt: recipes.publishedAt,
      firstSeenAt: recipes.firstSeenAt,
    })
    .from(recipes)
    .where(eq(recipes.status, 'pending'))
    .orderBy(asc(recipes.firstSeenAt), asc(recipes.id))
    .limit(1);

  if (recipe === undefined) return null;

  const ingredients = await db
    .select({
      position: recipeIngredients.position,
      rawText: recipeIngredients.rawText,
      qty: recipeIngredients.qty,
      unit: recipeIngredients.unit,
      note: recipeIngredients.note,
      optional: recipeIngredients.optional,
    })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipe.id))
    .orderBy(asc(recipeIngredients.position));

  return { ...recipe, ingredients };
}

interface CompleteRecipeEnrichmentBase {
  readonly recipeId: string;
  readonly expectedContentHash: string | null;
}

export type CompleteRecipeEnrichmentInput =
  | (CompleteRecipeEnrichmentBase & {
      readonly outcome: 'accepted';
      readonly blurb: string;
      readonly fields: DerivedFields;
    })
  | (CompleteRecipeEnrichmentBase & {
      readonly outcome: 'rejected';
      readonly reason: string;
    });

export interface CompleteRecipeEnrichmentResult {
  readonly outcome: 'completed' | 'stale';
  readonly recipeId: string;
}

/**
 * Publishes a complete enrichment decision in one statement.
 *
 * A zero-row update is not an error: it means the recipe was already handled
 * or its deterministic content changed while the LLM request was in flight.
 */
export async function completeRecipeEnrichment(
  db: Database,
  input: CompleteRecipeEnrichmentInput,
): Promise<CompleteRecipeEnrichmentResult> {
  const hashCondition =
    input.expectedContentHash === null
      ? isNull(recipes.contentHash)
      : eq(recipes.contentHash, input.expectedContentHash);

  const values: Partial<typeof recipes.$inferInsert> =
    input.outcome === 'accepted'
      ? acceptedValues(input.blurb, input.fields)
      : rejectedValues(input.reason);

  const completed = await db
    .update(recipes)
    .set(values)
    .where(
      and(
        eq(recipes.id, input.recipeId),
        eq(recipes.status, 'pending'),
        hashCondition,
      ),
    )
    .returning({ id: recipes.id });

  return {
    outcome: completed.length === 0 ? 'stale' : 'completed',
    recipeId: input.recipeId,
  };
}

function acceptedValues(
  blurbInput: string,
  fieldsInput: DerivedFields,
): Partial<typeof recipes.$inferInsert> {
  const blurb = blurbInput.trim();
  if (blurb.length === 0) {
    throw new TypeError('An accepted recipe requires a non-empty blurb');
  }
  const fields = derivedFieldsSchema.parse(fieldsInput);
  return {
    blurb,
    keepsDays: fields.keeps_days,
    freezerMonths: fields.freezer_months,
    category: fields.category,
    tags: fields.tags,
    status: 'active',
    rejectionReason: null,
  };
}

function rejectedValues(
  reasonInput: string,
): Partial<typeof recipes.$inferInsert> {
  const reason = reasonInput.trim();
  if (reason.length === 0) {
    throw new TypeError('A rejected recipe requires a non-empty reason');
  }
  return {
    blurb: null,
    keepsDays: null,
    freezerMonths: null,
    category: null,
    tags: [],
    status: 'rejected',
    rejectionReason: reason,
  };
}

export interface LlmUsageIncrement {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface DailyLlmUsage extends LlmUsageIncrement {
  readonly dayStartedAt: Date;
  readonly dayEndsAt: Date;
}

/** A null-source scan run represents one whole-backlog enrichment pass. */
export async function beginEnrichmentRun(
  db: Database,
  startedAt = new Date(),
): Promise<string> {
  const [run] = await db
    .insert(scanRuns)
    .values({
      sourceId: null,
      startedAt,
      status: 'running',
      found: 0,
      newCount: 0,
      noRecipeCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    })
    .returning({ id: scanRuns.id });

  if (run === undefined) {
    throw new Error('Could not create enrichment scan run');
  }
  return run.id;
}

/**
 * Records each provider response immediately. The arithmetic happens in
 * Postgres, so concurrent callbacks cannot lose one another's increments.
 */
export async function recordLlmUsage(
  db: Database,
  runId: string,
  usage: LlmUsageIncrement,
): Promise<void> {
  assertUsage(usage);
  const updated = await db
    .update(scanRuns)
    .set({
      tokensIn: sql`${scanRuns.tokensIn} + ${usage.tokensIn}`,
      tokensOut: sql`${scanRuns.tokensOut} + ${usage.tokensOut}`,
      costUsd: sql`${scanRuns.costUsd} + ${usage.costUsd}`,
    })
    .where(eq(scanRuns.id, runId))
    .returning({ id: scanRuns.id });

  if (updated.length === 0) {
    throw new Error(`Cannot record LLM usage for missing scan run ${runId}`);
  }
}

export interface FinishEnrichmentRunInput {
  readonly runId: string;
  readonly status: Exclude<ScanRunStatus, 'running'>;
  readonly processedCount: number;
  readonly finishedAt?: Date;
  readonly error?: string | null;
}

/**
 * Finalizes lifecycle fields without rewriting tokens/cost. Usage may have
 * been committed several responses earlier and must survive validation errors,
 * budget stops, or shutdown.
 */
export async function finishEnrichmentRun(
  db: Database,
  input: FinishEnrichmentRunInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.processedCount) || input.processedCount < 0) {
    throw new TypeError('processedCount must be a non-negative safe integer');
  }
  const updated = await db
    .update(scanRuns)
    .set({
      finishedAt: input.finishedAt ?? new Date(),
      status: input.status,
      found: input.processedCount,
      error: input.error ?? null,
    })
    .where(eq(scanRuns.id, input.runId))
    .returning({ id: scanRuns.id });

  if (updated.length === 0) {
    throw new Error(`Cannot finish missing enrichment scan run ${input.runId}`);
  }
}

/**
 * Budget day is UTC and is attributed by run start. Enrichment jobs are
 * bounded to six hours and are started by the daily worker schedule, so a run
 * cannot split its aggregate across multiple budget rows.
 */
export async function getDailyLlmUsage(
  db: Database,
  at = new Date(),
): Promise<DailyLlmUsage> {
  const dayStartedAt = utcDayStart(at);
  const dayEndsAt = new Date(dayStartedAt.getTime() + 24 * 60 * 60 * 1_000);
  const [usage] = await db
    .select({
      tokensIn: sql<number>`coalesce(sum(${scanRuns.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${scanRuns.tokensOut}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${scanRuns.costUsd}), 0)::double precision`,
    })
    .from(scanRuns)
    .where(
      and(
        gte(scanRuns.startedAt, dayStartedAt),
        lt(scanRuns.startedAt, dayEndsAt),
      ),
    );

  return {
    dayStartedAt,
    dayEndsAt,
    tokensIn: usage?.tokensIn ?? 0,
    tokensOut: usage?.tokensOut ?? 0,
    costUsd: usage?.costUsd ?? 0,
  };
}

function utcDayStart(at: Date): Date {
  if (Number.isNaN(at.getTime())) throw new TypeError('Budget date is invalid');
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

function assertUsage(usage: LlmUsageIncrement): void {
  if (!Number.isSafeInteger(usage.tokensIn) || usage.tokensIn < 0) {
    throw new TypeError('tokensIn must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(usage.tokensOut) || usage.tokensOut < 0) {
    throw new TypeError('tokensOut must be a non-negative safe integer');
  }
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw new TypeError('costUsd must be a non-negative finite number');
  }
}

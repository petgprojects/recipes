/**
 * Restart-safe orchestration for the Phase 2 pending-recipe backlog.
 *
 * This module owns sequencing and lifecycle semantics only. Provider clients,
 * prompts, budget storage, and Postgres connections are injected by the worker
 * composition root.
 */

import type {
  DerivedFields,
  Suitability,
} from '@recipes/shared';
import type {
  CompleteRecipeEnrichmentInput,
  CompleteRecipeEnrichmentResult,
  FinishEnrichmentRunInput,
  PendingRecipeForEnrichment,
} from './postgres';

export interface EnrichmentTaskContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface EnrichmentOrchestratorDependencies {
  readonly beginRun: (startedAt: Date) => Promise<string>;
  readonly loadNextPending: () => Promise<PendingRecipeForEnrichment | null>;
  readonly classifySuitability: (
    recipe: PendingRecipeForEnrichment,
    context: EnrichmentTaskContext,
  ) => Promise<Suitability>;
  readonly deriveFields: (
    recipe: PendingRecipeForEnrichment,
    context: EnrichmentTaskContext,
  ) => Promise<DerivedFields>;
  readonly writeBlurb: (
    recipe: PendingRecipeForEnrichment,
    context: EnrichmentTaskContext,
  ) => Promise<string>;
  readonly completeRecipe: (
    input: CompleteRecipeEnrichmentInput,
  ) => Promise<CompleteRecipeEnrichmentResult>;
  readonly finishRun: (input: FinishEnrichmentRunInput) => Promise<void>;
  /**
   * The LLM boundary owns the concrete budget error type. This predicate keeps
   * the orchestrator provider-agnostic while still treating budget exhaustion
   * as an orderly partial stop rather than a failed pg-boss attempt.
   */
  readonly isBudgetExceeded: (error: unknown) => boolean;
  readonly now?: () => Date;
}

export interface RunPendingEnrichmentOptions {
  readonly signal?: AbortSignal;
}

export interface EnrichmentRunSummary {
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: 'success' | 'partial';
  readonly attemptedCount: number;
  readonly completedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly staleCount: number;
  readonly budgetExhausted: boolean;
  readonly error: string | null;
}

export interface EnrichmentOrchestrator {
  run(
    options?: RunPendingEnrichmentOptions,
  ): Promise<EnrichmentRunSummary>;
}

export function createEnrichmentOrchestrator(
  dependencies: EnrichmentOrchestratorDependencies,
): EnrichmentOrchestrator {
  const now = dependencies.now ?? (() => new Date());

  return {
    async run(
      options: RunPendingEnrichmentOptions = {},
    ): Promise<EnrichmentRunSummary> {
      throwIfAborted(options.signal);
      const startedAt = now();
      const runId = await dependencies.beginRun(startedAt);
      const seenRecipeIds = new Set<string>();
      let attemptedCount = 0;
      let acceptedCount = 0;
      let rejectedCount = 0;
      let staleCount = 0;

      try {
        for (;;) {
          throwIfAborted(options.signal);
          const recipe = await dependencies.loadNextPending();
          if (recipe === null) {
            return finishAndSummarize({
              dependencies,
              now,
              runId,
              startedAt,
              status: 'success',
              attemptedCount,
              acceptedCount,
              rejectedCount,
              staleCount,
              budgetExhausted: false,
              error: null,
            });
          }

          // A completed row should disappear from the pending query. If an
          // injected store violates that contract—or a rescan immediately
          // resets the same row—defer it to the next pg-boss attempt instead
          // of allowing one oldest row to monopolize this process forever.
          if (seenRecipeIds.has(recipe.id)) {
            return finishAndSummarize({
              dependencies,
              now,
              runId,
              startedAt,
              status: 'partial',
              attemptedCount,
              acceptedCount,
              rejectedCount,
              staleCount,
              budgetExhausted: false,
              error: `recipe ${recipe.id} remained pending after this run attempted it`,
            });
          }
          seenRecipeIds.add(recipe.id);
          attemptedCount += 1;

          const context: EnrichmentTaskContext = {
            runId,
            signal: options.signal,
          };
          const suitability = await dependencies.classifySuitability(
            recipe,
            context,
          );
          throwIfAborted(options.signal);

          let completed: CompleteRecipeEnrichmentResult;
          if (!suitability.is_meal_prep) {
            completed = await dependencies.completeRecipe({
              recipeId: recipe.id,
              expectedContentHash: recipe.contentHash,
              outcome: 'rejected',
              reason: suitability.reason,
            });
          } else {
            const fields = await dependencies.deriveFields(recipe, context);
            throwIfAborted(options.signal);
            const blurb = await dependencies.writeBlurb(recipe, context);
            throwIfAborted(options.signal);
            completed = await dependencies.completeRecipe({
              recipeId: recipe.id,
              expectedContentHash: recipe.contentHash,
              outcome: 'accepted',
              fields,
              blurb,
            });
          }

          if (completed.outcome === 'stale') {
            staleCount += 1;
            return finishAndSummarize({
              dependencies,
              now,
              runId,
              startedAt,
              status: 'partial',
              attemptedCount,
              acceptedCount,
              rejectedCount,
              staleCount,
              budgetExhausted: false,
              error: `recipe ${recipe.id} changed while enrichment was running`,
            });
          }

          if (suitability.is_meal_prep) {
            acceptedCount += 1;
          } else {
            rejectedCount += 1;
          }
        }
      } catch (error) {
        if (dependencies.isBudgetExceeded(error)) {
          return finishAndSummarize({
            dependencies,
            now,
            runId,
            startedAt,
            status: 'partial',
            attemptedCount,
            acceptedCount,
            rejectedCount,
            staleCount,
            budgetExhausted: true,
            error: errorMessage(error),
          });
        }

        const finishedAt = now();
        try {
          await dependencies.finishRun({
            runId,
            status: 'error',
            processedCount: acceptedCount + rejectedCount,
            finishedAt,
            error: errorMessage(error),
          });
        } catch (finishError) {
          throw new AggregateError(
            [error, finishError],
            `enrichment run ${runId} failed and its telemetry could not be finalized`,
          );
        }
        throw error;
      }
    },
  };
}

interface FinishAndSummarizeInput {
  readonly dependencies: EnrichmentOrchestratorDependencies;
  readonly now: () => Date;
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: EnrichmentRunSummary['status'];
  readonly attemptedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly staleCount: number;
  readonly budgetExhausted: boolean;
  readonly error: string | null;
}

async function finishAndSummarize(
  input: FinishAndSummarizeInput,
): Promise<EnrichmentRunSummary> {
  const finishedAt = input.now();
  await input.dependencies.finishRun({
    runId: input.runId,
    status: input.status,
    processedCount: input.acceptedCount + input.rejectedCount,
    finishedAt,
    error: input.error,
  });
  return {
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt,
    status: input.status,
    attemptedCount: input.attemptedCount,
    completedCount: input.acceptedCount + input.rejectedCount,
    acceptedCount: input.acceptedCount,
    rejectedCount: input.rejectedCount,
    staleCount: input.staleCount,
    budgetExhausted: input.budgetExhausted,
    error: input.error,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('enrichment aborted during worker shutdown');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

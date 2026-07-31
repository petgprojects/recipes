import { asc, eq, isNull, sql } from '@recipes/db/operators';
import {
  ingredients,
  recipeIngredients,
  recipes,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  createBudgetedLlmCallOptions,
  isLlmBudgetExceeded,
} from '@recipes/db/llm-budget';
import {
  classifySuitability,
  deriveFields,
  mapIngredients,
  writeBlurb,
  type StructuredOutputClient,
} from '../llm';
import {
  createIngredientBackfillOrchestrator,
  type IngredientBackfillOrchestrator,
} from './ingredients-orchestrator';
import {
  applyIngredientMappings,
  loadUnmappedIngredientLines,
} from './ingredients-postgres';
import {
  createEnrichmentOrchestrator,
  type EnrichmentOrchestrator,
} from './orchestrator';
import {
  beginEnrichmentRun,
  completeRecipeEnrichment,
  finishEnrichmentRun,
  loadNextPendingRecipe,
} from './postgres';

export interface CreatePostgresEnrichmentOrchestratorOptions {
  readonly db: Database;
  readonly client: StructuredOutputClient;
  readonly dailyBudgetUsd: number;
  readonly now?: () => Date;
}

export interface EnrichmentJobRunSummary {
  readonly recipe: Awaited<ReturnType<EnrichmentOrchestrator['run']>>;
  readonly ingredients: Awaited<
    ReturnType<IngredientBackfillOrchestrator['run']>
  > | null;
  readonly status: 'success' | 'partial';
  readonly budgetExhausted: boolean;
  /**
   * A non-budget partial is durable but incomplete and should use pg-boss's
   * bounded retry policy. A budget stop waits for the next scheduled/startup
   * enqueue because retrying against the same UTC-day cap cannot make progress.
   */
  readonly retryRequired: boolean;
  readonly error: string | null;
}

export interface EnrichmentJobRunner {
  run(signal: AbortSignal): Promise<EnrichmentJobRunSummary>;
}

export interface CreateEnrichmentJobRunnerOptions {
  readonly recipes: EnrichmentOrchestrator;
  readonly ingredients: IngredientBackfillOrchestrator;
  readonly hasUnmappedIngredients: () => Promise<boolean>;
}

/**
 * Runs both durable Phase 2 backlogs and reports enough information for the
 * pg-boss handler to distinguish a retryable race/transient partial from an
 * orderly daily-budget stop.
 */
export function createEnrichmentJobRunner(
  options: CreateEnrichmentJobRunnerOptions,
): EnrichmentJobRunner {
  return {
    async run(signal) {
      const recipe = await options.recipes.run({ signal });
      if (recipe.status === 'partial') {
        return combinedJobSummary(recipe, null);
      }

      const ingredients = (await options.hasUnmappedIngredients())
        ? await options.ingredients.run({ signal })
        : null;
      return combinedJobSummary(recipe, ingredients);
    },
  };
}

export function createPostgresEnrichmentOrchestrator(
  options: CreatePostgresEnrichmentOrchestratorOptions,
): EnrichmentOrchestrator {
  const taskOptions = (runId: string, signal?: AbortSignal) =>
    createBudgetedLlmCallOptions({
      db: options.db,
      runId,
      kind: 'scan',
      dailyBudgetUsd: options.dailyBudgetUsd,
      signal,
      now: options.now,
    });

  return createEnrichmentOrchestrator({
    now: options.now,
    beginRun: (startedAt) => beginEnrichmentRun(options.db, startedAt),
    loadNextPending: () => loadNextPendingRecipe(options.db),
    classifySuitability: (recipe, context) =>
      classifySuitability(
        options.client,
        recipe,
        taskOptions(context.runId, context.signal),
      ),
    deriveFields: (recipe, context) =>
      deriveFields(
        options.client,
        recipe,
        taskOptions(context.runId, context.signal),
      ),
    writeBlurb: (recipe, context) =>
      writeBlurb(
        options.client,
        recipe,
        taskOptions(context.runId, context.signal),
      ),
    completeRecipe: (input) =>
      completeRecipeEnrichment(options.db, input),
    finishRun: (input) => finishEnrichmentRun(options.db, input),
    isBudgetExceeded: isLlmBudgetExceeded,
  });
}

export function createPostgresIngredientBackfillOrchestrator(
  options: CreatePostgresEnrichmentOrchestratorOptions,
): IngredientBackfillOrchestrator {
  const now = options.now ?? (() => new Date());
  return createIngredientBackfillOrchestrator(
    {
      now,
      beginRun: (startedAt) => beginEnrichmentRun(options.db, startedAt),
      finishRun: (input) => finishEnrichmentRun(options.db, input),
      loadUnmappedLines: (limit) =>
        loadUnmappedIngredientLines(options.db, limit),
      async countRemaining() {
        const [row] = await options.db
          .select({
            count: sql<number>`count(*)::int`,
          })
          .from(recipeIngredients)
          .where(isNull(recipeIngredients.ingredientId));
        return row?.count ?? 0;
      },
      loadCanonicalIngredients() {
        return options.db
          .select({
            name: ingredients.name,
            aisle: ingredients.aisle,
          })
          .from(ingredients)
          .orderBy(asc(ingredients.name));
      },
      mapIngredients: (input, context) =>
        mapIngredients(
          options.client,
          input,
          createBudgetedLlmCallOptions({
            db: options.db,
            runId: context.runId,
            kind: 'scan',
            dailyBudgetUsd: options.dailyBudgetUsd,
            signal: context.signal,
            now: options.now,
          }),
        ),
      applyMappings: (decisions, refs) =>
        applyIngredientMappings(options.db, decisions, refs),
      isBudgetExceeded: isLlmBudgetExceeded,
    },
    // Forty-name batches reached the model's output cap and made repairs
    // unnecessarily fragile in the live backfill. Twenty keeps the prompt
    // bounded while still mapping all duplicate rows for each chosen name.
    { batchSize: 20 },
  );
}

export async function hasPendingRecipes(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.status, 'pending'))
    .limit(1);
  return rows.length > 0;
}

export async function hasUnmappedIngredients(db: Database): Promise<boolean> {
  const rows = await db
    .select({ recipeId: recipeIngredients.recipeId })
    .from(recipeIngredients)
    .where(isNull(recipeIngredients.ingredientId))
    .limit(1);
  return rows.length > 0;
}

function combinedJobSummary(
  recipe: EnrichmentJobRunSummary['recipe'],
  ingredients: EnrichmentJobRunSummary['ingredients'],
): EnrichmentJobRunSummary {
  const status =
    recipe.status === 'partial' || ingredients?.status === 'partial'
      ? 'partial'
      : 'success';
  const budgetExhausted =
    recipe.budgetExhausted || ingredients?.budgetExhausted === true;
  return {
    recipe,
    ingredients,
    status,
    budgetExhausted,
    retryRequired: status === 'partial' && !budgetExhausted,
    error: recipe.error ?? ingredients?.error ?? null,
  };
}

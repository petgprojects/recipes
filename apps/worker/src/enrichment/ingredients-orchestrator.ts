/**
 * Pure orchestration for the semantic ingredient backfill.
 *
 * Parsing and grouping are deterministic. The only semantic operation is the
 * injected `mapIngredients` task; persistence, budget policy, and provider
 * clients remain outside this module.
 */

import {
  ingredientAliasKey,
  normalizedIngredientNameSchema,
  type CanonicalIngredientSummary,
  type IngredientMappingOutput,
} from '@recipes/shared';
import { parseIngredientLine } from '../ingredients/parser';
import type {
  ApplyIngredientMappingsResult,
  IngredientMappingDecision,
  ParsedIngredientLineRef,
  UnmappedIngredientLine,
} from './ingredients-postgres';
import type { FinishEnrichmentRunInput } from './postgres';

const DEFAULT_BATCH_SIZE = 40;
const MAX_BATCH_SIZE = 40;
const MAX_LOADED_LINES = 10_000;

export interface IngredientMappingTaskInput {
  readonly unknownNames: readonly string[];
  readonly canonicalIngredients: readonly CanonicalIngredientSummary[];
}

export interface IngredientMappingTaskContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface IngredientBackfillDependencies {
  readonly beginRun: (startedAt: Date) => Promise<string>;
  readonly finishRun: (input: FinishEnrichmentRunInput) => Promise<void>;
  readonly loadUnmappedLines: (
    limit: number,
  ) => Promise<readonly UnmappedIngredientLine[]>;
  readonly countRemaining: () => Promise<number>;
  readonly loadCanonicalIngredients: () => Promise<
    readonly CanonicalIngredientSummary[]
  >;
  readonly mapIngredients: (
    input: IngredientMappingTaskInput,
    context: IngredientMappingTaskContext,
  ) => Promise<IngredientMappingOutput>;
  readonly applyMappings: (
    decisions: readonly IngredientMappingDecision[],
    refs: readonly ParsedIngredientLineRef[],
  ) => Promise<ApplyIngredientMappingsResult>;
  readonly isBudgetExceeded: (error: unknown) => boolean;
  readonly now?: () => Date;
}

export interface IngredientBackfillOptions {
  readonly batchSize?: number;
}

export interface RunIngredientBackfillOptions {
  readonly signal?: AbortSignal;
}

export interface IngredientBackfillSummary {
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: 'success' | 'partial';
  readonly attemptedNames: number;
  readonly mappedRows: number;
  readonly learnedAliases: number;
  readonly staleRows: number;
  readonly conflicts: number;
  readonly remainingRows: number;
  readonly unparseableRows: number;
  readonly budgetExhausted: boolean;
  readonly error: string | null;
}

export interface IngredientBackfillOrchestrator {
  run(
    options?: RunIngredientBackfillOptions,
  ): Promise<IngredientBackfillSummary>;
}

export function createIngredientBackfillOrchestrator(
  dependencies: IngredientBackfillDependencies,
  options: IngredientBackfillOptions = {},
): IngredientBackfillOrchestrator {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0 ||
    batchSize > MAX_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be a safe integer between 1 and ${MAX_BATCH_SIZE}`,
    );
  }
  const now = dependencies.now ?? (() => new Date());

  return {
    async run(
      runOptions: RunIngredientBackfillOptions = {},
    ): Promise<IngredientBackfillSummary> {
      throwIfAborted(runOptions.signal);
      const startedAt = now();
      const runId = await dependencies.beginRun(startedAt);
      const totals = emptyTotals();
      const seenUnparseableLines = new Set<string>();

      try {
        for (;;) {
          throwIfAborted(runOptions.signal);
          // Load past permanently unparseable rows, then cap the provider
          // request by distinct names below. Otherwise the oldest forty bad
          // lines would starve every later valid ingredient forever.
          const lines = await dependencies.loadUnmappedLines(MAX_LOADED_LINES);
          if (lines.length === 0) {
            return finishAndSummarize({
              dependencies,
              now,
              runId,
              startedAt,
              status: 'success',
              totals,
              remainingRows: 0,
              budgetExhausted: false,
              error: null,
            });
          }

          const parsed = parseBatch(lines);
          for (const line of parsed.unparseableLines) {
            seenUnparseableLines.add(lineIdentity(line));
          }
          totals.unparseableRows = seenUnparseableLines.size;
          if (parsed.refs.length === 0) {
            return finishPartial({
              dependencies,
              now,
              runId,
              startedAt,
              totals,
              budgetExhausted: false,
              error:
                `${seenUnparseableLines.size} ingredient line(s) could not be ` +
                `parsed into a normalized name`,
            });
          }

          const unknownNames = [
            ...new Set(parsed.refs.map((ref) => ref.parsedName)),
          ].sort(compareText).slice(0, batchSize);
          const selectedNames = new Set(unknownNames);
          const selectedRefs = parsed.refs.filter((ref) =>
            selectedNames.has(ref.parsedName),
          );
          const canonicalIngredients = [
            ...(await dependencies.loadCanonicalIngredients()),
          ].sort((left, right) => compareText(left.name, right.name));
          totals.attemptedNames += unknownNames.length;

          const output = await dependencies.mapIngredients(
            { unknownNames, canonicalIngredients },
            { runId, signal: runOptions.signal },
          );
          throwIfAborted(runOptions.signal);
          const decisions = toPersistenceDecisions(
            output,
            canonicalIngredients,
          );
          const result = await dependencies.applyMappings(
            decisions,
            selectedRefs,
          );
          totals.mappedRows += result.mappedCount;
          totals.learnedAliases += result.learnedCount;
          totals.staleRows += result.staleCount;
          totals.conflicts += result.conflictCount;

          if (result.staleCount > 0 || result.conflictCount > 0) {
            return finishPartial({
              dependencies,
              now,
              runId,
              startedAt,
              totals,
              budgetExhausted: false,
              error:
                `ingredient mapping stopped with ${result.staleCount} stale ` +
                `row(s) and ${result.conflictCount} alias conflict(s)`,
            });
          }
          if (result.mappedCount === 0) {
            return finishPartial({
              dependencies,
              now,
              runId,
              startedAt,
              totals,
              budgetExhausted: false,
              error: 'ingredient mapping made zero row progress',
            });
          }
        }
      } catch (error) {
        if (dependencies.isBudgetExceeded(error)) {
          try {
            return await finishPartial({
              dependencies,
              now,
              runId,
              startedAt,
              totals,
              budgetExhausted: true,
              error: errorMessage(error),
            });
          } catch (finalizationError) {
            return finalizeErrorAndThrow({
              dependencies,
              now,
              runId,
              totals,
              error: finalizationError,
            });
          }
        }

        return finalizeErrorAndThrow({
          dependencies,
          now,
          runId,
          totals,
          error,
        });
      }
    },
  };
}

interface MutableTotals {
  attemptedNames: number;
  mappedRows: number;
  learnedAliases: number;
  staleRows: number;
  conflicts: number;
  unparseableRows: number;
}

function emptyTotals(): MutableTotals {
  return {
    attemptedNames: 0,
    mappedRows: 0,
    learnedAliases: 0,
    staleRows: 0,
    conflicts: 0,
    unparseableRows: 0,
  };
}

interface ParsedBatch {
  readonly refs: ParsedIngredientLineRef[];
  readonly unparseableLines: UnmappedIngredientLine[];
}

function parseBatch(
  lines: readonly UnmappedIngredientLine[],
): ParsedBatch {
  const refs: ParsedIngredientLineRef[] = [];
  const unparseableLines: UnmappedIngredientLine[] = [];
  for (const line of lines) {
    let parsed: ReturnType<typeof parseIngredientLine>;
    try {
      parsed = parseIngredientLine(line.rawText);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      unparseableLines.push(line);
      continue;
    }
    const normalized = ingredientAliasKey(parsed.name);
    const validated = normalizedIngredientNameSchema.safeParse(normalized);
    if (!validated.success) {
      unparseableLines.push(line);
      continue;
    }
    refs.push({
      ...line,
      parsedName: validated.data,
    });
  }
  return { refs, unparseableLines };
}

function toPersistenceDecisions(
  output: IngredientMappingOutput,
  canonicalIngredients: readonly CanonicalIngredientSummary[],
): IngredientMappingDecision[] {
  const aisleByName = new Map(
    canonicalIngredients.map((ingredient) => [
      ingredient.name,
      ingredient.aisle,
    ]),
  );
  return output.decisions.map((decision) => {
    const aisle =
      decision.action === 'new'
        ? decision.aisle
        : aisleByName.get(decision.canonical_name);
    if (aisle === undefined) {
      throw new Error(
        `No authoritative aisle for existing canonical ingredient ` +
          `"${decision.canonical_name}"`,
      );
    }
    return {
      inputName: decision.input_name,
      canonicalName: decision.canonical_name,
      aisle,
    };
  });
}

interface FinishPartialInput {
  readonly dependencies: IngredientBackfillDependencies;
  readonly now: () => Date;
  readonly runId: string;
  readonly startedAt: Date;
  readonly totals: MutableTotals;
  readonly budgetExhausted: boolean;
  readonly error: string;
}

async function finishPartial(
  input: FinishPartialInput,
): Promise<IngredientBackfillSummary> {
  const remainingRows = await input.dependencies.countRemaining();
  return finishAndSummarize({
    ...input,
    status: 'partial',
    remainingRows,
  });
}

interface FinishAndSummarizeInput {
  readonly dependencies: IngredientBackfillDependencies;
  readonly now: () => Date;
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: IngredientBackfillSummary['status'];
  readonly totals: MutableTotals;
  readonly remainingRows: number;
  readonly budgetExhausted: boolean;
  readonly error: string | null;
}

async function finishAndSummarize(
  input: FinishAndSummarizeInput,
): Promise<IngredientBackfillSummary> {
  const finishedAt = input.now();
  await input.dependencies.finishRun({
    runId: input.runId,
    status: input.status,
    processedCount: input.totals.mappedRows,
    finishedAt,
    error: input.error,
  });
  return {
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt,
    status: input.status,
    ...input.totals,
    remainingRows: input.remainingRows,
    budgetExhausted: input.budgetExhausted,
    error: input.error,
  };
}

interface FinalizeErrorInput {
  readonly dependencies: IngredientBackfillDependencies;
  readonly now: () => Date;
  readonly runId: string;
  readonly totals: MutableTotals;
  readonly error: unknown;
}

async function finalizeErrorAndThrow(
  input: FinalizeErrorInput,
): Promise<never> {
  const finishedAt = input.now();
  try {
    await input.dependencies.finishRun({
      runId: input.runId,
      status: 'error',
      processedCount: input.totals.mappedRows,
      finishedAt,
      error: errorMessage(input.error),
    });
  } catch (finishError) {
    throw new AggregateError(
      [input.error, finishError],
      `ingredient backfill run ${input.runId} failed and telemetry could not be finalized`,
    );
  }
  throw input.error;
}

function lineIdentity(line: UnmappedIngredientLine): string {
  return `${line.recipeId}:${line.position}:${line.rawText}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('ingredient backfill aborted during worker shutdown');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, db, ingredients, sql } from '@recipes/db';
import { createBudgetedLlmCallOptions } from '@recipes/db/llm-budget';
import { env, hasEnv, requireEnv } from '@recipes/shared/env';
import {
  createEnrichmentJobRunner,
  createPostgresIngredientBackfillOrchestrator,
  createPostgresEnrichmentOrchestrator,
  hasPendingRecipes,
  hasUnmappedIngredients,
} from './enrichment';
import {
  createOpenRouterClient,
  extractRecipe,
  type StructuredOutputClient,
} from './llm';
import {
  createPostgresRedditScanOrchestrator,
  mergeScanSummaries,
} from './reddit';
import {
  startEnrichmentQueue,
  type EnrichmentQueueRuntime,
} from './jobs/enrichment-queue';
import {
  startPersonalizationQueue,
  type PersonalizationQueueRuntime,
} from './jobs/personalization-queue';
import { runPersonalizationPass } from './personalization/runtime';
import { startScanJobs, type ScanJobsRuntime } from './jobs/runtime';
import {
  createPostgresScanOrchestrator,
  hasCompletedScan,
} from './scan/postgres';
import type { ScanOrchestrationDependencies } from './scan/orchestrator';
import { prepareHtmlFallback } from './scanner/html-fallback';

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

const logger = {
  info: log,
  error(message: string, error?: unknown) {
    console.error(`[worker] ${new Date().toISOString()} ${message}`, error ?? '');
  },
};

async function checkDatabase(): Promise<{ ingredients: number }> {
  const ping = await client`select 1 as ok`;
  if (ping[0]?.ok !== 1) throw new Error('`select 1` did not return 1');

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(ingredients);
  return { ingredients: row?.count ?? 0 };
}

function safeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export interface WorkerRuntime {
  readonly jobs: ScanJobsRuntime;
  readonly enrichment: EnrichmentQueueRuntime;
  readonly personalization: PersonalizationQueueRuntime;
  stop(): Promise<void>;
}

export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  log('starting…');
  log(`node        ${process.version}`);
  log(`NODE_ENV    ${env.NODE_ENV}`);
  log(`database    ${safeDatabaseUrl(env.DATABASE_URL)}`);

  const { ingredients: seeded } = await checkDatabase();
  const shutdownController = new AbortController();
  const llmClient = lazyOpenRouterClient();
  const htmlFallback: ScanOrchestrationDependencies['htmlFallback'] =
    hasEnv('OPENROUTER_API_KEY')
      ? async (input) => {
          const guarded = prepareHtmlFallback(input.html, input.extraction);
          if (guarded.outcome === 'skip') return guarded;

          const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
          const budgeted = createBudgetedLlmCallOptions({
            db,
            runId: input.runId,
            kind: 'scan',
            dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
            signal: input.signal,
          });
          const draft = await extractRecipe(
            llmClient,
            {
              pageText: guarded.pageText,
              sourceUrl: input.pageUrl,
              publishedAt: input.publishedAt,
            },
            {
              ...budgeted,
              async onUsage(increment, context) {
                usage.tokensIn += increment.tokensIn;
                usage.tokensOut += increment.tokensOut;
                usage.costUsd += increment.costUsd;
                await budgeted.onUsage?.(increment, context);
              },
            },
          );
          return draft === null
            ? {
                outcome: 'not-recipe' as const,
                reason: 'guarded HTML extraction found no complete recipe',
                usage,
              }
            : { outcome: 'recipe' as const, draft, usage };
        }
      : undefined;
  const scanner = createPostgresScanOrchestrator({
    db,
    imageOutputDir: env.RECIPE_IMAGES_DIR,
    discoveryLimit: env.SCAN_DISCOVERY_LIMIT,
    log,
    ...(htmlFallback === undefined ? {} : { htmlFallback }),
  });
  const redditScanner = createPostgresRedditScanOrchestrator({
    db,
    client: llmClient,
    imageOutputDir: env.RECIPE_IMAGES_DIR,
    dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
    discoveryLimit: env.SCAN_DISCOVERY_LIMIT,
    loadCredentials: () => ({
      clientId: requireEnv('REDDIT_CLIENT_ID'),
      clientSecret: requireEnv('REDDIT_CLIENT_SECRET'),
      userAgent: requireEnv('REDDIT_USER_AGENT'),
    }),
    log,
  });

  const enrichmentOrchestrator = createPostgresEnrichmentOrchestrator({
    db,
    client: llmClient,
    dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
  });
  const ingredientBackfill = createPostgresIngredientBackfillOrchestrator({
    db,
    client: llmClient,
    dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
  });
  const enrichmentJobRunner = createEnrichmentJobRunner({
    recipes: enrichmentOrchestrator,
    ingredients: ingredientBackfill,
    hasUnmappedIngredients: () => hasUnmappedIngredients(db),
  });
  // Phase 7's nightly pass. Started before the enrichment queue because the
  // enrichment job is what enqueues it: scoring a recipe Phase 2 has not yet
  // given a category, tags or a blurb would score it on a blank.
  const personalization = await startPersonalizationQueue({
    databaseUrl: env.DATABASE_URL,
    runPersonalization: (signal) =>
      runPersonalizationPass({
        // Rules are pure SQL and run either way; without a provider key the
        // profile and scoring halves are simply skipped.
        client: hasEnv('OPENROUTER_API_KEY') ? llmClient : null,
        dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
        signal: AbortSignal.any([signal, shutdownController.signal]),
      }),
    logger,
  });

  let enrichment: EnrichmentQueueRuntime;
  try {
    enrichment = await startEnrichmentQueue({
      databaseUrl: env.DATABASE_URL,
      async runEnrichment(signal) {
        const summary = await enrichmentJobRunner.run(
          AbortSignal.any([signal, shutdownController.signal]),
        );
        if (summary.ingredients !== null) {
          log(
            `ingredient mapping: ${summary.ingredients.mappedRows} rows mapped, ` +
              `${summary.ingredients.remainingRows} remaining` +
              (summary.ingredients.error === null
                ? ''
                : ` — ${summary.ingredients.error}`),
          );
        }
        // The last link of the nightly chain. Enqueued even after a partial
        // run: the readers whose recipes did enrich should not wait a day for
        // the ones that did not.
        const jobId = await personalization.enqueue('post-enrichment');
        log(
          jobId === null
            ? 'personalization already queued or active'
            : `personalization enqueued as job ${jobId}`,
        );
        return summary;
      },
      logger,
    });
  } catch (error) {
    await personalization.stop();
    throw error;
  }

  let jobs: ScanJobsRuntime;
  try {
    jobs = await startScanJobs({
      databaseUrl: env.DATABASE_URL,
      cronSchedule: env.SCAN_CRON_SCHEDULE,
      cronTimezone: env.SCAN_CRON_TIMEZONE,
      bootstrapEnabled: env.SCAN_BOOTSTRAP_ENABLED,
      async runScan(signal) {
        const combinedSignal = AbortSignal.any([
          signal,
          shutdownController.signal,
        ]);
        const blogSummary = await scanner.scanAllSources({
          signal: combinedSignal,
        });
        const redditSummary = await redditScanner.scanAll({
          signal: combinedSignal,
        });
        const summary = mergeScanSummaries(blogSummary, redditSummary);
        if (hasEnv('OPENROUTER_API_KEY')) {
          await enrichment.enqueue('post-scan');
        } else {
          // Without a provider key nothing will enqueue personalization at the
          // end of enrichment, because enrichment never runs. The rules half
          // still has to be re-derived nightly, or a filter outlives the
          // ratings that justified it.
          await personalization.enqueue('post-scan');
        }
        return summary;
      },
      hasCompletedScan: () => hasCompletedScan(db),
      logger,
    });
  } catch (error) {
    await Promise.allSettled([enrichment.stop(), personalization.stop()]);
    throw error;
  }

  const [pendingRecipes, unmappedIngredientRows] = await Promise.all([
    hasPendingRecipes(db),
    hasUnmappedIngredients(db),
  ]);
  if (
    hasEnv('OPENROUTER_API_KEY') &&
    (pendingRecipes || unmappedIngredientRows)
  ) {
    const jobId = await enrichment.enqueue('bootstrap');
    log(
      jobId === null
        ? 'Phase 2 enrichment already queued or active'
        : `Phase 2 enrichment enqueued as job ${jobId}`,
    );
  } else if (!hasEnv('OPENROUTER_API_KEY')) {
    log('LLM enrichment idle: OPENROUTER_API_KEY is not configured');
  }

  log('──────────────────────────────────────────────────────────');
  log('  recipes worker — ingestion, Phase 2 enrichment, personalization');
  log(`  database reachable, ${seeded} canonical ingredients seeded`);
  log(
    `  daily scan: ${env.SCAN_CRON_SCHEDULE} (${env.SCAN_CRON_TIMEZONE}); ` +
      `next ${jobs.schedule.task.getNextRun()?.toISOString() ?? 'unknown'}`,
  );
  log(
    `  enrichment budget: $${env.LLM_DAILY_BUDGET_USD.toFixed(2)}/day; ` +
      `${hasEnv('OPENROUTER_API_KEY') ? 'OpenRouter configured' : 'OpenRouter not configured'}`,
  );
  log(
    '  personalization: hard rules always; profile and scoring ' +
      `${hasEnv('OPENROUTER_API_KEY') ? 'enabled' : 'skipped (no provider key)'}`,
  );
  log('──────────────────────────────────────────────────────────');

  let stopping: Promise<void> | undefined;
  return {
    jobs,
    enrichment,
    personalization,
    stop() {
      stopping ??= (async () => {
        shutdownController.abort(
          new Error('worker shutdown requested; retry active jobs'),
        );
        try {
          const stopped = await Promise.allSettled([
            jobs.stop(),
            enrichment.stop(),
            personalization.stop(),
          ]);
          const failures = stopped.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, 'one or more worker queues failed to stop');
          }
        } finally {
          await client.end({ timeout: 5 });
        }
        log(
          'scan/enrichment/personalization queues, scheduler, and database pool stopped',
        );
      })();
      return stopping;
    },
  };
}

function lazyOpenRouterClient(): StructuredOutputClient {
  let configured: StructuredOutputClient | undefined;
  return {
    complete(task, options) {
      configured ??= createOpenRouterClient({
        apiKey: requireEnv('OPENROUTER_API_KEY'),
        baseURL: env.OPENROUTER_BASE_URL,
        model: env.OPENROUTER_MODEL,
        defaultHeaders: {
          'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
          'X-OpenRouter-Title': 'Recipe Planner',
        },
      });
      return configured.complete(task, options);
    },
  };
}

async function runWorkerProcess(): Promise<void> {
  const runtime = await startWorkerRuntime();
  const signal = await waitForTerminationSignal();
  log(`${signal} received — shutting down`);
  await runtime.stop();
}

function waitForTerminationSignal(): Promise<'SIGTERM' | 'SIGINT'> {
  return new Promise((resolve) => {
    const finish = (signal: 'SIGTERM' | 'SIGINT') => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInterrupt);
      resolve(signal);
    };
    const onTerm = () => finish('SIGTERM');
    const onInterrupt = () => finish('SIGINT');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInterrupt);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runWorkerProcess().catch(async (error: unknown) => {
    logger.error('fatal', error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  });
}

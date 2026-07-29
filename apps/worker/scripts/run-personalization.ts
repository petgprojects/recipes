/**
 * Run the nightly personalization pass once, now.
 *
 * `DATABASE_URL=… corepack pnpm --filter @recipes/worker personalize`
 * `… personalize --user <uuid>`   one reader only
 * `… personalize --rules-only`    no provider calls, no spend
 *
 * The pass is normally the last link of the nightly chain (scan → enrichment →
 * personalization), which means the only way to see it work is to wait for a
 * scan. This is that, without the wait: the same `runPersonalizationPass()` the
 * pg-boss handler calls, against the same budget row.
 *
 * It spends real money unless `--rules-only` is passed. What it costs is one
 * profile call per eligible reader plus one call per twenty unscored recipes.
 */

import { client, db } from '@recipes/db';
import { env, hasEnv, requireEnv } from '@recipes/shared/env';
import { beginEnrichmentRun, finishEnrichmentRun } from '../src/enrichment';
import { createOpenRouterClient, type StructuredOutputClient } from '../src/llm';
import {
  runPersonalizationForUser,
  runPersonalizationPass,
} from '../src/personalization/runtime';

interface Options {
  readonly userId: string | null;
  readonly rulesOnly: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const rulesOnly = argv.includes('--rules-only');
  const userFlag = argv.indexOf('--user');
  const userId = userFlag < 0 ? null : (argv[userFlag + 1] ?? null);
  if (userFlag >= 0 && userId === null) {
    throw new Error('--user requires a user id');
  }
  return { userId, rulesOnly };
}

function providerClient(rulesOnly: boolean): StructuredOutputClient | null {
  if (rulesOnly) return null;
  if (!hasEnv('OPENROUTER_API_KEY')) {
    console.warn('OPENROUTER_API_KEY is not configured — running the rules half only.');
    return null;
  }
  return createOpenRouterClient({
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseURL: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    defaultHeaders: {
      'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
      'X-OpenRouter-Title': 'Recipe Planner',
    },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = providerClient(options.rulesOnly);

  if (options.userId === null) {
    const summary = await runPersonalizationPass({
      client: provider,
      dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // One reader still opens a run row, so the tokens land under the same daily
  // budget every other provider call is charged against.
  const runId = await beginEnrichmentRun(db);
  try {
    const summary = await runPersonalizationForUser({
      client: provider,
      userId: options.userId,
      dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
      runId,
    });
    await finishEnrichmentRun(db, { runId, status: 'success', processedCount: 1 });
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await finishEnrichmentRun(db, {
      runId,
      status: 'error',
      processedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

main()
  .then(async () => {
    await client.end({ timeout: 5 });
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  });

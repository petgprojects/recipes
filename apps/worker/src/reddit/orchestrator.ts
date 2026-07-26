/**
 * Pure lifecycle orchestration for the disabled-by-default Reddit adapter.
 *
 * Provider clients, credentials, HTTP, Postgres and files are all injected.
 * This module owns only sequencing, attribution, counters and checkpoint
 * safety. Runtime wiring can therefore be added without changing these rules.
 */

import type {
  BlogSourceConfig,
  RecipeIngredient,
  RedditSourceConfig,
} from '@recipes/shared';
import type {
  CacheRecipeImageResult,
  CachedRecipeImage,
} from '../storage/images';
import type { PersistRecipeDraftResult } from '../storage/recipes';
import type { RecipeDraft } from '../scanner/jsonld';
import type { DiscoverRedditResult } from './discovery';
import type { RedditRouteResult } from './routing';
import type { RedditClient, RedditPost } from './types';

export interface RedditScannableSource {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly lastScannedAt: Date | null;
  readonly definition: RedditSourceConfig;
}

export interface RedditLlmUsageIncrement {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface RedditScanCounters {
  readonly found: number;
  readonly newCount: number;
  readonly noRecipeCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface RedditSourceScanSummary extends RedditScanCounters {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly runId: string;
  readonly status: 'success' | 'partial' | 'error';
  readonly error: string | null;
}

export interface RedditAllSourcesScanSummary extends RedditScanCounters {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly sourceCount: number;
  readonly sources: readonly RedditSourceScanSummary[];
}

export interface FinishRedditSourceScanInput extends RedditScanCounters {
  readonly source: RedditScannableSource;
  readonly runId: string;
  readonly scanStartedAt: Date;
  readonly finishedAt: Date;
  readonly status: RedditSourceScanSummary['status'];
  readonly error: string | null;
  readonly retryRequired: boolean;
  /**
   * The new `sources.last_scanned_at`, or null to preserve the old checkpoint.
   * Runtime persistence must never infer advancement from status alone.
   */
  readonly checkpointAt: Date | null;
}

export interface RedditRouteContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly onUsage: (usage: RedditLlmUsageIncrement) => void | Promise<void>;
}

export interface RedditScanOrchestratorDependencies {
  readonly now: () => Date;
  /** May return disabled rows; they are filtered before any credential access. */
  readonly loadSources: () => Promise<readonly RedditScannableSource[]>;
  readonly beginSourceScan: (
    source: RedditScannableSource,
    startedAt: Date,
  ) => Promise<string>;
  readonly finishSourceScan: (
    input: FinishRedditSourceScanInput,
  ) => Promise<void>;
  /**
   * The credential boundary. It is never invoked for a disabled source.
   * Missing credentials should throw a clear source-local error here.
   */
  readonly createClient: (source: RedditScannableSource) => RedditClient;
  readonly discoverPosts: (
    client: RedditClient,
    source: RedditScannableSource,
    options: { readonly signal?: AbortSignal },
  ) => Promise<DiscoverRedditResult>;
  readonly routePost: (
    post: RedditPost,
    source: RedditScannableSource,
    client: RedditClient,
    context: RedditRouteContext,
  ) => Promise<RedditRouteResult>;
  readonly resolveBlogSourceId: (
    source: BlogSourceConfig,
  ) => Promise<string | null>;
  readonly normalizeIngredients: (
    lines: readonly string[],
  ) => Promise<readonly RecipeIngredient[]>;
  readonly cacheImage: (input: {
    readonly redditSource: RedditScannableSource;
    readonly publisherSource: BlogSourceConfig | null;
    readonly imageUrl: string | null;
  }) => Promise<CacheRecipeImageResult>;
  readonly persistRecipe: (input: {
    readonly sourceId: string;
    readonly draft: RecipeDraft;
    readonly ingredients: readonly RecipeIngredient[];
    readonly image: CachedRecipeImage | null;
    readonly seenAt: Date;
  }) => Promise<PersistRecipeDraftResult>;
  readonly log?: (message: string) => void;
}

export interface RedditScanOptions {
  readonly signal?: AbortSignal;
}

export interface RedditScanOrchestrator {
  scanAll(options?: RedditScanOptions): Promise<RedditAllSourcesScanSummary>;
}

const MAX_ERROR_LENGTH = 12_000;

export function createRedditScanOrchestrator(
  dependencies: RedditScanOrchestratorDependencies,
): RedditScanOrchestrator {
  return {
    async scanAll(
      options: RedditScanOptions = {},
    ): Promise<RedditAllSourcesScanSummary> {
      throwIfAborted(options.signal);
      const startedAt = dependencies.now();
      const loaded = await dependencies.loadSources();
      const enabled = loaded.filter((source) => source.enabled);
      const summaries: RedditSourceScanSummary[] = [];

      // Filtering happens before begin/createClient. A disabled adapter is a
      // clean no-op and cannot accidentally read its deferred credentials.
      for (const source of enabled) {
        throwIfAborted(options.signal);
        summaries.push(await scanSource(source, options));
      }

      return {
        startedAt,
        finishedAt: dependencies.now(),
        sourceCount: enabled.length,
        sources: summaries,
        found: sum(summaries, (summary) => summary.found),
        newCount: sum(summaries, (summary) => summary.newCount),
        noRecipeCount: sum(summaries, (summary) => summary.noRecipeCount),
        tokensIn: sum(summaries, (summary) => summary.tokensIn),
        tokensOut: sum(summaries, (summary) => summary.tokensOut),
        costUsd: sum(summaries, (summary) => summary.costUsd),
      };
    },
  };

  async function scanSource(
    source: RedditScannableSource,
    options: RedditScanOptions,
  ): Promise<RedditSourceScanSummary> {
    const scanStartedAt = dependencies.now();
    const runId = await dependencies.beginSourceScan(source, scanStartedAt);
    let found = 0;
    let newCount = 0;
    let noRecipeCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let retryRequired = false;
    const errors: string[] = [];

    const counters = (): RedditScanCounters => ({
      found,
      newCount,
      noRecipeCount,
      tokensIn,
      tokensOut,
      costUsd,
    });
    const onUsage = async (usage: RedditLlmUsageIncrement): Promise<void> => {
      assertUsage(usage);
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      costUsd += usage.costUsd;
    };

    let client: RedditClient;
    try {
      client = dependencies.createClient(source);
    } catch (error) {
      return finishSource({
        source,
        runId,
        scanStartedAt,
        status: 'error',
        retryRequired: true,
        checkpointAt: null,
        counters: counters(),
        errors: [`credentials/client: ${errorMessage(error)}`],
      });
    }

    let discovery: DiscoverRedditResult;
    try {
      throwIfAborted(options.signal);
      discovery = await dependencies.discoverPosts(client, source, options);
    } catch (error) {
      return finishSource({
        source,
        runId,
        scanStartedAt,
        status: 'error',
        retryRequired: true,
        checkpointAt: null,
        counters: counters(),
        errors: [`discovery: ${errorMessage(error)}`],
      });
    }

    if (discovery.truncated) {
      retryRequired = true;
      errors.push(
        `discovery stopped after ${discovery.pages} page${
          discovery.pages === 1 ? '' : 's'
        } before reaching its checkpoint`,
      );
    }

    let abortError: Error | null = null;
    try {
      for (const post of discovery.posts) {
        throwIfAborted(options.signal);
        try {
          const routed = await dependencies.routePost(
            post,
            source,
            client,
            { runId, signal: options.signal, onUsage },
          );
          if (routed.warnings.length > 0) {
            retryRequired = true;
            errors.push(
              ...routed.warnings.map(
                (warning) => `post ${post.permalink}: ${warning}`,
              ),
            );
          }

          if (routed.outcome === 'not-recipe') {
            noRecipeCount += 1;
            continue;
          }
          found += 1;

          const targetSourceId =
            routed.publisherSource === null
              ? source.id
              : await dependencies.resolveBlogSourceId(routed.publisherSource);
          if (targetSourceId === null) {
            throw new Error(
              `no persisted blog source matches ${routed.publisherSource?.baseUrl ?? '(unknown)'}`,
            );
          }

          const ingredients = await dependencies.normalizeIngredients(
            routed.draft.ingredients.map((ingredient) => ingredient.rawText),
          );
          const imageResult = await dependencies.cacheImage({
            redditSource: source,
            publisherSource: routed.publisherSource,
            imageUrl: routed.draft.imageUrl,
          });
          const image =
            imageResult.outcome === 'cached' ? imageResult.image : null;
          if (imageResult.outcome === 'failed') {
            retryRequired = true;
            errors.push(
              `post ${post.permalink} image: ${imageResult.error}`,
            );
          }

          const persisted = await dependencies.persistRecipe({
            sourceId: targetSourceId,
            draft: routed.draft,
            ingredients,
            image,
            seenAt: dependencies.now(),
          });
          if (persisted.outcome === 'inserted') newCount += 1;
        } catch (error) {
          if (options.signal?.aborted === true) throw error;
          retryRequired = true;
          errors.push(`post ${post.permalink}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      if (options.signal?.aborted !== true) throw error;
      abortError =
        error instanceof Error ? error : new Error(errorMessage(error));
      retryRequired = true;
      errors.push(`scan interrupted: ${errorMessage(abortError)}`);
    }

    const summary = await finishSource({
      source,
      runId,
      scanStartedAt,
      status: errors.length === 0 ? 'success' : 'partial',
      retryRequired,
      checkpointAt: retryRequired ? null : scanStartedAt,
      counters: counters(),
      errors,
    });
    if (abortError !== null) throw abortError;
    return summary;
  }

  async function finishSource(input: {
    readonly source: RedditScannableSource;
    readonly runId: string;
    readonly scanStartedAt: Date;
    readonly status: RedditSourceScanSummary['status'];
    readonly retryRequired: boolean;
    readonly checkpointAt: Date | null;
    readonly counters: RedditScanCounters;
    readonly errors: readonly string[];
  }): Promise<RedditSourceScanSummary> {
    const finishedAt = dependencies.now();
    const error = joinedErrors(input.errors);
    await dependencies.finishSourceScan({
      source: input.source,
      runId: input.runId,
      scanStartedAt: input.scanStartedAt,
      finishedAt,
      status: input.status,
      error,
      retryRequired: input.retryRequired,
      checkpointAt: input.checkpointAt,
      ...input.counters,
    });
    dependencies.log?.(
      `${input.source.name}: ${input.status} (${input.counters.found} found, ` +
        `${input.counters.newCount} new, ${input.counters.noRecipeCount} no recipe, ` +
        `${input.counters.tokensIn + input.counters.tokensOut} tokens)`,
    );
    return {
      sourceId: input.source.id,
      sourceName: input.source.name,
      runId: input.runId,
      status: input.status,
      error,
      ...input.counters,
    };
  }
}

function assertUsage(usage: RedditLlmUsageIncrement): void {
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

function joinedErrors(errors: readonly string[]): string | null {
  if (errors.length === 0) return null;
  const joined = errors.join('\n');
  return joined.length <= MAX_ERROR_LENGTH
    ? joined
    : `${joined.slice(0, MAX_ERROR_LENGTH - 30)}\n…truncated`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Reddit scan aborted during worker shutdown');
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

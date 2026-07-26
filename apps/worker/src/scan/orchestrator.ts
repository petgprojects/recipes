import type { RecipeIngredient } from '@recipes/shared';
import {
  canonicalUrlKey,
  type DiscoveredUrl,
  type DiscoverResult,
} from '../scanner/discover';
import type { ExtractionResult, RecipeDraft } from '../scanner/jsonld';
import type { FetchResult } from '../scanner/fetcher';
import type { CacheRecipeImageResult, CachedRecipeImage } from '../storage/images';
import type {
  PageValidators,
  PersistRecipeDraftResult,
} from '../storage/recipes';

export interface ScannableSource {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly feedUrl: string | null;
  readonly feedEtag: string | null;
  readonly feedLastModified: string | null;
  readonly crawlDelayS: number;
  readonly lastScannedAt: Date | null;
}

export interface StoredPageValidators extends PageValidators {
  readonly sourceUrl: string;
}

export interface SourceScanCounters {
  readonly found: number;
  readonly newCount: number;
  readonly noRecipeCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface SourceScanSummary extends SourceScanCounters {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly runId: string;
  readonly status: 'success' | 'partial' | 'error';
  readonly error: string | null;
}

export interface AllSourcesScanSummary {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly sourceCount: number;
  readonly sources: readonly SourceScanSummary[];
  readonly found: number;
  readonly newCount: number;
  readonly noRecipeCount: number;
}

export interface FinishSourceScanInput extends SourceScanCounters {
  readonly source: ScannableSource;
  readonly runId: string;
  readonly scanStartedAt: Date;
  readonly finishedAt: Date;
  readonly status: SourceScanSummary['status'];
  readonly error: string | null;
  /**
   * True when a failed page/draft/write must remain discoverable next run.
   * Discovery warnings and non-fatal image-cache failures can still make the
   * run `partial`, but must not pin the source checkpoint forever.
   */
  readonly retryRequired: boolean;
  /**
   * Null for a fatal source-level failure. In that case `last_scanned_at` and
   * feed validators are left alone so a later retry cannot skip unseen posts.
   */
  readonly discovery: DiscoverResult | null;
}

export interface ScanLlmUsageIncrement {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/**
 * A guarded fallback owns the deterministic HTML eligibility decision as well
 * as the optional paid extraction. `skip` is the zero-token structural path;
 * paid negative decisions are intentionally separate from `no_recipe`.
 */
export type HtmlFallbackResult =
  | {
      readonly outcome: 'skip';
      readonly reason: string;
    }
  | {
      readonly outcome: 'not-recipe';
      readonly reason: string;
      readonly usage: ScanLlmUsageIncrement;
    }
  | {
      readonly outcome: 'recipe';
      readonly draft: RecipeDraft;
      readonly usage: ScanLlmUsageIncrement;
    };

export interface HtmlFallbackInput {
  readonly runId: string;
  readonly html: string;
  readonly pageUrl: string;
  readonly extraction: ExtractionResult;
  readonly publishedAt: Date | null;
  readonly title: string | null;
  readonly signal?: AbortSignal;
}

export interface ScanOrchestrationDependencies {
  readonly now: () => Date;
  readonly loadEnabledSources: () => Promise<readonly ScannableSource[]>;
  readonly beginSourceScan: (sourceId: string, startedAt: Date) => Promise<string>;
  readonly finishSourceScan: (input: FinishSourceScanInput) => Promise<void>;
  readonly discover: (source: ScannableSource) => Promise<DiscoverResult>;
  readonly loadPageValidators: (
    sourceId: string,
    urls: readonly string[],
  ) => Promise<readonly StoredPageValidators[]>;
  readonly fetchPage: (
    source: ScannableSource,
    item: DiscoveredUrl,
    validators: PageValidators,
  ) => Promise<FetchResult>;
  readonly extract: (html: string, pageUrl: string) => ExtractionResult;
  readonly toDraft: (
    result: ExtractionResult,
    sourceUrl: string,
    fallback: { publishedAt?: Date | null; title?: string | null },
  ) => RecipeDraft | null;
  /**
   * Optional Phase 2 seam. When absent, the Phase 1 no-Recipe and incomplete
   * JSON-LD behavior is unchanged.
   */
  readonly htmlFallback?: (
    input: HtmlFallbackInput,
  ) => Promise<HtmlFallbackResult>;
  readonly normalizeIngredients: (
    lines: readonly string[],
  ) => Promise<readonly RecipeIngredient[]>;
  readonly cacheImage: (
    source: ScannableSource,
    imageUrl: string | null,
  ) => Promise<CacheRecipeImageResult>;
  readonly persistRecipe: (input: {
    sourceId: string;
    draft: RecipeDraft;
    ingredients: readonly RecipeIngredient[];
    image: CachedRecipeImage | null;
    validators: PageValidators;
    seenAt: Date;
  }) => Promise<PersistRecipeDraftResult>;
  readonly markRecipeSeen: (
    sourceUrl: string,
    validators: PageValidators,
    seenAt: Date,
  ) => Promise<boolean>;
  readonly log?: (message: string) => void;
}

export interface ScanAllOptions {
  readonly signal?: AbortSignal;
}

export interface ScanOrchestrator {
  scanAllSources(options?: ScanAllOptions): Promise<AllSourcesScanSummary>;
  scanSource(source: ScannableSource, options?: ScanAllOptions): Promise<SourceScanSummary>;
}

const MAX_ERROR_LENGTH = 12_000;

/**
 * Testable Phase 1 scan lifecycle. Every external effect is injected, while
 * the counter/status/error semantics live in one place.
 */
export function createScanOrchestrator(
  dependencies: ScanOrchestrationDependencies,
): ScanOrchestrator {
  async function scanSource(
    source: ScannableSource,
    options: ScanAllOptions = {},
  ): Promise<SourceScanSummary> {
    throwIfAborted(options.signal);
    const scanStartedAt = dependencies.now();
    const runId = await dependencies.beginSourceScan(source.id, scanStartedAt);
    const errors: string[] = [];
    let found = 0;
    let newCount = 0;
    let noRecipeCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let retryRequired = false;
    let discovery: DiscoverResult;

    try {
      discovery = await dependencies.discover(source);
      errors.push(...discovery.warnings);
      // An unchanged conditional feed can legitimately produce no URLs. An
      // empty discovery accompanied by fetch/parse warnings cannot: advancing
      // its checkpoint would turn a transient WAF/upstream failure into a
      // silent permanent skip.
      if (
        discovery.urls.length === 0 &&
        discovery.warnings.length > 0 &&
        !discovery.feedUnchanged
      ) {
        retryRequired = true;
      }
    } catch (error) {
      const message = `discovery failed: ${errorMessage(error)}`;
      const finishedAt = dependencies.now();
      await dependencies.finishSourceScan({
        source,
        runId,
        scanStartedAt,
        finishedAt,
        status: 'error',
        retryRequired: true,
        found,
        newCount,
        noRecipeCount,
        tokensIn,
        tokensOut,
        costUsd,
        error: message,
        discovery: null,
      });
      dependencies.log?.(`${source.name}: ${message}`);
      return {
        sourceId: source.id,
        sourceName: source.name,
        runId,
        status: 'error',
        found,
        newCount,
        noRecipeCount,
        tokensIn,
        tokensOut,
        costUsd,
        error: message,
      };
    }

    let storedValidators: readonly StoredPageValidators[];
    try {
      storedValidators = await dependencies.loadPageValidators(
        source.id,
        discovery.urls.map((item) => item.url),
      );
    } catch (error) {
      const message = `loading page validators failed: ${errorMessage(error)}`;
      const finishedAt = dependencies.now();
      await dependencies.finishSourceScan({
        source,
        runId,
        scanStartedAt,
        finishedAt,
        status: 'error',
        retryRequired: true,
        found,
        newCount,
        noRecipeCount,
        tokensIn,
        tokensOut,
        costUsd,
        error: message,
        discovery: null,
      });
      dependencies.log?.(`${source.name}: ${message}`);
      return {
        sourceId: source.id,
        sourceName: source.name,
        runId,
        status: 'error',
        found,
        newCount,
        noRecipeCount,
        tokensIn,
        tokensOut,
        costUsd,
        error: message,
      };
    }
    const validatorsByUrl = new Map(
      storedValidators.map((item) => [canonicalUrlKey(item.sourceUrl), item]),
    );

    let abortError: Error | null = null;
    try {
      for (const item of discovery.urls) {
        throwIfAborted(options.signal);
        const previous: PageValidators =
          validatorsByUrl.get(canonicalUrlKey(item.url)) ?? {};

        try {
          const page = await dependencies.fetchPage(source, item, previous);
          const seenAt = dependencies.now();
          if (page.outcome === 'error') {
            retryRequired = true;
            errors.push(
              `page ${item.url}: ${page.reason}${page.statusCode === null ? '' : ` ${page.statusCode}`} — ${page.message}`,
            );
            continue;
          }

          if (page.outcome === 'notModified') {
            const touched = await dependencies.markRecipeSeen(
              item.url,
              {
                etag: page.etag ?? previous.etag,
                lastModified: page.lastModified ?? previous.lastModified,
              },
              seenAt,
            );
            if (touched) {
              found += 1;
            } else {
              retryRequired = true;
              errors.push(`page ${item.url}: returned 304 but no stored recipe exists`);
            }
            continue;
          }

          const extraction = dependencies.extract(page.body, page.finalUrl);
          const deterministicFound =
            extraction.found && extraction.recipe !== null;
          if (deterministicFound) found += 1;

          let draft = deterministicFound
            ? dependencies.toDraft(extraction, page.finalUrl, {
                publishedAt: item.publishedAt ?? null,
                title: item.title ?? null,
              })
            : null;

          if (draft === null) {
            if (dependencies.htmlFallback === undefined) {
              // Preserve the verified Phase 1 behavior exactly when the
              // optional Phase 2 seam is not installed.
              if (!deterministicFound) {
                noRecipeCount += 1;
              } else {
                retryRequired = true;
                errors.push(
                  `page ${item.url}: Recipe JSON-LD had no insertable title/ingredients`,
                );
              }
              continue;
            }

            const fallback = await dependencies.htmlFallback({
              runId,
              html: page.body,
              pageUrl: page.finalUrl,
              extraction,
              publishedAt: item.publishedAt ?? null,
              title: item.title ?? null,
              signal: options.signal,
            });
            if (fallback.outcome === 'skip') {
              noRecipeCount += 1;
              continue;
            }

            assertUsage(fallback.usage);
            tokensIn += fallback.usage.tokensIn;
            tokensOut += fallback.usage.tokensOut;
            costUsd += fallback.usage.costUsd;
            if (fallback.outcome === 'not-recipe') continue;

            draft = fallback.draft;
            if (!deterministicFound) found += 1;
          }

          const ingredients = await dependencies.normalizeIngredients(
            draft.ingredients.map((ingredient) => ingredient.rawText),
          );
          const imageResult = await dependencies.cacheImage(source, draft.imageUrl);
          const image = imageResult.outcome === 'cached' ? imageResult.image : null;
          if (imageResult.outcome === 'failed') {
            errors.push(`image ${draft.imageUrl ?? '(missing)'}: ${imageResult.error}`);
          }

          const persisted = await dependencies.persistRecipe({
            sourceId: source.id,
            draft,
            ingredients,
            image,
            validators: {
              etag: page.etag,
              lastModified: page.lastModified,
            },
            seenAt,
          });
          if (persisted.outcome === 'inserted') newCount += 1;
        } catch (error) {
          if (options.signal?.aborted === true) throw error;
          retryRequired = true;
          errors.push(`page ${item.url}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      if (options.signal?.aborted !== true) throw error;
      abortError =
        error instanceof Error ? error : new Error(errorMessage(error));
      retryRequired = true;
      errors.push(`scan interrupted: ${errorMessage(abortError)}`);
    }

    const finishedAt = dependencies.now();
    const status = errors.length === 0 ? 'success' : 'partial';
    const error = joinedErrors(errors);
    await dependencies.finishSourceScan({
      source,
      runId,
      scanStartedAt,
      finishedAt,
      status,
      retryRequired,
      found,
      newCount,
      noRecipeCount,
      tokensIn,
      tokensOut,
      costUsd,
      error,
      discovery,
    });
    dependencies.log?.(
      `${source.name}: ${status} (${found} found, ${newCount} new, ${noRecipeCount} no Recipe)`,
    );

    const summary: SourceScanSummary = {
      sourceId: source.id,
      sourceName: source.name,
      runId,
      status,
      found,
      newCount,
      noRecipeCount,
      tokensIn,
      tokensOut,
      costUsd,
      error,
    };
    // Rejecting keeps pg-boss's retry semantics intact. The telemetry write
    // above happens first so an orderly shutdown never strands a `running` row.
    if (abortError !== null) throw abortError;
    return summary;
  }

  async function scanAllSources(
    options: ScanAllOptions = {},
  ): Promise<AllSourcesScanSummary> {
    const startedAt = dependencies.now();
    const sources = await dependencies.loadEnabledSources();
    const summaries: SourceScanSummary[] = [];

    // Sequential source scans keep database/image pressure bounded. The
    // fetcher still serialises per origin and retries individual requests.
    for (const source of sources) {
      throwIfAborted(options.signal);
      try {
        summaries.push(await scanSource(source, options));
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        // A telemetry/database failure in one source must not hide every later
        // source. Failures after beginSourceScan are already recorded whenever
        // the database is healthy enough to do so.
        dependencies.log?.(`${source.name}: scan crashed — ${errorMessage(error)}`);
      }
    }

    return {
      startedAt,
      finishedAt: dependencies.now(),
      sourceCount: sources.length,
      sources: summaries,
      found: sum(summaries, (summary) => summary.found),
      newCount: sum(summaries, (summary) => summary.newCount),
      noRecipeCount: sum(summaries, (summary) => summary.noRecipeCount),
    };
  }

  return { scanAllSources, scanSource };
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

function assertUsage(usage: ScanLlmUsageIncrement): void {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('scan aborted during worker shutdown');
  }
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

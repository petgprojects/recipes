import { and, asc, eq, inArray, sql } from '@recipes/db/operators';
import {
  recipes,
  scanRuns,
  sources,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  createPostgresIngredientMatcher,
  normalizeIngredientLines,
} from '../ingredients';
import {
  canonicalUrlKey,
  discoverSource,
  type DiscoverResult,
} from '../scanner/discover';
import { createFetcher, type PoliteFetcher } from '../scanner/fetcher';
import {
  extractRecipeFromHtml,
  toRecipeDraft,
} from '../scanner/jsonld';
import { sourceScanConfiguration } from '../scanner/sources';
import { cacheRecipeImage } from '../storage/images';
import {
  markRecipeSeen,
  persistRecipeDraft,
} from '../storage/recipes';
import {
  createScanOrchestrator,
  type FinishSourceScanInput,
  type ScanOrchestrator,
  type ScannableSource,
} from './orchestrator';

export interface CreatePostgresScanOrchestratorOptions {
  readonly db: Database;
  readonly imageOutputDir: string;
  readonly discoveryLimit?: number;
  readonly fetcher?: PoliteFetcher;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export function createPostgresScanOrchestrator(
  options: CreatePostgresScanOrchestratorOptions,
): ScanOrchestrator {
  const fetcher = options.fetcher ?? createFetcher();
  const matcher = createPostgresIngredientMatcher(options.db);
  const now = options.now ?? (() => new Date());
  const discoveryLimit = options.discoveryLimit ?? 200;

  return createScanOrchestrator({
    now,
    log: options.log,

    async loadEnabledSources() {
      return options.db
        .select({
          id: sources.id,
          name: sources.name,
          baseUrl: sources.baseUrl,
          feedUrl: sources.feedUrl,
          feedEtag: sources.feedEtag,
          feedLastModified: sources.feedLastModified,
          crawlDelayS: sources.crawlDelayS,
          lastScannedAt: sources.lastScannedAt,
        })
        .from(sources)
        .where(and(eq(sources.enabled, true), eq(sources.kind, 'blog')))
        .orderBy(asc(sources.name));
    },

    async beginSourceScan(sourceId, startedAt) {
      const [run] = await options.db
        .insert(scanRuns)
        .values({
          sourceId,
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
      if (run === undefined) throw new Error(`Could not create scan run for source ${sourceId}`);
      return run.id;
    },

    finishSourceScan(input) {
      return finishSourceScan(options.db, input);
    },

    async discover(source) {
      const configuration = sourceScanConfiguration(source.baseUrl);
      return discoverSource(
        fetcher,
        {
          ...configuration.source,
          feedUrl: source.feedUrl,
          crawlDelayMs: source.crawlDelayS * 1_000,
        },
        {
          ...configuration.options,
          since: source.lastScannedAt,
          limit: discoveryLimit,
          feedEtag: source.feedEtag,
          feedLastModified: source.feedLastModified,
        },
      );
    },

    async loadPageValidators(sourceId, urls) {
      const canonical = [...new Set(urls.map(canonicalUrlKey))];
      if (canonical.length === 0) return [];
      return options.db
        .select({
          sourceUrl: recipes.sourceUrl,
          etag: recipes.pageEtag,
          lastModified: recipes.pageLastModified,
        })
        .from(recipes)
        .where(
          and(
            eq(recipes.sourceId, sourceId),
            inArray(recipes.sourceUrl, canonical),
          ),
        );
    },

    fetchPage(source, item, validators) {
      return fetcher.fetch(item.url, {
        etag: validators.etag,
        lastModified: validators.lastModified,
        crawlDelayMs: source.crawlDelayS * 1_000,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      });
    },

    extract: extractRecipeFromHtml,

    toDraft(result, sourceUrl, fallback) {
      return result.recipe === null
        ? null
        : toRecipeDraft(result.recipe, sourceUrl, fallback);
    },

    normalizeIngredients(lines) {
      return normalizeIngredientLines(lines, matcher);
    },

    cacheImage(source, imageUrl) {
      return cacheRecipeImage(fetcher, imageUrl, {
        outputDir: options.imageOutputDir,
        crawlDelayMs: source.crawlDelayS * 1_000,
      });
    },

    persistRecipe(input) {
      return persistRecipeDraft(options.db, input);
    },

    markRecipeSeen(sourceUrl, validators, seenAt) {
      return markRecipeSeen(options.db, sourceUrl, validators, seenAt);
    },
  });
}

/**
 * Used by bootstrap scheduling. A partial scan is still completed work; a
 * source-level `error` is not, so a restart can retry a completely failed
 * fresh database.
 */
export async function hasCompletedScan(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanRuns)
    .where(inArray(scanRuns.status, ['success', 'partial']));
  return (row?.count ?? 0) > 0;
}

async function finishSourceScan(
  db: Database,
  input: FinishSourceScanInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.discovery !== null && !input.retryRequired) {
      await tx
        .update(sources)
        .set({
          feedEtag: retainedValidator(
            input.discovery.feedEtag,
            input.source.feedEtag,
          ),
          feedLastModified: retainedValidator(
            input.discovery.feedLastModified,
            input.source.feedLastModified,
          ),
          // Use the start boundary, not finish, so a post published while the
          // scan is running is eligible next time.
          lastScannedAt: input.scanStartedAt,
        })
        .where(eq(sources.id, input.source.id));
    } else if (input.discovery !== null && input.retryRequired) {
      // A failed page must remain discoverable next time. Keeping the newly
      // returned feed validators could produce a 304, while advancing
      // last_scanned_at could filter the failed item by date; either would
      // silently make a transient page failure permanent. Force a full feed
      // read on the next run and retain the previous scan boundary.
      await tx
        .update(sources)
        .set({
          feedEtag: null,
          feedLastModified: null,
        })
        .where(eq(sources.id, input.source.id));
    }

    await tx
      .update(scanRuns)
      .set({
        finishedAt: input.finishedAt,
        status: input.status,
        found: input.found,
        newCount: input.newCount,
        noRecipeCount: input.noRecipeCount,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        error: input.error,
      })
      .where(eq(scanRuns.id, input.runId));
  });
}

function retainedValidator(
  next: string | null,
  previous: string | null,
): string | null {
  return next ?? previous;
}

export type { DiscoverResult, ScannableSource };

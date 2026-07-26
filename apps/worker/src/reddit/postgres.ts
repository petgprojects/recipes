import {
  findRedditSource,
  type RedditSourceConfig,
} from '@recipes/shared';
import { and, asc, eq } from '@recipes/db/operators';
import { scanRuns, sources } from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  createPostgresIngredientMatcher,
  normalizeIngredientLines,
} from '../ingredients';
import {
  extractRecipe,
  extractRecipeFromPost,
  type LlmRecipeDraft,
  type StructuredOutputCallOptions,
  type StructuredOutputClient,
} from '../llm';
import { createBudgetedLlmCallOptions } from '../enrichment';
import type { AllSourcesScanSummary } from '../scan/orchestrator';
import { createFetcher, type PoliteFetcher } from '../scanner/fetcher';
import { cacheRecipeImage } from '../storage/images';
import { persistRecipeDraft } from '../storage/recipes';
import {
  initializeRedditSource,
} from './client';
import { discoverRedditPosts } from './discovery';
import {
  createRedditScanOrchestrator,
  type FinishRedditSourceScanInput,
  type RedditAllSourcesScanSummary,
  type RedditScanOrchestrator,
  type RedditRouteContext,
} from './orchestrator';
import {
  routeRedditPost,
  type LlmExtractionResult,
  type LlmRecipeCandidate,
  type RedditLlmExtractor,
} from './routing';
import type { RedditClient, RedditCredentials } from './types';

export interface CreatePostgresRedditScanOrchestratorOptions {
  readonly db: Database;
  readonly client: StructuredOutputClient;
  readonly imageOutputDir: string;
  readonly dailyBudgetUsd: number;
  readonly loadCredentials: () => Partial<RedditCredentials>;
  readonly discoveryLimit?: number;
  readonly fetcher?: PoliteFetcher;
  readonly now?: () => Date;
  readonly createClient?: (
    source: RedditSourceConfig,
    credentials: RedditCredentials,
  ) => RedditClient;
  readonly log?: (message: string) => void;
}

/**
 * Production composition for the Reddit adapter. Loading a disabled source row
 * is harmless; credentials and the lazy LLM client are touched only after the
 * pure orchestrator filters enabled rows.
 */
export function createPostgresRedditScanOrchestrator(
  options: CreatePostgresRedditScanOrchestratorOptions,
): RedditScanOrchestrator {
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? createFetcher();
  const matcher = createPostgresIngredientMatcher(options.db);
  const discoveryLimit = options.discoveryLimit ?? 200;

  return createRedditScanOrchestrator({
    now,
    log: options.log,

    async loadSources() {
      const rows = await options.db
        .select({
          id: sources.id,
          name: sources.name,
          baseUrl: sources.baseUrl,
          enabled: sources.enabled,
          crawlDelayS: sources.crawlDelayS,
          lastScannedAt: sources.lastScannedAt,
        })
        .from(sources)
        .where(eq(sources.kind, 'reddit'))
        .orderBy(asc(sources.name));

      return rows.map((row) => {
        const configured = findRedditSource(row.baseUrl);
        if (configured === null) {
          throw new Error(`No Reddit-source adapter configured for ${row.baseUrl}`);
        }
        return {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          lastScannedAt: row.lastScannedAt,
          definition: {
            ...configured,
            enabled: row.enabled,
            crawlDelayS: row.crawlDelayS,
          },
        };
      });
    },

    async beginSourceScan(source, startedAt) {
      const [run] = await options.db
        .insert(scanRuns)
        .values({
          sourceId: source.id,
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
        throw new Error(`Could not create Reddit scan run for source ${source.id}`);
      }
      return run.id;
    },

    finishSourceScan(input) {
      return finishRedditSourceScan(options.db, input);
    },

    createClient(source) {
      const initialized = initializeRedditSource({
        source: source.definition,
        loadCredentials: options.loadCredentials,
        ...(options.createClient === undefined
          ? {}
          : {
              createClient: (credentials) =>
                options.createClient!(source.definition, credentials),
            }),
      });
      if (initialized.status === 'disabled') {
        throw new Error('Disabled Reddit source reached client initialization');
      }
      return initialized.client;
    },

    discoverPosts(client, source) {
      return discoverRedditPosts(
        client,
        {
          subreddits: source.definition.subreddits,
          minScore: source.definition.minScore,
        },
        {
          since: source.lastScannedAt,
          limit: discoveryLimit,
        },
      );
    },

    routePost(post, source, redditClient, context) {
      return routeRedditPost(post, source.definition, {
        fetchExternal(url, publisher) {
          return fetcher.fetch(url, {
            crawlDelayMs: publisher.crawlDelayS * 1_000,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          });
        },
        loadTopComments(_post, limit) {
          return redditClient.topComments(post.permalink, { limit });
        },
        llm: createRedditRuntimeLlmExtractor(
          options.client,
          budgetedRedditCallOptions(options, context),
        ),
      });
    },

    async resolveBlogSourceId(source) {
      const [row] = await options.db
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.kind, 'blog'),
            eq(sources.baseUrl, source.baseUrl),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    },

    normalizeIngredients(lines) {
      return normalizeIngredientLines(lines, matcher);
    },

    cacheImage(input) {
      const definition = input.publisherSource ?? input.redditSource.definition;
      return cacheRecipeImage(fetcher, input.imageUrl, {
        outputDir: options.imageOutputDir,
        crawlDelayMs: definition.crawlDelayS * 1_000,
      });
    },

    persistRecipe(input) {
      return persistRecipeDraft(options.db, input);
    },
  });
}

/**
 * Bridge the Reddit routing seam to the same strict structured-output tasks
 * used by blog HTML fallback. Production therefore has no alternate schema or
 * ad-hoc provider call.
 */
export function createRedditRuntimeLlmExtractor(
  client: StructuredOutputClient,
  options: StructuredOutputCallOptions,
): RedditLlmExtractor {
  return {
    async extractRecipe(input) {
      const draft = await extractRecipe(
        client,
        {
          pageText: input.pageText,
          sourceUrl: input.sourceUrl,
        },
        options,
      );
      return draftToExtractionResult(draft);
    },

    async extractRecipeFromPost(input) {
      const draft = await extractRecipeFromPost(
        client,
        {
          post: {
            sourceUrl: input.sourceUrl,
            title: input.post.title,
            body: input.post.selfText,
            publishedAt: input.post.createdAt,
          },
          comments: input.comments.map((comment) => ({
            author: comment.author,
            body: comment.body,
            score: comment.score,
          })),
        },
        options,
      );
      return draftToExtractionResult(draft);
    },
  };
}

export function mergeScanSummaries(
  blog: AllSourcesScanSummary,
  reddit: RedditAllSourcesScanSummary,
): AllSourcesScanSummary {
  return {
    startedAt:
      blog.startedAt <= reddit.startedAt ? blog.startedAt : reddit.startedAt,
    finishedAt:
      blog.finishedAt >= reddit.finishedAt ? blog.finishedAt : reddit.finishedAt,
    sourceCount: blog.sourceCount + reddit.sourceCount,
    sources: [...blog.sources, ...reddit.sources],
    found: blog.found + reddit.found,
    newCount: blog.newCount + reddit.newCount,
    noRecipeCount: blog.noRecipeCount + reddit.noRecipeCount,
  };
}

function budgetedRedditCallOptions(
  options: Pick<
    CreatePostgresRedditScanOrchestratorOptions,
    'db' | 'dailyBudgetUsd'
  >,
  context: RedditRouteContext,
): StructuredOutputCallOptions {
  const budgeted = createBudgetedLlmCallOptions({
    db: options.db,
    runId: context.runId,
    dailyBudgetUsd: options.dailyBudgetUsd,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return {
    ...budgeted,
    async onUsage(usage, requestContext) {
      // Persist first so a crash after the provider response cannot make the
      // cost disappear; then update the pure orchestrator's summary counters.
      await budgeted.onUsage?.(usage, requestContext);
      await context.onUsage(usage);
    },
  };
}

function draftToExtractionResult(
  draft: LlmRecipeDraft | null,
): LlmExtractionResult {
  if (draft === null) {
    return {
      outcome: 'not-recipe',
      reason: 'LLM found no complete recipe',
    };
  }
  return {
    outcome: 'recipe',
    recipe: draftToCandidate(draft),
  };
}

function draftToCandidate(draft: LlmRecipeDraft): LlmRecipeCandidate {
  return {
    title: draft.title,
    totalMinutes: draft.totalMinutes,
    activeMinutes: draft.activeMinutes,
    servings: draft.servings,
    imageUrl: draft.imageUrl,
    author: draft.author,
    instructions: draft.instructions,
    ingredients: draft.ingredients.map((ingredient) => ingredient.rawText),
  };
}

async function finishRedditSourceScan(
  db: Database,
  input: FinishRedditSourceScanInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.checkpointAt !== null) {
      await tx
        .update(sources)
        .set({ lastScannedAt: input.checkpointAt })
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
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        costUsd: input.costUsd,
        error: input.error,
      })
      .where(eq(scanRuns.id, input.runId));
  });
}

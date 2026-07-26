import type { BlogSourceConfig, RedditSourceConfig } from '@recipes/shared';
import type { FetchResult } from '../scanner/fetcher';
import { prepareHtmlFallback } from '../scanner/html-fallback';
import {
  extractRecipeFromHtml,
  toRecipeDraft,
  type RecipeDraft,
} from '../scanner/jsonld';
import { cleanTextOrNull, slugify, stableHash } from '../scanner/text';
import {
  extractConfiguredBlogLinks,
  isAllowedBlogRedirect,
} from './links';
import { prepareRedditPostPrompt } from './prompt';
import type { RedditComment, RedditPost } from './types';

export interface LlmRecipeCandidate {
  readonly title: string;
  readonly totalMinutes: number | null;
  readonly activeMinutes: number | null;
  readonly servings: number | null;
  readonly imageUrl?: string | null;
  readonly author?: string | null;
  readonly instructions: readonly {
    readonly name: string | null;
    readonly text: string;
  }[];
  readonly ingredients: readonly string[];
}

export type LlmExtractionResult =
  | { readonly outcome: 'recipe'; readonly recipe: LlmRecipeCandidate }
  | { readonly outcome: 'not-recipe'; readonly reason: string };

export interface RedditLlmExtractor {
  extractRecipe(input: {
    readonly pageText: string;
    readonly sourceUrl: string;
  }): Promise<LlmExtractionResult>;
  extractRecipeFromPost(input: {
    readonly prompt: string;
    readonly sourceUrl: string;
    /** Structured fields let production reuse the shared Phase 2 post task. */
    readonly post: RedditPost;
    readonly comments: readonly RedditComment[];
  }): Promise<LlmExtractionResult>;
}

export interface RedditRoutingDependencies {
  readonly fetchExternal: (
    url: string,
    source: BlogSourceConfig,
  ) => Promise<FetchResult>;
  readonly loadTopComments: (
    post: RedditPost,
    limit: number,
  ) => Promise<readonly RedditComment[]>;
  readonly llm: RedditLlmExtractor;
}

export type RedditRouteResult =
  | {
      readonly outcome: 'recipe';
      readonly method: 'external-jsonld' | 'external-html-llm' | 'reddit-llm';
      readonly draft: RecipeDraft;
      /** Non-null when the publisher is a configured external blog. */
      readonly publisherSource: BlogSourceConfig | null;
      readonly warnings: readonly string[];
    }
  | {
      readonly outcome: 'not-recipe';
      readonly reason: string;
      readonly warnings: readonly string[];
    };

/**
 * Route one already-discovered Reddit post. External configured blog links are
 * exhausted deterministically before post/comments are sent to the LLM.
 */
export async function routeRedditPost(
  post: RedditPost,
  source: RedditSourceConfig,
  dependencies: RedditRoutingDependencies,
): Promise<RedditRouteResult> {
  const warnings: string[] = [];

  for (const link of extractConfiguredBlogLinks(post)) {
    let page: FetchResult;
    try {
      page = await dependencies.fetchExternal(link.url, link.source);
    } catch (error) {
      warnings.push(`external ${link.url}: ${errorMessage(error)}`);
      continue;
    }
    if (page.outcome !== 'ok') {
      warnings.push(
        `external ${link.url}: ${
          page.outcome === 'error' ? page.message : 'unexpected 304'
        }`,
      );
      continue;
    }
    if (!isAllowedBlogRedirect(link, page.finalUrl)) {
      warnings.push(`external ${link.url}: redirect left configured recipe origin`);
      continue;
    }

    const extraction = extractRecipeFromHtml(page.body, page.finalUrl);
    if (extraction.recipe !== null) {
      const draft = toRecipeDraft(extraction.recipe, page.finalUrl, {
        publishedAt: post.createdAt,
        title: post.title,
      });
      if (draft !== null) {
        return {
          outcome: 'recipe',
          method: 'external-jsonld',
          draft,
          publisherSource: link.source,
          warnings,
        };
      }
    }

    const fallback = prepareHtmlFallback(page.body, extraction);
    if (fallback.outcome === 'skip') continue;

    try {
      const result = await dependencies.llm.extractRecipe({
        pageText: fallback.pageText,
        sourceUrl: page.finalUrl,
      });
      if (result.outcome === 'recipe') {
        const draft = llmCandidateToDraft(
          result.recipe,
          page.finalUrl,
          post.createdAt,
        );
        if (draft !== null) {
          return {
            outcome: 'recipe',
            method: 'external-html-llm',
            draft,
            publisherSource: link.source,
            warnings,
          };
        }
      }
    } catch (error) {
      warnings.push(`external ${link.url} LLM: ${errorMessage(error)}`);
    }
  }

  const comments = await dependencies.loadTopComments(
    post,
    source.topCommentLimit,
  );
  const result = await dependencies.llm.extractRecipeFromPost({
    prompt: prepareRedditPostPrompt(post, comments, {
      maxComments: source.topCommentLimit,
    }),
    sourceUrl: post.permalink,
    post,
    comments,
  });
  if (result.outcome === 'not-recipe') {
    return { outcome: 'not-recipe', reason: result.reason, warnings };
  }
  const draft = llmCandidateToDraft(
    result.recipe,
    post.permalink,
    post.createdAt,
  );
  return draft === null
    ? {
        outcome: 'not-recipe',
        reason: 'LLM recipe lacked an insertable title or ingredients',
        warnings,
      }
    : {
        outcome: 'recipe',
        method: 'reddit-llm',
        draft,
        publisherSource: null,
        warnings,
      };
}

export function llmCandidateToDraft(
  recipe: LlmRecipeCandidate,
  sourceUrl: string,
  publishedAt: Date | null,
): RecipeDraft | null {
  const title = cleanTextOrNull(recipe.title);
  const ingredients = recipe.ingredients
    .map((line) => cleanTextOrNull(line))
    .filter((line): line is string => line !== null);
  if (title === null || ingredients.length === 0) return null;

  const instructions = recipe.instructions.flatMap((step) => {
    const text = cleanTextOrNull(step.text);
    if (text === null) return [];
    return [{ name: cleanTextOrNull(step.name), text }];
  });
  const content = {
    title,
    servings: recipe.servings,
    totalMinutes: recipe.totalMinutes,
    activeMinutes: recipe.activeMinutes,
    ingredients,
    instructions: instructions.map((step) => step.text),
    imageUrl: recipe.imageUrl ?? null,
  };

  return {
    sourceUrl,
    contentHash: stableHash(content),
    title,
    slug: slugify(title) || 'recipe',
    totalMinutes: recipe.totalMinutes,
    activeMinutes: recipe.activeMinutes,
    servings: recipe.servings,
    imageUrl: recipe.imageUrl ?? null,
    author: recipe.author ?? null,
    sourceRating: null,
    sourceRatingCount: null,
    instructions,
    rawJsonld: null,
    publishedAt,
    ingredients: ingredients.map((rawText, position) => ({ position, rawText })),
    missing: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

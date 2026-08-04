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

/**
 * A post may hold several recipes; an external blog page holds one. The two
 * results stay separate types so that difference is visible at the seam.
 */
export type LlmPostExtractionResult =
  | {
      readonly outcome: 'recipes';
      readonly recipes: readonly LlmRecipeCandidate[];
    }
  | { readonly outcome: 'not-recipe'; readonly reason: string };

export interface RedditLlmExtractor {
  extractRecipe(input: {
    readonly pageText: string;
    readonly sourceUrl: string;
  }): Promise<LlmExtractionResult>;
  extractRecipesFromPost(input: {
    readonly prompt: string;
    readonly sourceUrl: string;
    /** Structured fields let production reuse the shared Phase 2 post task. */
    readonly post: RedditPost;
    readonly comments: readonly RedditComment[];
  }): Promise<LlmPostExtractionResult>;
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
      /**
       * Always at least one. The external paths produce exactly one — a blog
       * page is one recipe — while `reddit-llm` produces one per dish in the
       * post, each already carrying a distinct `sourceUrl`.
       */
      readonly drafts: readonly RecipeDraft[];
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
          drafts: [draft],
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
            drafts: [draft],
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
  const result = await dependencies.llm.extractRecipesFromPost({
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

  const drafts = result.recipes.flatMap((recipe, index) => {
    const draft = llmCandidateToDraft(
      recipe,
      redditRecipeSourceUrl(post.permalink, recipe.title, index, result.recipes.length),
      post.createdAt,
    );
    return draft === null ? [] : [draft];
  });
  const usable = dedupeBySourceUrl(drafts);
  if (usable.length < result.recipes.length) {
    warnings.push(
      `${result.recipes.length - usable.length} of ${result.recipes.length} ` +
        'extracted recipes were unusable or duplicated a source URL',
    );
  }

  return usable.length === 0
    ? {
        outcome: 'not-recipe',
        reason: 'LLM recipes lacked an insertable title or ingredients',
        warnings,
      }
    : {
        outcome: 'recipe',
        method: 'reddit-llm',
        drafts: usable,
        publisherSource: null,
        warnings,
      };
}

/**
 * The `source_url` for one recipe inside a post.
 *
 * `recipes.source_url` is unique and is the dedupe key, so five recipes from
 * one submission cannot all be filed under the permalink — they would collide
 * and overwrite one another, leaving the last one standing. Each therefore gets
 * a `?recipe=<slug>` marker.
 *
 * A query parameter rather than a `#fragment` for a concrete reason:
 * `canonicalUrlKey()` clears the hash before the uniqueness check, so five
 * fragments are one key. It is also still a working link — Reddit ignores the
 * unknown parameter and serves the post — which matters because `source_url`
 * is what the reader is sent to.
 *
 * A single-recipe post keeps its bare permalink, so nothing about the common
 * case changes and no existing row's key moves.
 */
export function redditRecipeSourceUrl(
  permalink: string,
  title: string,
  index: number,
  total: number,
): string {
  if (total <= 1) return permalink;
  const marker = slugify(title) || `recipe-${index + 1}`;
  try {
    const url = new URL(permalink);
    url.searchParams.set('recipe', marker);
    return url.toString();
  } catch {
    return permalink;
  }
}

function dedupeBySourceUrl(
  drafts: readonly RecipeDraft[],
): readonly RecipeDraft[] {
  // Two dishes in one post can slugify to the same marker ("Chicken bowl" twice
  // in a roundup). Persistence would treat the second as an update of the
  // first, so drop it here where the loss is visible as a warning instead.
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    if (seen.has(draft.sourceUrl)) return false;
    seen.add(draft.sourceUrl);
    return true;
  });
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

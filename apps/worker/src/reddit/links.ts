import * as cheerio from 'cheerio';
import {
  BLOG_SOURCES,
  findBlogSource,
  isRecipeUrlForSource,
  type BlogSourceConfig,
} from '@recipes/shared';
import { canonicalUrlKey } from '../scanner/discover';
import type { RedditPost } from './types';

export interface ConfiguredBlogLink {
  readonly url: string;
  readonly source: BlogSourceConfig;
}

/**
 * Pull external URLs without model involvement, then admit only configured
 * recipe-blog origins and URL shapes. This is both the attribution rule and
 * the SSRF boundary for Reddit-controlled links.
 */
export function extractConfiguredBlogLinks(
  post: RedditPost,
  configuredSources: readonly BlogSourceConfig[] = BLOG_SOURCES,
): ConfiguredBlogLink[] {
  const raw = [post.url, ...htmlLinks(post.selfTextHtml), ...textLinks(post.selfText)];
  const allowedSlugs = new Set(configuredSources.map((source) => source.slug));
  const seen = new Set<string>();
  const out: ConfiguredBlogLink[] = [];

  for (const value of raw) {
    let parsed: URL;
    try {
      parsed = new URL(trimUrlPunctuation(value));
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      continue;
    }

    const source = findBlogSource(parsed.origin);
    if (
      source === null ||
      !allowedSlugs.has(source.slug) ||
      !isRecipeUrlForSource(source, parsed.toString())
    ) {
      continue;
    }

    const url = canonicalUrlKey(parsed.toString());
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, source });
  }
  return out;
}

export function isAllowedBlogRedirect(
  initial: ConfiguredBlogLink,
  finalUrl: string,
): boolean {
  const finalSource = findBlogSource(finalUrl);
  return (
    finalSource?.slug === initial.source.slug &&
    isRecipeUrlForSource(initial.source, finalUrl)
  );
}

function htmlLinks(html: string | null): string[] {
  if (html === null || html.length === 0) return [];
  const $ = cheerio.load(html);
  return $('a[href]')
    .toArray()
    .flatMap((element) => {
      const href = $(element).attr('href');
      return href ? [href] : [];
    });
}

function textLinks(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
}

function trimUrlPunctuation(value: string): string {
  return value.trim().replace(/[),.;:!?\]}]+$/g, '');
}

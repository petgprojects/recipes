import {
  findBlogSource,
  isRecipeUrlForSource,
  type BlogSourceConfig,
} from '@recipes/shared';
import type { DiscoverOptions, DiscoverSource } from './discover';

export interface SourceScanConfiguration {
  readonly definition: BlogSourceConfig;
  readonly source: DiscoverSource;
  readonly options: Pick<DiscoverOptions, 'urlFilter'>;
}

/**
 * Resolve a persisted `sources` row into the canonical discovery adapter.
 * Unknown sources fail explicitly instead of silently crawling without the
 * source-specific recipe filter.
 */
export function sourceScanConfiguration(baseUrl: string): SourceScanConfiguration {
  const definition = findBlogSource(baseUrl);
  if (definition === null) {
    throw new Error(`No blog-source adapter configured for ${baseUrl}`);
  }

  return {
    definition,
    source: {
      baseUrl: definition.baseUrl,
      feedUrl: definition.feedUrl,
      sitemapUrls: definition.sitemapUrls,
      crawlDelayMs: definition.crawlDelayS * 1_000,
    },
    options: {
      urlFilter: (url) => isRecipeUrlForSource(definition, url),
    },
  };
}

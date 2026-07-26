/**
 * The canonical Phase 1 blog source list.
 *
 * This is deliberately pure data so the database seed, scanner and fixture
 * capture script all consume the same eight-source definition. Serious Eats is
 * enabled by an explicit project-owner decision.
 */

export type RecipeUrlAdapter =
  | 'generic-post'
  | 'recipes-directory'
  | 'kitchn-recipe-id'
  | 'serious-eats-recipe-id';

export interface BlogSourceConfig {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  /** One proven RSS/Atom URL to persist, or null for sitemap-only sources. */
  readonly feedUrl: string | null;
  /** Extra/manual probes used only when refreshing the committed fixtures. */
  readonly fixtureFeedUrls?: readonly string[];
  readonly sitemapUrls: readonly string[];
  readonly enabled: boolean;
  readonly crawlDelayS: number;
  readonly recipeUrlAdapter: RecipeUrlAdapter;
  /** Extra known recipe pages used only to keep fixture coverage representative. */
  readonly fixtureProbeUrls?: readonly string[];
}

export const BLOG_SOURCES = [
  {
    slug: 'budget-bytes',
    name: 'Budget Bytes',
    baseUrl: 'https://www.budgetbytes.com',
    feedUrl: 'https://www.budgetbytes.com/feed/',
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'generic-post',
  },
  {
    slug: 'pinch-of-yum',
    name: 'Pinch of Yum',
    baseUrl: 'https://pinchofyum.com',
    feedUrl: 'https://pinchofyum.com/feed',
    fixtureFeedUrls: ['https://pinchofyum.com/feed', 'https://pinchofyum.com/feed/'],
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'generic-post',
  },
  {
    slug: 'downshiftology',
    name: 'Downshiftology',
    baseUrl: 'https://downshiftology.com',
    feedUrl: 'https://downshiftology.com/feed/',
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'recipes-directory',
    fixtureProbeUrls: [
      'https://downshiftology.com/recipes/chicken-piccata/',
      'https://downshiftology.com/recipes/greek-baked-cod/',
    ],
  },
  {
    slug: 'gypsyplate',
    name: 'GypsyPlate',
    baseUrl: 'https://gypsyplate.com',
    feedUrl: null,
    fixtureFeedUrls: ['https://gypsyplate.com/feed/'],
    sitemapUrls: [
      'https://gypsyplate.com/sitemap_index.xml',
      'https://gypsyplate.com/sitemap.xml',
    ],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'generic-post',
  },
  {
    slug: 'skinnytaste',
    name: 'Skinnytaste',
    baseUrl: 'https://www.skinnytaste.com',
    feedUrl: 'https://www.skinnytaste.com/feed/',
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'generic-post',
  },
  {
    slug: 'the-kitchn',
    name: 'The Kitchn',
    baseUrl: 'https://www.thekitchn.com',
    feedUrl: 'https://www.thekitchn.com/main.rss',
    fixtureFeedUrls: [
      'https://www.thekitchn.com/main.rss',
      'https://www.thekitchn.com/feed',
    ],
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'kitchn-recipe-id',
  },
  {
    slug: 'love-and-lemons',
    name: 'Love & Lemons',
    baseUrl: 'https://www.loveandlemons.com',
    feedUrl: 'https://www.loveandlemons.com/feed/',
    sitemapUrls: [],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'generic-post',
  },
  {
    slug: 'serious-eats',
    name: 'Serious Eats',
    baseUrl: 'https://www.seriouseats.com',
    feedUrl: null,
    fixtureFeedUrls: [
      'https://www.seriouseats.com/rss',
      'https://www.seriouseats.com/feeds/all.rss',
    ],
    sitemapUrls: ['https://www.seriouseats.com/sitemap.xml'],
    enabled: true,
    crawlDelayS: 2,
    recipeUrlAdapter: 'serious-eats-recipe-id',
  },
] as const satisfies readonly BlogSourceConfig[];

export function findBlogSource(baseUrl: string): BlogSourceConfig | null {
  const origin = normalizedOrigin(baseUrl);
  return BLOG_SOURCES.find((source) => normalizedOrigin(source.baseUrl) === origin) ?? null;
}

/** Apply the source-specific URL shape before a page is queued for fetching. */
export function isRecipeUrlForSource(source: BlogSourceConfig, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (normalizedOrigin(url.origin) !== normalizedOrigin(source.baseUrl)) return false;

  const path = url.pathname.replace(/\/{2,}/g, '/');
  switch (source.recipeUrlAdapter) {
    case 'recipes-directory':
      return /^\/recipes\/[^/]+\/?$/i.test(path);
    case 'kitchn-recipe-id':
      return /-recipe(?:-[a-z0-9-]+)?-\d+\/?$/i.test(path);
    case 'serious-eats-recipe-id':
      return /-recipe-\d+\/?$/i.test(path);
    case 'generic-post':
      return genericPostPath(path);
  }
}

function genericPostPath(path: string): boolean {
  if (path === '/' || /\.[a-z0-9]{1,6}$/i.test(path)) return false;
  return !/^\/(?:about|author|category|contact|feed|page|privacy|search|shop|tag|wp-admin|wp-json)(?:\/|$)/i.test(
    path,
  );
}

function normalizedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.replace(/^www\./i, '').toLowerCase()}${
      parsed.port ? `:${parsed.port}` : ''
    }`;
  } catch {
    return value.toLowerCase().replace(/\/+$/, '');
  }
}

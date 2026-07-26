/**
 * Canonical Phase 2 Reddit configuration.
 *
 * Reddit is deliberately one source row: the official API can scan several
 * communities in one adapter, while `sources.base_url` remains the unique
 * natural key. It ships disabled until credentials are available. Database
 * seeding preserves an operator's later `enabled = true` change.
 */

export interface RedditSourceConfig {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly crawlDelayS: number;
  readonly subreddits: readonly string[];
  readonly minScore: number;
  readonly topCommentLimit: number;
}

export const REDDIT_SOURCES = [
  {
    slug: 'reddit-meal-prep',
    name: 'Reddit meal prep',
    baseUrl: 'https://www.reddit.com',
    enabled: false,
    crawlDelayS: 2,
    subreddits: ['MealPrepSunday', 'EatCheapAndHealthy'],
    minScore: 10,
    topCommentLimit: 10,
  },
] as const satisfies readonly RedditSourceConfig[];

export function findRedditSource(baseUrl: string): RedditSourceConfig | null {
  const origin = normalizedOrigin(baseUrl);
  return (
    REDDIT_SOURCES.find(
      (source) => normalizedOrigin(source.baseUrl) === origin,
    ) ?? null
  );
}

function normalizedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname
      .replace(/^www\./i, '')
      .toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return value.toLowerCase().replace(/\/+$/, '');
  }
}

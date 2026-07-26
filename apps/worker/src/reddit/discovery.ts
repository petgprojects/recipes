import type { RedditClient, RedditPost } from './types';

export interface DiscoverRedditOptions {
  readonly since?: Date | null;
  readonly limit?: number;
  readonly maxPages?: number;
  readonly pageSize?: number;
}

export interface DiscoverRedditResult {
  readonly posts: readonly RedditPost[];
  /** True when pagination reached a post at/before the saved checkpoint. */
  readonly crossedCheckpoint: boolean;
  /** A safety ceiling stopped discovery before the checkpoint/end was seen. */
  readonly truncated: boolean;
  readonly pages: number;
}

export async function discoverRedditPosts(
  client: RedditClient,
  input: {
    readonly subreddits: readonly string[];
    readonly minScore: number;
  },
  options: DiscoverRedditOptions = {},
): Promise<DiscoverRedditResult> {
  const since = options.since ?? null;
  const limit = Math.max(1, options.limit ?? 200);
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  const byId = new Map<string, RedditPost>();
  let after: string | null = null;
  let pages = 0;
  let crossedCheckpoint = false;
  let reachedEnd = false;

  while (pages < maxPages && !crossedCheckpoint && !reachedEnd) {
    const page = await client.listNew({
      subreddits: input.subreddits,
      after,
      limit: pageSize,
    });
    pages += 1;

    for (const post of page.posts) {
      if (since !== null && post.createdAt <= since) {
        crossedCheckpoint = true;
        continue;
      }
      if (post.score >= input.minScore && !byId.has(post.id) && byId.size < limit) {
        byId.set(post.id, post);
      }
    }

    after = page.after;
    reachedEnd = after === null;
  }

  return {
    posts: [...byId.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
    ),
    crossedCheckpoint,
    truncated: !crossedCheckpoint && !reachedEnd,
    pages,
  };
}

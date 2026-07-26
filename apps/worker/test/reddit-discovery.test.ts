import { describe, expect, it, vi } from 'vitest';
import { discoverRedditPosts } from '../src/reddit/discovery';
import type { RedditClient, RedditPost } from '../src/reddit/types';

describe('Reddit discovery', () => {
  it('paginates to the checkpoint, filters score, and deduplicates IDs', async () => {
    const fresh = post('fresh', '2026-07-26T11:00:00Z', 50);
    const low = post('low', '2026-07-26T10:00:00Z', 2);
    const old = post('old', '2026-07-25T11:00:00Z', 100);
    const listNew = vi
      .fn<RedditClient['listNew']>()
      .mockResolvedValueOnce({ posts: [fresh, low], after: 'next' })
      .mockResolvedValueOnce({ posts: [fresh, old], after: null });
    const client: RedditClient = {
      listNew,
      async topComments() {
        return [];
      },
    };

    const result = await discoverRedditPosts(
      client,
      { subreddits: ['MealPrepSunday'], minScore: 10 },
      { since: new Date('2026-07-26T00:00:00Z') },
    );

    expect(result.posts.map((item) => item.id)).toEqual(['fresh']);
    expect(result).toMatchObject({
      crossedCheckpoint: true,
      truncated: false,
      pages: 2,
    });
  });

  it('surfaces a safety ceiling before a checkpoint as truncated', async () => {
    const client: RedditClient = {
      async listNew() {
        return {
          posts: [post('fresh', '2026-07-26T11:00:00Z', 50)],
          after: 'still-more',
        };
      },
      async topComments() {
        return [];
      },
    };
    const result = await discoverRedditPosts(
      client,
      { subreddits: ['MealPrepSunday'], minScore: 10 },
      {
        since: new Date('2026-07-20T00:00:00Z'),
        maxPages: 1,
      },
    );
    expect(result.truncated).toBe(true);
  });
});

function post(id: string, createdAt: string, score: number): RedditPost {
  return {
    id,
    subreddit: 'MealPrepSunday',
    permalink: `https://www.reddit.com/r/MealPrepSunday/comments/${id}/post/`,
    title: id,
    selfText: '',
    selfTextHtml: null,
    url: `https://www.reddit.com/r/MealPrepSunday/comments/${id}/post/`,
    createdAt: new Date(createdAt),
    score,
    isSelf: true,
  };
}

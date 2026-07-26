import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REDDIT_SOURCES } from '@recipes/shared';
import {
  initializeRedditSource,
  RedditHttpClient,
} from '../src/reddit/client';

const fixtures = join(import.meta.dirname, 'fixtures', 'reddit');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as unknown;

describe('Reddit credential gating', () => {
  it('does not inspect credentials while the source is disabled', () => {
    const loadCredentials = vi.fn(() => {
      throw new Error('must not be called');
    });
    expect(
      initializeRedditSource({
        source: REDDIT_SOURCES[0],
        loadCredentials,
      }).status,
    ).toBe('disabled');
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it('fails clearly when an enabled source lacks credentials', () => {
    expect(() =>
      initializeRedditSource({
        source: { ...REDDIT_SOURCES[0], enabled: true },
        loadCredentials: () => ({ clientId: 'configured' }),
      }),
    ).toThrow('clientSecret, userAgent');
  });
});

describe('Reddit official API client', () => {
  it('authenticates once and maps mocked listing/comments responses', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/v1/access_token')) {
        return Response.json({ access_token: 'token-1', expires_in: 3600 });
      }
      if (url.includes('/new?')) return Response.json(fixture('listing.json'));
      if (url.includes('.json?')) return Response.json(fixture('comments.json'));
      return new Response('unexpected', { status: 404 });
    }) as typeof fetch;

    const client = new RedditHttpClient({
      credentials: {
        clientId: 'client',
        clientSecret: 'secret',
        userAgent: 'recipes-test/1.0 by u/tester',
      },
      fetchImpl,
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    });

    const listing = await client.listNew({
      subreddits: ['MealPrepSunday', 'EatCheapAndHealthy'],
      limit: 25,
    });
    const comments = await client.topComments(listing.posts[0]!.permalink, {
      limit: 5,
    });

    expect(listing.after).toBe('t3_older');
    expect(listing.posts.map((post) => post.id)).toEqual(['meal1', 'meal2']);
    expect(listing.posts[1]?.url).toBe(
      'https://www.budgetbytes.com/weeknight-beans/',
    );
    expect(comments).toEqual([
      expect.objectContaining({ id: 'good', score: 31 }),
    ]);
    expect(
      calls.filter((call) => call.url.endsWith('/api/v1/access_token')),
    ).toHaveLength(1);
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: expect.stringMatching(/^Basic /),
      'user-agent': 'recipes-test/1.0 by u/tester',
    });
    expect(calls[1]?.init?.headers).toMatchObject({
      authorization: 'Bearer token-1',
    });
  });
});

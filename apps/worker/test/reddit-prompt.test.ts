import { describe, expect, it } from 'vitest';
import { prepareRedditPostPrompt } from '../src/reddit/prompt';
import type { RedditPost } from '../src/reddit/types';

describe('Reddit post prompt preparation', () => {
  it('sorts useful comments, removes moderation noise, and enforces the cap', () => {
    const text = prepareRedditPostPrompt(
      post(),
      [
        {
          id: 'low',
          author: 'cook-1',
          body: 'Lower score instruction',
          score: 2,
        },
        {
          id: 'auto',
          author: 'AutoModerator',
          body: 'Rules',
          score: 1_000,
        },
        {
          id: 'high',
          author: 'cook-2',
          body: 'Higher score instruction',
          score: 20,
        },
      ],
      { maxChars: 400, maxComments: 2 },
    );

    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain('Higher score instruction');
    expect(text).not.toContain('AutoModerator');
    expect(text.indexOf('Higher score')).toBeLessThan(text.indexOf('Lower score'));
  });
});

function post(): RedditPost {
  return {
    id: 'post-1',
    subreddit: 'MealPrepSunday',
    permalink:
      'https://www.reddit.com/r/MealPrepSunday/comments/post1/lunches/',
    title: 'Five lunches',
    selfText: 'Cook beans, add vegetables, and divide into five containers.',
    selfTextHtml: null,
    url: 'https://www.reddit.com/r/MealPrepSunday/comments/post1/lunches/',
    createdAt: new Date('2026-07-26T10:00:00Z'),
    score: 50,
    isSelf: true,
  };
}

import { cleanText } from '../scanner/text';
import type { RedditComment, RedditPost } from './types';

export interface RedditPromptOptions {
  readonly maxChars?: number;
  readonly maxPostChars?: number;
  readonly maxCommentChars?: number;
  readonly maxComments?: number;
}

const DEFAULT_MAX_CHARS = 30_000;

/** Prepare bounded untrusted text; the static extraction prompt lives elsewhere. */
export function prepareRedditPostPrompt(
  post: RedditPost,
  comments: readonly RedditComment[],
  options: RedditPromptOptions = {},
): string {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxPostChars = Math.max(1, options.maxPostChars ?? 16_000);
  const maxCommentChars = Math.max(1, options.maxCommentChars ?? 3_000);
  const maxComments = Math.max(0, options.maxComments ?? 10);
  const body = cleanText(post.selfText).slice(0, maxPostChars);
  const selected = comments
    .filter(
      (comment) =>
        !/^\[(?:deleted|removed)\]$/i.test(comment.body.trim()) &&
        comment.author?.toLowerCase() !== 'automoderator',
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxComments);

  const lines = [
    `Title: ${cleanText(post.title)}`,
    `Community: r/${post.subreddit}`,
    `Score: ${post.score}`,
    'Post body:',
    body || '(empty)',
    'Top comments:',
    ...selected.map((comment, index) => {
      const author = cleanText(comment.author ?? 'unknown');
      const text = cleanText(comment.body).slice(0, maxCommentChars);
      return `${index + 1}. score=${comment.score} author=${author}: ${text}`;
    }),
  ];
  return lines.join('\n').slice(0, maxChars).trimEnd();
}

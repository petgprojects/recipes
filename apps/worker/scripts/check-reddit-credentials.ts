/**
 * Prove the Reddit credentials in `.env` actually work, and nothing more.
 *
 * ```
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-credentials.ts
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-credentials.ts --comments
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-credentials.ts --subreddit=Cooking --limit=3
 * ```
 *
 * **This is free.** It touches no database, opens no `scan_runs` row, and calls
 * no model — it exercises exactly the two Reddit endpoints `RedditHttpClient`
 * uses (`POST /api/v1/access_token` and a `/r/<subs>/new` listing, plus an
 * optional comment page) and prints what came back. The point is to separate
 * "the credentials are wrong" from "the pipeline is wrong" before anything is
 * enabled, so it is a script rather than a test: a suite that talks to Reddit
 * is a suite that fails on an aeroplane.
 *
 * The adapter authenticates with `grant_type=client_credentials`, which is
 * Reddit's application-only flow for confidential clients — script apps
 * included. No redirect URI is ever sent, so whatever is registered against the
 * app has no bearing on any of this. It also means the token is tied to no
 * user: everything read here is public, which is all the scanner wants.
 */

import { REDDIT_SOURCES } from '@recipes/shared';
import { requireEnv } from '@recipes/shared/env';
import { RedditHttpClient } from '../src/reddit/client';

interface Options {
  readonly subreddits: readonly string[];
  readonly limit: number;
  readonly withComments: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // requireEnv names the missing var and how to get it, which is the whole
  // diagnostic when someone has filled in two of the three.
  const credentials = {
    clientId: requireEnv('REDDIT_CLIENT_ID'),
    clientSecret: requireEnv('REDDIT_CLIENT_SECRET'),
    userAgent: requireEnv('REDDIT_USER_AGENT'),
  };

  console.log('Reddit credential check');
  console.log(`  client id   ${mask(credentials.clientId)}`);
  console.log(`  secret      ${mask(credentials.clientSecret)}`);
  console.log(`  user agent  ${credentials.userAgent}`);
  console.log(`  subreddits  ${options.subreddits.join(', ')}`);
  console.log('');

  const client = new RedditHttpClient({ credentials });

  const startedAt = Date.now();
  const page = await client.listNew({
    subreddits: options.subreddits,
    limit: options.limit,
  });
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `✓ token + listing OK — ${page.posts.length} post(s) in ${elapsedMs}ms, after=${page.after ?? 'null'}`,
  );
  console.log('');

  for (const post of page.posts) {
    console.log(`  r/${post.subreddit} · ${post.score} pts · ${post.createdAt.toISOString()}`);
    console.log(`    ${truncate(post.title, 96)}`);
    console.log(`    ${post.isSelf ? 'self post' : `links to ${post.url}`}`);
    console.log(`    ${post.permalink}`);
    console.log('');
  }

  if (!options.withComments) {
    console.log('Pass --comments to also read one post\'s comment page.');
    return;
  }

  const first = page.posts[0];
  if (first === undefined) {
    console.log('No posts came back, so there is no comment page to read.');
    return;
  }

  const comments = await client.topComments(first.permalink, { limit: 3 });
  console.log(`✓ comments OK — ${comments.length} on "${truncate(first.title, 60)}"`);
  for (const comment of comments) {
    console.log(`  ${comment.score} pts · u/${comment.author ?? 'unknown'}`);
    console.log(`    ${truncate(comment.body.replace(/\s+/g, ' '), 96)}`);
  }
}

function parseArgs(argv: readonly string[]): Options {
  const subreddits: string[] = [];
  let limit = 5;
  let withComments = false;

  for (const arg of argv) {
    if (arg === '--comments') {
      withComments = true;
      continue;
    }
    const subreddit = /^--subreddit=(.+)$/.exec(arg);
    if (subreddit?.[1] !== undefined) {
      subreddits.push(...subreddit[1].split(',').map((value) => value.trim()));
      continue;
    }
    const limitArg = /^--limit=(\d+)$/.exec(arg);
    if (limitArg?.[1] !== undefined) {
      limit = Math.min(100, Math.max(1, Number.parseInt(limitArg[1], 10)));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    // Default to the communities the configured source would actually scan, so
    // a clean run says something about the real thing and not about r/test.
    subreddits:
      subreddits.length > 0 ? subreddits : REDDIT_SOURCES[0].subreddits,
    limit,
    withComments,
  };
}

function mask(value: string): string {
  return value.length <= 4
    ? '*'.repeat(value.length)
    : `${value.slice(0, 2)}${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-2)} (${value.length} chars)`;
}

function truncate(value: string, max: number): string {
  const collapsed = value.trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ ${message}`);

  // The three failures worth telling apart, because each has a different fix
  // and Reddit's status codes alone do not say which one happened.
  if (/Reddit OAuth 401/.test(message)) {
    console.error(
      '\n  401 at the token endpoint means the id/secret pair was rejected.\n' +
        '  · REDDIT_CLIENT_ID is the short string under the app name on\n' +
        '    https://www.reddit.com/prefs/apps — not the app name itself.\n' +
        '  · An "installed app" has no secret and cannot use this flow; the app\n' +
        '    must be type "script" or "web app".\n' +
        '  · A regenerated secret invalidates the old one immediately.',
    );
  } else if (/Reddit OAuth 4\d\d/.test(message)) {
    console.error(
      '\n  A 4xx at the token endpoint that is not 401 is usually the user agent.\n' +
        '  Reddit blocks generic and empty ones. Use something like\n' +
        '    recipes/0.1 by u/<your-username> (+https://recipes.petergelgor.ca)',
    );
  } else if (/Reddit API 403/.test(message)) {
    console.error(
      '\n  403 on the listing means the token was accepted but the read was not:\n' +
        '  a private, quarantined or banned subreddit, or a user agent Reddit is\n' +
        '  refusing. Try --subreddit=Cooking to isolate which.',
    );
  } else if (/Reddit API 429/.test(message)) {
    console.error('\n  429 is the rate limit — 100 requests/minute per client id. Wait and retry.');
  }

  process.exitCode = 1;
});

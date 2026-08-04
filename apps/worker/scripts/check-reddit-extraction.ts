/**
 * Route live Reddit posts through the **real** extraction path and print what
 * came back, so the model's judgement can be read against the post it judged.
 *
 * ```
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-extraction.ts
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-extraction.ts --limit=10 --min-score=0
 * docker compose exec worker ./node_modules/.bin/tsx scripts/check-reddit-extraction.ts --subreddit=MealPrepSunday --show-prompt
 * ```
 *
 * **This spends real money** — roughly a cent for the default five posts, and
 * more per post on a roundup, which now returns every recipe it lists rather
 * than the first — and is deliberately not a test, for the same reason
 * `check-search-parse.ts` is not: a suite that calls a paid provider fails on
 * an aeroplane and goes red for reasons unrelated to the commit under it.
 *
 * A ten-post sweep can run for several minutes. Prefer detaching it inside the
 * container (`docker compose exec -d worker sh -c '… > /tmp/sweep.log 2>&1'`)
 * and tailing the log; a backgrounded `docker compose exec` is killed with its
 * client and takes the run with it.
 *
 * It is the *routing* seam that runs here, not a private copy of it:
 * `routeRedditPost` with `createRedditRuntimeLlmExtractor`, which is the same
 * composition `createPostgresRedditScanOrchestrator` builds. So an external
 * blog link is still exhausted deterministically before any post text is sent
 * to a model, and `method` in the output says which path actually answered.
 *
 * What it deliberately does not do is everything downstream of routing:
 * no `scan_runs` row, no budget row, no ingredient matching, no image cache and
 * **no persistence**. Nothing here can put a recipe in the corpus. The run
 * prints its own cost instead of debiting the day's scan budget, because a
 * diagnostic that quietly ate tonight's crawl would be a poor diagnostic.
 */

import { REDDIT_SOURCES } from '@recipes/shared';
import { env, requireEnv } from '@recipes/shared/env';
import {
  addLlmUsage,
  createOpenRouterClient,
  type LlmUsage,
  type StructuredOutputClient,
} from '../src/llm';
import { RedditHttpClient } from '../src/reddit/client';
import { discoverRedditPosts } from '../src/reddit/discovery';
import { createRedditRuntimeLlmExtractor } from '../src/reddit/postgres';
import { prepareRedditPostPrompt } from '../src/reddit/prompt';
import { routeRedditPost, type RedditRouteResult } from '../src/reddit/routing';
import { createFetcher } from '../src/scanner/fetcher';
import type { RedditPost } from '../src/reddit/types';

const ZERO_USAGE: LlmUsage = {
  tokensIn: 0,
  tokensOut: 0,
  totalTokens: 0,
  cachedTokensIn: 0,
  costUsd: 0,
  costSource: 'provider',
};

interface Options {
  readonly subreddits: readonly string[];
  readonly minScore: number;
  readonly limit: number;
  readonly showPrompt: boolean;
  /** A post id like `1vekq45`, pinning the run to one known post. */
  readonly postId: string | null;
}

/**
 * Find one post by id in the `/new` listing.
 *
 * Deliberately not a new `RedditClient` method: comparing two models on the
 * same post is a diagnostic need, and the production client should not grow an
 * endpoint that only a script calls. The cost is that the post has to still be
 * within a few pages of `/new` — fine for the day-old posts this is used on.
 */
async function findPostById(
  reddit: RedditHttpClient,
  subreddits: readonly string[],
  postId: string,
  maxPages = 3,
): Promise<RedditPost | null> {
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const listing = await reddit.listNew({ subreddits, after, limit: 100 });
    const found = listing.posts.find((post) => post.id === postId);
    if (found !== undefined) return found;
    after = listing.after;
    if (after === null) return null;
  }
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = {
    ...REDDIT_SOURCES[0],
    subreddits: options.subreddits,
    minScore: options.minScore,
    // Routing reads `enabled` nowhere; the orchestrator is what gates on it.
    // Left as configured so this script cannot be mistaken for turning it on.
  };

  const reddit = new RedditHttpClient({
    credentials: {
      clientId: requireEnv('REDDIT_CLIENT_ID'),
      clientSecret: requireEnv('REDDIT_CLIENT_SECRET'),
      userAgent: requireEnv('REDDIT_USER_AGENT'),
    },
  });

  let usage = ZERO_USAGE;
  const provider = createOpenRouterClient({
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseURL: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    // Match the worker's runtime client; the 180s default aborts the longest
    // roundups, which would make this script report a failure production does
    // not have.
    timeoutMs: 600_000,
    defaultHeaders: {
      'HTTP-Referer': env.NEXT_PUBLIC_APP_URL,
      'X-OpenRouter-Title': 'Recipe Planner',
    },
  });
  const counted: StructuredOutputClient = {
    complete: (task, callOptions = {}) =>
      provider.complete(task, {
        ...callOptions,
        onUsage: (called) => {
          usage = addLlmUsage(usage, called);
        },
      }),
  };

  console.log(
    `Model ${env.OPENROUTER_MODEL} · r/${options.subreddits.join(' + r/')} · ` +
      `score ≥ ${options.minScore} · up to ${options.limit} post(s)`,
  );
  console.log('No database writes, no budget row, nothing persisted.\n');

  let posts: readonly RedditPost[];
  if (options.postId !== null) {
    const pinned = await findPostById(reddit, options.subreddits, options.postId);
    if (pinned === null) {
      console.log(
        `Post ${options.postId} is not in the first pages of /new for the given ` +
          'subreddit(s). Pass --subreddit= to narrow it, or pick a newer post.',
      );
      return;
    }
    posts = [pinned];
    console.log('Pinned to one post.\n');
  } else {
    const discovered = await discoverRedditPosts(reddit, source, {
      limit: options.limit,
      // One listing page is plenty to find five routable posts, and it keeps the
      // Reddit side of this to a single request.
      maxPages: 2,
    });
    if (discovered.posts.length === 0) {
      console.log(
        `No posts at score ≥ ${options.minScore}. Lower it with --min-score=0.`,
      );
      return;
    }
    posts = discovered.posts;
    console.log(
      `Discovered ${posts.length} post(s) over ${discovered.pages} listing page(s).\n`,
    );
  }

  const fetcher = createFetcher();
  const llm = createRedditRuntimeLlmExtractor(counted, {});
  const results: { post: RedditPost; result: RedditRouteResult | null; error: string | null }[] =
    [];

  for (const post of posts) {
    console.log('─'.repeat(78));
    console.log(`r/${post.subreddit} · ${post.score} pts · ${post.permalink}`);
    console.log(`"${post.title}"`);
    console.log(
      post.isSelf
        ? `self post, ${post.selfText.length} chars of body`
        : `link post → ${post.url}`,
    );

    if (options.showPrompt) {
      const comments = await reddit.topComments(post.permalink, {
        limit: source.topCommentLimit,
      });
      console.log('\n  ── what the model is shown ──');
      for (const line of prepareRedditPostPrompt(post, comments, {
        maxComments: source.topCommentLimit,
      }).split('\n')) {
        console.log(`  │ ${line.slice(0, 160)}`);
      }
      console.log('');
    }

    try {
      const result = await routeRedditPost(post, source, {
        fetchExternal: (url, publisher) =>
          fetcher.fetch(url, {
            crawlDelayMs: publisher.crawlDelayS * 1_000,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          }),
        loadTopComments: (_post, limit) =>
          reddit.topComments(post.permalink, { limit }),
        llm,
      });
      results.push({ post, result, error: null });
      report(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ post, result: null, error: message });
      console.log(`\n  ✗ threw: ${message}`);
    }
    console.log('');
  }

  const recipes = results.filter((row) => row.result?.outcome === 'recipe');
  const byMethod = new Map<string, number>();
  let recipeCount = 0;
  let mostFromOnePost = 0;
  for (const row of recipes) {
    if (row.result?.outcome !== 'recipe') continue;
    const count = row.result.drafts.length;
    recipeCount += count;
    mostFromOnePost = Math.max(mostFromOnePost, count);
    byMethod.set(row.result.method, (byMethod.get(row.result.method) ?? 0) + count);
  }

  console.log('═'.repeat(78));
  console.log(
    `${recipes.length}/${results.length} posts yielded ${recipeCount} recipe(s)` +
      (byMethod.size === 0
        ? ''
        : ` — ${[...byMethod].map(([m, n]) => `${n} via ${m}`).join(', ')}`) +
      (mostFromOnePost > 1 ? `, most from one post: ${mostFromOnePost}` : ''),
  );
  console.log(
    `Cost $${usage.costUsd.toFixed(5)} (${usage.tokensIn} in, ${usage.tokensOut} out` +
      `${usage.cachedTokensIn > 0 ? `, ${usage.cachedTokensIn} cached` : ''})` +
      `, source: ${usage.costSource}`,
  );
  if (results.length > 0) {
    const perPost = usage.costUsd / results.length;
    console.log(
      `≈ $${perPost.toFixed(5)}/post — a 200-post nightly scan would be about ` +
        `$${(perPost * 200).toFixed(2)}, against LLM_DAILY_BUDGET_USD=$${env.LLM_DAILY_BUDGET_USD}.`,
    );
  }
}

function report(result: RedditRouteResult): void {
  for (const warning of result.warnings) {
    console.log(`  ! ${warning}`);
  }

  if (result.outcome === 'not-recipe') {
    console.log(`\n  ✗ not a recipe — ${result.reason}`);
    return;
  }

  console.log(
    `\n  ✓ ${result.drafts.length} recipe(s) via ${result.method}`,
  );
  result.drafts.forEach((draft, position) => {
    console.log(`\n    [${position + 1}] ${draft.title}`);
    console.log(
      `        servings ${draft.servings ?? '—'}   ` +
        `total ${draft.totalMinutes ?? '—'} min   active ${draft.activeMinutes ?? '—'} min   ` +
        `author ${draft.author ?? '—'}   image ${draft.imageUrl ?? '—'}`,
    );
    // The disambiguated key, which is what makes several recipes from one post
    // survive the unique index on `recipes.source_url`.
    console.log(`        source_url ${draft.sourceUrl}`);
    console.log(`        ingredients (${draft.ingredients.length})`);
    for (const ingredient of draft.ingredients) {
      console.log(`          · ${ingredient.rawText}`);
    }
    console.log(`        instructions (${draft.instructions.length})`);
    draft.instructions.forEach((step, index) => {
      console.log(`          ${index + 1}. ${truncate(step.text, 110)}`);
    });
  });
}

function parseArgs(argv: readonly string[]): Options {
  const subreddits: string[] = [];
  let limit = 5;
  // Annotated: `REDDIT_SOURCES` is `as const`, so this infers the literal 10.
  let minScore: number = REDDIT_SOURCES[0].minScore;
  let showPrompt = false;
  let postId: string | null = null;

  for (const arg of argv) {
    if (arg === '--show-prompt') {
      showPrompt = true;
      continue;
    }
    const postArg = /^--post=(.+)$/.exec(arg);
    if (postArg?.[1] !== undefined) {
      // Accept a bare id or a full permalink.
      const value = postArg[1].trim();
      postId =
        /^[a-z0-9]+$/i.test(value)
          ? value
          : (/\/comments\/([a-z0-9]+)/i.exec(value)?.[1] ?? value);
      continue;
    }
    const subreddit = /^--subreddit=(.+)$/.exec(arg);
    if (subreddit?.[1] !== undefined) {
      subreddits.push(...subreddit[1].split(',').map((value) => value.trim()));
      continue;
    }
    const limitArg = /^--limit=(\d+)$/.exec(arg);
    if (limitArg?.[1] !== undefined) {
      limit = Math.min(25, Math.max(1, Number.parseInt(limitArg[1], 10)));
      continue;
    }
    const scoreArg = /^--min-score=(\d+)$/.exec(arg);
    if (scoreArg?.[1] !== undefined) {
      minScore = Number.parseInt(scoreArg[1], 10);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    subreddits:
      subreddits.length > 0 ? subreddits : REDDIT_SOURCES[0].subreddits,
    minScore,
    limit,
    showPrompt,
    postId,
  };
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

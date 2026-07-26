import type { RedditSourceConfig } from '@recipes/shared';
import type {
  RedditClient,
  RedditComment,
  RedditCredentials,
  RedditListingPage,
  RedditPost,
  RedditSourceInitialization,
} from './types';

export interface RedditHttpClientOptions {
  readonly credentials: RedditCredentials;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * Small official-API client. IO is injectable and responses are mapped onto
 * stable internal types before the scanner sees them.
 */
export class RedditHttpClient implements RedditClient {
  private readonly credentials: RedditCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: CachedToken | null = null;

  constructor(options: RedditHttpClientOptions) {
    this.credentials = validateCredentials(options.credentials);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async listNew(input: {
    readonly subreddits: readonly string[];
    readonly after?: string | null;
    readonly limit?: number;
  }): Promise<RedditListingPage> {
    const subreddits = input.subreddits
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z0-9_]+$/.test(value));
    if (subreddits.length === 0) throw new Error('At least one valid subreddit is required');

    const url = new URL(
      `/r/${subreddits.join('+')}/new`,
      'https://oauth.reddit.com',
    );
    url.searchParams.set('limit', String(clamp(input.limit ?? 100, 1, 100)));
    url.searchParams.set('raw_json', '1');
    if (input.after) url.searchParams.set('after', input.after);

    return parseListing(await this.oauthJson(url));
  }

  async topComments(
    permalink: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly RedditComment[]> {
    const path = redditPermalinkPath(permalink);
    const url = new URL(`${path.replace(/\/+$/, '')}.json`, 'https://oauth.reddit.com');
    const limit = clamp(options.limit ?? 10, 1, 100);
    url.searchParams.set('sort', 'top');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('raw_json', '1');

    return parseComments(await this.oauthJson(url))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  private async oauthJson(url: URL): Promise<unknown> {
    let token = await this.accessToken();
    let response = await this.fetchImpl(url, {
      headers: this.oauthHeaders(token),
    });

    // Tokens can be revoked early. Refresh once, bounded, then surface the
    // actual response rather than looping.
    if (response.status === 401) {
      this.token = null;
      token = await this.accessToken();
      response = await this.fetchImpl(url, {
        headers: this.oauthHeaders(token),
      });
    }
    if (!response.ok) {
      throw new Error(`Reddit API ${response.status} for ${url.pathname}`);
    }
    return response.json() as Promise<unknown>;
  }

  private oauthHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'user-agent': this.credentials.userAgent,
      accept: 'application/json',
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt > this.now() + 30_000) {
      return this.token.value;
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`,
      'utf8',
    ).toString('base64');
    const response = await this.fetchImpl(
      'https://www.reddit.com/api/v1/access_token',
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': this.credentials.userAgent,
          accept: 'application/json',
        },
        body,
      },
    );
    if (!response.ok) {
      throw new Error(`Reddit OAuth ${response.status}`);
    }

    const data = asRecord(await response.json());
    const value = stringValue(data?.['access_token']);
    const expiresIn = numberValue(data?.['expires_in']);
    if (value === null || expiresIn === null || expiresIn <= 0) {
      throw new Error('Reddit OAuth returned an invalid token response');
    }
    this.token = {
      value,
      expiresAt: this.now() + expiresIn * 1_000,
    };
    return value;
  }
}

export interface InitializeRedditSourceOptions {
  readonly source: RedditSourceConfig;
  /**
   * Kept as a callback so a disabled adapter cannot accidentally read secrets.
   * Runtime wiring can call `requireEnv()` inside this function later.
   */
  readonly loadCredentials: () => Partial<RedditCredentials>;
  readonly createClient?: (credentials: RedditCredentials) => RedditClient;
}

export function initializeRedditSource(
  options: InitializeRedditSourceOptions,
): RedditSourceInitialization {
  if (!options.source.enabled) {
    return { status: 'disabled', source: options.source };
  }

  const credentials = validateCredentials(options.loadCredentials());
  return {
    status: 'enabled',
    source: options.source,
    client:
      options.createClient?.(credentials) ??
      new RedditHttpClient({ credentials }),
  };
}

function validateCredentials(
  credentials: Partial<RedditCredentials>,
): RedditCredentials {
  const missing = (
    ['clientId', 'clientSecret', 'userAgent'] as const
  ).filter((key) => (credentials[key]?.trim().length ?? 0) === 0);
  if (missing.length > 0) {
    throw new Error(
      `Reddit source is enabled but credentials are missing: ${missing.join(', ')}`,
    );
  }
  return {
    clientId: credentials.clientId!.trim(),
    clientSecret: credentials.clientSecret!.trim(),
    userAgent: credentials.userAgent!.trim(),
  };
}

function parseListing(value: unknown): RedditListingPage {
  const data = asRecord(asRecord(value)?.['data']);
  const children = Array.isArray(data?.['children']) ? data.children : [];
  const posts = children.flatMap((child): RedditPost[] => {
    const raw = asRecord(asRecord(child)?.['data']);
    const id = stringValue(raw?.['id']);
    const subreddit = stringValue(raw?.['subreddit']);
    const permalink = stringValue(raw?.['permalink']);
    const title = stringValue(raw?.['title']);
    const createdUtc = numberValue(raw?.['created_utc']);
    if (
      id === null ||
      subreddit === null ||
      permalink === null ||
      title === null ||
      createdUtc === null
    ) {
      return [];
    }

    const absolutePermalink = new URL(permalink, 'https://www.reddit.com').toString();
    const url =
      stringValue(raw?.['url_overridden_by_dest']) ??
      stringValue(raw?.['url']) ??
      absolutePermalink;
    return [
      {
        id,
        subreddit,
        permalink: absolutePermalink,
        title,
        selfText: stringValue(raw?.['selftext']) ?? '',
        selfTextHtml: stringValue(raw?.['selftext_html']),
        url,
        createdAt: new Date(createdUtc * 1_000),
        score: numberValue(raw?.['score']) ?? 0,
        isSelf: raw?.['is_self'] === true,
      },
    ];
  });

  return {
    posts,
    after: stringValue(data?.['after']),
  };
}

function parseComments(value: unknown): RedditComment[] {
  if (!Array.isArray(value)) return [];
  const listing = asRecord(value[1]);
  const children = asRecord(listing?.['data'])?.['children'];
  const out: RedditComment[] = [];

  const visit = (items: unknown, depth: number): void => {
    if (!Array.isArray(items) || depth > 4 || out.length >= 500) return;
    for (const child of items) {
      const record = asRecord(child);
      if (record?.['kind'] !== 't1') continue;
      const raw = asRecord(record['data']);
      const id = stringValue(raw?.['id']);
      const body = stringValue(raw?.['body']);
      if (id !== null && body !== null && !/^\[(?:deleted|removed)\]$/i.test(body.trim())) {
        const author = stringValue(raw?.['author']);
        if (author?.toLowerCase() !== 'automoderator') {
          out.push({
            id,
            author,
            body,
            score: numberValue(raw?.['score']) ?? 0,
          });
        }
      }
      const replies = asRecord(raw?.['replies']);
      visit(asRecord(replies?.['data'])?.['children'], depth + 1);
    }
  };

  visit(children, 0);
  return out;
}

function redditPermalinkPath(value: string): string {
  const parsed = new URL(value, 'https://www.reddit.com');
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'reddit.com' || !/^\/r\/[^/]+\/comments\//i.test(parsed.pathname)) {
    throw new Error(`Invalid Reddit post permalink: ${value}`);
  }
  return parsed.pathname;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

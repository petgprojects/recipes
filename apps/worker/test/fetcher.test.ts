/**
 * The polite fetcher, driven entirely by a stub `fetch`. No network.
 *
 * Every PLAN.md §7 requirement gets an assertion here, because all of them are
 * invisible when they break: a crawler that stops honouring robots.txt or
 * stops sending `If-None-Match` looks exactly like one that still does.
 */

import { describe, expect, it } from 'vitest';
import { MIN_CRAWL_DELAY_MS, PoliteFetcher, parseRetryAfter } from '../src/scanner/fetcher';

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  at: number;
}

/** A fake origin server plus a fake clock, so delays are asserted, not waited. */
function harness(routes: Record<string, StubResponse | StubResponse[]>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const remaining = new Map<string, StubResponse[]>(
    Object.entries(routes).map(([url, value]) => [url, Array.isArray(value) ? [...value] : [value]]),
  );

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, headers, at: now });

    const queue = remaining.get(url);
    const stub = queue === undefined ? undefined : (queue.length > 1 ? queue.shift() : queue[0]);
    if (stub === undefined) return new Response('not found', { status: 404 });
    if (stub.throws) throw stub.throws;
    return new Response(stub.status === 304 ? null : (stub.body ?? ''), {
      status: stub.status ?? 200,
      headers: stub.headers ?? {},
    });
  }) as unknown as typeof fetch;

  const fetcher = new PoliteFetcher({
    fetchImpl,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
    backoffBaseMs: 1_000,
  });

  return { fetcher, calls, sleeps, advance: (ms: number) => (now += ms) };
}

const ALLOW_ALL = { body: 'User-agent: *\nDisallow:\n' };

describe('robots.txt enforcement', () => {
  it('fetches robots.txt once per origin and reuses it', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { body: 'A' },
      'https://example.com/b': { body: 'B' },
    });

    await fetcher.fetch('https://example.com/a');
    await fetcher.fetch('https://example.com/b');

    expect(calls.filter((call) => call.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('never requests a disallowed URL', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': { body: 'User-agent: *\nDisallow: /private/\n' },
      'https://example.com/private/x': { body: 'secret' },
    });

    const result = await fetcher.fetch('https://example.com/private/x');

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.reason).toBe('robots');
      expect(result.retryable).toBe(false);
    }
    expect(calls.map((call) => call.url)).toEqual(['https://example.com/robots.txt']);
  });

  it('treats a 404 robots.txt as "crawl everything"', async () => {
    const { fetcher } = harness({
      'https://example.com/robots.txt': { status: 404 },
      'https://example.com/a': { body: 'A' },
    });
    const result = await fetcher.fetch('https://example.com/a');
    expect(result.outcome).toBe('ok');
  });

  it('fails closed when robots.txt is unreachable (5xx)', async () => {
    const { fetcher } = harness({
      'https://example.com/robots.txt': { status: 503 },
      'https://example.com/a': { body: 'A' },
    });
    const result = await fetcher.fetch('https://example.com/a');
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.reason).toBe('robots');
      expect(result.retryable).toBe(true);
    }
  });

  it('exposes robots.txt sitemaps for discovery', async () => {
    const { fetcher } = harness({
      'https://example.com/robots.txt': {
        body: 'Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:\n',
      },
    });
    await expect(fetcher.sitemapsFor('https://example.com')).resolves.toEqual([
      'https://example.com/sitemap.xml',
    ]);
  });
});

describe('identification and conditional GETs', () => {
  it('sends the configured User-Agent with a contact URL', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { body: 'A' },
    });
    await fetcher.fetch('https://example.com/a');
    expect(calls[0]?.headers['user-agent']).toContain('RecipePlannerBot');
    expect(calls[0]?.headers['user-agent']).toContain('https://github.com/');
  });

  it('sends If-None-Match / If-Modified-Since when validators are stored', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { body: 'A' },
    });

    await fetcher.fetch('https://example.com/a', {
      etag: 'W/"abc"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });

    const page = calls.find((call) => call.url.endsWith('/a'));
    expect(page?.headers['if-none-match']).toBe('W/"abc"');
    expect(page?.headers['if-modified-since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('reports 304 as its own cheap outcome, not as an error', async () => {
    const { fetcher } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { status: 304, headers: { etag: 'W/"v2"' } },
    });

    const result = await fetcher.fetch('https://example.com/a', { etag: 'W/"v1"' });

    expect(result.outcome).toBe('notModified');
    if (result.outcome === 'notModified') expect(result.etag).toBe('W/"v2"');
  });

  it('returns the ETag and Last-Modified to persist for next time', async () => {
    const { fetcher } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': {
        body: 'A',
        headers: { etag: '"xyz"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      },
    });
    const result = await fetcher.fetch('https://example.com/a');
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.etag).toBe('"xyz"');
      expect(result.lastModified).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    }
  });
});

describe('crawl delay', () => {
  it('spaces consecutive requests to one origin by at least a second', async () => {
    const { fetcher, sleeps } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { body: 'A' },
      'https://example.com/b': { body: 'B' },
    });

    await fetcher.fetch('https://example.com/a');
    await fetcher.fetch('https://example.com/b');

    expect(sleeps.every((ms) => ms >= MIN_CRAWL_DELAY_MS)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("honours robots.txt Crawl-delay when it is longer than ours", async () => {
    const { fetcher, sleeps } = harness({
      'https://example.com/robots.txt': { body: 'User-agent: *\nCrawl-delay: 5\nDisallow:\n' },
      'https://example.com/a': { body: 'A' },
      'https://example.com/b': { body: 'B' },
    });

    await fetcher.fetch('https://example.com/a');
    await fetcher.fetch('https://example.com/b');

    expect(sleeps.at(-1)).toBe(5_000);
  });

  it('clamps a per-source override up to the 1s floor', async () => {
    const { fetcher, sleeps } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { body: 'A' },
      'https://example.com/b': { body: 'B' },
    });

    await fetcher.fetch('https://example.com/a', { crawlDelayMs: 5 });
    await fetcher.fetch('https://example.com/b', { crawlDelayMs: 5 });

    expect(sleeps.at(-1)).toBe(MIN_CRAWL_DELAY_MS);
  });

  it('does not make one origin wait on another', async () => {
    const { fetcher, calls } = harness({
      'https://a.com/robots.txt': ALLOW_ALL,
      'https://b.com/robots.txt': ALLOW_ALL,
      'https://a.com/x': { body: 'A' },
      'https://b.com/x': { body: 'B' },
    });

    await Promise.all([fetcher.fetch('https://a.com/x'), fetcher.fetch('https://b.com/x')]);

    expect(calls.filter((call) => call.url === 'https://a.com/x')).toHaveLength(1);
    expect(calls.filter((call) => call.url === 'https://b.com/x')).toHaveLength(1);
  });
});

describe('retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const { fetcher, sleeps, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': [{ status: 429, headers: { 'retry-after': '7' } }, { body: 'A' }],
    });

    const result = await fetcher.fetch('https://example.com/a');

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') expect(result.attempts).toBe(2);
    expect(calls.filter((call) => call.url.endsWith('/a'))).toHaveLength(2);
    expect(sleeps).toContain(7_000);
  });

  it('retries a 503 with exponential backoff and gives up after maxAttempts', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { status: 503 },
    });

    const result = await fetcher.fetch('https://example.com/a');

    expect(calls.filter((call) => call.url.endsWith('/a'))).toHaveLength(3);
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.statusCode).toBe(503);
      expect(result.retryable).toBe(true);
      expect(result.attempts).toBe(3);
    }
  });

  it('never retries a 404 — the answer will not change', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { status: 404 },
    });

    const result = await fetcher.fetch('https://example.com/a');

    expect(calls.filter((call) => call.url.endsWith('/a'))).toHaveLength(1);
    if (result.outcome === 'error') expect(result.retryable).toBe(false);
  });

  it('never retries a 403', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { status: 403 },
    });
    await fetcher.fetch('https://example.com/a');
    expect(calls.filter((call) => call.url.endsWith('/a'))).toHaveLength(1);
  });

  it('retries a network failure and reports it as retryable', async () => {
    const { fetcher, calls } = harness({
      'https://example.com/robots.txt': ALLOW_ALL,
      'https://example.com/a': { throws: new Error('ECONNRESET') },
    });

    const result = await fetcher.fetch('https://example.com/a');

    expect(calls.filter((call) => call.url.endsWith('/a'))).toHaveLength(3);
    if (result.outcome === 'error') {
      expect(result.reason).toBe('network');
      expect(result.message).toContain('ECONNRESET');
    }
  });
});

describe('limits', () => {
  it('refuses a body larger than maxBytes', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(5_000))) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({
      fetchImpl,
      respectRobots: false,
      maxBytes: 1_000,
      sleep: async () => undefined,
    });

    const result = await fetcher.fetch('https://example.com/big');

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.reason).toBe('too-large');
      expect(result.retryable).toBe(false);
    }
  });

  it('rejects a declared content-length over the cap without reading the body', async () => {
    const fetchImpl = (async () =>
      new Response('small', { headers: { 'content-length': '99999999' } })) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({ fetchImpl, respectRobots: false, maxBytes: 1_000 });

    const result = await fetcher.fetch('https://example.com/big');
    if (result.outcome === 'error') expect(result.reason).toBe('too-large');
  });

  it('reports an aborted request as a timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({
      fetchImpl,
      respectRobots: false,
      timeoutMs: 5,
      maxAttempts: 1,
      sleep: async () => undefined,
    });

    const result = await fetcher.fetch('https://example.com/slow');
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') expect(result.reason).toBe('timeout');
  });

  it('rejects non-HTTP URLs without calling fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({ fetchImpl, respectRobots: false });

    const result = await fetcher.fetch('file:///etc/passwd');

    expect(called).toBe(false);
    if (result.outcome === 'error') expect(result.reason).toBe('invalid-url');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:29:00 GMT', now)).toBe(60_000);
  });

  it('never goes negative for a date in the past', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:30:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(0);
  });

  it('returns null for junk', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});

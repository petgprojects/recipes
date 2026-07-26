/**
 * Feed and sitemap discovery, against synthetic XML for the awkward shapes and
 * against the committed real feeds for the shapes that actually ship.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalUrlKey,
  dedupeByUrl,
  discoverSource,
  parseFeed,
  parseSitemap,
} from '../src/scanner/discover';
import { PoliteFetcher } from '../src/scanner/fetcher';

const fixture = (site: string, file: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', site, file), 'utf8');

describe('parseFeed — RSS', () => {
  it('reads link, title and pubDate', () => {
    const items = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Blog</title>
        <item>
          <title>Kale Salad</title>
          <link>https://example.com/kale/</link>
          <pubDate>Sat, 25 Jul 2026 10:00:00 +0000</pubDate>
        </item>
      </channel></rss>`);

    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/kale/');
    expect(items[0]?.title).toBe('Kale Salad');
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-07-25T10:00:00.000Z');
  });

  it('parses a single-item feed as a list, not an object', () => {
    const items = parseFeed(
      `<rss><channel><item><link>https://example.com/only/</link></item></channel></rss>`,
    );
    expect(items).toHaveLength(1);
  });

  it('falls back to a permalink guid when link is missing', () => {
    const items = parseFeed(
      `<rss><channel><item><guid isPermaLink="true">https://example.com/g/</guid></item></channel></rss>`,
    );
    expect(items[0]?.url).toBe('https://example.com/g/');
  });

  it('ignores a non-permalink guid', () => {
    const items = parseFeed(
      `<rss><channel><item><guid isPermaLink="false">https://example.com/?p=12</guid></item></channel></rss>`,
    );
    expect(items).toHaveLength(0);
  });

  it('resolves a relative link against the base URL', () => {
    const items = parseFeed(
      `<rss><channel><item><link>/relative/</link></item></channel></rss>`,
      'https://example.com',
    );
    expect(items[0]?.url).toBe('https://example.com/relative/');
  });

  it('returns nothing for HTML served where a feed was expected', () => {
    expect(parseFeed('<!DOCTYPE html><html><body>Access denied</body></html>')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

describe('parseFeed — Atom', () => {
  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <link rel="self" href="https://example.com/feed"/>
      <entry>
        <title>Gnocchi</title>
        <link rel="edit" href="https://example.com/edit/1"/>
        <link rel="alternate" href="https://example.com/gnocchi/"/>
        <published>2026-07-23T12:00:00Z</published>
      </entry>
    </feed>`;

  it('takes rel="alternate", not the first link element', () => {
    const items = parseFeed(atom);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/gnocchi/');
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-07-23T12:00:00.000Z');
  });

  it('handles namespace-prefixed elements', () => {
    const items = parseFeed(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
        <atom:entry><atom:link href="https://example.com/x/"/></atom:entry>
      </atom:feed>`);
    expect(items[0]?.url).toBe('https://example.com/x/');
  });
});

describe('parseSitemap', () => {
  it('recognises a sitemap index and its lastmod', () => {
    const doc = parseSitemap(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/post-sitemap.xml</loc><lastmod>2026-07-01</lastmod></sitemap>
      <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
    </sitemapindex>`);

    expect(doc.kind).toBe('index');
    if (doc.kind !== 'index') return;
    expect(doc.sitemaps).toHaveLength(2);
    expect(doc.sitemaps[0]?.lastmod?.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(doc.sitemaps[1]?.lastmod).toBeUndefined();
  });

  it('recognises a urlset and maps lastmod to publishedAt', () => {
    const doc = parseSitemap(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a/</loc><lastmod>2026-07-20T10:00:00-04:00</lastmod></url>
      <url><loc>https://example.com/b/</loc></url>
    </urlset>`);

    expect(doc.kind).toBe('urlset');
    if (doc.kind !== 'urlset') return;
    expect(doc.urls.map((u) => u.url)).toEqual(['https://example.com/a/', 'https://example.com/b/']);
    expect(doc.urls[0]?.publishedAt?.toISOString()).toBe('2026-07-20T14:00:00.000Z');
  });

  it('reports anything else as unknown rather than throwing', () => {
    expect(parseSitemap('<html><body>nope</body></html>').kind).toBe('unknown');
    expect(parseSitemap('not xml at all').kind).toBe('unknown');
  });
});

describe('deduplication', () => {
  it('collapses tracking parameters, www, scheme and trailing slash', () => {
    expect(canonicalUrlKey('http://www.example.com/a/?utm_source=rss&x=1#frag')).toBe(
      canonicalUrlKey('https://example.com/a?x=1'),
    );
  });

  it('keeps meaningful query parameters distinct', () => {
    expect(canonicalUrlKey('https://example.com/a?page=2')).not.toBe(
      canonicalUrlKey('https://example.com/a?page=3'),
    );
  });

  it('merges what each copy knows', () => {
    const merged = dedupeByUrl([
      { url: 'https://example.com/a/' },
      { url: 'https://example.com/a?utm_medium=feed', title: 'A', publishedAt: new Date(0) },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('A');
    expect(merged[0]?.url).toBe('https://example.com/a/');
  });
});

describe('the real feeds we captured', () => {
  it('parses every committed feed into dated, titled URLs on the right host', () => {
    for (const [site, host, min] of [
      ['budget-bytes', 'www.budgetbytes.com', 10],
      ['pinch-of-yum', 'pinchofyum.com', 5],
      ['downshiftology', 'downshiftology.com', 10],
      ['skinnytaste', 'www.skinnytaste.com', 10],
      ['the-kitchn', 'www.thekitchn.com', 20],
      ['love-and-lemons', 'www.loveandlemons.com', 10],
    ] as const) {
      const items = parseFeed(fixture(site, 'feed.xml'), `https://${host}`);
      expect(items.length, site).toBeGreaterThanOrEqual(min);
      expect(items.every((item) => new URL(item.url).hostname === host), site).toBe(true);
      expect(items.every((item) => item.title !== undefined), `${site} titles`).toBe(true);
      expect(items.every((item) => item.publishedAt !== undefined), `${site} dates`).toBe(true);
    }
  });

  it('parses the two sitemap-only sources', () => {
    const classpop = parseSitemap(fixture('classpop', 'sitemap.xml'));
    expect(classpop.kind).toBe('urlset');
    if (classpop.kind === 'urlset') expect(classpop.urls.length).toBeGreaterThan(1_000);

    const seriousEats = parseSitemap(fixture('serious-eats', 'sitemap.xml'));
    expect(seriousEats.kind).toBe('urlset');
    if (seriousEats.kind === 'urlset') {
      expect(seriousEats.urls.length).toBeGreaterThan(10_000);
      expect(seriousEats.urls.every((u) => u.publishedAt !== undefined)).toBe(true);
    }
  });

  it("does not mistake GypsyPlate's HTML feed response for a feed", () => {
    // `/feed/` 302s to the homepage. Silently treating that as an empty feed
    // would look identical to "the blog published nothing".
    expect(parseFeed(fixture('gypsyplate', 'feed-response.html'))).toEqual([]);
  });
});

// ── discoverSource, driven by a stub fetcher ────────────────────────────────

function stubFetcher(routes: Record<string, { status?: number; body?: string }>): PoliteFetcher {
  const fetchImpl = (async (input: string | URL | Request) => {
    const stub = routes[String(input)];
    if (stub === undefined) return new Response('missing', { status: 404 });
    return new Response(stub.body ?? '', { status: stub.status ?? 200 });
  }) as unknown as typeof fetch;
  return new PoliteFetcher({ fetchImpl, sleep: async () => undefined, minDelayMs: 1 });
}

const FEED = `<rss><channel>
  <item><title>New</title><link>https://blog.test/new/</link><pubDate>Sat, 25 Jul 2026 10:00:00 +0000</pubDate></item>
  <item><title>Old</title><link>https://blog.test/old/</link><pubDate>Mon, 01 Jan 2024 10:00:00 +0000</pubDate></item>
</channel></rss>`;

describe('discoverSource', () => {
  it('prefers the feed and does not touch the sitemap when it works', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
      'https://blog.test/feed/': { body: FEED },
    });

    const result = await discoverSource(fetcher, {
      feedUrl: 'https://blog.test/feed/',
      baseUrl: 'https://blog.test',
    });

    expect(result.via).toEqual(['feed']);
    expect(result.urls.map((u) => u.url)).toEqual([
      'https://blog.test/new/',
      'https://blog.test/old/',
    ]);
  });

  it('drops anything not newer than `since`', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
      'https://blog.test/feed/': { body: FEED },
    });

    const result = await discoverSource(
      fetcher,
      { feedUrl: 'https://blog.test/feed/', baseUrl: 'https://blog.test' },
      { since: new Date('2026-01-01T00:00:00Z') },
    );

    expect(result.urls.map((u) => u.url)).toEqual(['https://blog.test/new/']);
  });

  it('falls back to the sitemap when the feed 404s, following the index', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': {
        body: 'Sitemap: https://blog.test/sitemap_index.xml\nUser-agent: *\nDisallow:\n',
      },
      'https://blog.test/feed/': { status: 404 },
      'https://blog.test/sitemap_index.xml': {
        body: `<sitemapindex><sitemap><loc>https://blog.test/post-sitemap.xml</loc><lastmod>2026-07-01</lastmod></sitemap></sitemapindex>`,
      },
      'https://blog.test/post-sitemap.xml': {
        body: `<urlset><url><loc>https://blog.test/a/</loc><lastmod>2026-07-20</lastmod></url></urlset>`,
      },
    });

    const result = await discoverSource(fetcher, {
      feedUrl: 'https://blog.test/feed/',
      baseUrl: 'https://blog.test',
    });

    expect(result.via).toEqual(['sitemap']);
    expect(result.urls.map((u) => u.url)).toEqual(['https://blog.test/a/']);
    expect(result.warnings.some((w) => w.includes('feed'))).toBe(true);
  });

  it('skips child sitemaps whose lastmod predates the last scan', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
      'https://blog.test/sitemap_index.xml': {
        body: `<sitemapindex>
          <sitemap><loc>https://blog.test/old-sitemap.xml</loc><lastmod>2020-01-01</lastmod></sitemap>
        </sitemapindex>`,
      },
      'https://blog.test/old-sitemap.xml': {
        body: `<urlset><url><loc>https://blog.test/ancient/</loc></url></urlset>`,
      },
    });

    const result = await discoverSource(
      fetcher,
      { baseUrl: 'https://blog.test' },
      { since: new Date('2026-01-01T00:00:00Z') },
    );

    expect(result.urls).toEqual([]);
  });

  it('reports a 304 feed as unchanged and keeps the stored validators', async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith('robots.txt')
        ? new Response('User-agent: *\nDisallow:\n')
        : new Response(null, { status: 304 })) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({ fetchImpl, sleep: async () => undefined, minDelayMs: 1 });

    const result = await discoverSource(
      fetcher,
      { feedUrl: 'https://blog.test/feed/', baseUrl: 'https://blog.test' },
      { feedEtag: 'W/"kept"', includeSitemap: false },
    );

    expect(result.feedUnchanged).toBe(true);
    expect(result.feedEtag).toBe('W/"kept"');
  });

  it('does not fetch a feed robots.txt disallows', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': { body: 'User-agent: *\nDisallow: /feed/\n' },
      'https://blog.test/feed/': { body: FEED },
    });

    const result = await discoverSource(fetcher, {
      feedUrl: 'https://blog.test/feed/',
      baseUrl: 'https://blog.test',
    });

    expect(result.urls).toEqual([]);
    expect(result.warnings.some((w) => w.includes('robots'))).toBe(true);
  });

  it('applies the caller\'s URL filter', async () => {
    const fetcher = stubFetcher({
      'https://blog.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' },
      'https://blog.test/feed/': { body: FEED },
    });

    const result = await discoverSource(
      fetcher,
      { feedUrl: 'https://blog.test/feed/', baseUrl: 'https://blog.test' },
      { urlFilter: (url) => url.includes('/new/') },
    );

    expect(result.urls.map((u) => u.url)).toEqual(['https://blog.test/new/']);
  });
});

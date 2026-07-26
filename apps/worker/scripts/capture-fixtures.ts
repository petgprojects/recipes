/**
 * Capture test fixtures from the nine real sources (PROGRESS.md A3).
 *
 * Run manually, never in CI: `corepack pnpm --filter @recipes/worker capture`.
 * CI reads the committed output of this script and never touches the network.
 *
 * It is a coverage probe, not a crawl — at most `PAGES_PER_SITE` pages per
 * site, through the same `PoliteFetcher` the worker uses, so robots.txt and
 * the ≥1s crawl delay apply exactly as they do in production (PLAN.md §7).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetcher, type PoliteFetcher } from '../src/scanner/fetcher';
import { parseFeed, parseSitemap, type DiscoveredUrl } from '../src/scanner/discover';
import { isPathAllowed, parseRobotsTxt } from '../src/scanner/robots';

const PAGES_PER_SITE = 3;

interface SiteSpec {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Tried in order; the first that parses to ≥1 item wins. */
  readonly feedCandidates: string[];
  /** Sitemap roots, used when the site publishes no usable feed. */
  readonly sitemapCandidates?: string[];
  /** Keeps round-ups and category pages out of the sample. */
  readonly looksLikeRecipe?: (url: string) => boolean;
  /**
   * Extra permalinks captured after the discovered ones. Used where the feed
   * is dominated by round-up posts, so the sample still contains at least one
   * genuine single-recipe page — otherwise the coverage report would blame a
   * site for lacking Recipe JSON-LD on pages that are not recipes.
   */
  readonly extraPages?: string[];
}

const SITES: SiteSpec[] = [
  {
    slug: 'budget-bytes',
    name: 'Budget Bytes',
    baseUrl: 'https://www.budgetbytes.com',
    feedCandidates: ['https://www.budgetbytes.com/feed/'],
  },
  {
    slug: 'pinch-of-yum',
    name: 'Pinch of Yum',
    baseUrl: 'https://pinchofyum.com',
    feedCandidates: ['https://pinchofyum.com/feed', 'https://pinchofyum.com/feed/'],
  },
  {
    slug: 'downshiftology',
    name: 'Downshiftology',
    baseUrl: 'https://downshiftology.com',
    feedCandidates: ['https://downshiftology.com/feed/'],
    // Every item in the feed on capture day was a round-up ("What to cook in
    // July"), so two real permalinks are probed as well.
    extraPages: [
      'https://downshiftology.com/recipes/chicken-piccata/',
      'https://downshiftology.com/recipes/greek-baked-cod/',
    ],
  },
  {
    slug: 'gypsyplate',
    name: 'GypsyPlate',
    baseUrl: 'https://gypsyplate.com',
    feedCandidates: ['https://gypsyplate.com/feed/'],
    // `/feed/` 302s to the homepage and `/sitemap_index.xml` is 403 behind the
    // host's WAF, but plain `/sitemap.xml` serves a normal Yoast index.
    sitemapCandidates: ['https://gypsyplate.com/sitemap_index.xml', 'https://gypsyplate.com/sitemap.xml'],
    looksLikeRecipe: (url) => new URL(url).pathname.replace(/\/+$/, '').length > 1,
  },
  {
    slug: 'classpop',
    name: 'Classpop',
    baseUrl: 'https://www.classpop.com',
    // No feed exists anywhere on the host; the sitemap is the only discovery
    // surface, and even that leads to a magazine rather than to recipes.
    feedCandidates: [
      'https://www.classpop.com/magazine/feed',
      'https://www.classpop.com/feed',
      'https://www.classpop.com/blog/feed',
    ],
    sitemapCandidates: ['https://www.classpop.com/sitemap_files/magazine.xml'],
    looksLikeRecipe: (url) => /recipe|dinner|dessert|cake|cook|bake|lunch/i.test(url),
  },
  {
    slug: 'skinnytaste',
    name: 'Skinnytaste',
    baseUrl: 'https://www.skinnytaste.com',
    feedCandidates: ['https://www.skinnytaste.com/feed/'],
  },
  {
    slug: 'the-kitchn',
    name: 'The Kitchn',
    baseUrl: 'https://www.thekitchn.com',
    feedCandidates: ['https://www.thekitchn.com/main.rss', 'https://www.thekitchn.com/feed'],
  },
  {
    slug: 'love-and-lemons',
    name: 'Love & Lemons',
    baseUrl: 'https://www.loveandlemons.com',
    feedCandidates: ['https://www.loveandlemons.com/feed/'],
  },
  {
    slug: 'serious-eats',
    name: 'Serious Eats',
    baseUrl: 'https://www.seriouseats.com',
    feedCandidates: ['https://www.seriouseats.com/rss', 'https://www.seriouseats.com/feeds/all.rss'],
    sitemapCandidates: ['https://www.seriouseats.com/sitemap.xml'],
    // `…-recipe-<id>` is a single recipe; a bare `…-recipes-<id>` is a hub.
    looksLikeRecipe: (url) => /-recipe-\d+$/.test(url),
  },
];

interface PageRecord {
  file: string;
  url: string;
  finalUrl?: string;
  title?: string;
  publishedAt?: string;
  statusCode?: number;
  /** Bytes as served. */
  bytes?: number;
  /** Bytes actually committed, after inline JS/CSS bodies are emptied. */
  storedBytes?: number;
  /** True for a hand-picked permalink rather than a discovered URL. */
  probe?: boolean;
  error?: string;
}

interface Manifest {
  site: string;
  name: string;
  baseUrl: string;
  capturedAt: string;
  userAgent: string;
  feedUrl: string | null;
  feedFile: string | null;
  feedItems: number;
  feedError: string | null;
  sitemapUrl: string | null;
  sitemapFile: string | null;
  sitemapUrls: number;
  discoveredVia: 'feed' | 'sitemap' | 'none';
  robotsFile: string | null;
  robotsStatus: string;
  robotsCrawlDelayS: number | null;
  robotsDisallowedSample: string[];
  pages: PageRecord[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'test', 'fixtures');

async function main(): Promise<void> {
  const fetcher = createFetcher({ minDelayMs: 1_500, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });

  // `capture budget-bytes serious-eats` re-probes just those sites, so fixing
  // one source does not mean re-fetching all nine.
  const only = new Set(process.argv.slice(2));
  const selected = only.size === 0 ? SITES : SITES.filter((site) => only.has(site.slug));

  for (const site of selected) {
    const dir = join(fixturesDir, site.slug);
    await mkdir(dir, { recursive: true });
    process.stdout.write(`\n=== ${site.name}\n`);

    const manifest: Manifest = {
      site: site.slug,
      name: site.name,
      baseUrl: site.baseUrl,
      capturedAt: new Date().toISOString(),
      userAgent: fetcher.userAgent,
      feedUrl: null,
      feedFile: null,
      feedItems: 0,
      feedError: null,
      sitemapUrl: null,
      sitemapFile: null,
      sitemapUrls: 0,
      discoveredVia: 'none',
      robotsFile: null,
      robotsStatus: 'unknown',
      robotsCrawlDelayS: null,
      robotsDisallowedSample: [],
      pages: [],
    };

    // ── robots.txt, saved verbatim so the coverage report can cite it ──────
    const origin = new URL(site.baseUrl).origin;
    const robots = await fetcher.fetch(`${origin}/robots.txt`, { skipRobots: true });
    if (robots.outcome === 'ok') {
      await writeFile(join(dir, 'robots.txt'), robots.body, 'utf8');
      manifest.robotsFile = 'robots.txt';
      manifest.robotsStatus = `ok ${robots.statusCode}`;
      const parsed = parseRobotsTxt(robots.body);
      const group =
        parsed.groups.find((g) => g.agents.includes('*')) ?? parsed.groups[0] ?? null;
      manifest.robotsCrawlDelayS = group?.crawlDelaySeconds ?? null;
      manifest.robotsDisallowedSample =
        group?.rules.filter((r) => r.type === 'disallow').map((r) => r.pattern) ?? [];
    } else {
      manifest.robotsStatus = `${robots.outcome}: ${robots.outcome === 'error' ? robots.message : ''}`;
    }
    process.stdout.write(`  robots: ${manifest.robotsStatus}\n`);

    // ── feed ───────────────────────────────────────────────────────────────
    let items: { url: string; title?: string; publishedAt?: Date }[] = [];
    for (const candidate of site.feedCandidates) {
      const result = await fetcher.fetch(candidate, {
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      });
      if (result.outcome !== 'ok') {
        manifest.feedError = `${candidate}: ${result.outcome === 'error' ? `${result.reason} ${result.message}` : result.outcome}`;
        process.stdout.write(`  feed ${candidate}: ${manifest.feedError}\n`);
        continue;
      }
      const parsed = parseFeed(result.body, site.baseUrl);
      process.stdout.write(`  feed ${candidate}: ${parsed.length} items\n`);
      if (parsed.length === 0) {
        manifest.feedError = `${candidate}: HTTP ${result.statusCode} but parsed to zero items`;
        // Keep the evidence: a 200 that is not a feed is usually a WAF
        // interstitial, and "the feed is empty" would be the wrong diagnosis.
        await writeFile(join(dir, 'feed-response.html'), stripInlineAssets(result.body), 'utf8');
        continue;
      }
      await writeFile(join(dir, 'feed.xml'), result.body, 'utf8');
      manifest.feedUrl = candidate;
      manifest.feedFile = 'feed.xml';
      manifest.feedItems = parsed.length;
      manifest.feedError = null;
      items = parsed.map((item) => ({
        url: item.url,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
      }));
      manifest.discoveredVia = 'feed';
      break;
    }

    // ── sitemap fallback ───────────────────────────────────────────────────
    if (items.length === 0 && site.sitemapCandidates) {
      for (const candidate of site.sitemapCandidates) {
        const found = await captureSitemap(fetcher, candidate, dir, manifest);
        if (found.length > 0) {
          items = found;
          manifest.discoveredVia = 'sitemap';
          break;
        }
      }
    }

    // ── pages ──────────────────────────────────────────────────────────────
    const candidates: { url: string; title?: string; publishedAt?: Date; probe?: boolean }[] = [
      ...items.filter((item) => site.looksLikeRecipe?.(item.url) ?? true).slice(0, PAGES_PER_SITE),
      ...(site.extraPages ?? []).map((url) => ({ url, probe: true })),
    ];
    let saved = 0;
    for (const item of candidates) {
      const record: PageRecord = {
        file: `page-${saved + 1}.html`,
        url: item.url,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt.toISOString() } : {}),
        ...(item.probe === true ? { probe: true } : {}),
      };

      const page = await fetcher.fetch(item.url);
      if (page.outcome !== 'ok') {
        record.error = page.outcome === 'error' ? `${page.reason}: ${page.message}` : page.outcome;
        manifest.pages.push(record);
        process.stdout.write(`  page ${item.url}: ${record.error}\n`);
        continue;
      }

      const stored = stripInlineAssets(page.body);
      await writeFile(join(dir, record.file), stored, 'utf8');
      record.finalUrl = page.finalUrl;
      record.statusCode = page.statusCode;
      record.bytes = page.bytes;
      record.storedBytes = Buffer.byteLength(stored);
      manifest.pages.push(record);
      saved += 1;
      process.stdout.write(
        `  page ${item.url}: ${page.bytes} bytes (${record.storedBytes} stored) -> ${record.file}\n`,
      );
    }

    // A robots-blocked path is a finding worth recording explicitly.
    if (robots.outcome === 'ok' && items.length > 0) {
      const parsed = parseRobotsTxt(robots.body);
      const blocked = items.filter((item) => !isPathAllowed(parsed, fetcher.userAgent, item.url));
      if (blocked.length > 0) {
        process.stdout.write(`  robots blocked ${blocked.length} feed URLs\n`);
      }
    }

    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

/**
 * Follow one sitemap (index or urlset) and save it next to the pages.
 *
 * Only one level of index is followed — this is a fixture probe, not the
 * production crawl, and `discoverSource()` owns the real traversal.
 */
async function captureSitemap(
  fetcher: PoliteFetcher,
  url: string,
  dir: string,
  manifest: Manifest,
): Promise<DiscoveredUrl[]> {
  const result = await fetcher.fetch(url, { accept: 'application/xml, text/xml;q=0.9, */*;q=0.8' });
  if (result.outcome !== 'ok') {
    process.stdout.write(
      `  sitemap ${url}: ${result.outcome === 'error' ? `${result.reason} ${result.message}` : result.outcome}\n`,
    );
    return [];
  }

  const doc = parseSitemap(result.body, url);
  if (doc.kind === 'index') {
    process.stdout.write(`  sitemap ${url}: index with ${doc.sitemaps.length} children\n`);
    const first = doc.sitemaps[0];
    return first ? captureSitemap(fetcher, first.url, dir, manifest) : [];
  }
  if (doc.kind !== 'urlset') {
    process.stdout.write(`  sitemap ${url}: unrecognised document\n`);
    return [];
  }

  await writeFile(join(dir, 'sitemap.xml'), result.body, 'utf8');
  manifest.sitemapUrl = url;
  manifest.sitemapFile = 'sitemap.xml';
  manifest.sitemapUrls = doc.urls.length;
  process.stdout.write(`  sitemap ${url}: ${doc.urls.length} urls\n`);
  return doc.urls;
}

/**
 * Empty the bodies of inline `<script>` (except JSON-LD) and `<style>`.
 *
 * The fixtures are committed and read by CI forever, and inline ad/analytics
 * bundles are two thirds of a modern recipe page's bytes while being provably
 * irrelevant to extraction — the JSON-LD blocks and the entire document
 * structure are preserved byte-for-byte. `manifest.json` records both the
 * as-served and the stored size so the trimming is visible, not hidden.
 */
export function stripInlineAssets(html: string): string {
  return html
    .replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs: string) =>
      /ld\+json/i.test(attrs) ? match : `<script${attrs}></script>`,
    )
    .replace(/<style([^>]*)>[\s\S]*?<\/style>/gi, (_match, attrs: string) => `<style${attrs}></style>`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

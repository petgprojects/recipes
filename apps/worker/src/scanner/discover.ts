/**
 * Discovery: "what has this source published?" (PLAN.md §1, §5 Phase 1).
 *
 * Two mechanisms, cheapest first:
 *
 * 1. **RSS / Atom.** Every site in the source list publishes one, it is small,
 *    and it carries a publication date and title for free.
 * 2. **Sitemaps.** The fallback when a feed is missing, truncated (most feeds
 *    hold only the last 10–20 posts) or when backfilling. Sitemap *index*
 *    files are followed one level, and `lastmod` lets us skip everything older
 *    than the last scan without fetching a single page.
 *
 * The parsers are pure `string → DiscoveredUrl[]`; only `discoverSource()`
 * touches the network, and it does so exclusively through `PoliteFetcher`, so
 * robots.txt and the crawl delay apply to discovery as well as to pages.
 */

import { XMLParser } from 'fast-xml-parser';
import type { PoliteFetcher } from './fetcher';
import { absoluteUrl, cleanTextOrNull } from './text';

export interface DiscoveredUrl {
  readonly url: string;
  readonly publishedAt?: Date;
  readonly title?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  // Namespace prefixes vary (`atom:link`, `dc:date`); stripping them means one
  // code path instead of one per feed generator.
  removeNSPrefix: true,
  processEntities: true,
  // A feed with one <item> must still parse as a list.
  isArray: (name) => ['item', 'entry', 'url', 'sitemap', 'link'].includes(name),
});

/** Parse XML defensively — a truncated or HTML-error-page body returns null. */
function parseXml(xml: string): Record<string, unknown> | null {
  try {
    const parsed = parser.parse(xml) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── Feeds ───────────────────────────────────────────────────────────────────

/**
 * Parse an RSS 2.0 or Atom feed into candidate URLs.
 *
 * RSS puts the URL in `<link>` as text; Atom puts it in `<link href>` and can
 * carry several links per entry, of which only `rel="alternate"` (or no `rel`)
 * is the post itself. Getting that wrong silently discovers the feed's own
 * self-link instead of the article, on every Atom source.
 */
export function parseFeed(xml: string, baseUrl?: string): DiscoveredUrl[] {
  const doc = parseXml(xml);
  if (doc === null) return [];

  const channel = asRecord(asRecord(doc['rss'])?.['channel']) ?? asRecord(doc['channel']);
  const feed = asRecord(doc['feed']);

  const items = [...asArray(channel?.['item']), ...asArray(feed?.['entry']), ...asArray(doc['item'])];

  const out: DiscoveredUrl[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (item === null) continue;

    const url = absoluteUrl(feedItemLink(item), baseUrl);
    if (url === null) continue;

    const title = cleanTextOrNull(textOf(item['title']));
    const publishedAt = firstDate([
      item['pubDate'],
      item['published'],
      item['date'],
      item['updated'],
      item['modified'],
    ]);

    out.push({
      url,
      ...(publishedAt !== null ? { publishedAt } : {}),
      ...(title !== null ? { title } : {}),
    });
  }

  return dedupeByUrl(out);
}

function feedItemLink(item: Record<string, unknown>): string | null {
  // Atom: <link rel="alternate" href="…"/>, possibly several.
  const links = asArray(item['link']);
  let fallback: string | null = null;
  for (const raw of links) {
    if (typeof raw === 'string') {
      if (raw.trim().length > 0) return raw;
      continue;
    }
    const link = asRecord(raw);
    if (link === null) continue;
    const href = typeof link['@_href'] === 'string' ? link['@_href'] : textOf(link['#text']);
    if (href === null || href.trim().length === 0) continue;
    const rel = typeof link['@_rel'] === 'string' ? link['@_rel'] : null;
    if (rel === null || rel === 'alternate') return href;
    fallback ??= href;
  }
  // RSS 2.0 fallbacks: <guid isPermaLink="true">, then <id> (Atom).
  const guid = item['guid'];
  const guidText = typeof guid === 'string' ? guid : textOf(asRecord(guid)?.['#text']);
  const guidIsPermalink = asRecord(guid)?.['@_isPermaLink'] !== 'false';
  if (guidText !== null && guidIsPermalink && /^https?:\/\//i.test(guidText)) return guidText;

  const id = textOf(item['id']);
  if (id !== null && /^https?:\/\//i.test(id)) return id;

  return fallback;
}

// ── Sitemaps ────────────────────────────────────────────────────────────────

export interface SitemapEntry {
  readonly url: string;
  readonly lastmod?: Date;
}

export type SitemapDocument =
  | { readonly kind: 'index'; readonly sitemaps: SitemapEntry[] }
  | { readonly kind: 'urlset'; readonly urls: DiscoveredUrl[] }
  | { readonly kind: 'unknown' };

/** Parse either a `<sitemapindex>` or a `<urlset>`. */
export function parseSitemap(xml: string, baseUrl?: string): SitemapDocument {
  const doc = parseXml(xml);
  if (doc === null) return { kind: 'unknown' };

  const index = asRecord(doc['sitemapindex']);
  if (index !== null) {
    const sitemaps: SitemapEntry[] = [];
    for (const raw of asArray(index['sitemap'])) {
      const entry = asRecord(raw);
      const url = absoluteUrl(textOf(entry?.['loc']), baseUrl);
      if (url === null) continue;
      const lastmod = firstDate([entry?.['lastmod']]);
      sitemaps.push({ url, ...(lastmod !== null ? { lastmod } : {}) });
    }
    return { kind: 'index', sitemaps };
  }

  const urlset = asRecord(doc['urlset']);
  if (urlset !== null) {
    const urls: DiscoveredUrl[] = [];
    for (const raw of asArray(urlset['url'])) {
      const entry = asRecord(raw);
      const url = absoluteUrl(textOf(entry?.['loc']), baseUrl);
      if (url === null) continue;
      const publishedAt = firstDate([entry?.['lastmod'], asRecord(entry?.['news'])?.['publication_date']]);
      urls.push({ url, ...(publishedAt !== null ? { publishedAt } : {}) });
    }
    return { kind: 'urlset', urls: dedupeByUrl(urls) };
  }

  return { kind: 'unknown' };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface DiscoverSource {
  /** `sources.feed_url`. Tried first when present. */
  readonly feedUrl?: string | null;
  /** `sources.base_url`. Used for sitemap fallback and URL resolution. */
  readonly baseUrl: string;
  /** Source-specific sitemap roots to try before robots/conventional guesses. */
  readonly sitemapUrls?: readonly string[];
  /** `sources.crawl_delay_s` in ms, if the source overrides it. */
  readonly crawlDelayMs?: number | null;
}

export interface DiscoverOptions {
  /** Skip anything published/modified at or before this (`last_scanned_at`). */
  readonly since?: Date | null;
  /** Hard cap on returned URLs. */
  readonly limit?: number;
  /** Sitemap index children to follow. Recipe sites publish dozens. */
  readonly maxSitemaps?: number;
  /** Force the sitemap path even when a feed produced results. */
  readonly includeSitemap?: boolean;
  /** Keep only URLs that look like recipe pages. */
  readonly urlFilter?: (url: string) => boolean;
  /** Stored ETag for the feed, enabling a conditional GET. */
  readonly feedEtag?: string | null;
  readonly feedLastModified?: string | null;
}

export interface DiscoverResult {
  readonly urls: DiscoveredUrl[];
  /** Which mechanisms actually produced anything. */
  readonly via: ('feed' | 'sitemap')[];
  /** `true` when the feed answered `304` — nothing new, and nearly free. */
  readonly feedUnchanged: boolean;
  /** New validators to persist for the next conditional GET. */
  readonly feedEtag: string | null;
  readonly feedLastModified: string | null;
  /** Non-fatal problems worth surfacing in `scan_runs.error`. */
  readonly warnings: string[];
}

/**
 * Discover candidate recipe URLs for one source.
 *
 * Feed first (small, dated, cheap). Sitemaps only if the feed produced nothing
 * or `includeSitemap` is set, because a sitemap fetch is 10–100× the bytes.
 */
export async function discoverSource(
  fetcher: PoliteFetcher,
  source: DiscoverSource,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const {
    since = null,
    limit = 200,
    maxSitemaps = 5,
    includeSitemap = false,
    urlFilter,
    feedEtag = null,
    feedLastModified = null,
  } = options;

  const warnings: string[] = [];
  const via: ('feed' | 'sitemap')[] = [];
  let collected: DiscoveredUrl[] = [];
  let feedUnchanged = false;
  let newEtag: string | null = null;
  let newLastModified: string | null = null;

  if (source.feedUrl) {
    const result = await fetcher.fetch(source.feedUrl, {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      etag: feedEtag,
      lastModified: feedLastModified,
      crawlDelayMs: source.crawlDelayMs ?? null,
    });

    if (result.outcome === 'ok') {
      newEtag = result.etag;
      newLastModified = result.lastModified;
      const parsedItems = parseFeed(result.body, source.baseUrl);
      const items = urlFilter
        ? parsedItems.filter((item) => urlFilter(item.url))
        : parsedItems;
      if (parsedItems.length === 0) {
        warnings.push(`feed ${source.feedUrl} parsed to zero items`);
      } else if (items.length === 0) {
        warnings.push(`feed ${source.feedUrl} contained no candidate recipe URLs`);
      } else {
        via.push('feed');
      }
      collected = collected.concat(items);
    } else if (result.outcome === 'notModified') {
      feedUnchanged = true;
      newEtag = result.etag ?? feedEtag;
      newLastModified = result.lastModified ?? feedLastModified;
    } else {
      warnings.push(`feed ${source.feedUrl}: ${result.reason} ${result.message}`);
    }
  }

  // A 304 is a successful answer: the feed has not changed. Falling through
  // to several sitemap requests here would defeat the conditional GET's main
  // benefit on every routine scan. `includeSitemap` remains the explicit
  // backfill escape hatch.
  if (includeSitemap || (collected.length === 0 && !feedUnchanged)) {
    const fromSitemap = await discoverViaSitemap(fetcher, source, { since, maxSitemaps, warnings });
    if (fromSitemap.length > 0) via.push('sitemap');
    collected = collected.concat(fromSitemap);
  }

  const filtered = dedupeByUrl(collected)
    .filter((item) => (urlFilter ? urlFilter(item.url) : true))
    .filter((item) => (since === null || item.publishedAt === undefined ? true : item.publishedAt > since))
    .sort(byPublishedDesc)
    .slice(0, limit);

  return {
    urls: filtered,
    via,
    feedUnchanged,
    feedEtag: newEtag,
    feedLastModified: newLastModified,
    warnings,
  };
}

async function discoverViaSitemap(
  fetcher: PoliteFetcher,
  source: DiscoverSource,
  context: { since: Date | null; maxSitemaps: number; warnings: string[] },
): Promise<DiscoveredUrl[]> {
  const origin = originOf(source.baseUrl);
  if (origin === null) return [];

  // robots.txt is the authoritative list of a site's sitemaps; `/sitemap.xml`
  // and `/sitemap_index.xml` are the conventional fallbacks.
  const advertised = await fetcher.sitemapsFor(origin).catch(() => []);
  const roots = dedupe([
    ...(source.sitemapUrls ?? []),
    ...advertised,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap.xml`,
  ]);

  const out: DiscoveredUrl[] = [];
  const queue = [...roots];
  let followed = 0;
  const visited = new Set<string>();

  while (queue.length > 0 && followed < context.maxSitemaps + roots.length) {
    const next = queue.shift();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);
    followed += 1;

    const result = await fetcher.fetch(next, {
      accept: 'application/xml, text/xml;q=0.9, */*;q=0.8',
      crawlDelayMs: source.crawlDelayMs ?? null,
    });
    if (result.outcome !== 'ok') {
      // A 404 on a guessed conventional path is expected, not a warning.
      if (!(result.outcome === 'error' && result.statusCode === 404)) {
        context.warnings.push(`sitemap ${next}: ${result.outcome === 'error' ? result.message : result.outcome}`);
      }
      continue;
    }

    const doc = parseSitemap(result.body, next);
    if (doc.kind === 'index') {
      const children = doc.sitemaps
        // `lastmod` on the index entry means "nothing inside changed since",
        // so an old child sitemap can be skipped without fetching it at all.
        .filter((entry) => context.since === null || entry.lastmod === undefined || entry.lastmod > context.since)
        .sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0))
        .slice(0, context.maxSitemaps)
        .map((entry) => entry.url);
      queue.push(...children);
      continue;
    }

    if (doc.kind === 'urlset') {
      out.push(
        ...doc.urls.filter(
          (entry) =>
            context.since === null || entry.publishedAt === undefined || entry.publishedAt > context.since,
        ),
      );
      // One good urlset from a conventional guess is enough; keep draining the
      // queue only while it holds index children.
      if (out.length > 0 && queue.length === 0) break;
    }
  }

  return dedupeByUrl(out);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function byPublishedDesc(a: DiscoveredUrl, b: DiscoveredUrl): number {
  return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
}

export function dedupeByUrl(items: DiscoveredUrl[]): DiscoveredUrl[] {
  const byUrl = new Map<string, { url: string; publishedAt?: Date; title?: string }>();
  for (const item of items) {
    const key = canonicalUrlKey(item.url);
    const existing = byUrl.get(key);
    if (existing === undefined) {
      byUrl.set(key, { ...item });
      continue;
    }
    // The same post can arrive from both the feed and the sitemap; merge so
    // whichever copy knows the title or the date wins.
    if (existing.publishedAt === undefined && item.publishedAt !== undefined) {
      existing.publishedAt = item.publishedAt;
    }
    if (existing.title === undefined && item.title !== undefined) existing.title = item.title;
  }
  return [...byUrl.values()];
}

/**
 * The dedupe key. Tracking parameters and a trailing slash are not a different
 * recipe, and `recipes.source_url` is a UNIQUE column (PLAN.md §4) — so the
 * same post arriving from both the feed and the sitemap must collapse here,
 * not become two rows.
 */
export function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|adt_ei$|ref$|source$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  const record = asRecord(value);
  if (record !== null) {
    const text = record['#text'];
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
  }
  return null;
}

function firstDate(values: unknown[]): Date | null {
  for (const value of values) {
    const text = textOf(value);
    if (text === null) continue;
    const parsed = new Date(text.trim());
    if (Number.isNaN(parsed.getTime())) continue;
    const year = parsed.getUTCFullYear();
    if (year < 1990 || year > 2100) continue;
    return parsed;
  }
  return null;
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

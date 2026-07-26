/**
 * The polite HTTP client (PLAN.md §7).
 *
 * Every requirement in §7 is enforced here rather than left to callers:
 *
 * - **robots.txt** is fetched once per origin, cached with a TTL, and honoured.
 *   A disallowed URL is never requested — it comes back as a cheap
 *   `error/robots` result.
 * - **Identification.** A real User-Agent with a contact URL, configurable.
 * - **Crawl delay** per origin, taking `Crawl-delay` from robots.txt when the
 *   site publishes one, with a ≥1s floor so we can never be configured into
 *   hammering anyone. Requests to the same origin are serialised.
 * - **Conditional GETs.** `If-None-Match` / `If-Modified-Since` from the
 *   stored ETag / Last-Modified, and `304` is a first-class cheap outcome.
 * - **Retry** with exponential backoff on 429 and 5xx only, honouring
 *   `Retry-After`, bounded by `maxAttempts`. A 4xx that is not 429 is
 *   permanent and is never retried.
 * - **Hard timeout** per attempt and a **cap on response body size**, both of
 *   which are the difference between "one bad page" and "the worker is stuck".
 *
 * Expected outcomes are returned, not thrown: the result is a discriminated
 * union of `ok` / `notModified` / `error`, because a 404 on one recipe is
 * normal operation for a crawler and should not unwind a scan.
 *
 * The class takes injectable `fetch`, `sleep`, `now` and `random` so the whole
 * thing is testable with zero network access (PLAN.md §5).
 */

import {
  EMPTY_ROBOTS,
  crawlDelayMsFor,
  isPathAllowed,
  parseRobotsTxt,
  type RobotsTxt,
} from './robots';

export const DEFAULT_USER_AGENT =
  'RecipePlannerBot/0.1 (+https://github.com/petergelgor/recipes)';

/** PLAN.md §7's "respect crawl delays", made un-overridable. */
export const MIN_CRAWL_DELAY_MS = 1_000;

export interface FetcherOptions {
  /** Must identify the crawler and carry a contact URL (PLAN.md §7). */
  userAgent?: string;
  /** Floor for the per-origin delay. Clamped to ≥ `MIN_CRAWL_DELAY_MS`. */
  minDelayMs?: number;
  /** Used when robots.txt publishes no `Crawl-delay`. */
  defaultDelayMs?: number;
  /** Upper bound on a robots.txt `Crawl-delay` we are willing to obey. */
  maxDelayMs?: number;
  /** Hard timeout per attempt, including reading the body. */
  timeoutMs?: number;
  /** Response bodies larger than this are abandoned mid-stream. */
  maxBytes?: number;
  /** Total attempts per URL, including the first. */
  maxAttempts?: number;
  /** Base for exponential backoff: `backoffBaseMs * 2 ** (attempt - 1)`. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** How long a parsed robots.txt stays cached. */
  robotsTtlMs?: number;
  /** Shorter TTL after a robots.txt fetch failed, so we recover quickly. */
  robotsErrorTtlMs?: number;
  /** Set false only for fixtures/offline replay — never for a live crawl. */
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter source; tests pin it to 0. */
  random?: () => number;
}

export interface FetchRequest {
  /** Stored `recipes`/`sources` ETag, sent as `If-None-Match`. */
  etag?: string | null;
  /** Stored Last-Modified, sent as `If-Modified-Since`. */
  lastModified?: string | null;
  accept?: string;
  /** Per-source override (e.g. `sources.crawl_delay_s`). Still floored. */
  crawlDelayMs?: number | null;
  /** Skip the robots.txt check for this one request (used to fetch robots). */
  skipRobots?: boolean;
  /** Per-request cap, clamped to the fetcher's configured maximum. */
  maxBytes?: number;
}

export interface FetchOk {
  readonly outcome: 'ok';
  readonly url: string;
  /** After redirects. `url !== finalUrl` means the source moved. */
  readonly finalUrl: string;
  readonly statusCode: number;
  readonly body: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly attempts: number;
  readonly fetchedAt: Date;
}

export interface FetchBytesOk extends Omit<FetchOk, 'body'> {
  readonly body: Buffer;
}

export interface FetchNotModified {
  readonly outcome: 'notModified';
  readonly url: string;
  readonly statusCode: 304;
  /** Servers may rotate the validator on a 304; persist it if they do. */
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly attempts: number;
  readonly fetchedAt: Date;
}

export type FetchErrorReason =
  | 'robots'
  | 'http'
  | 'timeout'
  | 'network'
  | 'too-large'
  | 'invalid-url';

export interface FetchError {
  readonly outcome: 'error';
  readonly url: string;
  readonly reason: FetchErrorReason;
  readonly statusCode: number | null;
  readonly message: string;
  readonly attempts: number;
  /** True when a later scan could plausibly succeed (5xx, 429, timeout). */
  readonly retryable: boolean;
}

export type FetchResult = FetchOk | FetchNotModified | FetchError;
export type FetchBytesResult = FetchBytesOk | FetchNotModified | FetchError;

interface RobotsCacheEntry {
  robots: RobotsTxt;
  expiresAt: number;
  /** True when robots.txt could not be read and we are failing closed. */
  failClosed: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 521, 522, 524]);

export class PoliteFetcher {
  readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly defaultDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly robotsTtlMs: number;
  private readonly robotsErrorTtlMs: number;
  private readonly respectRobots: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly robotsCache = new Map<string, RobotsCacheEntry>();
  private readonly robotsInflight = new Map<string, Promise<RobotsCacheEntry>>();
  /** Per-origin serialisation chain — the mechanism behind the crawl delay. */
  private readonly originQueue = new Map<string, Promise<unknown>>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: FetcherOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.minDelayMs = Math.max(MIN_CRAWL_DELAY_MS, options.minDelayMs ?? MIN_CRAWL_DELAY_MS);
    this.defaultDelayMs = Math.max(this.minDelayMs, options.defaultDelayMs ?? this.minDelayMs);
    this.maxDelayMs = Math.max(this.defaultDelayMs, options.maxDelayMs ?? 30_000);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.robotsTtlMs = options.robotsTtlMs ?? 12 * 60 * 60 * 1_000;
    this.robotsErrorTtlMs = options.robotsErrorTtlMs ?? 10 * 60 * 1_000;
    this.respectRobots = options.respectRobots ?? true;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Fetch one URL politely. Resolves to `ok`, `notModified` or `error`; the
   * only way this rejects is a bug in the fetcher itself.
   */
  async fetch(url: string, request: FetchRequest = {}): Promise<FetchResult> {
    const result = await this.fetchRaw(url, request);
    if (result.outcome !== 'ok') return result;
    return {
      ...result,
      body: decodeBuffer(result.body, charsetOf(result.contentType)),
    };
  }

  /**
   * Binary counterpart used for recipe images. It shares the same robots
   * checks, identification, per-origin queue, delays, retries, timeouts and
   * byte cap as HTML fetching; image bytes are never decoded through a string.
   */
  async fetchBytes(url: string, request: FetchRequest = {}): Promise<FetchBytesResult> {
    return this.fetchRaw(url, request);
  }

  private async fetchRaw(url: string, request: FetchRequest): Promise<FetchBytesResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return errorResult(url, 'invalid-url', null, `not a URL: ${url}`, 0, false);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return errorResult(url, 'invalid-url', null, `unsupported protocol ${parsed.protocol}`, 0, false);
    }

    const origin = parsed.origin;

    if (this.respectRobots && request.skipRobots !== true) {
      const entry = await this.robotsFor(origin);
      if (entry.failClosed) {
        return errorResult(
          url,
          'robots',
          null,
          `robots.txt for ${origin} could not be read; failing closed`,
          0,
          true,
        );
      }
      if (!isPathAllowed(entry.robots, this.userAgent, url)) {
        return errorResult(url, 'robots', null, `disallowed by ${origin}/robots.txt`, 0, false);
      }
    }

    const delayMs = await this.delayForOrigin(origin, request.crawlDelayMs);
    return this.enqueue(origin, delayMs, () => this.attemptRaw(url, request));
  }

  /** Is this URL crawlable? Exposed so discovery can filter before queueing. */
  async isAllowed(url: string): Promise<boolean> {
    if (!this.respectRobots) return true;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    const entry = await this.robotsFor(origin);
    if (entry.failClosed) return false;
    return isPathAllowed(entry.robots, this.userAgent, url);
  }

  /** The parsed robots.txt for an origin, fetched at most once per TTL. */
  async robotsFor(origin: string): Promise<RobotsCacheEntry> {
    const cached = this.robotsCache.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached;

    const inflight = this.robotsInflight.get(origin);
    if (inflight) return inflight;

    const promise = this.loadRobots(origin).finally(() => {
      this.robotsInflight.delete(origin);
    });
    this.robotsInflight.set(origin, promise);
    return promise;
  }

  /** Sitemap URLs advertised in robots.txt — free input for discovery. */
  async sitemapsFor(origin: string): Promise<string[]> {
    const entry = await this.robotsFor(origin);
    return entry.robots.sitemaps;
  }

  private async loadRobots(origin: string): Promise<RobotsCacheEntry> {
    const url = `${origin}/robots.txt`;
    // robots.txt itself is fetched with the same politeness (delay, timeout,
    // retries) but obviously without a robots check.
    const delayMs = await this.delayForOrigin(origin, null);
    const rawResult = await this.enqueue(origin, delayMs, () =>
      this.attemptRaw(url, { skipRobots: true, accept: 'text/plain,*/*;q=0.8' }),
    );
    const result: FetchResult =
      rawResult.outcome === 'ok'
        ? {
            ...rawResult,
            body: decodeBuffer(rawResult.body, charsetOf(rawResult.contentType)),
          }
        : rawResult;

    let entry: RobotsCacheEntry;
    if (result.outcome === 'ok') {
      entry = {
        robots: parseRobotsTxt(result.body),
        expiresAt: this.now() + this.robotsTtlMs,
        failClosed: false,
      };
    } else if (result.outcome === 'error' && result.statusCode !== null && result.statusCode >= 400 && result.statusCode < 500) {
      // 404 / 401 / 403 on robots.txt: RFC 9309 says "unavailable" means the
      // whole site is crawlable. This is the common case for small blogs.
      entry = { robots: EMPTY_ROBOTS, expiresAt: this.now() + this.robotsTtlMs, failClosed: false };
    } else {
      // 5xx or a network failure means "unreachable", which RFC 9309 says to
      // treat as a full disallow. Short TTL so a blip doesn't cost a day.
      entry = { robots: EMPTY_ROBOTS, expiresAt: this.now() + this.robotsErrorTtlMs, failClosed: true };
    }

    this.robotsCache.set(origin, entry);
    return entry;
  }

  /** The delay this origin must observe before its next request. */
  private async delayForOrigin(origin: string, override: number | null | undefined): Promise<number> {
    if (typeof override === 'number' && Number.isFinite(override)) {
      return clamp(override, this.minDelayMs, this.maxDelayMs);
    }
    if (this.respectRobots) {
      const cached = this.robotsCache.get(origin);
      // Only consult an already-cached robots.txt — asking for one here would
      // recurse, since fetching robots.txt itself needs a delay.
      if (cached && !cached.failClosed) {
        const published = crawlDelayMsFor(cached.robots, this.userAgent);
        if (published !== null) return clamp(published, this.minDelayMs, this.maxDelayMs);
      }
    }
    return this.defaultDelayMs;
  }

  /**
   * Serialise per origin and space requests out by `delayMs`. Two concurrent
   * `fetch()` calls to the same host queue behind each other; different hosts
   * proceed in parallel.
   */
  private enqueue<T>(origin: string, delayMs: number, task: () => Promise<T>): Promise<T> {
    const previous = this.originQueue.get(origin) ?? Promise.resolve();
    const run = previous.then(async () => {
      const last = this.lastRequestAt.get(origin);
      if (last !== undefined) {
        const wait = last + delayMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastRequestAt.set(origin, this.now());
      return task();
    });
    // Keep the chain alive regardless of failures.
    this.originQueue.set(
      origin,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** One URL, up to `maxAttempts` HTTP attempts with backoff between them. */
  private async attemptRaw(url: string, request: FetchRequest): Promise<FetchBytesResult> {
    let lastError: FetchError = errorResult(url, 'network', null, 'no attempt made', 0, true);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const outcome = await this.once(url, request, attempt);

      if (outcome.outcome !== 'error') return outcome;
      lastError = outcome;
      if (!outcome.retryable || attempt === this.maxAttempts) return outcome;

      const wait = this.backoffFor(attempt, outcome.retryAfterMs);
      await this.sleep(wait);
      this.lastRequestAt.set(originOf(url), this.now());
    }

    return lastError;
  }

  private backoffFor(attempt: number, retryAfterMs: number | null): number {
    const exponential = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
    const jittered = exponential * (0.5 + this.random() * 0.5);
    const base = Math.max(retryAfterMs ?? 0, jittered);
    return Math.min(Math.max(base, this.minDelayMs), this.backoffMaxMs);
  }

  private async once(
    url: string,
    request: FetchRequest,
    attempt: number,
  ): Promise<FetchBytesOk | FetchNotModified | (FetchError & { retryAfterMs: number | null })> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: request.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    };
    // Conditional GET — the cheapest possible re-scan (PLAN.md §7).
    if (request.etag) headers['if-none-match'] = request.etag;
    if (request.lastModified) headers['if-modified-since'] = request.lastModified;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });

      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');

      if (response.status === 304) {
        await discardBody(response);
        return {
          outcome: 'notModified',
          url,
          statusCode: 304,
          etag,
          lastModified,
          attempts: attempt,
          fetchedAt: new Date(this.now()),
        };
      }

      if (!response.ok) {
        await discardBody(response);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
        // Never retry a 4xx other than 429 — the answer will not change.
        const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
        return {
          ...errorResult(url, 'http', response.status, `HTTP ${response.status}`, attempt, retryable),
          retryAfterMs,
        };
      }

      const maxBytes = Math.min(
        this.maxBytes,
        typeof request.maxBytes === 'number' &&
          Number.isFinite(request.maxBytes) &&
          request.maxBytes > 0
          ? Math.floor(request.maxBytes)
          : this.maxBytes,
      );
      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        return {
          ...errorResult(
            url,
            'too-large',
            response.status,
            `content-length ${declared} exceeds ${maxBytes}`,
            attempt,
            false,
          ),
          retryAfterMs: null,
        };
      }

      const read = await readCapped(response, maxBytes);
      if (read === null) {
        return {
          ...errorResult(url, 'too-large', response.status, `body exceeds ${maxBytes} bytes`, attempt, false),
          retryAfterMs: null,
        };
      }

      return {
        outcome: 'ok',
        url,
        finalUrl: response.url || url,
        statusCode: response.status,
        body: read.buffer,
        etag,
        lastModified,
        contentType: response.headers.get('content-type'),
        bytes: read.bytes,
        attempts: attempt,
        fetchedAt: new Date(this.now()),
      };
    } catch (cause) {
      const aborted = controller.signal.aborted;
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ...errorResult(
          url,
          aborted ? 'timeout' : 'network',
          null,
          aborted ? `timed out after ${this.timeoutMs}ms` : message,
          attempt,
          true,
        ),
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createFetcher(options: FetcherOptions = {}): PoliteFetcher {
  return new PoliteFetcher(options);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function errorResult(
  url: string,
  reason: FetchErrorReason,
  statusCode: number | null,
  message: string,
  attempts: number,
  retryable: boolean,
): FetchError {
  return { outcome: 'error', url, reason, statusCode, message, attempts, retryable };
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear live. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/**
 * Read a body, giving up as soon as it exceeds `maxBytes`.
 *
 * `response.text()` would buffer the whole thing first, which is exactly the
 * failure mode the cap exists to prevent, so this streams instead.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; bytes: number } | null> {
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : { buffer, bytes: buffer.byteLength };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const buffer = Buffer.concat(chunks);
  return { buffer, bytes };
}

function charsetOf(contentType: string | null): string {
  const match = contentType?.match(/charset=["']?([\w-]+)/i);
  return (match?.[1] ?? 'utf-8').toLowerCase();
}

function decodeBuffer(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be consumed or absent; nothing to do.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

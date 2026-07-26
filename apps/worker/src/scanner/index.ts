/**
 * The Phase 1 discovery + extraction layer (PLAN.md §5).
 *
 * Everything exported here is a pure `input → output` function or a client
 * with injectable IO, so it can be pinned against the fixtures in
 * `test/fixtures/` without touching the network. Nothing in this directory
 * writes to the database or knows that pg-boss exists — the job wiring
 * consumes these.
 *
 * The usual path:
 *
 * ```ts
 * const fetcher = createFetcher();                      // robots + delays
 * const { urls } = await discoverSource(fetcher, source);
 * const page = await fetcher.fetch(urls[0].url, { etag });
 * if (page.outcome === 'ok') {
 *   const { recipe } = extractRecipeFromHtml(page.body, page.finalUrl);
 *   const draft = recipe && toRecipeDraft(recipe, page.finalUrl);
 * }
 * ```
 */

export * from './fetcher';
export * from './robots';
export * from './discover';
export * from './jsonld';
export {
  absoluteUrl,
  cleanText,
  cleanTextOrNull,
  collapseWhitespace,
  slugify,
  stableHash,
  stripHtml,
} from './text';

/**
 * schema.org/Recipe extraction from a page's JSON-LD (PLAN.md §1).
 *
 * This is the part of Phase 1 that either works or silently loses recipes, so
 * it is deliberately paranoid about shape. Real pages, all of which exist in
 * `test/fixtures/`, do all of the following:
 *
 * - one bare `{"@type": "Recipe"}` object;
 * - an array of top-level nodes, one of which is the Recipe;
 * - a Yoast/WordPress `@graph` wrapper with the Recipe several nodes in;
 * - `"@type": ["Recipe", "NewsArticle"]` — an array, not a string;
 * - `"@type": "http://schema.org/Recipe"` — the full IRI;
 * - instructions as a plain HTML string, as `HowToStep[]`, or as
 *   `HowToSection[]` whose `itemListElement` holds the actual steps;
 * - `image` as a string, an array, an `ImageObject`, or an array of those;
 * - `recipeYield` as `"6 servings"`, `"4-6"`, `6`, or `["6", "6 servings"]`;
 * - a JSON-LD block that simply does not parse.
 *
 * Nothing here throws and nothing here invents a value. A field the page did
 * not publish comes back `null` and is named in `missing`, which is what
 * routes a page to Phase 2's LLM extractor instead of quietly storing junk.
 */

import * as cheerio from 'cheerio';
import { absoluteUrl, cleanText, cleanTextOrNull, slugify, stableHash } from './text';

// ── Result types ────────────────────────────────────────────────────────────

export interface ExtractedInstruction {
  /** Section heading (`HowToSection.name`), or null for a flat step list. */
  readonly name: string | null;
  readonly text: string;
}

export interface ExtractedRating {
  readonly value: number | null;
  readonly count: number | null;
}

/**
 * The fields we track presence of. `keeps`, `tags` and `category` are absent
 * on purpose — schema.org has no shelf-life field at all (PLAN.md §1) and they
 * are *expected* to be null after Phase 1.
 */
export const TRACKED_FIELDS = [
  'title',
  'imageUrl',
  'servings',
  'totalMinutes',
  'activeMinutes',
  'ingredients',
  'instructions',
  'rating',
  'author',
  'publishedAt',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface ExtractedRecipe {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  /** Every image the page offered, in order, for the Phase 1 image pipeline. */
  readonly imageUrls: string[];
  readonly servings: number | null;
  /** The raw yield string (`"4-6 servings"`, `"1 loaf"`) kept verbatim. */
  readonly yieldText: string | null;
  readonly totalMinutes: number | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  /** Hands-on time. `prepTime` is the only deterministic proxy schema.org has. */
  readonly activeMinutes: number | null;
  readonly ingredients: string[];
  readonly instructions: ExtractedInstruction[];
  readonly rating: ExtractedRating | null;
  readonly author: string | null;
  readonly publishedAt: Date | null;
  /** Free-form source values; Phase 2 maps them onto our vocabularies. */
  readonly keywords: string[];
  readonly recipeCategory: string[];
  readonly recipeCuisine: string[];
  /** Verbatim node for `recipes.raw_jsonld` (PLAN.md §4). */
  readonly raw: Record<string, unknown>;
  /** SHA-256 over the extracted content — `recipes.content_hash`. */
  readonly contentHash: string;
  /** Which of `TRACKED_FIELDS` the page did not publish. */
  readonly missing: TrackedField[];
}

export interface JsonLdStats {
  /** `<script type="application/ld+json">` blocks in the document. */
  readonly blocks: number;
  /** Blocks whose contents could not be parsed as JSON, even after repair. */
  readonly malformed: number;
  /** JSON-LD nodes reachable after unwrapping arrays / `@graph` / nesting. */
  readonly nodes: number;
  /** Nodes whose `@type` includes `Recipe`. */
  readonly recipeNodes: number;
}

export interface ExtractionResult {
  readonly found: boolean;
  readonly recipe: ExtractedRecipe | null;
  readonly missing: TrackedField[];
  readonly stats: JsonLdStats;
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Extract a Recipe from a full HTML page.
 *
 * `pageUrl` is used only to resolve relative image URLs; extraction works
 * without it.
 */
export function extractRecipeFromHtml(html: string, pageUrl?: string): ExtractionResult {
  const blocks = collectJsonLdBlocks(html);
  const nodes = flattenNodes(blocks.values);
  const recipeNodes = nodes.filter(isRecipeNode);

  const stats: JsonLdStats = {
    blocks: blocks.total,
    malformed: blocks.malformed,
    nodes: nodes.length,
    recipeNodes: recipeNodes.length,
  };

  const best = pickBestRecipeNode(recipeNodes);
  if (best === null) {
    return { found: false, recipe: null, missing: [...TRACKED_FIELDS], stats };
  }

  const recipe = mapRecipeNode(best, pageUrl, buildRefIndex(nodes));
  return { found: true, recipe, missing: recipe.missing, stats };
}

/**
 * Parse every `<script type="application/ld+json">` block in a document.
 *
 * Exported because "how many blocks did this page have and how many were
 * broken" is exactly the number the coverage report needs.
 */
export function collectJsonLdBlocks(html: string): {
  total: number;
  malformed: number;
  values: unknown[];
} {
  const $ = cheerio.load(html);
  const values: unknown[] = [];
  let total = 0;
  let malformed = 0;

  $('script').each((_, element) => {
    const type = ($(element).attr('type') ?? '').toLowerCase();
    if (!type.includes('ld+json')) return;
    total += 1;
    const raw = $(element).text();
    const parsed = parseJsonLoosely(raw);
    if (parsed === undefined) {
      malformed += 1;
      return;
    }
    values.push(parsed);
  });

  return { total, malformed, values };
}

/**
 * `JSON.parse`, then one repair attempt.
 *
 * The repairs cover what recipe plugins actually emit: CDATA guards left over
 * from XHTML-era templates, HTML comment wrappers, a UTF-8 BOM, and raw
 * control characters where a theme interpolated a multi-line excerpt straight
 * into a JSON string. Anything still broken is reported, never guessed at.
 */
export function parseJsonLoosely(raw: string): unknown {
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  const direct = attempt(raw);
  if (direct !== undefined) return direct;

  const repaired = raw
    .replace(/^\ufeff/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/\/\*\s*<!\[CDATA\[\s*\*\//g, '')
    .replace(/\/\*\s*\]\]>\s*\*\//g, '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    // Control characters are illegal inside JSON strings; newlines inside a
    // description are the single most common cause of an unparseable block.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/(?<!\\)\\'/g, "'")
    .trim();

  const withoutRawNewlines = repairNewlinesInStrings(repaired);
  return attempt(withoutRawNewlines) ?? attempt(repaired);
}

/** Escape literal newlines that appear *inside* JSON string literals. */
function repairNewlinesInStrings(text: string): string {
  let inString = false;
  let escaped = false;
  let out = '';
  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && (char === '\n' || char === '\r')) {
      out += '\\n';
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Walk parsed JSON-LD into a flat list of nodes.
 *
 * Handles arrays, `@graph`, and the `mainEntity` / `mainEntityOfPage` /
 * `itemListElement` nesting that WordPress SEO plugins produce. Bounded in
 * depth and count so a pathological page cannot spin.
 */
export function flattenNodes(values: unknown[], maxNodes = 5_000, maxDepth = 12): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown, depth: number): void => {
    if (out.length >= maxNodes || depth > maxDepth || value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    const node = value as Record<string, unknown>;
    out.push(node);

    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart', 'about']) {
      if (key in node) walk(node[key], depth + 1);
    }
  };

  for (const value of values) walk(value, 0);
  return out;
}

/** Does this node's `@type` include `Recipe`? */
export function isRecipeNode(node: Record<string, unknown>): boolean {
  return typeOf(node).includes('recipe');
}

/**
 * `@type` normalised to a lower-case list with any IRI prefix removed, so
 * `"Recipe"`, `["Recipe","NewsArticle"]` and `"http://schema.org/Recipe"` are
 * all the same thing.
 */
export function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'] ?? node['type'];
  return asArray(raw)
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().replace(/^.*[/#]/, '').toLowerCase());
}

/**
 * When a page carries several Recipe nodes (a round-up post, or a plugin that
 * emits both a summary and a full node), prefer the most complete one rather
 * than the first — the first is usually the stub.
 */
export function pickBestRecipeNode(nodes: Record<string, unknown>[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const node of nodes) {
    const score =
      asArray(node['recipeIngredient'] ?? node['ingredients']).length * 2 +
      asArray(node['recipeInstructions']).length +
      (node['name'] ? 1 : 0);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

// ── `@id` references ────────────────────────────────────────────────────────

/** `@id` → node, for resolving references within a JSON-LD graph. */
export type RefIndex = ReadonlyMap<string, Record<string, unknown>>;

/**
 * Index every node that declares an `@id`.
 *
 * This matters more than it sounds. Yoast + WP Recipe Maker — which is what
 * Budget Bytes, Skinnytaste and most of the corpus run — emit
 * `"author": {"@id": "https://site/#/schema/person/ab12…"}` and put the actual
 * `Person` node with the name elsewhere in the same `@graph`. A reader that
 * only looks inside the Recipe node reports "no author" on sites that clearly
 * publish one. Ours did, until this index existed.
 */
export function buildRefIndex(nodes: Record<string, unknown>[]): RefIndex {
  const index = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = node['@id'];
    // Only index nodes that carry content; a bare `{"@id": …}` stub is the
    // reference itself, not the target.
    if (typeof id === 'string' && id.length > 0 && Object.keys(node).length > 1 && !index.has(id)) {
      index.set(id, node);
    }
  }
  return index;
}

/** Follow a `{"@id": …}` reference, if it resolves to a richer node. */
function deref(value: unknown, refs: RefIndex | undefined): unknown {
  if (refs === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const node = value as Record<string, unknown>;
  const id = node['@id'];
  if (typeof id !== 'string') return value;
  const target = refs.get(id);
  return target !== undefined && target !== node ? target : value;
}

// ── Mapping schema.org → our shape ──────────────────────────────────────────

export function mapRecipeNode(
  node: Record<string, unknown>,
  pageUrl?: string,
  refs?: RefIndex,
): ExtractedRecipe {
  const title = truncate(cleanTextOrNull(node['name'] ?? node['headline']), 300);
  const imageUrls = extractImages(node['image'], pageUrl, refs);
  const yieldValue = node['recipeYield'] ?? node['yield'];
  const parsedYield = parseYield(yieldValue);

  const totalMinutes = parseDurationMinutes(node['totalTime']);
  const prepMinutes = parseDurationMinutes(node['prepTime']);
  const cookMinutes = parseDurationMinutes(node['cookTime']) ?? parseDurationMinutes(node['performTime']);

  const ingredients = asArray(node['recipeIngredient'] ?? node['ingredients'])
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0);

  const instructions = extractInstructions(node['recipeInstructions']);
  const rating = extractRating(node['aggregateRating'], refs);
  const author = extractAuthor(node['author'] ?? node['creator'], refs);
  const publishedAt = parseDate(node['datePublished'] ?? node['dateCreated'] ?? node['uploadDate']);

  // `totalTime` is missing surprisingly often on sites that publish prep+cook.
  // Summing them is arithmetic on published values, not invention; the fields
  // it is derived from stay available separately.
  const derivedTotal =
    totalMinutes ??
    (prepMinutes !== null || cookMinutes !== null ? (prepMinutes ?? 0) + (cookMinutes ?? 0) : null);

  const recipe = {
    title,
    description: truncate(cleanTextOrNull(node['description']), 2_000),
    imageUrl: imageUrls[0] ?? null,
    imageUrls,
    servings: parsedYield.servings,
    yieldText: parsedYield.text,
    totalMinutes: derivedTotal,
    prepMinutes,
    cookMinutes,
    activeMinutes: prepMinutes,
    ingredients,
    instructions,
    rating,
    author,
    publishedAt,
    keywords: splitList(node['keywords']),
    recipeCategory: splitList(node['recipeCategory']),
    recipeCuisine: splitList(node['recipeCuisine']),
    raw: node,
  } satisfies Omit<ExtractedRecipe, 'contentHash' | 'missing'>;

  return {
    ...recipe,
    contentHash: computeContentHash(recipe),
    missing: missingFields(recipe),
  };
}

type RecipeCore = Omit<ExtractedRecipe, 'contentHash' | 'missing'>;

function missingFields(recipe: RecipeCore): TrackedField[] {
  const missing: TrackedField[] = [];
  if (recipe.title === null) missing.push('title');
  if (recipe.imageUrl === null) missing.push('imageUrl');
  if (recipe.servings === null) missing.push('servings');
  if (recipe.totalMinutes === null) missing.push('totalMinutes');
  if (recipe.activeMinutes === null) missing.push('activeMinutes');
  if (recipe.ingredients.length === 0) missing.push('ingredients');
  if (recipe.instructions.length === 0) missing.push('instructions');
  if (recipe.rating === null || recipe.rating.value === null) missing.push('rating');
  if (recipe.author === null) missing.push('author');
  if (recipe.publishedAt === null) missing.push('publishedAt');
  return missing;
}

/**
 * `recipes.content_hash` — hashes the *extracted* content, not the raw block.
 *
 * Hashing the raw JSON-LD would churn on every deploy of the source's SEO
 * plugin (`dateModified`, a new `@id`, a reordered key). Hashing what we
 * actually store means the hash changes when the recipe changes.
 */
export function computeContentHash(recipe: RecipeCore): string {
  return stableHash({
    title: recipe.title,
    servings: recipe.servings,
    totalMinutes: recipe.totalMinutes,
    activeMinutes: recipe.activeMinutes,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions.map((step) => step.text),
    imageUrl: recipe.imageUrl,
  });
}

// ── Field parsers (individually exported: they are the unit-test surface) ───

/**
 * ISO-8601 duration → whole minutes.
 *
 * Accepts what schema.org specifies (`PT1H30M`, `P0DT35M`, fractional units,
 * `P1W`) plus the two non-conforming forms that show up constantly in the
 * wild: a bare number of minutes (`"45"`, `45`) and an English phrase
 * (`"1 hour 20 minutes"`). Returns `null` for anything else — including
 * `"PT0S"`, because a zero-minute recipe is missing data, not a fast recipe.
 *
 * Months and years are approximated (30 / 365 days). They never legitimately
 * appear on a recipe; supporting them only stops a typo becoming a crash.
 */
export function parseDurationMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseDurationMinutes(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value === 'object') {
    // Some plugins emit `{"@type":"Duration","value":"PT30M"}`.
    const record = value as Record<string, unknown>;
    return parseDurationMinutes(record['value'] ?? record['@value'] ?? record['duration']);
  }
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text.length === 0) return null;

  const iso =
    /^(-)?P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i.exec(
      text,
    );
  if (iso) {
    const [, sign, years, months, weeks, days, hours, minutes, seconds] = iso;
    if (sign === '-') return null;
    const total =
      num(years) * 365 * 24 * 60 +
      num(months) * 30 * 24 * 60 +
      num(weeks) * 7 * 24 * 60 +
      num(days) * 24 * 60 +
      num(hours) * 60 +
      num(minutes) +
      num(seconds) / 60;
    const rounded = Math.round(total);
    return rounded > 0 ? rounded : null;
  }

  if (/^\d+$/.test(text)) {
    const minutes = Number.parseInt(text, 10);
    return minutes > 0 ? minutes : null;
  }

  // "1 hour 20 mins", "45 minutes", "1 hr"
  const phrase = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(phrase)) {
    const amount = Number.parseFloat(match[1] ?? '');
    const unit = (match[2] ?? '').toLowerCase();
    if (!Number.isFinite(amount)) continue;
    matched = true;
    total += unit.startsWith('h') ? amount * 60 : amount;
  }
  if (!matched) return null;
  const rounded = Math.round(total);
  return rounded > 0 ? rounded : null;
}

function num(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface ParsedYield {
  /** Servings as an integer, or null when the yield isn't a serving count. */
  readonly servings: number | null;
  /** The human string, kept because "1 loaf" is information we can't type. */
  readonly text: string | null;
}

/**
 * `recipeYield` → servings.
 *
 * Real values: `"6 servings"`, `6`, `"4-6"`, `"Serves 4 to 6"`, `"12 muffins"`,
 * `"1 loaf"`, `["6", "6 servings"]`, `"about 4 1/2 cups"`.
 *
 * A range takes the **lower** bound: under-buying groceries for a recipe you
 * are batch-cooking is the recoverable failure. A yield with no number, or a
 * unit that clearly isn't a portion count (`cups`, `quarts`), yields `null`
 * servings while keeping the text — Phase 2 can look at it, and a wrong
 * `servings` silently corrupts every grocery quantity downstream.
 */
export function parseYield(value: unknown): ParsedYield {
  if (value === null || value === undefined) return { servings: null, text: null };

  if (Array.isArray(value)) {
    // Prefer the entry that parses to a number; keep the longest as the text.
    const parsed = value.map((item) => parseYield(item));
    const withServings = parsed.find((p) => p.servings !== null);
    const text =
      parsed
        .map((p) => p.text)
        .filter((t): t is string => t !== null)
        .sort((a, b) => b.length - a.length)[0] ?? null;
    return { servings: withServings?.servings ?? null, text };
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0
      ? { servings: Math.round(value), text: String(Math.round(value)) }
      : { servings: null, text: null };
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return parseYield(record['value'] ?? record['@value'] ?? record['name']);
  }

  if (typeof value !== 'string') return { servings: null, text: null };

  const text = cleanTextOrNull(value);
  if (text === null) return { servings: null, text: null };

  // A volume/weight yield is not a serving count.
  if (/\b(cups?|quarts?|pints?|gallons?|litres?|liters?|ml|ounces?|oz|pounds?|lbs?|grams?|g|kg)\b/i.test(text)) {
    return { servings: null, text };
  }

  const range = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/.exec(text);
  if (range) {
    const low = Number.parseInt(range[1] ?? '', 10);
    return { servings: Number.isFinite(low) && low > 0 ? low : null, text };
  }

  const single = /(\d+(?:\.\d+)?)/.exec(text);
  if (single) {
    const parsed = Number.parseFloat(single[1] ?? '');
    if (Number.isFinite(parsed) && parsed > 0) return { servings: Math.round(parsed), text };
  }

  return { servings: null, text };
}

/**
 * `image` → an ordered list of absolute URLs.
 *
 * Accepts a string, an array of strings, an `ImageObject` (`url` or
 * `contentUrl`), an array of `ImageObject`s, and the `{"@list": [...]}` form.
 */
export function extractImages(
  value: unknown,
  pageUrl?: string,
  refs?: RefIndex,
  depth = 0,
): string[] {
  if (value === null || value === undefined || depth > 4) return [];

  if (typeof value === 'string') {
    const url = absoluteUrl(value, pageUrl);
    return url ? [url] : [];
  }
  if (Array.isArray(value)) {
    return dedupe(value.flatMap((item) => extractImages(item, pageUrl, refs, depth + 1)));
  }
  if (typeof value === 'object') {
    const record = deref(value, refs) as Record<string, unknown>;
    const candidate = record['url'] ?? record['contentUrl'] ?? record['@id'] ?? record['@list'];
    return extractImages(candidate, pageUrl, refs, depth + 1);
  }
  return [];
}

/**
 * `recipeInstructions` → ordered plain-text steps.
 *
 * The four shapes that matter, all present in the fixtures:
 * 1. a plain string, sometimes containing `<ol><li>` or `<p>` markup;
 * 2. `string[]`;
 * 3. `HowToStep[]` (`{"@type":"HowToStep","text":"…"}`);
 * 4. `HowToSection[]`, where the steps live in a nested `itemListElement` and
 *    the section's `name` is a heading like "For the sauce".
 *
 * Sections are flattened into a single ordered list with the heading carried
 * on each of its steps, which is exactly what `instructionStepSchema` in
 * `@recipes/shared` models.
 */
export function extractInstructions(value: unknown): ExtractedInstruction[] {
  const out: ExtractedInstruction[] = [];
  collectInstructions(value, null, out, 0);
  return out;
}

function collectInstructions(
  value: unknown,
  heading: string | null,
  out: ExtractedInstruction[],
  depth: number,
): void {
  if (value === null || value === undefined || depth > 6 || out.length > 500) return;

  if (typeof value === 'string') {
    for (const text of splitInstructionString(value)) out.push({ name: heading, text });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectInstructions(item, heading, out, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  const types = typeOf(node);
  const name = cleanTextOrNull(node['name']);

  // A section (or any node with children) contributes its heading, not a step.
  const children = node['itemListElement'] ?? node['steps'] ?? node['itemListElements'];
  if (children !== undefined && children !== null) {
    const sectionHeading = types.includes('howtosection') ? (name ?? heading) : heading;
    collectInstructions(children, sectionHeading, out, depth + 1);
    return;
  }

  const text = cleanTextOrNull(node['text'] ?? node['description'] ?? node['@value']);
  if (text !== null) {
    // Plugins routinely set `name` to a truncation of `text`; only keep it
    // when it is a genuine heading rather than the step repeated.
    const stepHeading =
      heading ?? (name !== null && !isRedundantName(name, text) ? name : null);
    for (const part of splitInstructionString(text)) out.push({ name: stepHeading, text: part });
    return;
  }

  if (name !== null) out.push({ name: heading, text: name });
}

function isRedundantName(name: string, text: string): boolean {
  const a = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return b.startsWith(a.slice(0, 40)) || a.startsWith(b.slice(0, 40));
}

/**
 * Split an instruction blob into steps.
 *
 * A single string is one step unless it carries list markup or hard line
 * breaks, which is how sites that store instructions as one HTML field encode
 * step boundaries. Splitting on sentences would be wrong — plenty of steps are
 * two sentences.
 */
export function splitInstructionString(value: string): string[] {
  if (/<\s*(li|br|p)\b/i.test(value)) {
    const $ = cheerio.load(`<div id="__wrap">${value}</div>`);
    const items = $('#__wrap li')
      .map((_, el) => cleanText($(el).html() ?? ''))
      .get()
      .filter((text) => text.length > 0);
    if (items.length > 0) return items;

    const paragraphs = $('#__wrap p')
      .map((_, el) => cleanText($(el).html() ?? ''))
      .get()
      .filter((text) => text.length > 0);
    if (paragraphs.length > 1) return paragraphs;
    if (paragraphs.length === 1) return paragraphs;
  }

  const lines = value
    .split(/\r?\n+/)
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0);
  if (lines.length > 1) return lines;

  const single = cleanText(value);
  return single.length > 0 ? [single] : [];
}

/** `aggregateRating` → `{value, count}`, tolerating string numbers. */
export function extractRating(value: unknown, refs?: RefIndex): ExtractedRating | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = extractRating(item, refs);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const node = deref(value, refs) as Record<string, unknown>;
  const ratingValue = toNumber(node['ratingValue'] ?? node['@value']);
  const count = toNumber(node['ratingCount'] ?? node['reviewCount']);

  if (ratingValue === null && count === null) return null;

  // Some sites publish a 0/0 placeholder before the first review; that is the
  // absence of a rating, not a rating of zero.
  const bestValue = ratingValue !== null && ratingValue > 0 && ratingValue <= 5 ? ratingValue : null;
  const bestCount = count !== null && count >= 0 ? Math.round(count) : null;
  if (bestValue === null && (bestCount === null || bestCount === 0)) return null;

  return { value: bestValue, count: bestCount };
}

/**
 * `author` → one display string. String, `Person`, `Organization`, an array of
 * those, or — on every Yoast site in the corpus — a bare `{"@id": …}` pointing
 * at a `Person` node elsewhere in the graph, which `refs` resolves.
 */
export function extractAuthor(value: unknown, refs?: RefIndex, depth = 0): string | null {
  if (value === null || value === undefined || depth > 3) return null;
  if (typeof value === 'string') return truncate(cleanTextOrNull(value), 200);
  if (Array.isArray(value)) {
    const names = value
      .map((item) => extractAuthor(item, refs, depth + 1))
      .filter((name): name is string => name !== null);
    return names.length > 0 ? truncate(dedupe(names).join(', '), 200) : null;
  }
  if (typeof value === 'object') {
    const node = deref(value, refs) as Record<string, unknown>;
    return extractAuthor(node['name'] ?? node['@value'] ?? node['alternateName'], refs, depth + 1);
  }
  return null;
}

/** An ISO date (or anything `Date.parse` groks) → `Date`, else null. */
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseDate(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const node = value as Record<string, unknown>;
    return parseDate(node['@value'] ?? node['value']);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against a plugin emitting `0000-00-00` or a far-future placeholder.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return parsed;
}

// ── Bridging to the insert path ─────────────────────────────────────────────

export interface RecipeDraft {
  readonly sourceUrl: string;
  readonly contentHash: string;
  readonly title: string;
  readonly slug: string;
  readonly totalMinutes: number | null;
  readonly activeMinutes: number | null;
  readonly servings: number | null;
  readonly imageUrl: string | null;
  readonly author: string | null;
  readonly sourceRating: number | null;
  readonly sourceRatingCount: number | null;
  readonly instructions: ExtractedInstruction[];
  readonly rawJsonld: Record<string, unknown>;
  readonly publishedAt: Date | null;
  /** Raw ingredient lines, positioned. Canonicalisation is a separate stage. */
  readonly ingredients: { position: number; rawText: string }[];
  readonly missing: TrackedField[];
}

/**
 * Shape an extraction into the subset of `RecipeInput` (`@recipes/shared`)
 * that Phase 1 can fill deterministically. `blurb`, `keeps_days`,
 * `freezer_months`, `category` and `tags` are deliberately absent — Phase 2
 * owns them, and inventing them here is exactly what PLAN.md §1 warns against.
 *
 * Returns `null` when the page gave us nothing insertable: no title, or no
 * ingredients at all. Those pages belong to the LLM fallback path, not to a
 * half-empty row.
 */
export function toRecipeDraft(
  recipe: ExtractedRecipe,
  sourceUrl: string,
  fallback: { publishedAt?: Date | null; title?: string | null } = {},
): RecipeDraft | null {
  const title = recipe.title ?? cleanTextOrNull(fallback.title ?? null);
  if (title === null || recipe.ingredients.length === 0) return null;

  return {
    sourceUrl,
    contentHash: recipe.contentHash,
    title,
    slug: slugify(title) || 'recipe',
    totalMinutes: recipe.totalMinutes,
    activeMinutes: recipe.activeMinutes,
    servings: recipe.servings,
    imageUrl: recipe.imageUrl,
    author: recipe.author,
    sourceRating: recipe.rating?.value ?? null,
    sourceRatingCount: recipe.rating?.count ?? null,
    instructions: recipe.instructions,
    rawJsonld: recipe.raw,
    publishedAt: recipe.publishedAt ?? fallback.publishedAt ?? null,
    ingredients: recipe.ingredients.map((rawText, position) => ({ position, rawText })),
    missing: recipe.missing,
  };
}

// ── small shared utilities ──────────────────────────────────────────────────

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function splitList(value: unknown): string[] {
  return dedupe(
    asArray(value)
      .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
      .map((item) => cleanText(item))
      .filter((item) => item.length > 0),
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

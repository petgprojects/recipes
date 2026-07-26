/**
 * Text hygiene shared by the extractors.
 *
 * Every string that reaches the database from a scraped page goes through
 * `cleanText()`. Recipe sites put markup inside JSON-LD strings constantly —
 * `<p>`-wrapped instruction steps, `&nbsp;` between a quantity and its unit,
 * `&#189;` for ½, stray `<a>` tags in ingredient lines — and storing that raw
 * means every consumer (UI, LLM prompt, ingredient parser) has to re-do the
 * same cleanup, differently, forever.
 */

import { decodeHTML } from 'entities';
import { createHash } from 'node:crypto';

/** Tags whose content is never part of the recipe text. */
const DROPPED_ELEMENTS = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Elements that imply a line break rather than a space when removed. */
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|h[1-6]|section|article)\b[^>]*>/gi;

const ANY_TAG = /<[^>]*>/g;

/**
 * Strip HTML and decode entities.
 *
 * Deliberately regex-based rather than a DOM parse: this runs once per
 * ingredient line and once per instruction step, so thousands of times per
 * scan, and the input is a short fragment with no structure worth preserving.
 * `decodeHTML` runs *after* tag removal so an entity-encoded `&lt;script&gt;`
 * in a recipe title cannot be resurrected into a tag.
 */
export function stripHtml(input: string): string {
  return decodeHTML(
    input
      .replace(DROPPED_ELEMENTS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(ANY_TAG, ' '),
  );
}

/** Collapse all runs of whitespace (including NBSP and newlines) to one space. */
export function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00a0\u200b\u200e\u200f\ufeff]+/g, ' ').trim();
}

/** `stripHtml` + whitespace collapse. The default for any extracted string. */
export function cleanText(input: unknown): string {
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  if (typeof input !== 'string') return '';
  return collapseWhitespace(stripHtml(input));
}

/** `cleanText`, but empty strings become `null` so callers can use `??`. */
export function cleanTextOrNull(input: unknown): string | null {
  const cleaned = cleanText(input);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * A URL-safe slug. Not unique on its own — `recipes.source_url` is the dedupe
 * key (PLAN.md §4), so a slug collision between two sites is fine.
 */
export function slugify(input: string, maxLength = 200): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  // Cut on a word boundary so the slug never ends mid-token.
  return slug.slice(0, maxLength).replace(/-+[^-]*$/, '').replace(/-+$/, '');
}

/** Stable SHA-256 of any JSON-serialisable value, with object keys sorted. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Resolve a possibly-relative URL, returning `null` rather than throwing. */
export function absoluteUrl(href: string | null | undefined, base?: string): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

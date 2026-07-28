/**
 * Display formatting for recipe quantities, times and shelf life.
 *
 * `fmtQty`, `fmtLine` and `fmtTime` are ports of the helpers in
 * `meal-prep-planner.jsx` — the artifact's typographic decisions (vulgar
 * fractions, "4 hr" rather than "240 min") are part of the design and survive
 * the port. They live in `packages/shared` rather than in `apps/web` because
 * they are pure, worth testing, and the grocery aggregation below is their
 * main caller.
 *
 * Nothing here may import anything with side effects: this module is pulled
 * into the browser bundle.
 */

import { COUNT_UNITS, normalizeUnit, type CanonicalUnit } from './units';

/** Fraction glyphs the artifact snapped to, smallest first. */
const FRACTIONS: readonly (readonly [number, string])[] = [
  [0.125, '⅛'],
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
];

/**
 * `1.5` → `1½`, `0.333` → `⅓`, `2` → `2`, `1.27` → `1.27`.
 *
 * Recipe quantities are read at a glance in a store aisle, so a near-miss on a
 * common fraction is rendered as the fraction. Anything that is not close to
 * one falls back to at most two decimals.
 */
export function fmtQty(qty: number | null | undefined): string {
  if (qty === null || qty === undefined || !Number.isFinite(qty)) return '';

  const whole = Math.floor(qty + 1e-9);
  const remainder = Number((qty - whole).toFixed(3));
  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(remainder - value) < 0.02) return whole ? `${whole}${glyph}` : glyph;
  }
  if (Math.abs(qty - Math.round(qty)) < 0.01) return String(Math.round(qty));
  return String(Number(qty.toFixed(2)));
}

/** Count units that read wrong in the singular on a shopping list. */
const PLURALIZABLE = new Set<CanonicalUnit>(
  COUNT_UNITS.filter((unit) => unit !== 'each'),
);

function pluralize(unit: CanonicalUnit): string {
  return unit === 'inch' ? 'inches' : `${unit}s`;
}

/**
 * `1.5, 'lb'` → `1½ lb`; `2, 'can'` → `2 cans`; `3, 'each'` → `3`.
 *
 * `each` renders bare — "3 avocados" is the item name doing the work, and
 * "3 each avocados" is nobody's shopping list. An unrecognised unit is printed
 * verbatim rather than dropped, because the raw text is all we have.
 */
export function fmtLine(qty: number | null | undefined, unit: string | null | undefined): string {
  const amount = fmtQty(qty);
  const canonical = normalizeUnit(unit);

  if (canonical === null) {
    const raw = (unit ?? '').trim();
    if (raw === '') return amount;
    return amount === '' ? raw : `${amount} ${raw}`;
  }
  if (canonical === 'each') return amount;

  const plural = qty !== null && qty !== undefined && qty > 1 && PLURALIZABLE.has(canonical);
  const rendered = plural ? pluralize(canonical) : canonical;
  return amount === '' ? rendered : `${amount} ${rendered}`;
}

/** `45` → `45 min`; `240` → `4 hr`. Two hours is where minutes stop helping. */
export function fmtTime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  if (minutes >= 120) return `${Math.round(minutes / 60)} hr`;
  return `${Math.round(minutes)} min`;
}

/**
 * `4, 3` → `4 days · 3 months frozen`; `null, 3` → `3 months frozen`.
 *
 * Both halves are genuinely optional in the live data — 216 of 235 active
 * recipes have `keeps_days` and only 91 have `freezer_months` — so this
 * returns `''` and the caller omits the whole line rather than rendering
 * "keeps null".
 */
export function fmtKeeps(
  keepsDays: number | null | undefined,
  freezerMonths: number | null | undefined,
): string {
  const parts: string[] = [];
  if (typeof keepsDays === 'number' && Number.isFinite(keepsDays) && keepsDays > 0) {
    parts.push(`${keepsDays} ${keepsDays === 1 ? 'day' : 'days'}`);
  }
  if (typeof freezerMonths === 'number' && Number.isFinite(freezerMonths) && freezerMonths > 0) {
    parts.push(`${freezerMonths} ${freezerMonths === 1 ? 'month' : 'months'} frozen`);
  }
  return parts.join(' · ');
}

/**
 * `4.8, 24` → `4.8★ (24 reviews)`; `4.8, null` → `4.8★`.
 *
 * Ratings are not free (PROGRESS.md, Phase 1): 9 of 21 probed pages published
 * none and The Kitchn never does. Absent means absent — the card omits the
 * line rather than showing a zero or an empty star row.
 */
export function fmtRating(
  rating: number | null | undefined,
  count: number | null | undefined,
): string {
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating <= 0) return '';
  const stars = `${Number(rating.toFixed(1))}★`;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return stars;
  return `${stars} (${count} ${count === 1 ? 'review' : 'reviews'})`;
}

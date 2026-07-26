/**
 * Deterministic ingredient-line parsing — stage 1 of PLAN.md §4.
 *
 * This parser intentionally stays conservative. It extracts quantities and
 * units only when their syntax is unambiguous, while the original `rawText`
 * remains the source of truth for rendering. A partial parse is useful; a
 * confident-looking wrong quantity is not.
 */

import { normalizeUnit, parsedIngredientLineSchema, type ParsedIngredientLine } from '@recipes/shared';
import { cleanText } from '../scanner/text';

const UNICODE_FRACTIONS: Readonly<Record<string, number>> = {
  '⅛': 1 / 8,
  '¼': 1 / 4,
  '⅓': 1 / 3,
  '⅜': 3 / 8,
  '½': 1 / 2,
  '⅝': 5 / 8,
  '⅔': 2 / 3,
  '¾': 3 / 4,
  '⅞': 7 / 8,
};

const FRACTION_GLYPHS = Object.keys(UNICODE_FRACTIONS).join('');
const ASCII_MIXED = String.raw`\d+\s+\d+\/\d+`;
const UNICODE_MIXED = String.raw`\d*\s*[${FRACTION_GLYPHS}]`;
const ASCII_FRACTION = String.raw`\d+\/\d+`;
const DECIMAL = String.raw`\d+(?:\.\d+)?`;
const QUANTITY_ATOM = `(?:${ASCII_MIXED}|${UNICODE_MIXED}|${ASCII_FRACTION}|${DECIMAL})`;
const LEADING_QUANTITY = new RegExp(
  `^(${QUANTITY_ATOM})(?:\\s*(?:-|–|—|to)\\s*(${QUANTITY_ATOM}))?(?=\\s|[^\\d./]|$)`,
  'iu',
);

/**
 * Measures which are useful to parse even though the grocery-list converter
 * deliberately refuses to convert them. Known shared units are detected via
 * `normalizeUnit()`; this list covers common free-form recipe measures.
 */
const FREEFORM_UNITS = new Set([
  'bag',
  'bags',
  'bottle',
  'bottles',
  'box',
  'boxes',
  'dash',
  'dashes',
  'envelope',
  'envelopes',
  'filet',
  'filets',
  'fillet',
  'fillets',
  'jar',
  'jars',
  'package',
  'packages',
  'packet',
  'packets',
  'pinch',
  'pinches',
  'sheet',
  'sheets',
  'sprig',
  'sprigs',
  'stick',
  'sticks',
]);

const UNIT_PREFIXES = new Set(['full', 'heaping', 'level', 'packed', 'rounded', 'scant']);
const TRAILING_NOTE =
  /\s+(to taste|as needed|until desired consistency|for (?:serving|garnish|frying|drizzling))\s*$/i;
const OPTIONAL = /\boptional(?:ly)?\b/i;

export function parseIngredientLine(raw: string): ParsedIngredientLine | null {
  const text = cleanText(raw);
  if (text.length === 0) return null;

  const optional = OPTIONAL.test(text);
  let remainder = text;
  let qty: number | null = null;
  let unit: string | null = null;
  const notes: string[] = [];

  const quantity = consumeQuantity(remainder);
  if (quantity !== null) {
    qty = quantity.value;
    remainder = quantity.remainder;
  }

  // Package sizes and modifiers commonly sit between quantity and unit:
  // `1 (15-ounce) can beans`, `1 (packed) cup cilantro`.
  const leadingGroups = consumeLeadingParentheticals(remainder);
  remainder = leadingGroups.remainder;
  notes.push(...leadingGroups.notes);

  const measured = consumeUnit(remainder);
  if (measured !== null) {
    unit = measured.unit;
    remainder = measured.remainder.replace(/^of\b\s*/i, '');
    notes.push(...measured.notes);
  }

  const parentheticals = extractParentheticals(remainder);
  remainder = parentheticals.text;
  notes.push(...parentheticals.notes);

  const pieces = remainder
    .split(/\s*[,;]\s*/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  let name = pieces.shift() ?? text;
  notes.push(...pieces);

  const trailing = name.match(TRAILING_NOTE);
  if (trailing !== null) {
    notes.push(trailing[1] ?? '');
    name = name.slice(0, trailing.index).trim();
  }

  name = cleanFragment(name) || text;
  const note = normalizeNotes(notes, optional);

  return parsedIngredientLineSchema.parse({
    qty,
    unit,
    name,
    note,
    optional,
  });
}

function consumeQuantity(
  input: string,
): { value: number; remainder: string } | null {
  const match = input.match(LEADING_QUANTITY);
  if (match === null) return null;

  // The schema has one quantity column. For a range (`4-5 cups`) use its
  // explicitly stated lower bound; `rawText` still preserves the full range.
  const value = parseQuantityAtom(match[1] ?? '');
  if (value === null || value <= 0) return null;

  return {
    value,
    remainder: input.slice(match[0].length).trim(),
  };
}

function parseQuantityAtom(input: string): number | null {
  const value = input.trim();
  const glyph = value.match(new RegExp(`([${FRACTION_GLYPHS}])$`))?.[1];
  if (glyph !== undefined) {
    const fraction = UNICODE_FRACTIONS[glyph];
    if (fraction === undefined) return null;
    const wholeText = value.slice(0, -glyph.length).trim();
    const whole = wholeText.length === 0 ? 0 : Number(wholeText);
    return Number.isFinite(whole) ? whole + fraction : null;
  }

  const mixed = value.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed !== null) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    return denominator > 0 ? whole + numerator / denominator : null;
  }

  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (fraction !== null) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator > 0 ? numerator / denominator : null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function consumeUnit(
  input: string,
): { unit: string; remainder: string; notes: string[] } | null {
  let candidateInput = input.trim();
  const notes: string[] = [];

  const prefix = candidateInput.match(/^([A-Za-z]+)\s+/)?.[1];
  if (prefix !== undefined && UNIT_PREFIXES.has(prefix.toLowerCase())) {
    const withoutPrefix = candidateInput.slice(prefix.length).trim();
    if (findUnitToken(withoutPrefix) !== null) {
      notes.push(prefix);
      candidateInput = withoutPrefix;
    }
  }

  const found = findUnitToken(candidateInput);
  if (found === null) return null;
  return {
    unit: found.unit,
    remainder: candidateInput.slice(found.length).trim(),
    notes,
  };
}

function findUnitToken(input: string): { unit: string; length: number } | null {
  const words = [...input.matchAll(/[^\s]+/g)].slice(0, 2);
  for (let count = words.length; count >= 1; count -= 1) {
    const last = words[count - 1];
    if (last === undefined) continue;
    const length = (last.index ?? 0) + last[0].length;
    const original = input.slice(0, length);
    const cleaned = original.replace(/[.,]+$/, '');
    const key = cleaned.toLowerCase();
    if (normalizeUnit(cleaned) !== null || FREEFORM_UNITS.has(key)) {
      return { unit: cleaned, length };
    }
  }
  return null;
}

function consumeLeadingParentheticals(input: string): { remainder: string; notes: string[] } {
  let remainder = input.trim();
  const notes: string[] = [];
  while (remainder.startsWith('(')) {
    const end = matchingParenIndex(remainder, 0);
    if (end < 0) break;
    notes.push(remainder.slice(1, end));
    remainder = remainder.slice(end + 1).trim();
  }
  return { remainder, notes };
}

function extractParentheticals(input: string): { text: string; notes: string[] } {
  let text = '';
  const notes: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const start = input.indexOf('(', cursor);
    if (start < 0) {
      text += input.slice(cursor);
      break;
    }
    const end = matchingParenIndex(input, start);
    if (end < 0) {
      text += input.slice(cursor);
      break;
    }
    text += `${input.slice(cursor, start)} `;
    notes.push(input.slice(start + 1, end));
    cursor = end + 1;
  }

  return { text: cleanFragment(text), notes };
}

function matchingParenIndex(input: string, start: number): number {
  let depth = 0;
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '(') depth += 1;
    if (input[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeNotes(parts: readonly string[], optional: boolean): string | null {
  const cleaned = parts
    .flatMap((part) => part.split(/\s*[,;]\s*/))
    .map((part) =>
      cleanFragment(
        part
          .replace(/\boptional(?:ly)?\b/gi, '')
          .replace(/\$\d+(?:\.\d+)?\**/g, '')
          .replace(/^\*+|\*+$/g, ''),
      ),
    )
    .filter((part) => part.length > 0)
    .filter((part, index, all) => all.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index);

  // `optional` is represented structurally, not repeated as a free-text note.
  if (optional && cleaned.length === 0) return null;
  return cleaned.length > 0 ? cleaned.join('; ') : null;
}

function cleanFragment(input: string): string {
  return input.replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();
}

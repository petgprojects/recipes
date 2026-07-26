/**
 * PLAN.md §5, Phase 0: "*Tests:* unit-conversion and aisle-vocabulary
 * round-trips."
 *
 * The thing being defended here is PLAN.md §4's hard rule: "Never merge
 * `2 cans` with `14 oz`." A conversion bug in this file does not crash
 * anything — it silently produces a wrong grocery list, which is exactly the
 * class of wrongness §5 says to test.
 */

import { describe, expect, it } from 'vitest';
import {
  BASE_UNIT,
  CANONICAL_UNITS,
  COUNT_UNITS,
  MASS_UNITS,
  VOLUME_UNITS,
  convert,
  isSameDimension,
  normalizeUnit,
  toBaseUnit,
  unitDimension,
  unitDimensionKey,
} from '../src/units';

const CLOSE = 1e-9;

describe('normalizeUnit', () => {
  it('maps the artifact vocabulary onto canonical units', () => {
    // Every unit string that appears in the real artifact data.
    const artifactUnits = [
      '',
      'bunch',
      'can',
      'cup',
      'head',
      'inch',
      'lb',
      'oz',
      'pint',
      'slice',
      'stalk',
      'tbsp',
      'tsp',
    ];
    for (const unit of artifactUnits) {
      expect(normalizeUnit(unit), `artifact unit ${JSON.stringify(unit)}`).not.toBeNull();
    }
  });

  it('is idempotent: normalising a canonical unit returns itself', () => {
    for (const unit of CANONICAL_UNITS) {
      expect(normalizeUnit(unit)).toBe(unit);
    }
  });

  it('handles case, plurals, punctuation and surrounding whitespace', () => {
    expect(normalizeUnit('  Tbsp.  ')).toBe('tbsp');
    expect(normalizeUnit('TABLESPOONS')).toBe('tbsp');
    expect(normalizeUnit('Ounce')).toBe('oz');
    expect(normalizeUnit('lbs')).toBe('lb');
    expect(normalizeUnit('fluid  ounces')).toBe('fl oz');
    expect(normalizeUnit('cloves')).toBe('clove');
  });

  it('respects the T/t collision — capital T is tablespoon, lowercase t is teaspoon', () => {
    expect(normalizeUnit('T')).toBe('tbsp');
    expect(normalizeUnit('t')).toBe('tsp');
    // and the two are not interchangeable
    expect(convert(1, 'T', 't')).toBeCloseTo(3, 6);
  });

  it('treats a missing unit as a count of whole items', () => {
    expect(normalizeUnit('')).toBe('each');
    expect(normalizeUnit(null)).toBe('each');
    expect(normalizeUnit(undefined)).toBe('each');
  });

  it('returns null for units outside the vocabulary', () => {
    expect(normalizeUnit('smidgen')).toBeNull();
    expect(normalizeUnit('handful')).toBeNull();
    expect(unitDimension('smidgen')).toBeNull();
  });
});

describe('unitDimension', () => {
  it('assigns every canonical unit to exactly one dimension', () => {
    for (const unit of MASS_UNITS) expect(unitDimension(unit)).toBe('mass');
    for (const unit of VOLUME_UNITS) expect(unitDimension(unit)).toBe('volume');
    for (const unit of COUNT_UNITS) expect(unitDimension(unit)).toBe('count');
  });
});

describe('convert — round-trips', () => {
  it('round-trips every mass unit through every other mass unit', () => {
    for (const from of MASS_UNITS) {
      for (const to of MASS_UNITS) {
        const there = convert(7.5, from, to);
        expect(there, `${from} -> ${to}`).not.toBeNull();
        const back = convert(there!, to, from);
        expect(back!, `${from} -> ${to} -> ${from}`).toBeCloseTo(7.5, 9);
      }
    }
  });

  it('round-trips every volume unit through every other volume unit', () => {
    for (const from of VOLUME_UNITS) {
      for (const to of VOLUME_UNITS) {
        const there = convert(3.25, from, to);
        expect(there, `${from} -> ${to}`).not.toBeNull();
        const back = convert(there!, to, from);
        expect(back!, `${from} -> ${to} -> ${from}`).toBeCloseTo(3.25, 9);
      }
    }
  });

  it('gets the well-known factors right', () => {
    expect(convert(1, 'lb', 'oz')!).toBeCloseTo(16, 9);
    expect(convert(1, 'lb', 'g')!).toBeCloseTo(453.59237, 9);
    expect(convert(1000, 'g', 'kg')!).toBeCloseTo(1, 9);
    expect(convert(1, 'cup', 'tbsp')!).toBeCloseTo(16, 9);
    expect(convert(1, 'tbsp', 'tsp')!).toBeCloseTo(3, 9);
    expect(convert(1, 'cup', 'fl oz')!).toBeCloseTo(8, 9);
    expect(convert(1, 'quart', 'cup')!).toBeCloseTo(4, 9);
    expect(convert(1, 'gallon', 'quart')!).toBeCloseTo(4, 9);
    expect(convert(1, 'l', 'ml')!).toBeCloseTo(1000, 9);
  });

  it('is exactly the identity for a unit onto itself', () => {
    for (const unit of CANONICAL_UNITS) {
      expect(convert(42, unit, unit), unit).toBe(42);
    }
  });
});

describe('convert — the refusals that keep the grocery list honest', () => {
  it('returns null (never throws) across dimensions', () => {
    // PLAN.md §4: "Never merge `2 cans` with `14 oz`."
    expect(convert(2, 'can', 'oz')).toBeNull();
    expect(convert(14, 'oz', 'can')).toBeNull();
    expect(convert(1, 'cup', 'g')).toBeNull();
    expect(convert(1, 'g', 'ml')).toBeNull();
    expect(convert(1, 'lb', 'tbsp')).toBeNull();
    expect(convert(1, 'each', 'g')).toBeNull();
  });

  it('never converts a count unit to a different count unit', () => {
    for (const from of COUNT_UNITS) {
      for (const to of COUNT_UNITS) {
        const result = convert(3, from, to);
        if (from === to) {
          expect(result, `${from} -> ${to}`).toBe(3);
        } else {
          expect(result, `${from} -> ${to}`).toBeNull();
        }
      }
    }
  });

  it('never converts a count unit to a mass or volume unit, in either direction', () => {
    for (const count of COUNT_UNITS) {
      for (const other of [...MASS_UNITS, ...VOLUME_UNITS]) {
        expect(convert(1, count, other), `${count} -> ${other}`).toBeNull();
        expect(convert(1, other, count), `${other} -> ${count}`).toBeNull();
      }
    }
  });

  it('returns null for unknown units rather than throwing', () => {
    expect(() => convert(1, 'smidgen', 'g')).not.toThrow();
    expect(convert(1, 'smidgen', 'g')).toBeNull();
    expect(convert(1, 'g', 'smidgen')).toBeNull();
    expect(convert(Number.NaN, 'g', 'kg')).toBeNull();
    expect(convert(Number.POSITIVE_INFINITY, 'g', 'kg')).toBeNull();
  });

  it('agrees with isSameDimension', () => {
    for (const from of CANONICAL_UNITS) {
      for (const to of CANONICAL_UNITS) {
        const converted = convert(1, from, to);
        if (converted === null) {
          // Only same-dimension count pairs may be same-dimension yet unconvertible.
          if (isSameDimension(from, to)) {
            expect(unitDimension(from), `${from} -> ${to}`).toBe('count');
          }
        } else {
          expect(isSameDimension(from, to), `${from} -> ${to}`).toBe(true);
        }
      }
    }
  });
});

describe('toBaseUnit', () => {
  it('normalises a dimension onto one comparable number', () => {
    const a = toBaseUnit(1, 'lb');
    const b = toBaseUnit(16, 'oz');
    expect(a!.unit).toBe(BASE_UNIT.mass);
    expect(b!.unit).toBe(BASE_UNIT.mass);
    expect(Math.abs(a!.qty - b!.qty)).toBeLessThan(CLOSE);
  });

  it('leaves count units alone instead of inventing a base', () => {
    const cans = toBaseUnit(2, 'cans');
    expect(cans).toEqual({ qty: 2, unit: 'can', dimension: 'count' });
  });

  it('returns null for an unknown unit', () => {
    expect(toBaseUnit(1, 'smidgen')).toBeNull();
  });
});

describe('unitDimensionKey — the grocery_checks.item_key suffix', () => {
  it('gives mass units one shared key so lb and oz share a checkbox', () => {
    // PLAN.md §4: "'chicken breast' in lb and in oz are one shopping line and
    // must share one checkbox."
    expect(unitDimensionKey('lb')).toBe('mass');
    expect(unitDimensionKey('oz')).toBe('mass');
    expect(unitDimensionKey('g')).toBe('mass');
    expect(unitDimensionKey('cup')).toBe('volume');
    expect(unitDimensionKey('ml')).toBe('volume');
  });

  it('keeps distinct count units on distinct keys', () => {
    expect(unitDimensionKey('can')).not.toBe(unitDimensionKey('head'));
    expect(unitDimensionKey('cans')).toBe(unitDimensionKey('can'));
    expect(unitDimensionKey('')).toBe(unitDimensionKey(null));
  });

  it('is stable for unknown units', () => {
    expect(unitDimensionKey('smidgen')).toBe(unitDimensionKey(' Smidgen '));
    expect(unitDimensionKey('smidgen')).not.toBe(unitDimensionKey('handful'));
  });
});

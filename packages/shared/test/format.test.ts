/**
 * The artifact's typography, ported. These assertions are lifted from what
 * `meal-prep-planner.jsx` actually rendered for its 24 hand-authored recipes,
 * so a regression here is visible as "the design used to look better".
 */

import { describe, expect, it } from 'vitest';
import { fmtKeeps, fmtLine, fmtQty, fmtRating, fmtTime } from '../src/format';

describe('fmtQty', () => {
  it('snaps to vulgar fractions', () => {
    expect(fmtQty(0.25)).toBe('¼');
    expect(fmtQty(0.33)).toBe('⅓');
    expect(fmtQty(0.5)).toBe('½');
    expect(fmtQty(0.75)).toBe('¾');
    expect(fmtQty(1.5)).toBe('1½');
    expect(fmtQty(2.25)).toBe('2¼');
  });

  it('prints whole numbers without decoration', () => {
    expect(fmtQty(1)).toBe('1');
    expect(fmtQty(12)).toBe('12');
    expect(fmtQty(3.001)).toBe('3');
  });

  it('falls back to two decimals for anything not near a fraction', () => {
    expect(fmtQty(1.27)).toBe('1.27');
    expect(fmtQty(0.1)).toBe('0.1');
  });

  it('renders nothing for an absent quantity', () => {
    expect(fmtQty(null)).toBe('');
    expect(fmtQty(undefined)).toBe('');
    expect(fmtQty(Number.NaN)).toBe('');
  });
});

describe('fmtLine', () => {
  it('pluralises countable units above one', () => {
    expect(fmtLine(2, 'can')).toBe('2 cans');
    expect(fmtLine(1, 'can')).toBe('1 can');
    expect(fmtLine(4, 'stalk')).toBe('4 stalks');
    expect(fmtLine(2, 'inch')).toBe('2 inches');
  });

  it('never pluralises measures', () => {
    expect(fmtLine(3, 'tbsp')).toBe('3 tbsp');
    expect(fmtLine(1.5, 'lb')).toBe('1½ lb');
    expect(fmtLine(2, 'cups')).toBe('2 cup');
  });

  it('renders `each` as a bare count', () => {
    expect(fmtLine(3, '')).toBe('3');
    expect(fmtLine(2, null)).toBe('2');
    expect(fmtLine(2, 'each')).toBe('2');
  });

  it('prints an unrecognised unit verbatim rather than dropping it', () => {
    expect(fmtLine(1, 'sprig')).toBe('1 sprig');
    expect(fmtLine(null, 'sprig')).toBe('sprig');
  });
});

describe('fmtTime', () => {
  it('switches to hours at two hours', () => {
    expect(fmtTime(45)).toBe('45 min');
    expect(fmtTime(119)).toBe('119 min');
    expect(fmtTime(120)).toBe('2 hr');
    expect(fmtTime(240)).toBe('4 hr');
    expect(fmtTime(480)).toBe('8 hr');
  });

  it('is empty when the source published no time', () => {
    expect(fmtTime(null)).toBe('');
  });
});

describe('fmtKeeps', () => {
  it('joins fridge and freezer life the way the card does', () => {
    expect(fmtKeeps(5, 3)).toBe('5 days · 3 months frozen');
    expect(fmtKeeps(4, null)).toBe('4 days');
    expect(fmtKeeps(null, 3)).toBe('3 months frozen');
    expect(fmtKeeps(1, 1)).toBe('1 day · 1 month frozen');
  });

  it('is empty when neither is known, so the caller omits the line', () => {
    expect(fmtKeeps(null, null)).toBe('');
    expect(fmtKeeps(0, 0)).toBe('');
  });
});

describe('fmtRating', () => {
  it('renders an optional source rating', () => {
    expect(fmtRating(4.8, 24)).toBe('4.8★ (24 reviews)');
    expect(fmtRating(5, 1)).toBe('5★ (1 review)');
    expect(fmtRating(4.75, null)).toBe('4.8★');
  });

  it('is empty when the source published no rating', () => {
    expect(fmtRating(null, null)).toBe('');
    expect(fmtRating(0, 12)).toBe('');
  });
});

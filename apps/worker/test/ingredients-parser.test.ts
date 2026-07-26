import { describe, expect, it } from 'vitest';
import { parseIngredientLine } from '../src/ingredients/parser';

describe('parseIngredientLine — quantities', () => {
  it.each([
    ['2 cups flour', 2],
    ['1.75 lbs. chicken drumsticks', 1.75],
    ['1/2 cup sugar', 0.5],
    ['1 3/4 cups cream', 1.75],
    ['½ cup sugar', 0.5],
    ['1½ cups water', 1.5],
    ['1¼ tsp salt', 1.25],
    ['⅓ cup olive oil', 1 / 3],
  ])('parses %s', (raw, qty) => {
    expect(parseIngredientLine(raw)?.qty).toBeCloseTo(qty, 10);
  });

  it.each([
    ['4-5 cups fresh strawberries', 4],
    ['6–8 tortillas', 6],
    ['1 to 2 canned chipotles', 1],
  ])('uses the stated lower bound for range %s', (raw, qty) => {
    expect(parseIngredientLine(raw)?.qty).toBe(qty);
  });

  it('does not invent a quantity when the line has none', () => {
    expect(parseIngredientLine('Ground black pepper')?.qty).toBeNull();
    expect(parseIngredientLine('Water until desired consistency')?.qty).toBeNull();
  });

  it('leaves malformed or non-positive quantities in the name', () => {
    expect(parseIngredientLine('0 cups flour')).toMatchObject({
      qty: null,
      unit: null,
      name: '0 cups flour',
    });
    expect(parseIngredientLine('1/0 cup flour')).toMatchObject({
      qty: null,
      unit: null,
      name: '1/0 cup flour',
    });
  });
});

describe('parseIngredientLine — units and names', () => {
  it.each([
    ['2 tablespoons olive oil', 'tablespoons', 'olive oil'],
    ['4oz feta cheese', 'oz', 'feta cheese'],
    ['1 lb. chicken breast', 'lb', 'chicken breast'],
    ['1 fluid ounce vermouth', 'fluid ounce', 'vermouth'],
    ['3 cloves of garlic', 'cloves', 'garlic'],
    ['1 dash Angostura bitters', 'dash', 'Angostura bitters'],
    ['12 sheets graham crackers', 'sheets', 'graham crackers'],
  ])('splits %s', (raw, unit, name) => {
    expect(parseIngredientLine(raw)).toMatchObject({ unit, name });
  });

  it('keeps source unit spelling rather than silently canonicalising it', () => {
    expect(parseIngredientLine('2 TABLESPOONS oil')?.unit).toBe('TABLESPOONS');
    expect(parseIngredientLine('1 T oil')?.unit).toBe('T');
    expect(parseIngredientLine('1 t salt')?.unit).toBe('t');
  });

  it('does not mistake an unknown word for a unit', () => {
    expect(parseIngredientLine('2 smidgens salt')).toMatchObject({
      qty: 2,
      unit: null,
      name: 'smidgens salt',
    });
  });

  it('extracts a package size before a count unit', () => {
    expect(parseIngredientLine('1 (15-ounce) can black beans')).toEqual({
      qty: 1,
      unit: 'can',
      name: 'black beans',
      note: '15-ounce',
      optional: false,
    });
  });

  it('handles a unit modifier without treating it as part of the ingredient', () => {
    expect(parseIngredientLine('12 full sheets graham crackers')).toMatchObject({
      qty: 12,
      unit: 'sheets',
      name: 'graham crackers',
      note: 'full',
    });
    expect(parseIngredientLine('1 packed cup cilantro')).toMatchObject({
      unit: 'cup',
      name: 'cilantro',
      note: 'packed',
    });
  });
});

describe('parseIngredientLine — notes and resilience', () => {
  it('moves comma-separated preparation text into note', () => {
    expect(parseIngredientLine('5 tablespoons unsalted butter, melted')).toMatchObject({
      name: 'unsalted butter',
      note: 'melted',
    });
  });

  it('extracts nested and multiple parentheticals in source order', () => {
    expect(
      parseIngredientLine('6 ripe peaches (pitted and sliced (5 cups)) (about 2 pounds)'),
    ).toMatchObject({
      name: 'ripe peaches',
      note: 'pitted and sliced (5 cups); about 2 pounds',
    });
  });

  it.each([
    ['salt to taste', 'salt', 'to taste'],
    ['avocado oil for frying', 'avocado oil', 'for frying'],
    ['Water until desired consistency', 'Water', 'until desired consistency'],
    ['Crusty bread, for serving', 'Crusty bread', 'for serving'],
  ])('extracts an unquantified suffix from %s', (raw, name, note) => {
    expect(parseIngredientLine(raw)).toMatchObject({ name, note });
  });

  it('sets optional structurally and does not duplicate it in note', () => {
    expect(parseIngredientLine('cooked rice (optional for serving)')).toEqual({
      qty: null,
      unit: null,
      name: 'cooked rice',
      note: 'for serving',
      optional: true,
    });
    expect(parseIngredientLine('1 lemon (optional)')?.note).toBeNull();
  });

  it('drops source price noise without dropping useful notes', () => {
    expect(parseIngredientLine('1.75 lbs. chicken drumsticks (6 pieces, $4.06*)')).toMatchObject({
      name: 'chicken drumsticks',
      note: '6 pieces',
    });
  });

  it('cleans markup/entities before parsing and never throws on blank input', () => {
    expect(parseIngredientLine('<b>½</b>&nbsp;cup salt &amp; pepper')).toMatchObject({
      qty: 0.5,
      unit: 'cup',
      name: 'salt & pepper',
    });
    expect(parseIngredientLine(' \n\u00a0 ')).toBeNull();
  });

  it('falls back to the whole clean line when punctuation leaves no usable name', () => {
    expect(parseIngredientLine(',,,')?.name).toBe(',,,');
  });
});

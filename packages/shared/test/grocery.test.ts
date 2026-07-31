/**
 * PLAN.md §5: the aggregation query is named as part of "the highest-value test
 * surface in the project — it's where wrongness is silent." A wrong grocery
 * list does not throw; you find out in the store.
 *
 * The invariant these tests defend is PLAN.md §4's: merge within a dimension,
 * never across one, and give the merged line exactly one stable check key.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateGroceries,
  countGroceryItems,
  groceryItemKey,
  groceryListToText,
  type GroceryRecipeInput,
} from '../src/grocery';

const CHICKEN = '11111111-1111-4111-8111-111111111111';
const TOMATOES = '22222222-2222-4222-8222-222222222222';
const OLIVE_OIL = '33333333-3333-4333-8333-333333333333';

function recipe(
  id: string,
  title: string,
  ingredients: GroceryRecipeInput['ingredients'],
  batches = 1,
): GroceryRecipeInput {
  return { id, title, batches, ingredients };
}

function line(
  overrides: Partial<GroceryRecipeInput['ingredients'][number]> = {},
): GroceryRecipeInput['ingredients'][number] {
  return {
    ingredientId: CHICKEN,
    name: 'chicken breast',
    rawText: '1 lb chicken breast',
    aisle: 'Meat & Seafood',
    qty: 1,
    unit: 'lb',
    ...overrides,
  };
}

describe('groceryItemKey', () => {
  it('is the PLAN.md §4 shape: identity plus unit dimension', () => {
    expect(groceryItemKey(CHICKEN, '1 lb chicken breast', 'lb')).toBe(`${CHICKEN}:mass`);
    expect(groceryItemKey(CHICKEN, '8 oz chicken breast', 'oz')).toBe(`${CHICKEN}:mass`);
    expect(groceryItemKey(TOMATOES, '2 cans tomatoes', 'can')).toBe(`${TOMATOES}:count:can`);
  });

  it('falls back to slugified raw text for an unmapped row', () => {
    expect(groceryItemKey(null, '1 (14 oz) can whatever, drained', 'can')).toBe(
      'raw:1-14-oz-can-whatever-drained:count:can',
    );
  });

  it('keeps two different unmapped rows apart', () => {
    const a = groceryItemKey(null, 'juice of half a lemon', null);
    const b = groceryItemKey(null, 'a small handful of parsley', null);
    expect(a).not.toBe(b);
  });
});

describe('aggregateGroceries', () => {
  it('merges the same ingredient across recipes within a dimension', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Sheet-Pan Chili Chicken', [line({ qty: 1.5, unit: 'lb' })]),
      recipe('b', 'Buffalo Chicken Bowls', [
        line({ qty: 8, unit: 'oz', rawText: '8 oz boneless skinless chicken breasts' }),
      ]),
    ]);

    expect(groups).toHaveLength(1);
    const [item] = groups[0]!.items;
    expect(item!.key).toBe(`${CHICKEN}:mass`);
    expect(item!.qty).toBeCloseTo(2, 6);
    expect(item!.unit).toBe('lb');
    expect(item!.amount).toBe('2 lb');
    expect(item!.recipes).toEqual(['Sheet-Pan Chili Chicken', 'Buffalo Chicken Bowls']);
  });

  it('never merges cans with ounces', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Chili', [
        line({
          ingredientId: TOMATOES,
          name: 'diced tomatoes',
          rawText: '2 cans diced tomatoes',
          aisle: 'Canned & Jarred',
          qty: 2,
          unit: 'can',
        }),
      ]),
      recipe('b', 'Soup', [
        line({
          ingredientId: TOMATOES,
          name: 'diced tomatoes',
          rawText: '14 oz diced tomatoes',
          aisle: 'Canned & Jarred',
          qty: 14,
          unit: 'oz',
        }),
      ]),
    ]);

    const items = groups[0]!.items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.amount).sort()).toEqual(['14 oz', '2 cans']);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it('applies the batch multiplier', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Chili', [line({ qty: 1.5, unit: 'lb' })], 3),
    ]);
    expect(groups[0]!.items[0]!.amount).toBe('4½ lb');
  });

  it('promotes to a unit that keeps the total readable', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Dressing', [
        line({
          ingredientId: OLIVE_OIL,
          name: 'olive oil',
          rawText: '2 tbsp olive oil',
          aisle: 'Pantry',
          qty: 2,
          unit: 'tbsp',
        }),
      ]),
      recipe('b', 'Roast', [
        line({
          ingredientId: OLIVE_OIL,
          name: 'olive oil',
          rawText: '1 cup olive oil',
          aisle: 'Pantry',
          qty: 1,
          unit: 'cup',
        }),
      ]),
    ]);

    const item = groups[0]!.items[0]!;
    expect(item.unit).toBe('cup');
    expect(item.qty).toBeCloseTo(1.125, 6);
  });

  it('orders aisles for the store walk, with Frozen and Other last', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Bowls', [
        line({ ingredientId: null, name: 'a pinch of something', rawText: 'a pinch of something', aisle: null, qty: null, unit: null }),
        line({ ingredientId: 'f0000000-0000-4000-8000-000000000001', name: 'frozen corn', rawText: '2 cups frozen corn', aisle: 'Frozen', qty: 2, unit: 'cup' }),
        line({ ingredientId: 'f0000000-0000-4000-8000-000000000002', name: 'limes', rawText: '2 limes', aisle: 'Produce', qty: 2, unit: '' }),
      ]),
    ]);

    expect(groups.map((g) => g.aisle)).toEqual(['Produce', 'Frozen', 'Other']);
    expect(countGroceryItems(groups)).toBe(3);
  });

  it('keeps an unquantified line renderable and marks the total approximate', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Stew', [
        line({ ingredientId: null, name: '', rawText: 'kosher salt, to taste', aisle: null, qty: null, unit: null }),
      ]),
    ]);

    const item = groups[0]!.items[0]!;
    expect(item.name).toBe('kosher salt, to taste');
    expect(item.qty).toBeNull();
    expect(item.amount).toBe('');
    expect(item.approximate).toBe(true);
  });

  it('marks a total approximate when only some lines carry a quantity', () => {
    const groups = aggregateGroceries([
      recipe('a', 'Roast', [line({ qty: 2, unit: 'lb' })]),
      recipe('b', 'Salad', [line({ qty: null, unit: null, rawText: 'chicken breast, as needed' })]),
    ]);

    const item = groups[0]!.items[0]!;
    expect(item.amount).toBe('2 lb');
    expect(item.approximate).toBe(true);
    expect(item.recipes).toHaveLength(2);
  });

  it('prefers the canonical name once any contributing row is mapped', () => {
    const groups = aggregateGroceries([
      recipe('a', 'One', [
        line({ ingredientId: null, name: '', rawText: '1 lb chicken breast', aisle: null }),
      ]),
      recipe('b', 'Two', [line({ qty: 1, unit: 'lb' })]),
    ]);

    // The unmapped row keys on its own text, so these stay separate lines —
    // but the mapped one shows the canonical name and the real aisle.
    const mapped = groups
      .flatMap((g) => g.items)
      .find((item) => item.key === `${CHICKEN}:mass`);
    expect(mapped?.name).toBe('chicken breast');
    expect(mapped?.aisle).toBe('Meat & Seafood');
  });

  it('flags an item optional only when every contributing line is', () => {
    const both = aggregateGroceries([
      recipe('a', 'One', [line({ optional: true })]),
      recipe('b', 'Two', [line({ optional: true })]),
    ]);
    expect(both[0]!.items[0]!.optional).toBe(true);

    const mixed = aggregateGroceries([
      recipe('a', 'One', [line({ optional: true })]),
      recipe('b', 'Two', [line({ optional: false })]),
    ]);
    expect(mixed[0]!.items[0]!.optional).toBe(false);
  });

  it('returns nothing for no saved recipes', () => {
    expect(aggregateGroceries([])).toEqual([]);
    expect(countGroceryItems([])).toBe(0);
  });
});

describe('groceryListToText', () => {
  const groups = aggregateGroceries([
    recipe('a', 'Chili', [
      line({ qty: 2, unit: 'lb' }),
      line({
        ingredientId: OLIVE_OIL,
        name: 'olive oil',
        rawText: 'olive oil, to taste',
        aisle: 'Pantry',
        qty: null,
        unit: null,
        optional: true,
      }),
    ]),
  ]);

  it('carries the aisle order, the amounts and the check marks', () => {
    const text = groceryListToText(groups, {
      checked: { [`${CHICKEN}:mass`]: true },
      recipeCount: 1,
      totalServings: 4,
    });

    expect(text).toBe(
      [
        'SHOPPING LIST',
        '1 recipe · 4 servings · 2 items',
        '',
        'MEAT & SEAFOOD',
        '[x] chicken breast — 2 lb',
        '',
        'PANTRY',
        '[ ] olive oil (optional)',
        '',
      ].join('\n'),
    );
  });

  it('needs no options and still says how many items there are', () => {
    expect(groceryListToText([])).toBe('SHOPPING LIST\n0 items\n');
  });
});

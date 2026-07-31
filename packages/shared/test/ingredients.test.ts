/**
 * The guard on the semantic mapper's `action: "existing"` claim.
 *
 * Every "rejects" case below is a mapping that was actually written into this
 * database by the Phase 2 run and found by the audit at the start of Phase 5
 * (PROGRESS.md amendment A18). Every "accepts" case is a mapping from the same
 * corpus that is genuinely correct and must keep working.
 */

import { describe, expect, it } from 'vitest';
import { ingredientAliasKey, isPlausibleCanonicalMatch } from '../src/ingredients';

describe('ingredientAliasKey', () => {
  it('is the storage form: trimmed, lower-case, single-spaced', () => {
    expect(ingredientAliasKey('  Flat-Leaf   Parsley ')).toBe('flat-leaf parsley');
  });
});

describe('isPlausibleCanonicalMatch', () => {
  it('rejects the collisions the live run produced', () => {
    const wrong: [string, string][] = [
      ['ketchup', 'kalamata olives'],
      ['tahini', 'taco seasoning'],
      ['tapioca flour', 'taco seasoning'],
      ['tamarind pulp', 'taco seasoning'],
      ['tequila', 'taco seasoning'],
      ['tender lettuce', 'taco seasoning'],
      ['medium head cauliflower', 'capers'],
      ['brandy or bourbon', 'brown rice'],
      ['branzino filets', 'brown rice'],
      ['burrata or fresh mozzarella cheese', 'brown rice'],
      ['chopped chives', 'chickpeas'],
      ['swiss chard', 'sweet potatoes'],
      ['large bunch flat-leaf parsley', 'mushrooms'],
      ['packed parsley leaves and tender stems', 'parsnips'],
      ['flaky sea salt for sprinkling', 'flat-leaf parsley'],
      ['blue cheese crumbles', 'feta'],
      ['dried ground sage', 'dried rosemary'],
      ['shelled', 'blanched'],
      ['spanish dry-cured chorizo', 'salami'],
      ['white wine vinegar', 'white rice'],
    ];

    for (const [input, canonical] of wrong) {
      expect(isPlausibleCanonicalMatch(input, canonical), `${input} -> ${canonical}`).toBe(
        false,
      );
    }
  });

  it('accepts a canonical that shares an identity word through any amount of prose', () => {
    const right: [string, string][] = [
      ['chopped fresh parsley', 'flat-leaf parsley'],
      ['neutral oil such as canola or vegetable oil', 'cooking oil'],
      ['homemade chicken stock or store-bought low-sodium chicken broth', 'chicken broth'],
      ['loosely packed fresh mint leaves', 'fresh mint'],
      ['1 large egg', 'eggs'],
      ['thinly sliced shallots', 'shallot'],
      ['firm plum or roma tomatoes', 'tomatoes'],
      ['nigerian garden eggs or thai eggplants', 'eggplant'],
      ['orange zest from about half a large orange', 'orange zest'],
      ['jalapeno pepper', 'jalapeño'],
      ['long-grain fragrant rice', 'jasmine rice'],
    ];

    for (const [input, canonical] of right) {
      expect(isPlausibleCanonicalMatch(input, canonical), `${input} -> ${canonical}`).toBe(
        true,
      );
    }
  });

  it('accepts an abbreviation that prefixes the canonical', () => {
    expect(isPlausibleCanonicalMatch('mayo', 'mayonnaise')).toBe(true);
    expect(isPlausibleCanonicalMatch('kiwifruit', 'kiwi')).toBe(true);
    // Three letters is too little to mean anything: `cab` must not reach
    // `cabbage` by the same route that `mayo` reaches `mayonnaise`, or the
    // rule stops discriminating.
    expect(isPlausibleCanonicalMatch('bay leaves', 'bacon')).toBe(false);
  });

  it('is reflexive and survives casing and spacing', () => {
    expect(isPlausibleCanonicalMatch('kosher salt', 'kosher salt')).toBe(true);
    expect(isPlausibleCanonicalMatch('  Kosher  Salt ', 'kosher salt')).toBe(true);
  });

  it('rejects a true synonym that shares no words, and that is the intended trade', () => {
    // A missed merge is two lines on the receipt. A wrong merge is a quantity
    // nobody can see is wrong. These are already learned aliases in the live
    // database, matched exactly long before this guard runs.
    expect(isPlausibleCanonicalMatch('green onions', 'scallions')).toBe(false);
    expect(isPlausibleCanonicalMatch('garbanzo beans', 'chickpeas')).toBe(false);
  });

  it('does not merge two names that overlap only on prep or colour words', () => {
    expect(isPlausibleCanonicalMatch('chopped fresh dill', 'chopped fresh cilantro')).toBe(
      false,
    );
    expect(isPlausibleCanonicalMatch('red onion', 'red cabbage')).toBe(false);
  });

  it('rejects an empty name rather than matching everything', () => {
    expect(isPlausibleCanonicalMatch('', 'kosher salt')).toBe(false);
    expect(isPlausibleCanonicalMatch('kosher salt', '   ')).toBe(false);
  });
});

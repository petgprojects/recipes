/**
 * Extraction pinned against the real pages in `test/fixtures/`.
 *
 * PLAN.md §5 calls this the highest-value test surface in the project, because
 * this is where wrongness is silent: an extractor that quietly starts
 * returning `servings: null` for one source looks exactly like an extractor
 * that works. So the expectations below are the *actual values* from the
 * committed pages, not shape checks.
 *
 * No network. Re-run `pnpm --filter @recipes/worker capture` to refresh the
 * fixtures, then `coverage` to see what changed upstream.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractRecipeFromHtml, toRecipeDraft } from '../src/scanner/jsonld';

const fixturesDir = join(import.meta.dirname, 'fixtures');

const read = (site: string, file: string): string =>
  readFileSync(join(fixturesDir, site, file), 'utf8');

const extract = (site: string, file: string) => {
  const manifest = JSON.parse(read(site, 'manifest.json')) as {
    pages: { file: string; url: string }[];
  };
  const url = manifest.pages.find((page) => page.file === file)?.url;
  return extractRecipeFromHtml(read(site, file), url);
};

interface Expectation {
  site: string;
  file: string;
  title: string;
  ingredients: number;
  firstIngredient: string;
  steps: number;
  totalMinutes: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  servings: number | null;
  yieldText: string | null;
  rating: { value: number; count: number } | null;
  author: string;
  missing: string[];
}

/** Every recipe page we captured, with what it really contains. */
const EXPECTED: Expectation[] = [
  {
    site: 'budget-bytes',
    file: 'page-1.html',
    title: 'Easy Kale Salad',
    ingredients: 11,
    firstIngredient: '½ lb. chopped kale (about one bunch, $1.24*)',
    steps: 7,
    totalMinutes: 20,
    prepMinutes: 20,
    cookMinutes: null,
    servings: 4,
    yieldText: '4 servings',
    rating: { value: 4.87, count: 44 },
    author: 'Beth Moncel',
    missing: [],
  },
  {
    site: 'budget-bytes',
    file: 'page-2.html',
    title: 'Bruschetta Chicken',
    ingredients: 14,
    firstIngredient: '4 Roma tomatoes (diced, (340g) $0.88)',
    steps: 6,
    totalMinutes: 25,
    prepMinutes: 10,
    cookMinutes: 15,
    servings: 4,
    yieldText: '4 servings',
    rating: null,
    author: 'Jennie Alley',
    missing: ['rating'],
  },
  {
    site: 'budget-bytes',
    file: 'page-3.html',
    title: 'Oven Baked Chicken Drumsticks',
    ingredients: 9,
    firstIngredient: '1 tsp smoked paprika ($0.08)',
    steps: 4,
    totalMinutes: 45,
    prepMinutes: 5,
    cookMinutes: 40,
    servings: 6,
    yieldText: '6 pieces',
    rating: { value: 4.83, count: 74 },
    author: 'Beth Moncel',
    missing: [],
  },
  {
    site: 'downshiftology',
    file: 'page-4.html',
    title: 'Chicken Piccata',
    ingredients: 14,
    firstIngredient: '2 large boneless skinless chicken breasts',
    steps: 6,
    totalMinutes: 30,
    prepMinutes: 10,
    cookMinutes: 20,
    servings: 4,
    yieldText: '4 servings',
    rating: { value: 4.98, count: 99 },
    author: 'Lisa Bryan',
    missing: [],
  },
  {
    site: 'downshiftology',
    file: 'page-5.html',
    title: 'Greek Baked Cod',
    ingredients: 15,
    firstIngredient: '4 cod filets',
    steps: 5,
    totalMinutes: 40,
    prepMinutes: 15,
    cookMinutes: 25,
    servings: 4,
    yieldText: '4',
    rating: { value: 5, count: 1 },
    author: 'Lisa Bryan',
    missing: [],
  },
  {
    site: 'gypsyplate',
    file: 'page-1.html',
    title: 'Summer Detox Chicken Buddha Bowl',
    ingredients: 28,
    firstIngredient: '1 avocado',
    steps: 13,
    totalMinutes: 60,
    prepMinutes: 30,
    cookMinutes: 30,
    servings: 6,
    yieldText: '6',
    rating: { value: 5, count: 50 },
    author: 'GypsyPlate',
    missing: [],
  },
  {
    site: 'gypsyplate',
    file: 'page-2.html',
    title: 'Greek Steak Salad Bowl',
    ingredients: 29,
    firstIngredient: '¾ cup Olive Oil',
    steps: 5,
    totalMinutes: 40,
    prepMinutes: 15,
    cookMinutes: 25,
    servings: 4,
    yieldText: '4',
    rating: { value: 5, count: 35 },
    author: 'GypsyPlate',
    missing: [],
  },
  {
    site: 'gypsyplate',
    file: 'page-3.html',
    title: 'Easy Baked Sweet Potato Fries',
    ingredients: 7,
    firstIngredient: '1 lb sweet potatoes',
    steps: 6,
    // The source publishes totalTime=PT1H10M with prep 10 + cook 30; we keep
    // its number rather than "fixing" the arithmetic.
    totalMinutes: 70,
    prepMinutes: 10,
    cookMinutes: 30,
    servings: 4,
    yieldText: '4',
    rating: { value: 5, count: 8 },
    author: 'GypsyPlate',
    missing: [],
  },
  {
    site: 'love-and-lemons',
    file: 'page-1.html',
    title: 'Peach Crisp Recipe',
    ingredients: 12,
    firstIngredient: '6 ripe peaches (pitted and sliced (5 cups))',
    steps: 5,
    totalMinutes: 45,
    prepMinutes: 15,
    cookMinutes: 30,
    servings: 6,
    yieldText: '6',
    rating: { value: 4.98, count: 102 },
    author: 'Jeanine Donofrio, Phoebe Moore',
    missing: [],
  },
  {
    site: 'love-and-lemons',
    file: 'page-2.html',
    title: 'Caprese Gnocchi',
    ingredients: 11,
    firstIngredient: '1 pound store-bought gnocchi',
    steps: 3,
    totalMinutes: 30,
    prepMinutes: 10,
    cookMinutes: 20,
    servings: 4,
    yieldText: '4',
    rating: { value: 5, count: 1 },
    author: 'Jeanine Donofrio, Phoebe Moore',
    missing: [],
  },
  {
    site: 'love-and-lemons',
    file: 'page-3.html',
    title: 'Whipped Cottage Cheese',
    ingredients: 10,
    firstIngredient: '16 ounces whole milk cottage cheese',
    steps: 2,
    totalMinutes: 5,
    prepMinutes: 5,
    cookMinutes: null,
    servings: 4,
    // A range yield: we take the lower bound and keep the text.
    yieldText: '4 to 6',
    rating: { value: 5, count: 5 },
    author: 'Jeanine Donofrio, Phoebe Moore',
    missing: [],
  },
  {
    site: 'pinch-of-yum',
    file: 'page-1.html',
    title: 'Easy Strawberry Pie',
    ingredients: 11,
    firstIngredient: '12 full sheets graham crackers, crushed (1 1/2 cups of crumbs)',
    steps: 7,
    // 6h "prep" is chill time. Real data, and exactly why activeMinutes from
    // prepTime is a proxy and not a promise.
    totalMinutes: 365,
    prepMinutes: 360,
    cookMinutes: 5,
    servings: 8,
    yieldText: '8 large slices',
    rating: { value: 4.8, count: 13 },
    author: 'Lindsay Ostrom',
    missing: [],
  },
  {
    site: 'pinch-of-yum',
    file: 'page-3.html',
    title: 'Chicken Caesar Smash Tacos',
    ingredients: 15,
    firstIngredient: '½ cup mayo',
    steps: 6,
    totalMinutes: 25,
    prepMinutes: 10,
    cookMinutes: 15,
    servings: 4,
    yieldText: '4 servings',
    rating: { value: 5, count: 16 },
    author: 'Lindsay Ostrom',
    missing: [],
  },
  {
    site: 'serious-eats',
    file: 'page-1.html',
    title: 'Vermouth Preparado (Marianito)',
    ingredients: 6,
    firstIngredient: '4 fluid ounces sweet red vermouth (1/2 cup; 120 ml)',
    steps: 1,
    // A cocktail with no times and no yield at all — the sparsest real page
    // in the corpus, and a good example of what Phase 2 has to finish.
    totalMinutes: null,
    prepMinutes: null,
    cookMinutes: null,
    servings: null,
    yieldText: null,
    rating: null,
    author: 'Daniel Gritzer',
    missing: ['servings', 'totalMinutes', 'activeMinutes', 'rating'],
  },
  {
    site: 'serious-eats',
    file: 'page-2.html',
    title: 'Shrimp With Chorizo-Tomato Sauce',
    ingredients: 15,
    firstIngredient: '2 pounds extra-large shrimp, peeled, deveined, and tails removed (see notes)',
    steps: 6,
    totalMinutes: 30,
    prepMinutes: 5,
    cookMinutes: 25,
    servings: 6,
    yieldText: '6',
    rating: null,
    author: 'Amanda Luchtel',
    missing: ['rating'],
  },
  {
    site: 'serious-eats',
    file: 'page-3.html',
    title: 'Spicy Grilled Watermelon',
    ingredients: 6,
    firstIngredient: '1/4 cup honey',
    steps: 4,
    totalMinutes: 10,
    prepMinutes: 5,
    cookMinutes: 5,
    servings: 12,
    yieldText: '12',
    rating: null,
    author: 'Joshua Bousel',
    missing: ['rating'],
  },
  {
    site: 'skinnytaste',
    file: 'page-1.html',
    title: 'Shrimp and Pineapple Skewers',
    ingredients: 9,
    firstIngredient: '2 teaspoons sambal oelek (or sriracha)',
    steps: 6,
    totalMinutes: 30,
    prepMinutes: 20,
    cookMinutes: 6,
    servings: 4,
    yieldText: '4 servings',
    rating: null,
    author: 'Gina Homolka',
    missing: ['rating'],
  },
  {
    site: 'skinnytaste',
    file: 'page-3.html',
    title: 'Zucchini Fritters With Feta and Mint',
    ingredients: 10,
    firstIngredient: '3 medium zucchini (about 1½ pounds)',
    steps: 8,
    totalMinutes: 30,
    prepMinutes: 15,
    cookMinutes: 15,
    servings: 8,
    yieldText: '8 servings',
    rating: { value: 4.6, count: 44 },
    author: 'Gina Homolka',
    missing: [],
  },
  {
    site: 'the-kitchn',
    file: 'page-1.html',
    title: 'Monti Carlo’s Caribbean Cowboy Caviar',
    ingredients: 16,
    firstIngredient: '3 tablespoons olive oil',
    steps: 4,
    totalMinutes: 20,
    prepMinutes: 20,
    cookMinutes: null,
    servings: 6,
    yieldText: '6',
    rating: null,
    author: 'Andrea Rivera Wawrzyn',
    missing: ['rating'],
  },
  {
    site: 'the-kitchn',
    file: 'page-2.html',
    title: 'Kalua Pork',
    ingredients: 6,
    firstIngredient:
      '1 (3 1/2-pound) boneless pork shoulder or pork butt roast, preferably with a fat cap',
    steps: 8,
    totalMinutes: 200,
    prepMinutes: 20,
    cookMinutes: 180,
    servings: 8,
    yieldText: '8',
    rating: null,
    author: 'Alana Kysar',
    missing: ['rating'],
  },
  {
    site: 'the-kitchn',
    file: 'page-3.html',
    title: 'Frozen Peanut Butter Bars',
    ingredients: 9,
    firstIngredient: 'Cooking spray',
    steps: 9,
    totalMinutes: 40,
    prepMinutes: 40,
    cookMinutes: null,
    servings: 16,
    yieldText: '16',
    rating: null,
    author: 'Molly Allen',
    missing: ['rating'],
  },
];

describe.each(EXPECTED)('$site $file', (expected) => {
  const result = extract(expected.site, expected.file);
  const recipe = result.recipe;

  it('finds exactly one Recipe node', () => {
    expect(result.found).toBe(true);
    expect(result.stats.recipeNodes).toBe(1);
    expect(result.stats.malformed).toBe(0);
  });

  it('extracts the title, ingredients and steps', () => {
    expect(recipe?.title).toBe(expected.title);
    expect(recipe?.ingredients).toHaveLength(expected.ingredients);
    expect(recipe?.ingredients[0]).toBe(expected.firstIngredient);
    expect(recipe?.instructions).toHaveLength(expected.steps);
    expect(recipe?.instructions.every((step) => step.text.length > 0)).toBe(true);
  });

  it('extracts times, yield, rating and author', () => {
    expect(recipe?.totalMinutes).toBe(expected.totalMinutes);
    expect(recipe?.prepMinutes).toBe(expected.prepMinutes);
    expect(recipe?.cookMinutes).toBe(expected.cookMinutes);
    expect(recipe?.servings).toBe(expected.servings);
    expect(recipe?.yieldText).toBe(expected.yieldText);
    expect(recipe?.rating).toEqual(expected.rating);
    expect(recipe?.author).toBe(expected.author);
  });

  it('reports exactly the fields the page did not publish', () => {
    expect(recipe?.missing.sort()).toEqual([...expected.missing].sort());
  });

  it('carries a usable image URL and the raw node', () => {
    expect(recipe?.imageUrl).toMatch(/^https:\/\//);
    expect(Object.keys(recipe?.raw ?? {}).length).toBeGreaterThan(5);
  });

  it('produces an insertable draft with a 64-char content hash', () => {
    const draft = toRecipeDraft(recipe!, `https://example.test/${expected.site}/${expected.file}`);
    expect(draft).not.toBeNull();
    expect(draft?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(draft?.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(draft?.ingredients).toHaveLength(expected.ingredients);
    // Phase 1 must not invent the fields Phase 2 owns.
    expect(Object.keys(draft ?? {})).not.toContain('category');
    expect(Object.keys(draft ?? {})).not.toContain('tags');
  });
});

describe('structural oddities in the real corpus', () => {
  it('flattens The Kitchn HowToSections, keeping the section heading per step', () => {
    const recipe = extract('the-kitchn', 'page-1.html').recipe!;
    expect([...new Set(recipe.instructions.map((step) => step.name))]).toEqual([
      'Make the dressing:',
      'Make the salad:',
    ]);
  });

  it('keeps Budget Bytes per-step HowToStep names as headings', () => {
    const recipe = extract('budget-bytes', 'page-1.html').recipe!;
    expect(recipe.instructions[1]?.name).toBe('Prep the kale');
    expect(recipe.instructions[0]?.name).toBeNull(); // "Gather" repeats its text
  });

  it('resolves a Yoast @id author reference into a real name', () => {
    // The Recipe node only holds {"@id": ".../schema/person/…"}; the Person is
    // a sibling in the same @graph.
    const raw = extract('skinnytaste', 'page-1.html').recipe!.raw;
    expect(raw['author']).toHaveProperty('@id');
    expect(extract('skinnytaste', 'page-1.html').recipe!.author).toBe('Gina Homolka');
  });

  it('takes the lower bound of a range yield', () => {
    const recipe = extract('love-and-lemons', 'page-3.html').recipe!;
    expect(recipe.yieldText).toBe('4 to 6');
    expect(recipe.servings).toBe(4);
  });

  it('reads a non-serving yield ("6 pieces") as a count without lying about it', () => {
    const recipe = extract('budget-bytes', 'page-3.html').recipe!;
    expect(recipe.yieldText).toBe('6 pieces');
    expect(recipe.servings).toBe(6);
  });
});

describe('pages that carry no Recipe JSON-LD', () => {
  it.each([
    ['downshiftology', 'page-1.html'],
    ['downshiftology', 'page-2.html'],
    ['downshiftology', 'page-3.html'],
    ['pinch-of-yum', 'page-2.html'],
    ['skinnytaste', 'page-2.html'],
  ])('%s %s reports no recipe rather than a hollow one', (site, file) => {
    const result = extract(site, file);
    expect(result.found).toBe(false);
    expect(result.recipe).toBeNull();
    expect(result.stats.recipeNodes).toBe(0);
    // The pages do have JSON-LD — it is just Article/BreadcrumbList/ItemList.
    expect(result.stats.blocks).toBeGreaterThan(0);
  });

  it('finds Recipe JSON-LD on 21 of the 26 captured pages', () => {
    const manifests = [
      'budget-bytes',
      'downshiftology',
      'gypsyplate',
      'love-and-lemons',
      'pinch-of-yum',
      'serious-eats',
      'skinnytaste',
      'the-kitchn',
    ].map((site) => ({
      site,
      pages: (JSON.parse(read(site, 'manifest.json')) as { pages: { file: string }[] }).pages,
    }));

    const results = manifests.flatMap(({ site, pages }) =>
      pages.map((page) => extract(site, page.file).found),
    );

    expect(results).toHaveLength(26);
    expect(results.filter(Boolean)).toHaveLength(21);
  });
});

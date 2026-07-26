/**
 * JSON-LD extraction, unit by unit and shape by shape.
 *
 * The fixture suite (`fixtures.test.ts`) proves we handle the pages we have
 * seen. This file proves we handle the shapes schema.org permits but our nine
 * sources happen not to use — which is what the tenth source will use.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRefIndex,
  collectJsonLdBlocks,
  computeContentHash,
  extractAuthor,
  extractImages,
  extractInstructions,
  extractRating,
  extractRecipeFromHtml,
  flattenNodes,
  parseDate,
  parseDurationMinutes,
  parseJsonLoosely,
  parseYield,
  toRecipeDraft,
  typeOf,
} from '../src/scanner/jsonld';

/** Wrap a JSON-LD payload in the smallest page that can carry it. */
const page = (jsonld: string): string =>
  `<!DOCTYPE html><html><head><script type="application/ld+json">${jsonld}</script></head><body></body></html>`;

const MINIMAL = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Test Recipe',
  recipeIngredient: ['1 cup flour', '2 eggs'],
  recipeInstructions: 'Mix and bake.',
};

describe('parseDurationMinutes', () => {
  it.each([
    ['PT35M', 35],
    ['PT1H', 60],
    ['PT1H30M', 90],
    ['PT2H15M30S', 136],
    ['P0DT0H35M', 35],
    ['P1DT2H', 1_560],
    ['P1W', 10_080],
    ['pt45m', 45],
    ['PT0.5H', 30],
    ['PT1,5H', 90],
  ])('parses %s as %i minutes', (input, expected) => {
    expect(parseDurationMinutes(input)).toBe(expected);
  });

  it.each([
    ['PT0S'],
    ['PT'],
    ['P'],
    [''],
    ['   '],
    ['-PT30M'],
    ['banana'],
    [null],
    [undefined],
    [{}],
    [0],
    [-5],
  ])('returns null for %o', (input) => {
    expect(parseDurationMinutes(input)).toBeNull();
  });

  it('accepts the non-conforming forms sites actually publish', () => {
    expect(parseDurationMinutes(45)).toBe(45);
    expect(parseDurationMinutes('45')).toBe(45);
    expect(parseDurationMinutes('1 hour 20 minutes')).toBe(80);
    expect(parseDurationMinutes('1 hr 5 mins')).toBe(65);
    expect(parseDurationMinutes({ '@type': 'Duration', value: 'PT25M' })).toBe(25);
    expect(parseDurationMinutes(['', 'PT15M'])).toBe(15);
  });
});

describe('parseYield', () => {
  it.each([
    ['6 servings', 6, '6 servings'],
    ['6', 6, '6'],
    ['Serves 4', 4, 'Serves 4'],
    ['12 muffins', 12, '12 muffins'],
    ['about 8 tacos', 8, 'about 8 tacos'],
  ])('reads %s as %i servings', (input, servings, text) => {
    expect(parseYield(input)).toEqual({ servings, text });
  });

  it('takes the lower bound of a range', () => {
    expect(parseYield('4-6 servings').servings).toBe(4);
    expect(parseYield('4 to 6').servings).toBe(4);
    expect(parseYield('4–6 servings').servings).toBe(4);
  });

  it('accepts a number', () => {
    expect(parseYield(8)).toEqual({ servings: 8, text: '8' });
  });

  it('prefers the array entry that parses, keeping the longest text', () => {
    expect(parseYield(['6', '6 servings'])).toEqual({ servings: 6, text: '6 servings' });
  });

  it('refuses to call a volume or weight a serving count', () => {
    expect(parseYield('4 1/2 cups')).toEqual({ servings: null, text: '4 1/2 cups' });
    expect(parseYield('2 pounds')).toEqual({ servings: null, text: '2 pounds' });
    expect(parseYield('1 quart')).toEqual({ servings: null, text: '1 quart' });
  });

  it('keeps unquantified text without inventing a number', () => {
    expect(parseYield('a crowd')).toEqual({ servings: null, text: 'a crowd' });
    expect(parseYield(null)).toEqual({ servings: null, text: null });
  });

  it('unwraps a QuantitativeValue object', () => {
    expect(parseYield({ '@type': 'QuantitativeValue', value: '4' }).servings).toBe(4);
  });
});

describe('@type handling', () => {
  it('accepts a string, an array, and a full IRI', () => {
    expect(typeOf({ '@type': 'Recipe' })).toEqual(['recipe']);
    expect(typeOf({ '@type': ['Recipe', 'NewsArticle'] })).toEqual(['recipe', 'newsarticle']);
    expect(typeOf({ '@type': 'http://schema.org/Recipe' })).toEqual(['recipe']);
    expect(typeOf({ '@type': 'https://schema.org/Recipe' })).toEqual(['recipe']);
  });

  it('finds a Recipe whose @type is an array', () => {
    const result = extractRecipeFromHtml(
      page(JSON.stringify({ ...MINIMAL, '@type': ['NewsArticle', 'Recipe'] })),
    );
    expect(result.found).toBe(true);
    expect(result.recipe?.title).toBe('Test Recipe');
  });

  it('finds a Recipe whose @type is the full IRI', () => {
    const result = extractRecipeFromHtml(
      page(JSON.stringify({ ...MINIMAL, '@type': 'http://schema.org/Recipe' })),
    );
    expect(result.found).toBe(true);
  });
});

describe('document shapes', () => {
  it('handles a bare object', () => {
    expect(extractRecipeFromHtml(page(JSON.stringify(MINIMAL))).found).toBe(true);
  });

  it('handles a top-level array', () => {
    const result = extractRecipeFromHtml(
      page(JSON.stringify([{ '@type': 'Organization', name: 'Blog' }, MINIMAL])),
    );
    expect(result.found).toBe(true);
    expect(result.stats.recipeNodes).toBe(1);
  });

  it('handles an @graph wrapper', () => {
    const result = extractRecipeFromHtml(
      page(
        JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [{ '@type': 'WebSite' }, { '@type': 'WebPage' }, MINIMAL],
        }),
      ),
    );
    expect(result.found).toBe(true);
    expect(result.stats.nodes).toBeGreaterThanOrEqual(4);
  });

  it('handles a Recipe nested under mainEntity', () => {
    const result = extractRecipeFromHtml(
      page(JSON.stringify({ '@type': 'WebPage', mainEntity: MINIMAL })),
    );
    expect(result.found).toBe(true);
  });

  it('handles several blocks, one of which is the recipe', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
      <script type="application/ld+json">${JSON.stringify(MINIMAL)}</script>
      <script type="application/json">{"not":"jsonld"}</script>
    </head></html>`;
    const result = extractRecipeFromHtml(html);
    expect(result.stats.blocks).toBe(2);
    expect(result.found).toBe(true);
  });

  it('keeps going when one block is malformed, and counts it', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">${JSON.stringify(MINIMAL)}</script>
    </head></html>`;
    const result = extractRecipeFromHtml(html);
    expect(result.stats.malformed).toBe(1);
    expect(result.found).toBe(true);
  });

  it('reports a page with no JSON-LD at all instead of throwing', () => {
    const result = extractRecipeFromHtml('<html><body><h1>A blog post</h1></body></html>');
    expect(result.found).toBe(false);
    expect(result.recipe).toBeNull();
    expect(result.stats.blocks).toBe(0);
    expect(result.missing).toContain('ingredients');
  });

  it('reports JSON-LD that contains no Recipe', () => {
    const result = extractRecipeFromHtml(page(JSON.stringify({ '@type': 'Article', name: 'x' })));
    expect(result.found).toBe(false);
    expect(result.stats.nodes).toBe(1);
    expect(result.stats.recipeNodes).toBe(0);
  });

  it('prefers the most complete Recipe node when a page has several', () => {
    const stub = { '@type': 'Recipe', name: 'Stub' };
    const full = { ...MINIMAL, name: 'Full' };
    const result = extractRecipeFromHtml(page(JSON.stringify([stub, full])));
    expect(result.recipe?.title).toBe('Full');
  });

  it('does not spin on a self-referential graph', () => {
    const nodes = flattenNodes([JSON.parse('{"@graph":[{"@type":"Recipe","name":"x"}]}')]);
    expect(nodes.length).toBeLessThan(10);
  });
});

describe('parseJsonLoosely', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips CDATA guards and HTML comment wrappers', () => {
    expect(parseJsonLoosely('<!--{"a":1}-->')).toEqual({ a: 1 });
    expect(parseJsonLoosely('/*<![CDATA[*/{"a":1}/*]]>*/')).toEqual({ a: 1 });
  });

  it('escapes raw newlines inside a string, which plugins emit constantly', () => {
    expect(parseJsonLoosely('{"description":"line one\nline two"}')).toEqual({
      description: 'line one\nline two',
    });
  });

  it('gives up rather than guessing', () => {
    expect(parseJsonLoosely('{ unquoted: key }')).toBeUndefined();
    expect(parseJsonLoosely('')).toBeUndefined();
  });
});

describe('image', () => {
  it('accepts a string', () => {
    expect(extractImages('https://x.test/a.jpg')).toEqual(['https://x.test/a.jpg']);
  });

  it('accepts an array of strings and keeps order', () => {
    expect(extractImages(['https://x.test/a.jpg', 'https://x.test/b.jpg'])[0]).toBe(
      'https://x.test/a.jpg',
    );
  });

  it('accepts an ImageObject and an array of them', () => {
    expect(extractImages({ '@type': 'ImageObject', url: 'https://x.test/a.jpg' })).toEqual([
      'https://x.test/a.jpg',
    ]);
    expect(extractImages([{ contentUrl: 'https://x.test/c.jpg' }])).toEqual(['https://x.test/c.jpg']);
  });

  it('resolves a relative URL against the page', () => {
    expect(extractImages('/img/a.jpg', 'https://x.test/recipes/kale/')).toEqual([
      'https://x.test/img/a.jpg',
    ]);
  });

  it('follows an @id reference to an ImageObject elsewhere in the graph', () => {
    const refs = buildRefIndex([
      { '@id': 'https://x.test/#img', '@type': 'ImageObject', url: 'https://x.test/hero.jpg' },
    ]);
    expect(extractImages({ '@id': 'https://x.test/#img' }, undefined, refs)).toEqual([
      'https://x.test/hero.jpg',
    ]);
  });

  it('ignores junk without throwing', () => {
    expect(extractImages(null)).toEqual([]);
    expect(extractImages(42)).toEqual([]);
    expect(extractImages('not a url')).toEqual([]);
  });
});

describe('author', () => {
  it('accepts a string', () => {
    expect(extractAuthor('Beth Moncel')).toBe('Beth Moncel');
  });

  it('accepts a Person object', () => {
    expect(extractAuthor({ '@type': 'Person', name: 'Lisa Bryan' })).toBe('Lisa Bryan');
  });

  it('joins an array of authors', () => {
    expect(extractAuthor([{ name: 'Jeanine' }, { name: 'Phoebe' }])).toBe('Jeanine, Phoebe');
  });

  it('follows an @id reference into the graph — the Yoast shape', () => {
    const refs = buildRefIndex([
      { '@id': 'https://x.test/#/schema/person/ab12', '@type': 'Person', name: 'Gina Homolka' },
    ]);
    expect(extractAuthor({ '@id': 'https://x.test/#/schema/person/ab12' }, refs)).toBe(
      'Gina Homolka',
    );
  });

  it('returns null for an unresolvable reference rather than the raw @id', () => {
    expect(extractAuthor({ '@id': 'https://x.test/#/schema/person/missing' })).toBeNull();
  });

  it('strips markup and decodes entities', () => {
    expect(extractAuthor('<a href="/x">Beth &amp; Co</a>')).toBe('Beth & Co');
  });
});

describe('instructions', () => {
  it('treats a plain string as one step', () => {
    expect(extractInstructions('Mix and bake.')).toEqual([{ name: null, text: 'Mix and bake.' }]);
  });

  it('splits an HTML list into steps', () => {
    expect(extractInstructions('<ol><li>Chop.</li><li>Fry.</li></ol>')).toEqual([
      { name: null, text: 'Chop.' },
      { name: null, text: 'Fry.' },
    ]);
  });

  it('splits hard line breaks into steps', () => {
    expect(extractInstructions('Chop.\nFry.\n\nServe.')).toHaveLength(3);
  });

  it('reads an array of strings', () => {
    expect(extractInstructions(['Chop.', 'Fry.'])).toHaveLength(2);
  });

  it('reads HowToStep[]', () => {
    expect(
      extractInstructions([
        { '@type': 'HowToStep', text: 'Chop.' },
        { '@type': 'HowToStep', text: 'Fry.' },
      ]),
    ).toEqual([
      { name: null, text: 'Chop.' },
      { name: null, text: 'Fry.' },
    ]);
  });

  it('keeps a HowToStep name only when it is a heading, not a repeat of the text', () => {
    expect(extractInstructions([{ '@type': 'HowToStep', name: 'Prep the kale', text: 'Chop it.' }])).toEqual(
      [{ name: 'Prep the kale', text: 'Chop it.' }],
    );
    expect(
      extractInstructions([{ '@type': 'HowToStep', name: 'Chop it.', text: 'Chop it. Then rinse.' }]),
    ).toEqual([{ name: null, text: 'Chop it. Then rinse.' }]);
  });

  it('flattens HowToSection into ordered steps carrying the section heading', () => {
    const steps = extractInstructions([
      {
        '@type': 'HowToSection',
        name: 'For the sauce',
        itemListElement: [
          { '@type': 'HowToStep', text: 'Whisk.' },
          { '@type': 'HowToStep', text: 'Simmer.' },
        ],
      },
      {
        '@type': 'HowToSection',
        name: 'To serve',
        itemListElement: [{ '@type': 'HowToStep', text: 'Plate.' }],
      },
    ]);

    expect(steps).toEqual([
      { name: 'For the sauce', text: 'Whisk.' },
      { name: 'For the sauce', text: 'Simmer.' },
      { name: 'To serve', text: 'Plate.' },
    ]);
  });

  it('handles sections and loose steps mixed in one array', () => {
    const steps = extractInstructions([
      { '@type': 'HowToStep', text: 'Preheat.' },
      {
        '@type': 'HowToSection',
        name: 'Assembly',
        itemListElement: [{ '@type': 'HowToStep', text: 'Layer.' }],
      },
    ]);
    expect(steps).toEqual([
      { name: null, text: 'Preheat.' },
      { name: 'Assembly', text: 'Layer.' },
    ]);
  });

  it('handles a section nested two levels deep', () => {
    const steps = extractInstructions([
      {
        '@type': 'HowToSection',
        name: 'Outer',
        itemListElement: {
          '@type': 'ItemList',
          itemListElement: [{ '@type': 'HowToStep', text: 'Deep step.' }],
        },
      },
    ]);
    expect(steps).toEqual([{ name: 'Outer', text: 'Deep step.' }]);
  });

  it('strips markup and decodes entities inside step text', () => {
    expect(
      extractInstructions([{ '@type': 'HowToStep', text: 'Heat <b>oil</b> &amp; add&nbsp;garlic.' }]),
    ).toEqual([{ name: null, text: 'Heat oil & add garlic.' }]);
  });

  it('returns an empty list, not a fake step, when there are no instructions', () => {
    expect(extractInstructions(undefined)).toEqual([]);
    expect(extractInstructions([])).toEqual([]);
    expect(extractInstructions('')).toEqual([]);
  });
});

describe('aggregateRating', () => {
  it('reads numeric and string values', () => {
    expect(extractRating({ ratingValue: 4.8, ratingCount: 24 })).toEqual({ value: 4.8, count: 24 });
    expect(extractRating({ ratingValue: '4.8', ratingCount: '24' })).toEqual({
      value: 4.8,
      count: 24,
    });
  });

  it('falls back to reviewCount', () => {
    expect(extractRating({ ratingValue: '5', reviewCount: '3' })?.count).toBe(3);
  });

  it('treats a 0/0 placeholder as no rating', () => {
    expect(extractRating({ ratingValue: '0', ratingCount: '0' })).toBeNull();
  });

  it('returns null when absent', () => {
    expect(extractRating(undefined)).toBeNull();
    expect(extractRating('4.8')).toBeNull();
  });
});

describe('datePublished', () => {
  it('parses ISO dates', () => {
    expect(parseDate('2026-07-25T10:00:00Z')?.toISOString()).toBe('2026-07-25T10:00:00.000Z');
  });

  it('rejects placeholders and junk', () => {
    expect(parseDate('0000-00-00')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('soon')).toBeNull();
    expect(parseDate('1900-01-01')).toBeNull();
  });
});

describe('missing fields and partial results', () => {
  it('reports what a sparse recipe did not publish, and invents nothing', () => {
    const result = extractRecipeFromHtml(page(JSON.stringify(MINIMAL)));
    const recipe = result.recipe;

    expect(recipe).not.toBeNull();
    expect(recipe?.title).toBe('Test Recipe');
    expect(recipe?.ingredients).toEqual(['1 cup flour', '2 eggs']);
    expect(recipe?.servings).toBeNull();
    expect(recipe?.totalMinutes).toBeNull();
    expect(recipe?.rating).toBeNull();
    expect(recipe?.missing).toEqual(
      expect.arrayContaining(['imageUrl', 'servings', 'totalMinutes', 'rating', 'author', 'publishedAt']),
    );
    expect(recipe?.missing).not.toContain('ingredients');
  });

  it('derives totalTime from prep + cook when the source omits it', () => {
    const result = extractRecipeFromHtml(
      page(JSON.stringify({ ...MINIMAL, prepTime: 'PT10M', cookTime: 'PT20M' })),
    );
    expect(result.recipe?.totalMinutes).toBe(30);
    expect(result.recipe?.activeMinutes).toBe(10);
  });

  it('keeps the raw node verbatim for recipes.raw_jsonld', () => {
    const result = extractRecipeFromHtml(page(JSON.stringify({ ...MINIMAL, nutrition: { calories: '200' } })));
    expect(result.recipe?.raw['nutrition']).toEqual({ calories: '200' });
    expect(result.recipe?.raw['@type']).toBe('Recipe');
  });
});

describe('computeContentHash', () => {
  const base = extractRecipeFromHtml(page(JSON.stringify(MINIMAL))).recipe!;

  it('is stable across identical extractions', () => {
    const again = extractRecipeFromHtml(page(JSON.stringify(MINIMAL))).recipe!;
    expect(again.contentHash).toBe(base.contentHash);
  });

  it('ignores key order in the source JSON', () => {
    const reordered = extractRecipeFromHtml(
      page(
        JSON.stringify({
          recipeInstructions: MINIMAL.recipeInstructions,
          recipeIngredient: MINIMAL.recipeIngredient,
          name: MINIMAL.name,
          '@type': 'Recipe',
        }),
      ),
    ).recipe!;
    expect(reordered.contentHash).toBe(base.contentHash);
  });

  it('ignores fields that churn without the recipe changing', () => {
    const withNoise = extractRecipeFromHtml(
      page(JSON.stringify({ ...MINIMAL, dateModified: '2026-07-26', description: 'new blurb' })),
    ).recipe!;
    expect(withNoise.contentHash).toBe(base.contentHash);
  });

  it('changes when an ingredient changes', () => {
    const edited = extractRecipeFromHtml(
      page(JSON.stringify({ ...MINIMAL, recipeIngredient: ['2 cups flour', '2 eggs'] })),
    ).recipe!;
    expect(edited.contentHash).not.toBe(base.contentHash);
  });

  it('is a plain function of the extracted content', () => {
    expect(computeContentHash(base)).toBe(base.contentHash);
  });
});

describe('toRecipeDraft', () => {
  it('maps an extraction onto the insertable subset', () => {
    const recipe = extractRecipeFromHtml(
      page(
        JSON.stringify({
          ...MINIMAL,
          name: 'Spanish Chickpeas & Rice',
          image: 'https://x.test/a.jpg',
          recipeYield: '6 servings',
          totalTime: 'PT35M',
          prepTime: 'PT10M',
          author: { name: 'Beth Moncel' },
          aggregateRating: { ratingValue: '4.8', ratingCount: '24' },
          datePublished: '2026-07-01',
        }),
      ),
      'https://x.test/spanish-chickpeas/',
    ).recipe!;

    const draft = toRecipeDraft(recipe, 'https://x.test/spanish-chickpeas/');

    expect(draft).not.toBeNull();
    expect(draft?.title).toBe('Spanish Chickpeas & Rice');
    expect(draft?.slug).toBe('spanish-chickpeas-rice');
    expect(draft?.servings).toBe(6);
    expect(draft?.totalMinutes).toBe(35);
    expect(draft?.activeMinutes).toBe(10);
    expect(draft?.sourceRating).toBe(4.8);
    expect(draft?.sourceRatingCount).toBe(24);
    expect(draft?.ingredients).toEqual([
      { position: 0, rawText: '1 cup flour' },
      { position: 1, rawText: '2 eggs' },
    ]);
  });

  it('refuses to build a row with no title or no ingredients', () => {
    const noIngredients = extractRecipeFromHtml(
      page(JSON.stringify({ '@type': 'Recipe', name: 'Empty' })),
    ).recipe!;
    expect(toRecipeDraft(noIngredients, 'https://x.test/empty/')).toBeNull();

    const noTitle = extractRecipeFromHtml(
      page(JSON.stringify({ '@type': 'Recipe', recipeIngredient: ['flour'] })),
    ).recipe!;
    expect(toRecipeDraft(noTitle, 'https://x.test/untitled/')).toBeNull();
  });

  it('falls back to the feed title when the recipe node has none', () => {
    const noTitle = extractRecipeFromHtml(
      page(JSON.stringify({ '@type': 'Recipe', recipeIngredient: ['flour'] })),
    ).recipe!;
    const draft = toRecipeDraft(noTitle, 'https://x.test/untitled/', { title: 'From The Feed' });
    expect(draft?.title).toBe('From The Feed');
    expect(draft?.slug).toBe('from-the-feed');
  });
});

describe('collectJsonLdBlocks', () => {
  it('ignores scripts that are not ld+json', () => {
    const html = `<html><head>
      <script>var x = 1;</script>
      <script type="text/javascript">var y = 2;</script>
      <script type="application/ld+json">{"@type":"Recipe"}</script>
    </head></html>`;
    expect(collectJsonLdBlocks(html).total).toBe(1);
  });

  it('accepts the type attribute with a charset suffix', () => {
    const html = `<script type="application/ld+json; charset=UTF-8">{"@type":"Recipe"}</script>`;
    expect(collectJsonLdBlocks(html).total).toBe(1);
  });
});

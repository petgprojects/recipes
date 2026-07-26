import { describe, expect, it } from 'vitest';
import {
  BLOG_SOURCES,
  findBlogSource,
  isRecipeUrlForSource,
} from '../src/blog-sources';

describe('canonical blog sources', () => {
  it('contains exactly the eight approved blogs, all enabled', () => {
    expect(BLOG_SOURCES.map((source) => source.name)).toEqual([
      'Budget Bytes',
      'Pinch of Yum',
      'Downshiftology',
      'GypsyPlate',
      'Skinnytaste',
      'The Kitchn',
      'Love & Lemons',
      'Serious Eats',
    ]);
    expect(BLOG_SOURCES).toHaveLength(8);
    expect(BLOG_SOURCES.every((source) => source.enabled)).toBe(true);
  });

  it('finds a source independent of its www spelling', () => {
    expect(findBlogSource('https://budgetbytes.com/')?.slug).toBe('budget-bytes');
  });
});

describe('recipe URL adapters', () => {
  it.each([
    ['budget-bytes', 'https://www.budgetbytes.com/easy-kale-salad/', true],
    ['budget-bytes', 'https://www.budgetbytes.com/category/recipes/', false],
    ['downshiftology', 'https://downshiftology.com/recipes/chicken-piccata/', true],
    ['downshiftology', 'https://downshiftology.com/what-to-cook-in-july/', false],
    ['the-kitchn', 'https://www.thekitchn.com/kalua-pork-recipe-23791234', true],
    ['the-kitchn', 'https://www.thekitchn.com/grocery-news-23791234', false],
    ['serious-eats', 'https://www.seriouseats.com/tartiflette-recipe-5217300', true],
    ['serious-eats', 'https://www.seriouseats.com/best-aprons-8763265', false],
  ])('%s classifies %s', (slug, url, expected) => {
    const source = BLOG_SOURCES.find((candidate) => candidate.slug === slug);
    expect(source).toBeDefined();
    expect(isRecipeUrlForSource(source!, url)).toBe(expected);
  });

  it('rejects a recipe-shaped URL on a different host', () => {
    const source = BLOG_SOURCES.find((candidate) => candidate.slug === 'serious-eats')!;
    expect(isRecipeUrlForSource(source, 'https://evil.example/tartiflette-recipe-5217300')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  crawlDelayMsFor,
  isPathAllowed,
  parseRobotsTxt,
  productToken,
  selectGroup,
} from '../src/scanner/robots';

const UA = 'RecipePlannerBot/0.1 (+https://github.com/petergelgor/recipes)';

describe('parseRobotsTxt', () => {
  it('groups consecutive user-agent lines and keeps sitemaps', () => {
    const robots = parseRobotsTxt(
      [
        '# a comment',
        'Sitemap: https://example.com/sitemap.xml',
        'User-agent: BadBot',
        'User-agent: WorseBot',
        'Disallow: /',
        '',
        'User-agent: *',
        'Disallow: /wp-admin/',
        'Allow: /wp-admin/admin-ajax.php',
        'Crawl-delay: 4',
      ].join('\n'),
    );

    expect(robots.empty).toBe(false);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0]?.agents).toEqual(['badbot', 'worsebot']);
    expect(robots.groups[1]?.crawlDelaySeconds).toBe(4);
  });

  it('treats an empty Disallow as "allow everything", not "disallow /"', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(robots.groups[0]?.rules).toHaveLength(0);
    expect(isPathAllowed(robots, UA, 'https://example.com/anything')).toBe(true);
  });

  it('ignores rules that appear before any user-agent line', () => {
    const robots = parseRobotsTxt('Disallow: /\nUser-agent: *\nAllow: /');
    expect(isPathAllowed(robots, UA, 'https://example.com/x')).toBe(true);
  });

  it('reports an empty file as empty', () => {
    expect(parseRobotsTxt('').empty).toBe(true);
    expect(parseRobotsTxt('\n\n# only comments\n').empty).toBe(true);
  });
});

describe('isPathAllowed', () => {
  const robots = parseRobotsTxt(
    [
      'User-agent: *',
      'Disallow: /private/',
      'Disallow: /*?s=',
      'Disallow: /tmp$',
      'Allow: /private/public-note',
    ].join('\n'),
  );

  it('allows paths no rule matches', () => {
    expect(isPathAllowed(robots, UA, 'https://example.com/recipes/kale')).toBe(true);
  });

  it('honours a plain prefix disallow', () => {
    expect(isPathAllowed(robots, UA, 'https://example.com/private/secret')).toBe(false);
  });

  it('lets the longest match win, so a nested Allow re-opens a path', () => {
    expect(isPathAllowed(robots, UA, 'https://example.com/private/public-note')).toBe(true);
  });

  it('expands * inside a pattern and matches against the query string', () => {
    expect(isPathAllowed(robots, UA, 'https://example.com/blog?s=chicken')).toBe(false);
    expect(isPathAllowed(robots, UA, 'https://example.com/blog?q=chicken')).toBe(true);
  });

  it('anchors a trailing $', () => {
    expect(isPathAllowed(robots, UA, 'https://example.com/tmp')).toBe(false);
    expect(isPathAllowed(robots, UA, 'https://example.com/tmpfile')).toBe(true);
  });

  it('prefers the most specific matching user-agent group', () => {
    const specific = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: recipeplannerbot', 'Disallow:'].join('\n'),
    );
    expect(selectGroup(specific, UA)?.agents).toEqual(['recipeplannerbot']);
    expect(isPathAllowed(specific, UA, 'https://example.com/x')).toBe(true);
    expect(isPathAllowed(specific, 'OtherBot/1.0', 'https://example.com/x')).toBe(false);
  });

  it('reads the crawl delay for the matching group only', () => {
    const robotsWithDelay = parseRobotsTxt(
      ['User-agent: *', 'Crawl-delay: 10', '', 'User-agent: recipeplannerbot', 'Crawl-delay: 2'].join('\n'),
    );
    expect(crawlDelayMsFor(robotsWithDelay, UA)).toBe(2_000);
    expect(crawlDelayMsFor(robotsWithDelay, 'OtherBot/1.0')).toBe(10_000);
    expect(crawlDelayMsFor(parseRobotsTxt('User-agent: *\nDisallow: /x'), UA)).toBeNull();
  });
});

describe('productToken', () => {
  it('strips the version and contact URL', () => {
    expect(productToken(UA)).toBe('recipeplannerbot');
  });
});

describe('the robots.txt files we actually captured', () => {
  const fixture = (site: string): string =>
    readFileSync(join(import.meta.dirname, 'fixtures', site, 'robots.txt'), 'utf8');

  it('does not disallow recipe pages on any captured source', () => {
    for (const [site, url] of [
      ['budget-bytes', 'https://www.budgetbytes.com/easy-kale-salad/'],
      ['pinch-of-yum', 'https://pinchofyum.com/easy-strawberry-pie'],
      ['downshiftology', 'https://downshiftology.com/recipes/chicken-piccata/'],
      ['gypsyplate', 'https://gypsyplate.com/greek-steak-salad-bowl/'],
      ['skinnytaste', 'https://www.skinnytaste.com/zucchini-and-feta-fritters/'],
      ['the-kitchn', 'https://www.thekitchn.com/kalua-pork-recipe-23791234'],
      ['love-and-lemons', 'https://www.loveandlemons.com/peach-crisp/'],
      ['serious-eats', 'https://www.seriouseats.com/tartiflette-recipe-5217300'],
    ] as const) {
      expect(isPathAllowed(parseRobotsTxt(fixture(site)), UA, url), site).toBe(true);
    }
  });

  it("blocks the AI-agent user-agents Serious Eats names, which we are not one of", () => {
    const robots = parseRobotsTxt(fixture('serious-eats'));
    // The site disallows a named list of LLM crawlers outright. We match `*`,
    // which only excludes /embed? and /cdn-cgi/ — see COVERAGE.md for why that
    // is not the same as permission.
    expect(isPathAllowed(robots, 'GPTBot/1.0', 'https://www.seriouseats.com/thmb/x.jpg')).toBe(false);
    expect(isPathAllowed(robots, 'PerplexityBot/1.0', 'https://www.seriouseats.com/anything')).toBe(false);
    expect(isPathAllowed(robots, UA, 'https://www.seriouseats.com/embed?x=1')).toBe(false);
  });

  it('blocks WordPress internals everywhere, which discovery must not walk into', () => {
    const robots = parseRobotsTxt(fixture('budget-bytes'));
    expect(isPathAllowed(robots, UA, 'https://www.budgetbytes.com/wp-admin/')).toBe(false);
  });
});

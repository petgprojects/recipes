import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  htmlToPromptText,
  prepareHtmlFallback,
} from '../src/scanner/html-fallback';
import { extractRecipeFromHtml } from '../src/scanner/jsonld';

const fixtures = join(import.meta.dirname, 'fixtures', 'html-fallback');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('guarded HTML fallback', () => {
  it('does not spend tokens for insertable JSON-LD with optional omissions', () => {
    const html = read('insertable-jsonld.html');
    expect(
      prepareHtmlFallback(html, extractRecipeFromHtml(html)),
    ).toEqual({ outcome: 'skip', reason: 'insertable-jsonld' });
  });

  it('routes malformed JSON-LD with visible recipe sections', () => {
    const html = read('malformed-jsonld.html');
    const decision = prepareHtmlFallback(html, extractRecipeFromHtml(html));
    expect(decision).toMatchObject({
      outcome: 'candidate',
      reason: 'malformed-recipe-jsonld',
    });
    if (decision.outcome === 'candidate') {
      expect(decision.pageText).toContain('1 cup lentils');
      expect(decision.pageText).not.toContain('"@type"');
    }
  });

  it('routes a visible recipe card without JSON-LD', () => {
    const html = read('visible-recipe-card.html');
    expect(
      prepareHtmlFallback(html, extractRecipeFromHtml(html)),
    ).toMatchObject({
      outcome: 'candidate',
      reason: 'visible-recipe-card',
    });
  });

  it('keeps an ordinary roundup on the zero-token path', () => {
    const html = read('roundup.html');
    expect(
      prepareHtmlFallback(html, extractRecipeFromHtml(html)),
    ).toEqual({ outcome: 'skip', reason: 'no-recipe-signals' });
  });

  it('removes chrome and bounds prompt text', () => {
    const html =
      '<nav>Account navigation</nav><main><h1>Recipe</h1><p>' +
      'useful '.repeat(100) +
      '</p></main><footer>Legal footer</footer>';
    const text = htmlToPromptText(html, { maxChars: 120 });
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('Recipe');
    expect(text).not.toContain('Account navigation');
    expect(text).not.toContain('Legal footer');
  });
});

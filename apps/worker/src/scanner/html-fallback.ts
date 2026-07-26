/**
 * Deterministic guard and prompt preparation for Phase 2's HTML extractor.
 *
 * Missing JSON-LD is not enough to spend tokens: real feeds contain many
 * roundups and ordinary articles. A page reaches the LLM only when it has an
 * incomplete Recipe node, or visible recipe-card/microdata plus ingredient and
 * instruction signals. Optional omissions on an otherwise insertable Recipe
 * never trigger fallback.
 */

import * as cheerio from 'cheerio';
import type { ExtractionResult } from './jsonld';
import { cleanText } from './text';

export interface HtmlFallbackOptions {
  readonly maxChars?: number;
}

export type HtmlFallbackDecision =
  | {
      readonly outcome: 'candidate';
      readonly reason:
        | 'incomplete-recipe-jsonld'
        | 'malformed-recipe-jsonld'
        | 'visible-recipe-card';
      readonly pageText: string;
    }
  | {
      readonly outcome: 'skip';
      readonly reason:
        | 'insertable-jsonld'
        | 'no-recipe-signals'
        | 'empty-page-text';
    };

const DEFAULT_MAX_CHARS = 40_000;

/**
 * Decide whether a page deserves the paid fallback, and prepare bounded text
 * when it does. This function performs no IO and never calls an LLM.
 */
export function prepareHtmlFallback(
  html: string,
  extraction: ExtractionResult,
  options: HtmlFallbackOptions = {},
): HtmlFallbackDecision {
  if (
    extraction.recipe !== null &&
    extraction.recipe.title !== null &&
    extraction.recipe.ingredients.length > 0
  ) {
    return { outcome: 'skip', reason: 'insertable-jsonld' };
  }

  const $ = cheerio.load(html);
  const signals = visibleRecipeSignals($);
  let reason: Extract<HtmlFallbackDecision, { outcome: 'candidate' }>['reason'] | null =
    null;

  if (extraction.recipe !== null || extraction.stats.recipeNodes > 0) {
    reason = 'incomplete-recipe-jsonld';
  } else if (
    extraction.stats.malformed > 0 &&
    signals.hasIngredients &&
    signals.hasInstructions
  ) {
    reason = 'malformed-recipe-jsonld';
  } else if (
    signals.hasRecipeContainer &&
    signals.hasIngredients &&
    signals.hasInstructions
  ) {
    reason = 'visible-recipe-card';
  }

  if (reason === null) return { outcome: 'skip', reason: 'no-recipe-signals' };

  const pageText = htmlToPromptText(html, options);
  if (pageText.length === 0) return { outcome: 'skip', reason: 'empty-page-text' };
  return { outcome: 'candidate', reason, pageText };
}

/** Strip page chrome while preserving the headings/list boundaries recipes use. */
export function htmlToPromptText(
  html: string,
  options: HtmlFallbackOptions = {},
): string {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const $ = cheerio.load(html);

  $(
    [
      'script',
      'style',
      'template',
      'noscript',
      'svg',
      'iframe',
      'nav',
      'header',
      'footer',
      'aside',
      'form',
      '[aria-hidden="true"]',
      '.advertisement',
      '.advertising',
      '.ad',
      '.ads',
      '.newsletter',
      '.social-share',
    ].join(','),
  ).remove();

  const root =
    firstNonEmpty($, [
      'main',
      'article',
      '.recipe-card',
      '.wprm-recipe',
      '.tasty-recipes',
      '.mv-create',
      'body',
    ]) ?? $.root();
  const lines: string[] = [];
  root.find('h1,h2,h3,h4,h5,h6,p,li').each((_, element) => {
    const line = cleanText($(element).text());
    if (line.length === 0 || lines.at(-1) === line) return;
    lines.push(line);
  });

  let text = lines.join('\n');
  if (text.length === 0) text = cleanText(root.text());
  if (text.length <= maxChars) return text;

  const prefix = text.slice(0, maxChars);
  const lineBoundary = prefix.lastIndexOf('\n');
  return (lineBoundary >= maxChars * 0.75
    ? prefix.slice(0, lineBoundary)
    : prefix
  ).trimEnd();
}

interface RecipeSignals {
  readonly hasRecipeContainer: boolean;
  readonly hasIngredients: boolean;
  readonly hasInstructions: boolean;
}

function visibleRecipeSignals($: cheerio.CheerioAPI): RecipeSignals {
  const elements = $('*').toArray();
  const hasRecipeContainer = elements.some((element) => {
    const attributes = element.type === 'tag' ? element.attribs : undefined;
    const itemtype = attributes?.['itemtype']?.toLowerCase() ?? '';
    const marker = `${attributes?.['id'] ?? ''} ${attributes?.['class'] ?? ''}`;
    return (
      itemtype.includes('schema.org/recipe') ||
      /\b(?:recipe-card|wprm-recipe|tasty-recipes|mv-create)\b/i.test(marker)
    );
  });

  const itemProps = elements.flatMap((element) => {
    const attributes = element.type === 'tag' ? element.attribs : undefined;
    return (attributes?.['itemprop'] ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  });
  const headings = $('h1,h2,h3,h4,h5,h6')
    .toArray()
    .map((element) => cleanText($(element).text()));

  return {
    hasRecipeContainer,
    hasIngredients:
      itemProps.includes('recipeingredient') ||
      headings.some((heading) =>
        /^(?:ingredients|what you(?:'|’)ll need|you will need)\b/i.test(heading),
      ),
    hasInstructions:
      itemProps.includes('recipeinstructions') ||
      headings.some((heading) =>
        /^(?:instructions|directions|method|how to make)\b/i.test(heading),
      ),
  };
}

function firstNonEmpty(
  $: cheerio.CheerioAPI,
  selectors: readonly string[],
): ReturnType<cheerio.CheerioAPI> | null {
  for (const selector of selectors) {
    const element = $(selector).first();
    if (element.length > 0 && cleanText(element.text()).length > 0) return element;
  }
  return null;
}

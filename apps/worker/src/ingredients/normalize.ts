/**
 * Batch boundary between extracted JSON-LD strings and
 * `recipe_ingredients`-ready rows.
 */

import { ingredientAliasKey, type RecipeIngredient } from '@recipes/shared';
import type { IngredientMatcher } from './matcher';
import { parseIngredientLine } from './parser';

export async function normalizeIngredientLines(
  rawLines: readonly string[],
  matcher: IngredientMatcher,
): Promise<RecipeIngredient[]> {
  const matchCache = new Map<string, ReturnType<IngredientMatcher['match']>>();

  const rows = await Promise.all(
    rawLines.map(async (rawText, position): Promise<RecipeIngredient | null> => {
      const parsed = parseIngredientLine(rawText);
      if (parsed === null) return null;

      const matchKey = ingredientAliasKey(parsed.name);
      let pendingMatch = matchCache.get(matchKey);
      if (pendingMatch === undefined) {
        pendingMatch = matcher.match(parsed.name);
        matchCache.set(matchKey, pendingMatch);
      }
      const match = await pendingMatch;

      return {
        position,
        rawText: rawText.trim(),
        ingredientId: match?.ingredientId ?? null,
        qty: parsed.qty,
        unit: parsed.unit,
        note: parsed.note,
        optional: parsed.optional,
      };
    }),
  );

  return rows.filter((row): row is RecipeIngredient => row !== null);
}

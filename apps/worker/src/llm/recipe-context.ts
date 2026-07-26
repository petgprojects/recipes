import type { InstructionStep } from '@recipes/shared';

const MAX_INGREDIENTS = 200;
const MAX_INSTRUCTIONS = 200;
const MAX_INGREDIENT_CHARS = 1_000;
const MAX_INSTRUCTION_CHARS = 4_000;

export interface RecipeContextIngredient {
  readonly rawText: string;
}

export interface RecipeContextInput {
  readonly title: string;
  readonly totalMinutes: number | null;
  readonly activeMinutes: number | null;
  readonly servings: number | null;
  readonly ingredients: readonly (string | RecipeContextIngredient)[];
  readonly instructions: readonly InstructionStep[];
}

export interface RecipeFacts {
  readonly title: string;
  readonly total_minutes: number | null;
  readonly active_minutes: number | null;
  readonly servings: number | null;
  readonly ingredients: readonly string[];
  readonly instructions: readonly {
    readonly name: string | null;
    readonly text: string;
  }[];
}

/**
 * Keep every LLM task on the same compact factual representation.
 * Source prose/headnotes and internal identifiers are intentionally excluded.
 */
export function recipeFacts(input: RecipeContextInput): RecipeFacts {
  return {
    title: boundedText(input.title, 300),
    total_minutes: finiteIntegerOrNull(input.totalMinutes),
    active_minutes: finiteIntegerOrNull(input.activeMinutes),
    servings: finiteIntegerOrNull(input.servings),
    ingredients: input.ingredients
      .slice(0, MAX_INGREDIENTS)
      .map((ingredient) =>
        boundedText(
          typeof ingredient === 'string' ? ingredient : ingredient.rawText,
          MAX_INGREDIENT_CHARS,
        ),
      )
      .filter((ingredient) => ingredient.length > 0),
    instructions: input.instructions
      .slice(0, MAX_INSTRUCTIONS)
      .map((step) => ({
        name: step.name === null ? null : boundedText(step.name, 200) || null,
        text: boundedText(step.text, MAX_INSTRUCTION_CHARS),
      }))
      .filter((step) => step.text.length > 0),
  };
}

export function serializeRecipeFacts(input: RecipeContextInput): string {
  return JSON.stringify(recipeFacts(input));
}

function boundedText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function finiteIntegerOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.round(value) : null;
}

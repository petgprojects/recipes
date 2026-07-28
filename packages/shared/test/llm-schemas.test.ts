import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  blurbOutputSchema,
  canonicalIngredientSummarySchema,
  derivedFieldsSchema,
  ingredientMappingOutputSchema,
  llmExtractedRecipeSchema,
  llmRecipeExtractionResultSchema,
  normalizedIngredientNameSchema,
  suitabilitySchema,
} from '../src/schemas';

describe('Phase 2 LLM task schemas', () => {
  it('accepts exact controlled suitability and derived-field outputs', () => {
    expect(
      suitabilitySchema.parse({
        is_meal_prep: true,
        reason: 'Makes four portions and reheats cleanly.',
      }),
    ).toEqual({
      is_meal_prep: true,
      reason: 'Makes four portions and reheats cleanly.',
    });

    expect(
      derivedFieldsSchema.parse({
        keeps_days: 4,
        freezer_months: 3,
        category: 'Chicken',
        tags: ['Big batch', 'Freezes'],
      }),
    ).toEqual({
      keeps_days: 4,
      freezer_months: 3,
      category: 'Chicken',
      tags: ['Big batch', 'Freezes'],
    });
  });

  it('rejects unknown or duplicate controlled vocabulary values', () => {
    expect(() =>
      derivedFieldsSchema.parse({
        keeps_days: 4,
        freezer_months: null,
        category: 'Seafood',
        tags: ['Big batch'],
      }),
    ).toThrow();
    expect(() =>
      derivedFieldsSchema.parse({
        keeps_days: 4,
        freezer_months: null,
        category: 'Soup',
        tags: ['Big batch', 'Big batch'],
      }),
    ).toThrow(/duplicates/);
  });

  it('bounds blurbs and extracted recipe facts', () => {
    expect(blurbOutputSchema.parse({ blurb: 'Five lunches from one sheet pan.' })).toEqual({
      blurb: 'Five lunches from one sheet pan.',
    });
    expect(() => blurbOutputSchema.parse({ blurb: 'x'.repeat(281) })).toThrow();

    expect(
      llmExtractedRecipeSchema.parse({
        title: 'Lentil bowls',
        total_minutes: 45,
        active_minutes: 15,
        servings: 5,
        ingredients: ['1 cup lentils'],
        instructions: [{ name: null, text: 'Simmer until tender.' }],
        image_url: null,
        author: null,
        published_at: '2026-07-26T12:00:00Z',
      }),
    ).toMatchObject({ title: 'Lentil bowls', servings: 5 });

    expect(() =>
      llmExtractedRecipeSchema.parse({
        title: 'Lentil bowls',
        total_minutes: -1,
        active_minutes: null,
        servings: null,
        ingredients: [],
        instructions: [],
        image_url: 'not a URL',
        author: null,
        published_at: null,
      }),
    ).toThrow();
  });

  it('requires found and recipe presence to agree', () => {
    expect(
      llmRecipeExtractionResultSchema.parse({
        found: false,
        reason: 'This is an editorial round-up.',
        recipe: null,
      }),
    ).toEqual({
      found: false,
      reason: 'This is an editorial round-up.',
      recipe: null,
    });

    expect(() =>
      llmRecipeExtractionResultSchema.parse({
        found: true,
        reason: 'A complete recipe is present.',
        recipe: null,
      }),
    ).toThrow(/must be present/);
  });

  it('constrains semantic ingredient mapping to identity-only names and controlled aisles', () => {
    expect(normalizedIngredientNameSchema.parse('jalapeño')).toBe('jalapeño');
    expect(canonicalIngredientSummarySchema.parse({
      name: 'black garlic',
      aisle: 'Produce',
    })).toEqual({
      name: 'black garlic',
      aisle: 'Produce',
    });
    expect(
      ingredientMappingOutputSchema.parse({
        decisions: [
          {
            input_name: 'green onions',
            action: 'existing',
            canonical_name: 'scallions',
            aisle: 'Produce',
          },
          {
            input_name: 'black garlic',
            action: 'new',
            canonical_name: 'black garlic',
            aisle: 'Produce',
          },
        ],
      }).decisions,
    ).toHaveLength(2);

    for (const unsafe of [
      '',
      ' Scallions',
      'Scallions',
      '2 scallions',
      'scallions, chopped',
      '<script>',
      'scallions to taste',
    ]) {
      expect(normalizedIngredientNameSchema.safeParse(unsafe).success).toBe(false);
    }
    expect(
      ingredientMappingOutputSchema.safeParse({
        decisions: [
          {
            input_name: 'black garlic',
            action: 'new',
            canonical_name: 'black garlic',
            aisle: 'Garden',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects mapping quantities, notes, and other undeclared properties', () => {
    expect(
      ingredientMappingOutputSchema.safeParse({
        decisions: [
          {
            input_name: 'green onions',
            action: 'existing',
            canonical_name: 'scallions',
            aisle: 'Produce',
            quantity: 2,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ingredientMappingOutputSchema.safeParse({
        decisions: [
          {
            input_name: 'green onions',
            action: 'new',
            canonical_name: 'green onions, sliced',
            aisle: 'Produce',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('converts every task schema to strict object JSON Schema', () => {
    for (const schema of [
      suitabilitySchema,
      derivedFieldsSchema,
      blurbOutputSchema,
      llmRecipeExtractionResultSchema,
      ingredientMappingOutputSchema,
    ]) {
      const jsonSchema = z.toJSONSchema(schema);
      expect(jsonSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });
});

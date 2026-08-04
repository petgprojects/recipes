/**
 * The canonical Recipe contract.
 *
 * These schemas mirror the `recipes` and `recipe_ingredients` columns in
 * PLAN.md §4 and are the boundary every producer must pass through: the
 * deterministic JSON-LD extractor (Phase 1) and the LLM extractor (Phase 2)
 * both emit `RecipeInput`, and PROGRESS.md amendment A2 makes this the same
 * shape that gets handed to OpenRouter as a strict JSON Schema.
 *
 * Rule of thumb for nullability here: anything Phase 1 can get for free from
 * schema.org is optional-but-present; anything only an LLM can infer
 * (`blurb`, `keeps_days`, `freezer_months`, `tags`, `category`) is nullable,
 * because Phase 1 ships before Phase 2 and must be able to insert without it.
 */

import { z } from 'zod';
import {
  AISLES,
  CATEGORIES,
  RECIPE_STATUS,
  SOURCE_KIND,
  TAGS,
  RATING_ASPECTS,
} from './vocab';
import { CANONICAL_UNITS } from './units';

// ── Primitives ──────────────────────────────────────────────────────────────

export const uuidSchema = z.uuid();
export const urlSchema = z.url();

/** A positive integer count of minutes, or null when the source didn't say. */
const minutes = z.number().int().positive().max(60 * 24 * 14).nullable();

// ── Instructions (`recipes.instructions jsonb`) ─────────────────────────────

export const instructionStepSchema = z.object({
  /** Optional heading, for sources that group steps into sections. */
  name: z.string().trim().min(1).nullable().default(null),
  text: z.string().trim().min(1),
});

export const instructionsSchema = z.array(instructionStepSchema);

export type InstructionStep = z.infer<typeof instructionStepSchema>;

// ── Ingredients ─────────────────────────────────────────────────────────────

/**
 * Stage 1 of the three-stage matcher in PLAN.md §4: a raw ingredient line
 * parsed into structure, before any canonicalisation has happened.
 *
 * `unit` is a free string rather than an enum on purpose — the parser sees
 * whatever the blog wrote, and `normalizeUnit()` in `./units` is what decides
 * whether it maps onto the vocabulary. Rejecting unknown units here would
 * throw away a line we can still render from `rawText`.
 */
export const parsedIngredientLineSchema = z.object({
  qty: z.number().positive().nullable(),
  unit: z.string().trim().nullable(),
  name: z.string().trim().min(1),
  note: z.string().trim().min(1).nullable().default(null),
  optional: z.boolean().default(false),
});

export type ParsedIngredientLine = z.infer<typeof parsedIngredientLineSchema>;

/** The canonical unit vocabulary, for callers that want to constrain a field. */
export const canonicalUnitSchema = z.enum(CANONICAL_UNITS);

/**
 * A row of `recipe_ingredients`.
 *
 * `ingredientId` is nullable on purpose (PLAN.md §4): an unmapped ingredient
 * still renders from `rawText` and still reaches the grocery list under the
 * fallback aisle — it just doesn't merge with anything.
 */
export const recipeIngredientSchema = z.object({
  position: z.number().int().nonnegative(),
  rawText: z.string().trim().min(1),
  ingredientId: uuidSchema.nullable().default(null),
  qty: z.number().positive().nullable().default(null),
  unit: z.string().trim().nullable().default(null),
  note: z.string().trim().min(1).nullable().default(null),
  optional: z.boolean().default(false),
});

export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;

// ── Recipes ─────────────────────────────────────────────────────────────────

export const recipeStatusSchema = z.enum(RECIPE_STATUS);
export const sourceKindSchema = z.enum(SOURCE_KIND);
export const categorySchema = z.enum(CATEGORIES);
export const tagSchema = z.enum(TAGS);
export const ratingAspectSchema = z.enum(RATING_ASPECTS);

/**
 * Everything needed to insert a recipe. No `id`, no `first_seen_at` /
 * `last_seen_at` — the database owns those.
 */
export const recipeInputSchema = z.object({
  sourceId: uuidSchema,
  /** The dedupe key (PLAN.md §4). Always a real URL; there is no seed data. */
  sourceUrl: urlSchema,
  /** Hash of the extracted content, so a re-scan can detect upstream edits. */
  contentHash: z.string().trim().min(1).nullable().default(null),

  title: z.string().trim().min(1).max(300),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),

  /** OUR one-liner, LLM-written in Phase 2 — never the source's prose (§7). */
  blurb: z.string().trim().min(1).max(280).nullable().default(null),

  totalMinutes: minutes.default(null),
  activeMinutes: minutes.default(null),
  servings: z.number().int().positive().max(200).nullable().default(null),

  /** Shelf life. Schema.org has no equivalent; Phase 2 infers both. */
  keepsDays: z.number().int().nonnegative().max(60).nullable().default(null),
  freezerMonths: z.number().int().nonnegative().max(24).nullable().default(null),

  category: categorySchema.nullable().default(null),
  tags: z.array(tagSchema).default([]),

  imageUrl: urlSchema.nullable().default(null),
  imageLocalPath: z.string().trim().min(1).nullable().default(null),
  imageW: z.number().int().positive().nullable().default(null),
  imageH: z.number().int().positive().nullable().default(null),
  imageBlurhash: z.string().trim().min(1).nullable().default(null),

  author: z.string().trim().min(1).max(200).nullable().default(null),
  sourceRating: z.number().min(0).max(5).nullable().default(null),
  sourceRatingCount: z.number().int().nonnegative().nullable().default(null),

  instructions: instructionsSchema.default([]),
  /** Kept verbatim so fields can be re-derived without re-crawling (§4). */
  rawJsonld: z.unknown().nullable().default(null),

  status: recipeStatusSchema.default('pending'),
  /** Why the Phase 2 suitability gate rejected this, kept for audit (§5). */
  rejectionReason: z.string().trim().min(1).nullable().default(null),

  publishedAt: z.coerce.date().nullable().default(null),

  ingredients: z.array(recipeIngredientSchema).default([]),
});

export type RecipeInput = z.infer<typeof recipeInputSchema>;

/** A recipe as it comes back out of the database. */
export const recipeSchema = recipeInputSchema.extend({
  id: uuidSchema,
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
});

export type Recipe = z.infer<typeof recipeSchema>;

// ── Phase 2 LLM task contracts ──────────────────────────────────────────────
// Small enough to live here, and keeping them next to the Recipe shape is what
// stops the extraction prompt and the table definition from drifting apart.

/** `classifySuitability(recipe)` — runs before insert (PLAN.md §5, Phase 2). */
export const suitabilitySchema = z.object({
  is_meal_prep: z
    .boolean()
    .describe('Whether this recipe works as practical make-ahead meal prep.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe('A concise, factual explanation of the classification.'),
});

/** `deriveFields(recipe)` — the fields schema.org cannot give us (§1). */
export const derivedFieldsSchema = z.object({
  keeps_days: z
    .number()
    .int()
    .nonnegative()
    .max(60)
    .nullable()
    .describe('Conservative refrigerator shelf life in days, or null when uncertain.'),
  freezer_months: z
    .number()
    .int()
    .nonnegative()
    .max(24)
    .nullable()
    .describe('Conservative freezer shelf life in months, or null when unsuitable or uncertain.'),
  category: categorySchema.describe('Exactly one category from the controlled vocabulary.'),
  tags: z
    .array(tagSchema)
    .max(6)
    .describe('Up to six distinct tags from the controlled vocabulary.'),
}).superRefine((value, context) => {
  if (new Set(value.tags).size !== value.tags.length) {
    context.addIssue({
      code: 'custom',
      path: ['tags'],
      message: 'tags must not contain duplicates',
    });
  }
});

/**
 * `writeBlurb(recipe)` returns an object rather than a bare string so it can
 * use strict JSON Schema structured output like every other Phase 2 task.
 */
export const blurbOutputSchema = z.object({
  blurb: z
    .string()
    .trim()
    .min(1)
    .max(280)
    .describe('An original, factual one-sentence meal-prep blurb.'),
});

/**
 * LLM-only instruction shape. Unlike `instructionStepSchema`, it deliberately
 * has no default: strict structured-output schemas require every property to
 * be explicit, with null representing an absent heading.
 */
export const llmInstructionStepSchema = z.object({
  name: z.string().trim().min(1).max(200).nullable(),
  text: z.string().trim().min(1).max(4_000),
});

/**
 * Factual recipe fields an LLM may extract from visible page/post text.
 *
 * Provenance, source URL, slug and content hash are intentionally absent.
 * Callers derive those locally so untrusted text can never make the model
 * redirect attribution or choose a dedupe key.
 */
export const llmExtractedRecipeSchema = z.object({
  title: z.string().trim().min(1).max(300),
  total_minutes: z.number().int().positive().max(60 * 24 * 14).nullable(),
  active_minutes: z.number().int().positive().max(60 * 24 * 14).nullable(),
  servings: z.number().int().positive().max(200).nullable(),
  ingredients: z
    .array(z.string().trim().min(1).max(1_000))
    .min(1)
    .max(200),
  instructions: z.array(llmInstructionStepSchema).max(200),
  image_url: z.url().nullable(),
  author: z.string().trim().min(1).max(200).nullable(),
  published_at: z.iso.datetime({ offset: true }).nullable(),
});

/**
 * A page or post may legitimately contain no complete recipe. Keeping that as
 * a validated result avoids turning ordinary round-up/editorial content into
 * an exception or a fabricated recipe.
 */
export const llmRecipeExtractionResultSchema = z
  .object({
    found: z.boolean(),
    reason: z.string().trim().min(1).max(400),
    recipe: llmExtractedRecipeSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.found !== (value.recipe !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['recipe'],
        message: value.found
          ? 'recipe must be present when found is true'
          : 'recipe must be null when found is false',
      });
    }
  });

/**
 * The same result for a *post*, which routinely carries several recipes at
 * once: a weekly meal-prep roundup is one submission holding five.
 *
 * Kept separate from `llmRecipeExtractionResultSchema` rather than replacing
 * it, because the two describe genuinely different sources. A recipe blog page
 * is one recipe by construction, and letting that path return a list would
 * invite an ingredient index or a "more like this" rail to be read as extra
 * recipes. A post has no such guarantee.
 *
 * The cap is a bound on a single response, not a judgement about posts: twelve
 * is comfortably above the largest roundups observed on r/MealPrepSunday
 * (five), and a strict `json_schema` array needs *some* ceiling.
 */
export const llmRecipePostExtractionResultSchema = z
  .object({
    found: z.boolean(),
    reason: z.string().trim().min(1).max(400),
    recipes: z.array(llmExtractedRecipeSchema).max(12),
  })
  .superRefine((value, context) => {
    if (value.found !== (value.recipes.length > 0)) {
      context.addIssue({
        code: 'custom',
        path: ['recipes'],
        message: value.found
          ? 'recipes must be non-empty when found is true'
          : 'recipes must be empty when found is false',
      });
    }
  });

/**
 * Canonical ingredient names contain only the ingredient identity — no amount,
 * unit, preparation note, HTML, control characters, or surrounding whitespace.
 * Lowercase storage keys make exact comparisons deterministic.
 */
export const normalizedIngredientNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value === value.trim(), 'ingredient name must not have surrounding whitespace')
  .refine(
    (value) => value === value.toLocaleLowerCase('en-US'),
    'ingredient name must be lowercase',
  )
  .regex(
    /^\p{L}+(?:[ &'’.-]\p{L}+)*$/u,
    'ingredient name may contain only words and name punctuation',
  )
  .refine(
    (value) =>
      !/\b(?:as needed|divided|for garnish|for serving|optional|plus more|to taste)\b/u.test(
        value,
      ),
    'ingredient name must not contain a quantity or preparation note',
  );

export const canonicalIngredientSummarySchema = z
  .object({
    name: normalizedIngredientNameSchema,
    aisle: z.enum(AISLES),
  })
  .strict();

/**
 * `aisle` is required here even though the database already knows the aisle of
 * an existing canonical ingredient, and `toPersistenceDecisions()` still uses
 * that authoritative value. It is asked for so that the plausibility guard has
 * somewhere to land: when `isPlausibleCanonicalMatch()` rejects the model's
 * `"existing"` claim, the decision is rewritten as `"new"`, and a `new`
 * canonical needs an aisle. Without this the guard would need a second
 * round-trip to find out where the item lives in the store.
 */
const ingredientMappingExistingDecisionSchema = z
  .object({
    input_name: normalizedIngredientNameSchema,
    action: z.literal('existing'),
    canonical_name: normalizedIngredientNameSchema,
    aisle: z.enum(AISLES),
  })
  .strict();

const ingredientMappingNewDecisionSchema = z
  .object({
    input_name: normalizedIngredientNameSchema,
    action: z.literal('new'),
    canonical_name: normalizedIngredientNameSchema,
    aisle: z.enum(AISLES),
  })
  .strict();

/** One semantic decision for one previously-unmatched normalized input name. */
export const ingredientMappingDecisionSchema = z.discriminatedUnion('action', [
  ingredientMappingExistingDecisionSchema,
  ingredientMappingNewDecisionSchema,
]);

/**
 * Structural strict-output contract. `mapIngredients()` adds input-aware
 * validation for exact batch coverage and existing-target membership.
 */
export const ingredientMappingOutputSchema = z
  .object({
    decisions: z.array(ingredientMappingDecisionSchema).min(1).max(40),
  })
  .strict();

export type Suitability = z.infer<typeof suitabilitySchema>;
export type DerivedFields = z.infer<typeof derivedFieldsSchema>;
export type BlurbOutput = z.infer<typeof blurbOutputSchema>;
export type LlmInstructionStep = z.infer<typeof llmInstructionStepSchema>;
export type LlmExtractedRecipe = z.infer<typeof llmExtractedRecipeSchema>;
export type LlmRecipeExtractionResult = z.infer<typeof llmRecipeExtractionResultSchema>;
export type LlmRecipePostExtractionResult = z.infer<
  typeof llmRecipePostExtractionResultSchema
>;
export type CanonicalIngredientSummary = z.infer<typeof canonicalIngredientSummarySchema>;
export type IngredientMappingDecision = z.infer<typeof ingredientMappingDecisionSchema>;
export type IngredientMappingOutput = z.infer<typeof ingredientMappingOutputSchema>;

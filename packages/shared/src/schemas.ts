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
import { CATEGORIES, RECIPE_STATUS, SOURCE_KIND, TAGS, RATING_ASPECTS } from './vocab';
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
  is_meal_prep: z.boolean(),
  reason: z.string().trim().min(1).max(400),
});

/** `deriveFields(recipe)` — the fields schema.org cannot give us (§1). */
export const derivedFieldsSchema = z.object({
  keeps_days: z.number().int().nonnegative().max(60).nullable(),
  freezer_months: z.number().int().nonnegative().max(24).nullable(),
  category: categorySchema,
  tags: z.array(tagSchema).max(6),
});

export type Suitability = z.infer<typeof suitabilitySchema>;
export type DerivedFields = z.infer<typeof derivedFieldsSchema>;

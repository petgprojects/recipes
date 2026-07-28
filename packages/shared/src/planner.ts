/**
 * The planner's per-user state: which recipes are picked, and which grocery
 * lines are ticked off.
 *
 * This module is the *contract*, and it is deliberately pure and client-safe.
 * The same two shapes are used in three places and have to agree in all of
 * them:
 *
 *   - `localStorage`, for a signed-out reader (Phase 3, `saved-store.ts`);
 *   - the `/api/planner` request and response bodies;
 *   - `saved_recipes` and `grocery_checks` (PLAN.md §4).
 *
 * That is why `SavedMap` is `{recipeId: batches}` and `CheckedMap` is
 * `{itemKey: true}` — Phase 3 chose those shapes so the Phase 4 migration would
 * be a direct insert rather than a translation, and this file is where that
 * promise is kept.
 *
 * No database and no environment: `@recipes/shared/env` is server-only and the
 * planner components import from here.
 */

import { z } from 'zod';

/** `{recipeId: batches}` — mirrors `saved_recipes(recipe_id, batches)`. */
export type SavedMap = Record<string, number>;

/** `{itemKey: true}` — mirrors `grocery_checks(item_key)`. */
export type CheckedMap = Record<string, true>;

export interface PlannerState {
  saved: SavedMap;
  checked: CheckedMap;
}

/**
 * The batch multiplier bounds, matching the stepper in the picks list. The
 * lower bound is also a database CHECK (`saved_recipes_batches_positive`); the
 * upper bound is a UI decision, so it is enforced here rather than in SQL.
 */
export const MIN_BATCHES = 1;
export const MAX_BATCHES = 4;

export function clampBatches(batches: number): number {
  return Math.max(MIN_BATCHES, Math.min(MAX_BATCHES, Math.round(batches)));
}

// ── Wire schemas ────────────────────────────────────────────────────────────

const recipeIdSchema = z.uuid();

const batchesSchema = z.number().int().min(MIN_BATCHES).max(MAX_BATCHES);

/**
 * `{ingredient_id}:{dimension}` is 36 + 1 + a short word; `raw:{slug}:{dim}` is
 * bounded by the 80-character slug cap in `grocery.ts`. 160 is comfortably
 * above both and stops an arbitrary-length key from becoming an arbitrary-
 * length row.
 */
const itemKeySchema = z.string().trim().min(1).max(160);

/** `batches: null` removes the pick — one route for toggle-off and set-count. */
export const savedPatchSchema = z.object({
  recipeId: recipeIdSchema,
  batches: batchesSchema.nullable(),
});

export const checkPatchSchema = z.object({
  itemKey: itemKeySchema,
  checked: z.boolean(),
});

export type SavedPatch = z.infer<typeof savedPatchSchema>;
export type CheckPatch = z.infer<typeof checkPatchSchema>;

/**
 * An upper bound on a single migration. A reader's `localStorage` holds tens of
 * picks, not thousands; the cap keeps a hand-written request from turning one
 * POST into an unbounded insert.
 */
export const MAX_IMPORT_ENTRIES = 500;

const boundedRecord = <K extends z.ZodType<string, string>, V extends z.ZodTypeAny>(
  key: K,
  value: V,
) =>
  z
    .record(key, value)
    .refine(
      (record) => Object.keys(record).length <= MAX_IMPORT_ENTRIES,
      `at most ${MAX_IMPORT_ENTRIES} entries`,
    );

/**
 * The body of the one-time first-sign-in migration. Both halves are optional so
 * a reader who only ever ticked boxes, or only ever picked recipes, still
 * migrates cleanly.
 */
export const plannerImportSchema = z.object({
  saved: boundedRecord(recipeIdSchema, batchesSchema).default({}),
  checked: boundedRecord(itemKeySchema, z.literal(true)).default({}),
});

export type PlannerImport = z.infer<typeof plannerImportSchema>;

/**
 * The body of a grocery-list request (Phase 5).
 *
 * A signed-out reader's picks live only in this browser, so the list they are
 * asking for cannot be derived from anything the server already holds — the
 * picks have to travel with the request. A signed-in reader sends the same
 * body and the server ignores it in favour of `saved_recipes`, on the same
 * principle as the sign-in migration: the account is authoritative.
 *
 * `MAX_IMPORT_ENTRIES` is the wrong bound here — that one sizes a one-time
 * migration of everything a browser ever accumulated. This is one shopping
 * trip.
 */
export const MAX_GROCERY_PICKS = 100;

export const groceryRequestSchema = z.object({
  picks: z
    .array(z.object({ recipeId: recipeIdSchema, batches: batchesSchema }))
    .max(MAX_GROCERY_PICKS)
    .default([]),
});

export type GroceryRequest = z.infer<typeof groceryRequestSchema>;

// ── Merge ───────────────────────────────────────────────────────────────────

/** What a migration would actually write, once existing rows are excluded. */
export interface PlannerAdditions {
  saved: SavedMap;
  checked: CheckedMap;
}

/**
 * The additive half of a merge: everything in `local` that `server` does not
 * already have.
 *
 * PLAN.md §5, Phase 4: "don't make the user lose their picks." Note which way
 * that cuts — the account is authoritative, so a recipe already saved at two
 * batches is *not* reset to the one batch a signed-out session happened to
 * leave in this browser. Nothing is ever overwritten or deleted; a migration
 * can only add. That also makes it idempotent, which matters because the client
 * records "already migrated" locally and a cleared browser will run it again.
 */
export function plannerAdditions(server: PlannerState, local: PlannerState): PlannerAdditions {
  const saved: SavedMap = {};
  for (const [recipeId, batches] of Object.entries(local.saved)) {
    if (server.saved[recipeId] === undefined) saved[recipeId] = clampBatches(batches);
  }

  const checked: CheckedMap = {};
  for (const itemKey of Object.keys(local.checked)) {
    if (server.checked[itemKey] === undefined) checked[itemKey] = true;
  }

  return { saved, checked };
}

/** The state a migration leaves behind. `server` wins every conflict. */
export function mergePlannerState(server: PlannerState, local: PlannerState): PlannerState {
  const additions = plannerAdditions(server, local);
  return {
    saved: { ...additions.saved, ...server.saved },
    checked: { ...additions.checked, ...server.checked },
  };
}

export function countPlannerAdditions(additions: PlannerAdditions): number {
  return Object.keys(additions.saved).length + Object.keys(additions.checked).length;
}

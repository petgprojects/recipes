/**
 * The after-cooking flow (PLAN.md §5, Phase 6): a star rating, free-text notes
 * and fixed-vocabulary aspect tags, logged once per cook.
 *
 * Client-safe contract only, same split as `@recipes/shared/planner`: this
 * module owns the shape and the wire schema, `apps/web/src/lib/ratings.ts`
 * owns the SQL. `RATING_ASPECTS` and its Zod mirror `ratingAspectSchema`
 * already existed in `./vocab` and `./schemas` (PLAN.md §4 required the
 * vocabulary and the check constraint to agree); this file is what finally
 * puts them to use.
 */

import { z } from 'zod';
import type { RatingAspect } from './vocab';
import { ratingAspectSchema, uuidSchema } from './schemas';

export const MIN_RATING = 1;
export const MAX_RATING = 5;

const ratingSchema = z.number().int().min(MIN_RATING).max(MAX_RATING);

/**
 * Long enough for a real note, short enough that one cook log can't blow up a
 * row. `null` means "no note" — an empty string is not a distinct state worth
 * representing.
 */
export const MAX_NOTES_LENGTH = 2000;
const notesSchema = z.string().trim().min(1).max(MAX_NOTES_LENGTH);

export const cookLogCreateSchema = z.object({
  recipeId: uuidSchema,
  rating: ratingSchema,
  aspects: z.array(ratingAspectSchema).default([]),
  notes: notesSchema.nullable().default(null),
});

export type CookLogCreate = z.infer<typeof cookLogCreateSchema>;

/** `GET /api/ratings?recipeId=` and the `DELETE` route validate against this. */
export const recipeIdQuerySchema = uuidSchema;

/** One logged cook, as the API and the client agree to shape it. */
export interface CookLogEntry {
  id: string;
  recipeId: string;
  rating: number;
  aspects: RatingAspect[];
  notes: string | null;
  /** ISO 8601 — `cook_logs.cooked_at`. */
  cookedAt: string;
}

/**
 * Canonical ingredient matching — stage 2 of PLAN.md §4.
 *
 * Exact aliases are authoritative. Fuzzy matches must clear both a high
 * pg_trgm threshold and an ambiguity margin before they are accepted, because
 * one false-positive alias write poisons every future match for that spelling.
 */

import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import { ingredientAliasKey } from '@recipes/shared';
import { ingredientAliases, ingredients } from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';

/** High enough to catch pluralisation/minor spelling drift without guessing. */
export const DEFAULT_FUZZY_MATCH_THRESHOLD = 0.78;
/** The best distinct ingredient must beat the runner-up by this much. */
export const DEFAULT_FUZZY_AMBIGUITY_MARGIN = 0.08;

export interface AliasCandidate {
  readonly ingredientId: string;
  readonly canonicalName: string;
  readonly alias: string;
  readonly similarity: number;
}

export interface IngredientAliasRepository {
  findExact(alias: string): Promise<AliasCandidate | null>;
  findFuzzy(alias: string, threshold: number): Promise<readonly AliasCandidate[]>;
  remember(alias: string, ingredientId: string): Promise<void>;
}

export interface IngredientMatch {
  readonly ingredientId: string;
  readonly canonicalName: string;
  /** The stored alias that won. For a learned match this is the fuzzy source alias. */
  readonly matchedAlias: string;
  readonly strategy: 'exact' | 'fuzzy';
  readonly similarity: number;
}

export interface IngredientMatcherOptions {
  readonly fuzzyThreshold?: number;
  readonly ambiguityMargin?: number;
}

export interface IngredientMatcher {
  match(name: string): Promise<IngredientMatch | null>;
}

export function createIngredientMatcher(
  repository: IngredientAliasRepository,
  options: IngredientMatcherOptions = {},
): IngredientMatcher {
  const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_MATCH_THRESHOLD;
  const ambiguityMargin = options.ambiguityMargin ?? DEFAULT_FUZZY_AMBIGUITY_MARGIN;
  assertProbability('fuzzyThreshold', fuzzyThreshold);
  assertProbability('ambiguityMargin', ambiguityMargin);

  return {
    async match(name: string): Promise<IngredientMatch | null> {
      const alias = ingredientAliasKey(name);
      if (alias.length === 0) return null;

      const exact = await repository.findExact(alias);
      if (exact !== null) return toMatch(exact, 'exact');

      const candidates = [
        ...(await repository.findFuzzy(alias, fuzzyThreshold)),
      ]
        .filter((candidate) => candidate.similarity > fuzzyThreshold)
        .sort(
          (left, right) =>
            right.similarity - left.similarity || left.alias.localeCompare(right.alias),
        );
      const best = candidates[0];
      if (best === undefined) return null;

      const runnerUp = candidates.find(
        (candidate) => candidate.ingredientId !== best.ingredientId,
      );
      if (
        runnerUp !== undefined &&
        best.similarity - runnerUp.similarity < ambiguityMargin
      ) {
        return null;
      }

      await repository.remember(alias, best.ingredientId);

      // Re-read the unique alias after ON CONFLICT DO NOTHING. If another
      // worker learned it concurrently, that row—not our stale fuzzy choice—
      // is authoritative.
      const learned = await repository.findExact(alias);
      if (learned === null) return null;
      if (learned.ingredientId !== best.ingredientId) return toMatch(learned, 'exact');

      return toMatch(best, 'fuzzy');
    },
  };
}

export function createPostgresIngredientAliasRepository(
  db: Database,
): IngredientAliasRepository {
  return {
    async findExact(alias) {
      const [row] = await db
        .select({
          ingredientId: ingredientAliases.ingredientId,
          canonicalName: ingredients.name,
          alias: ingredientAliases.alias,
        })
        .from(ingredientAliases)
        .innerJoin(ingredients, eq(ingredientAliases.ingredientId, ingredients.id))
        .where(eq(ingredientAliases.alias, alias))
        .limit(1);
      return row === undefined ? null : { ...row, similarity: 1 };
    },

    async findFuzzy(alias, threshold) {
      const similarity = sql<number>`similarity(${ingredientAliases.alias}, ${alias})`;
      return db
        .select({
          ingredientId: ingredientAliases.ingredientId,
          canonicalName: ingredients.name,
          alias: ingredientAliases.alias,
          similarity,
        })
        .from(ingredientAliases)
        .innerJoin(ingredients, eq(ingredientAliases.ingredientId, ingredients.id))
        .where(gt(similarity, threshold))
        .orderBy(desc(similarity), asc(ingredientAliases.alias));
    },

    async remember(alias, ingredientId) {
      await db
        .insert(ingredientAliases)
        .values({ alias, ingredientId })
        .onConflictDoNothing({ target: ingredientAliases.alias });
    },
  };
}

export function createPostgresIngredientMatcher(
  db: Database,
  options: IngredientMatcherOptions = {},
): IngredientMatcher {
  return createIngredientMatcher(createPostgresIngredientAliasRepository(db), options);
}

function toMatch(candidate: AliasCandidate, strategy: 'exact' | 'fuzzy'): IngredientMatch {
  return {
    ingredientId: candidate.ingredientId,
    canonicalName: candidate.canonicalName,
    matchedAlias: candidate.alias,
    strategy,
    similarity: strategy === 'exact' ? 1 : candidate.similarity,
  };
}

function assertProbability(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

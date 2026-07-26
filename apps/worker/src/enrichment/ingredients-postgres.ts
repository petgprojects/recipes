/**
 * Postgres persistence for semantic ingredient decisions (PLAN.md §4 stage 3).
 *
 * The globally exclusive enrichment queue is the primary concurrency bound.
 * Unique canonical-name/alias indexes plus row locks and authoritative alias
 * re-reads protect the remaining races with deterministic ingestion.
 */

import {
  and,
  asc,
  eq,
  isNull,
} from '@recipes/db/operators';
import {
  ingredientAliases,
  ingredients,
  recipeIngredients,
} from '@recipes/db/schema';
import type { Database } from '@recipes/db/client';
import {
  ingredientAliasKey,
  isAisle,
  type Aisle,
} from '@recipes/shared';

export interface UnmappedIngredientLine {
  readonly recipeId: string;
  readonly position: number;
  readonly rawText: string;
}

/**
 * Caller-held provenance for a parsed line. `rawText` guards against an
 * upstream recipe edit reusing the same `(recipe_id, position)`.
 */
export interface ParsedIngredientLineRef extends UnmappedIngredientLine {
  readonly parsedName: string;
}

/**
 * One semantic decision may serve several lines with the same normalized
 * parsed name. `aisle` is used only when the canonical ingredient is new.
 */
export interface IngredientMappingDecision {
  readonly inputName: string;
  readonly canonicalName: string;
  readonly aisle: Aisle;
}

export interface ApplyIngredientMappingsResult {
  /** New normalized input aliases learned by this transaction. */
  readonly learnedCount: number;
  /** Still-null recipe ingredient rows successfully assigned. */
  readonly mappedCount: number;
  /** Missing, changed, or already-mapped recipe ingredient rows. */
  readonly staleCount: number;
  /** Input aliases retained under a different authoritative owner. */
  readonly conflictCount: number;
}

export async function loadUnmappedIngredientLines(
  db: Database,
  limit: number,
): Promise<UnmappedIngredientLine[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new RangeError('limit must be a safe integer between 1 and 10000');
  }
  return db
    .select({
      recipeId: recipeIngredients.recipeId,
      position: recipeIngredients.position,
      rawText: recipeIngredients.rawText,
    })
    .from(recipeIngredients)
    .where(isNull(recipeIngredients.ingredientId))
    .orderBy(
      asc(recipeIngredients.recipeId),
      asc(recipeIngredients.position),
    )
    .limit(limit);
}

/**
 * Applies a batch atomically. Decisions are joined to parsed refs through the
 * same normalized input-name key used by the deterministic matcher.
 */
export async function applyIngredientMappings(
  db: Database,
  decisions: readonly IngredientMappingDecision[],
  parsedLineRefs: readonly ParsedIngredientLineRef[],
): Promise<ApplyIngredientMappingsResult> {
  const decisionsByAlias = normalizedDecisions(decisions);

  return db.transaction(async (tx) => {
    let learnedCount = 0;
    let mappedCount = 0;
    let staleCount = 0;
    let conflictCount = 0;

    for (const ref of parsedLineRefs) {
      const inputAlias = ingredientAliasKey(ref.parsedName);
      if (inputAlias.length === 0) {
        throw new TypeError('parsed ingredient names must not be empty');
      }
      const decision = decisionsByAlias.get(inputAlias);
      if (decision === undefined) {
        throw new Error(`No ingredient mapping decision for "${inputAlias}"`);
      }

      // Lock and validate the exact source line before teaching aliases. A
      // stale LLM result must not mutate canonical knowledge even if its row
      // can no longer be updated.
      const [current] = await tx
        .select({
          ingredientId: recipeIngredients.ingredientId,
          rawText: recipeIngredients.rawText,
        })
        .from(recipeIngredients)
        .where(
          and(
            eq(recipeIngredients.recipeId, ref.recipeId),
            eq(recipeIngredients.position, ref.position),
          ),
        )
        .limit(1)
        .for('update');
      if (
        current === undefined ||
        current.ingredientId !== null ||
        current.rawText !== ref.rawText
      ) {
        staleCount += 1;
        continue;
      }

      const canonicalAlias = ingredientAliasKey(decision.canonicalName);
      const retainedInputOwner = await findAliasOwner(tx, inputAlias);
      let targetId: string;
      if (retainedInputOwner !== null) {
        // Exact aliases are authoritative. Avoid creating an orphan canonical
        // ingredient when the requested input spelling is already owned.
        const intendedExistingOwner = await findExistingCanonicalIngredient(
          tx,
          canonicalAlias,
        );
        if (intendedExistingOwner !== retainedInputOwner) {
          conflictCount += 1;
        }
        targetId = retainedInputOwner;
      } else {
        targetId = await resolveCanonicalIngredient(
          tx,
          canonicalAlias,
          decision.aisle,
        );
        const canonicalOwnership = await retainAlias(
          tx,
          canonicalAlias,
          targetId,
        );
        // This can only differ after a concurrent alias insert. The unique
        // alias row is authoritative, matching the deterministic matcher.
        if (canonicalOwnership.ownerId !== targetId) {
          conflictCount += 1;
          targetId = canonicalOwnership.ownerId;
        }

        const inputOwnership =
          inputAlias === canonicalAlias
            ? canonicalOwnership
            : await retainAlias(tx, inputAlias, targetId);
        if (inputOwnership.inserted) learnedCount += 1;
        if (inputOwnership.ownerId !== targetId) {
          conflictCount += 1;
          targetId = inputOwnership.ownerId;
        }
      }

      const updated = await tx
        .update(recipeIngredients)
        .set({ ingredientId: targetId })
        .where(
          and(
            eq(recipeIngredients.recipeId, ref.recipeId),
            eq(recipeIngredients.position, ref.position),
            eq(recipeIngredients.rawText, ref.rawText),
            isNull(recipeIngredients.ingredientId),
          ),
        )
        .returning({ recipeId: recipeIngredients.recipeId });
      if (updated.length === 0) {
        staleCount += 1;
      } else {
        mappedCount += 1;
      }
    }

    return {
      learnedCount,
      mappedCount,
      staleCount,
      conflictCount,
    };
  });
}

interface NormalizedDecision {
  readonly canonicalName: string;
  readonly aisle: Aisle;
}

function normalizedDecisions(
  decisions: readonly IngredientMappingDecision[],
): ReadonlyMap<string, NormalizedDecision> {
  const normalized = new Map<string, NormalizedDecision>();
  const aisleByCanonical = new Map<string, Aisle>();
  for (const decision of decisions) {
    const inputAlias = ingredientAliasKey(decision.inputName);
    const canonicalName = ingredientAliasKey(decision.canonicalName);
    if (inputAlias.length === 0 || canonicalName.length === 0) {
      throw new TypeError('ingredient decision names must not be empty');
    }
    if (!isAisle(decision.aisle)) {
      throw new TypeError(`Invalid ingredient aisle: ${String(decision.aisle)}`);
    }
    const canonicalAisle = aisleByCanonical.get(canonicalName);
    if (canonicalAisle !== undefined && canonicalAisle !== decision.aisle) {
      throw new Error(
        `Conflicting aisles for canonical ingredient "${canonicalName}"`,
      );
    }
    aisleByCanonical.set(canonicalName, decision.aisle);

    const previous = normalized.get(inputAlias);
    if (
      previous !== undefined &&
      (previous.canonicalName !== canonicalName ||
        previous.aisle !== decision.aisle)
    ) {
      throw new Error(`Conflicting ingredient decisions for "${inputAlias}"`);
    }
    normalized.set(inputAlias, {
      canonicalName,
      aisle: decision.aisle,
    });
  }
  return normalized;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function resolveCanonicalIngredient(
  tx: Transaction,
  canonicalName: string,
  aisle: Aisle,
): Promise<string> {
  const normalizedName = ingredientAliasKey(canonicalName);
  const existing = await findExistingCanonicalIngredient(tx, normalizedName);
  if (existing !== null) return existing;

  const [inserted] = await tx
    .insert(ingredients)
    .values({
      name: normalizedName,
      aisle,
      defaultUnit: null,
    })
    .onConflictDoNothing({ target: ingredients.name })
    .returning({ id: ingredients.id });
  if (inserted !== undefined) return inserted.id;

  const [concurrent] = await tx
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(eq(ingredients.name, normalizedName))
    .limit(1);
  if (concurrent === undefined) {
    throw new Error(`Could not resolve canonical ingredient "${normalizedName}"`);
  }
  return concurrent.id;
}

async function findExistingCanonicalIngredient(
  tx: Transaction,
  normalizedName: string,
): Promise<string | null> {
  const [exact] = await tx
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(eq(ingredients.name, normalizedName))
    .limit(1);
  if (exact !== undefined) return exact.id;

  // A canonical decision can name an already-learned alias. Reusing its owner
  // is safer than creating a near-duplicate canonical ingredient.
  const [aliased] = await tx
    .select({ id: ingredientAliases.ingredientId })
    .from(ingredientAliases)
    .where(eq(ingredientAliases.alias, normalizedName))
    .limit(1);
  if (aliased !== undefined) return aliased.id;
  return null;
}

interface AliasOwnership {
  readonly ownerId: string;
  readonly inserted: boolean;
}

async function findAliasOwner(
  tx: Transaction,
  alias: string,
): Promise<string | null> {
  const [retained] = await tx
    .select({ ingredientId: ingredientAliases.ingredientId })
    .from(ingredientAliases)
    .where(eq(ingredientAliases.alias, alias))
    .limit(1);
  return retained?.ingredientId ?? null;
}

async function retainAlias(
  tx: Transaction,
  alias: string,
  intendedOwnerId: string,
): Promise<AliasOwnership> {
  const [inserted] = await tx
    .insert(ingredientAliases)
    .values({
      alias,
      ingredientId: intendedOwnerId,
    })
    .onConflictDoNothing({ target: ingredientAliases.alias })
    .returning({ ingredientId: ingredientAliases.ingredientId });
  if (inserted !== undefined) {
    return { ownerId: inserted.ingredientId, inserted: true };
  }

  const [retained] = await tx
    .select({ ingredientId: ingredientAliases.ingredientId })
    .from(ingredientAliases)
    .where(eq(ingredientAliases.alias, alias))
    .limit(1);
  if (retained === undefined) {
    throw new Error(`Could not retain ingredient alias "${alias}"`);
  }
  return { ownerId: retained.ingredientId, inserted: false };
}

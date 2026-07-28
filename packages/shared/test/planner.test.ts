/**
 * The Phase 4 migration contract.
 *
 * PLAN.md §5, Phase 4: "One-time migration of existing `localStorage` state
 * into the account on first sign-in — don't make the user lose their picks."
 *
 * These tests pin down what that sentence means in the one direction it is
 * ambiguous: a pick that exists on *both* sides keeps the account's batch
 * count, not the browser's. A migration only ever adds, which is also what
 * makes it safe to run more than once — the client remembers that it migrated
 * in the same `localStorage` the migration reads from, so a cleared browser
 * will run it again.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BATCHES,
  MAX_IMPORT_ENTRIES,
  MIN_BATCHES,
  checkPatchSchema,
  clampBatches,
  countPlannerAdditions,
  mergePlannerState,
  plannerAdditions,
  plannerImportSchema,
  savedPatchSchema,
  type PlannerState,
} from '../src/planner';

const SHEET_PAN = '11111111-1111-4111-8111-111111111111';
const CHILI = '22222222-2222-4222-8222-222222222222';
const CURRY = '33333333-3333-4333-8333-333333333333';

const EMPTY: PlannerState = { saved: {}, checked: {} };

function state(saved: Record<string, number>, checked: string[] = []): PlannerState {
  return {
    saved,
    checked: Object.fromEntries(checked.map((key) => [key, true as const])),
  };
}

describe('clampBatches', () => {
  it('holds the stepper bounds', () => {
    expect(clampBatches(0)).toBe(MIN_BATCHES);
    expect(clampBatches(-5)).toBe(MIN_BATCHES);
    expect(clampBatches(99)).toBe(MAX_BATCHES);
    expect(clampBatches(2)).toBe(2);
  });

  it('rounds rather than truncating', () => {
    expect(clampBatches(2.6)).toBe(3);
    expect(clampBatches(2.4)).toBe(2);
  });
});

describe('plannerAdditions', () => {
  it('migrates everything into an empty account', () => {
    const local = state({ [SHEET_PAN]: 1, [CHILI]: 3 }, ['abc:mass']);

    const additions = plannerAdditions(EMPTY, local);

    expect(additions.saved).toEqual({ [SHEET_PAN]: 1, [CHILI]: 3 });
    expect(additions.checked).toEqual({ 'abc:mass': true });
    expect(countPlannerAdditions(additions)).toBe(3);
  });

  it('never overwrites a pick the account already has', () => {
    const server = state({ [SHEET_PAN]: 2 });
    const local = state({ [SHEET_PAN]: 1, [CHILI]: 1 });

    const additions = plannerAdditions(server, local);

    // The account said two batches; the anonymous session in this browser
    // said one. The account wins, and only the genuinely new pick is written.
    expect(additions.saved).toEqual({ [CHILI]: 1 });
  });

  it('is a no-op the second time it runs', () => {
    const local = state({ [SHEET_PAN]: 2 }, ['abc:mass']);
    const migrated = mergePlannerState(EMPTY, local);

    expect(countPlannerAdditions(plannerAdditions(migrated, local))).toBe(0);
  });

  it('clamps a batch count that local storage was hand-edited to', () => {
    const additions = plannerAdditions(EMPTY, state({ [CURRY]: 99 }));

    expect(additions.saved[CURRY]).toBe(MAX_BATCHES);
  });

  it('leaves the account alone when there is nothing local to migrate', () => {
    const server = state({ [SHEET_PAN]: 2 }, ['abc:mass']);

    expect(countPlannerAdditions(plannerAdditions(server, EMPTY))).toBe(0);
  });
});

describe('mergePlannerState', () => {
  it('is the union, with the account winning every conflict', () => {
    const server = state({ [SHEET_PAN]: 2 }, ['abc:mass']);
    const local = state({ [SHEET_PAN]: 1, [CHILI]: 4 }, ['abc:mass', 'def:volume']);

    expect(mergePlannerState(server, local)).toEqual({
      saved: { [SHEET_PAN]: 2, [CHILI]: 4 },
      checked: { 'abc:mass': true, 'def:volume': true },
    });
  });
});

describe('wire schemas', () => {
  it('accepts a batch change and a removal', () => {
    expect(savedPatchSchema.parse({ recipeId: SHEET_PAN, batches: 3 })).toEqual({
      recipeId: SHEET_PAN,
      batches: 3,
    });
    // `null` is how the client says "unpick this", so it must survive parsing.
    expect(savedPatchSchema.parse({ recipeId: SHEET_PAN, batches: null }).batches).toBeNull();
  });

  it('rejects a non-uuid recipe id and an out-of-range batch count', () => {
    expect(savedPatchSchema.safeParse({ recipeId: 'sheetpan-chili', batches: 1 }).success).toBe(
      false,
    );
    expect(savedPatchSchema.safeParse({ recipeId: SHEET_PAN, batches: 0 }).success).toBe(false);
    expect(savedPatchSchema.safeParse({ recipeId: SHEET_PAN, batches: 9 }).success).toBe(false);
  });

  it('rejects an empty or oversized item key', () => {
    expect(checkPatchSchema.safeParse({ itemKey: '', checked: true }).success).toBe(false);
    expect(
      checkPatchSchema.safeParse({ itemKey: 'x'.repeat(161), checked: true }).success,
    ).toBe(false);
    expect(checkPatchSchema.parse({ itemKey: 'raw:kosher-salt:unspecified', checked: true })).toEqual(
      { itemKey: 'raw:kosher-salt:unspecified', checked: true },
    );
  });

  it('defaults both halves of an import, so a half-empty browser still migrates', () => {
    expect(plannerImportSchema.parse({})).toEqual({ saved: {}, checked: {} });
    expect(plannerImportSchema.parse({ checked: { 'abc:mass': true } }).saved).toEqual({});
  });

  it('refuses an import larger than one reader could plausibly have', () => {
    const saved = Object.fromEntries(
      Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, (_unused, index) => [
        `1111111a-1111-4111-8111-${String(index).padStart(12, '0')}`,
        1,
      ]),
    );

    expect(plannerImportSchema.safeParse({ saved }).success).toBe(false);
  });
});

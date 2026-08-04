/**
 * The share-link contract.
 *
 * The database enforces the same code shape (`recipes_share_code_shape`,
 * migration 0005), so these are the application-side mirror of that
 * constraint. The pair that matters most is the round trip: every handle this
 * module builds must parse back to the code it was built from, because the
 * failure mode when it does not is a link that was already pasted somewhere and
 * now 404s.
 */

import { describe, expect, it } from 'vitest';
import {
  SHARE_CODE_ALPHABET,
  SHARE_CODE_LENGTH,
  isShareCode,
  parseRecipeHandle,
  recipeHandle,
  recipeSharePath,
  recipeShareUrl,
} from '../src/share';

/** Two real codes from the backfill, and one from a duplicate-slug recipe. */
const CODE = 'ydbw8vzv';
const OTHER_CODE = '8gbe18px';

describe('SHARE_CODE_ALPHABET', () => {
  it('is 32 unambiguous symbols', () => {
    expect(SHARE_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(SHARE_CODE_ALPHABET).size).toBe(32);
  });

  it('excludes the four characters that get misread', () => {
    for (const ambiguous of ['i', 'l', 'o', 'u']) {
      expect(SHARE_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('agrees with isShareCode about every symbol it contains', () => {
    for (const symbol of SHARE_CODE_ALPHABET) {
      expect(isShareCode(symbol.repeat(SHARE_CODE_LENGTH))).toBe(true);
    }
  });

  it('rejects the excluded characters, so the parser and the CHECK agree', () => {
    for (const ambiguous of ['i', 'l', 'o', 'u']) {
      expect(isShareCode(ambiguous.repeat(SHARE_CODE_LENGTH))).toBe(false);
    }
  });
});

describe('isShareCode', () => {
  it('accepts a real code', () => {
    expect(isShareCode(CODE)).toBe(true);
  });

  it('is length-exact', () => {
    expect(isShareCode(CODE.slice(0, 7))).toBe(false);
    expect(isShareCode(`${CODE}a`)).toBe(false);
    expect(isShareCode('')).toBe(false);
  });

  it('rejects uppercase, punctuation and a UUID', () => {
    expect(isShareCode(CODE.toUpperCase())).toBe(false);
    expect(isShareCode('ydbw-8vz')).toBe(false);
    expect(isShareCode('11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});

describe('recipeHandle', () => {
  it('joins the slug and the code', () => {
    expect(recipeHandle('spicy-grilled-watermelon', CODE)).toBe(
      `spicy-grilled-watermelon-${CODE}`,
    );
  });

  it('distinguishes two recipes that share a slug', () => {
    expect(recipeHandle('spicy-grilled-watermelon', CODE)).not.toBe(
      recipeHandle('spicy-grilled-watermelon', OTHER_CODE),
    );
  });

  it('falls back to the bare code rather than emitting a leading hyphen', () => {
    expect(recipeHandle('', CODE)).toBe(CODE);
    expect(recipeHandle('   ', CODE)).toBe(CODE);
    expect(recipeHandle('-', CODE)).toBe(CODE);
  });
});

describe('recipeSharePath / recipeShareUrl', () => {
  it('builds the canonical path', () => {
    expect(recipeSharePath('chicken-alambre', CODE)).toBe(`/r/chicken-alambre-${CODE}`);
  });

  it('builds an absolute URL without doubling the slash', () => {
    expect(recipeShareUrl('http://localhost:3000', 'chicken-alambre', CODE)).toBe(
      `http://localhost:3000/r/chicken-alambre-${CODE}`,
    );
    expect(recipeShareUrl('http://localhost:3000/', 'chicken-alambre', CODE)).toBe(
      `http://localhost:3000/r/chicken-alambre-${CODE}`,
    );
  });
});

describe('parseRecipeHandle', () => {
  it('reads the code and the slug back out', () => {
    expect(parseRecipeHandle(`spicy-grilled-watermelon-${CODE}`)).toEqual({
      shareCode: CODE,
      slug: 'spicy-grilled-watermelon',
    });
  });

  it('accepts a bare code, with an empty slug', () => {
    expect(parseRecipeHandle(CODE)).toEqual({ shareCode: CODE, slug: '' });
  });

  it('takes the LAST segment, so a code-shaped word inside the slug is harmless', () => {
    // `abcdefgh` is eight characters drawn entirely from the alphabet, so it is
    // indistinguishable from a code on its own. It is not the last segment, so
    // it is never considered — which is the whole reason the rule is "last
    // segment" rather than "the first segment that looks like a code".
    expect(parseRecipeHandle(`abcdefgh-${CODE}`)).toEqual({
      shareCode: CODE,
      slug: 'abcdefgh',
    });
    expect(parseRecipeHandle(`${CODE}-${OTHER_CODE}`)?.shareCode).toBe(OTHER_CODE);
  });

  it('is case- and slash-forgiving, the way a pasted link is', () => {
    expect(parseRecipeHandle(`/SPICY-WATERMELON-${CODE.toUpperCase()}/`)).toEqual({
      shareCode: CODE,
      slug: 'spicy-watermelon',
    });
  });

  it('returns null when the last segment is not a code', () => {
    expect(parseRecipeHandle('spicy-grilled-watermelon')).toBeNull();
    expect(parseRecipeHandle('')).toBeNull();
    expect(parseRecipeHandle('/')).toBeNull();
    expect(parseRecipeHandle(`${CODE}-`)).toBeNull();
    expect(parseRecipeHandle('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('round-trips every handle it builds', () => {
    const slugs = [
      'spicy-grilled-watermelon',
      'chicken-alambre-mexican-chicken-skillet-with-bacon-vegetables-and-melted-cheese',
      'recipe',
      '',
    ];
    for (const slug of slugs) {
      const parsed = parseRecipeHandle(recipeHandle(slug, CODE));
      expect(parsed?.shareCode).toBe(CODE);
      expect(parsed?.slug).toBe(slug);
    }
  });
});

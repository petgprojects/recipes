/**
 * Share links: the one place that knows what `/r/<handle>` means.
 *
 * A handle is `<slug>-<share_code>` — `spicy-grilled-watermelon-ydbw8vzv`. The
 * two halves have very different jobs:
 *
 *   - the **code** identifies the recipe, and nothing else does. `recipes.slug`
 *     is documented as non-unique in `scanner/text.ts` and the corpus agrees:
 *     425 recipes, 419 distinct slugs. A link keyed on a slug would resolve to
 *     whichever of two identically-titled recipes the query happened to return.
 *   - the **slug** is for the human holding the link, and is deliberately not
 *     part of resolution. That is what lets a pasted link survive a Phase 2
 *     title rewrite: the code still resolves, and the route redirects to the
 *     new canonical handle rather than 404ing on the old words.
 *
 * The code alphabet is Crockford-shaped — no `i`, `l`, `o` or `u`, so a code
 * read off a screenshot cannot be ambiguous — and is enforced in the database
 * too, by `recipes_share_code_shape` (migration 0005). Both sides must agree;
 * a code the database accepts and this parser rejects is a link that 404s for
 * no visible reason.
 *
 * Client-safe and in the barrel: the share button, the route and the tests all
 * need it, and none of it touches a database or an environment variable.
 */

/** The 32 symbols `gen_share_code()` draws from. */
export const SHARE_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 32^8 ≈ 1.1e12, against a corpus of a few hundred. */
export const SHARE_CODE_LENGTH = 8;

/**
 * Kept as a character class rather than built from {@link SHARE_CODE_ALPHABET}
 * so it reads the same as the SQL `CHECK` constraint it mirrors.
 */
const SHARE_CODE = /^[0-9a-hjkmnp-tv-z]{8}$/;

/** The share-link path prefix, without a trailing slash. */
export const SHARE_PATH_PREFIX = '/r';

export function isShareCode(value: string): boolean {
  return SHARE_CODE.test(value);
}

/**
 * The canonical handle for a recipe. Falls back to the bare code when a slug is
 * empty or unusable — `/r/-ydbw8vzv` would still resolve, but it looks broken,
 * and a link that looks broken does not get pasted.
 */
export function recipeHandle(slug: string, shareCode: string): string {
  const trimmed = slug.trim().replace(/^-+|-+$/g, '');
  return trimmed === '' ? shareCode : `${trimmed}-${shareCode}`;
}

/** The canonical path, e.g. `/r/spicy-grilled-watermelon-ydbw8vzv`. */
export function recipeSharePath(slug: string, shareCode: string): string {
  return `${SHARE_PATH_PREFIX}/${recipeHandle(slug, shareCode)}`;
}

/**
 * The absolute URL to paste. `origin` has no trailing slash — pass
 * `window.location.origin` on the client, `NEXT_PUBLIC_APP_URL` on the server.
 */
export function recipeShareUrl(origin: string, slug: string, shareCode: string): string {
  return `${origin.replace(/\/+$/, '')}${recipeSharePath(slug, shareCode)}`;
}

export interface ParsedRecipeHandle {
  /** The identifying half. */
  shareCode: string;
  /** The decorative half, `''` when the handle was a bare code. */
  slug: string;
}

/**
 * Pull the code out of a handle, or `null` if there isn't one.
 *
 * **Always the last hyphen-delimited segment**, which is what makes this
 * unambiguous: a slug can contain any number of hyphens and an eight-letter
 * word that happens to avoid `i`, `l`, `o` and `u` is perfectly possible in the
 * middle of one. Taking the last segment and nothing else means the only handle
 * this can misread is one that was never generated here.
 *
 * A bare code (`/r/ydbw8vzv`) parses, with an empty slug — hand-typed, or a
 * link truncated by something that ate the words. The route redirects it to the
 * canonical handle.
 */
export function parseRecipeHandle(handle: string): ParsedRecipeHandle | null {
  const trimmed = handle.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (trimmed === '') return null;

  const cut = trimmed.lastIndexOf('-');
  if (cut === -1) return isShareCode(trimmed) ? { shareCode: trimmed, slug: '' } : null;

  const shareCode = trimmed.slice(cut + 1);
  if (!isShareCode(shareCode)) return null;

  return { shareCode, slug: trimmed.slice(0, cut) };
}

/**
 * The canonical ingredient seed.
 *
 * PLAN.md §4: "Seed the canonical table with the ~120 ingredients already in
 * the artifact — they're clean, hand-classified, and cover the common cases."
 * This is the one piece of `meal-prep-planner.jsx` kept as data.
 *
 * The JSON is the source of truth; this module only puts a type on it. It is
 * NOT validated with Zod at import time — that would run 117 parses in every
 * browser bundle that happens to want the aisle list. `test/vocab.test.ts`
 * validates the file instead, which is where drift would actually be caught.
 */

import { z } from 'zod';
import rawSeed from './data/ingredient-seed.json';
import { AISLES, type Aisle } from './vocab';

export interface SeedIngredient {
  /** Lower-case canonical name. Unique — it is the `ingredients.name` key. */
  readonly name: string;
  readonly aisle: Aisle;
  /** The unit this is usually bought in, or null for things counted whole. */
  readonly defaultUnit: string | null;
}

/**
 * The storage key used by `ingredient_aliases.alias`.
 *
 * Both the seed and the runtime matcher call this exact helper. Keeping the
 * deliberately small transform in one pure module prevents a future cleanup
 * on either side from silently making seeded aliases impossible to match.
 */
export function ingredientAliasKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Words that say how an ingredient was bought, cut or written down rather than
 * what it *is*. Two names that overlap only here have not been shown to be the
 * same grocery item: `flaky sea salt for sprinkling` and `flat-leaf parsley`
 * share nothing but the shape of the sentence.
 *
 * `orange` is deliberately absent — it is a fruit as often as it is a colour,
 * and dropping it would stop `orange zest` from matching `orange`.
 */
const IDENTITY_STOPWORDS = new Set([
  // preparation
  'chopped', 'minced', 'sliced', 'diced', 'grated', 'shredded', 'crushed',
  'ground', 'cut', 'trimmed', 'peeled', 'seeded', 'cored', 'pitted', 'beaten',
  'cooked', 'raw', 'toasted', 'roasted', 'softened', 'melted', 'mashed',
  // condition and provenance
  'fresh', 'freshly', 'dried', 'frozen', 'canned', 'jarred', 'ripe', 'firm',
  'unsalted', 'salted', 'unsweetened', 'sweetened', 'low', 'sodium', 'store',
  'bought', 'homemade', 'room', 'temperature', 'quality', 'best', 'preferred',
  'favorite', 'plain', 'regular',
  // amount, size and packaging
  'packed', 'loosely', 'lightly', 'roughly', 'finely', 'coarsely', 'thinly',
  'whole', 'halves', 'large', 'medium', 'small', 'baby', 'jumbo', 'extra',
  'plus', 'more', 'about', 'bunch', 'head', 'piece', 'pieces', 'leaves',
  'leaf', 'stems', 'stem', 'sprigs', 'sprig', 'slab', 'block', 'loaf',
  // colours, which name a variety and not an identity
  'red', 'green', 'white', 'black', 'yellow', 'purple', 'brown', 'golden',
  // sentence glue
  'a', 'an', 'the', 'of', 'or', 'and', 'to', 'for', 'as', 'such', 'like',
  'your', 'with', 'from', 'in', 'taste', 'garnish', 'serving', 'optional',
  'needed', 'divided', 'other', 'any',
]);

function foldDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/** `tomatoes` → `tomato`, `chilies` → `chily`, `beans` → `bean`. */
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function identityTokens(name: string): string[] {
  const all = foldDiacritics(name.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(singularize);
  const content = all.filter((token) => !IDENTITY_STOPWORDS.has(token));
  // A name made entirely of stopwords ("baby greens") still has to compare
  // against something, so fall back to every token rather than to nothing.
  return content.length > 0 ? content : all;
}

/** The shorter token has to be long enough that a shared prefix means something. */
const MIN_PREFIX_TOKEN_LENGTH = 4;

function tokensAgree(left: string, right: string): boolean {
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= MIN_PREFIX_TOKEN_LENGTH && long.startsWith(short);
}

/**
 * Is `canonicalName` a defensible canonical identity for `inputName`?
 *
 * This is the guard on the semantic mapper's `action: "existing"` claim
 * (PROGRESS.md amendment A18). The provider-facing schema pins
 * `canonical_name` to an enum of the whole canonical vocabulary, so once the
 * model has committed to `"existing"` the decoder *must* emit some member of
 * that enum — and when the right answer is not in there it emits a neighbour
 * instead. That is how `ketchup` became `kalamata olives` and `tahini`,
 * `tapioca flour` and `tamarind pulp` all became `taco seasoning`. A wrong
 * canonical is silent: the line still renders, it just merges into the wrong
 * item on someone's grocery list.
 *
 * The test is lexical and deliberately blunt: the two names must share an
 * identity word, ignoring preparation, packaging and colour. It cannot tell
 * `garbanzo beans` → `chickpeas` (right) from `chopped chives` → `chickpeas`
 * (wrong), so it rejects both. That asymmetry is the point — a rejected
 * decision becomes its own canonical and shows up as a second line on the
 * list, which a reader can see and shrug at, while a wrong merge is a
 * quantity they never find out was wrong. Synonyms already learned in
 * `ingredient_aliases` are matched exactly and never reach this guard, so it
 * only constrains names the corpus has not seen before.
 */
export function isPlausibleCanonicalMatch(inputName: string, canonicalName: string): boolean {
  const input = ingredientAliasKey(inputName);
  const canonical = ingredientAliasKey(canonicalName);
  if (input === canonical) return true;
  if (input.length === 0 || canonical.length === 0) return false;

  const canonicalTokens = identityTokens(canonical);
  return identityTokens(input).some((token) =>
    canonicalTokens.some((other) => tokensAgree(token, other)),
  );
}

/** Shape check used by the tests and available to the seeder. */
export const seedIngredientSchema = z.object({
  name: z.string().trim().min(1),
  aisle: z.enum(AISLES),
  defaultUnit: z.string().trim().min(1).nullable(),
});

export const ingredientSeedSchema = z.array(seedIngredientSchema);

/** All 117 hand-classified canonical ingredients, in file order. */
export const CANONICAL_INGREDIENTS: readonly SeedIngredient[] = rawSeed as SeedIngredient[];

const BY_NAME: ReadonlyMap<string, SeedIngredient> = new Map(
  CANONICAL_INGREDIENTS.map((i) => [i.name.toLowerCase(), i]),
);

export function findSeedIngredient(name: string): SeedIngredient | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

/** Every aisle that actually appears in the seed data, in store-walk order. */
export function seededAisles(): Aisle[] {
  const present = new Set(CANONICAL_INGREDIENTS.map((i) => i.aisle));
  return AISLES.filter((a) => present.has(a));
}

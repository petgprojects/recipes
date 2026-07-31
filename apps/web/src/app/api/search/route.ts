/**
 * GET /api/search?q= — one natural-language search (FILTER_PLAN.md §7, Phase 5).
 *
 * Thin on purpose: `lib/search-service.ts` does the work, and this file decides
 * which of four answers the reader gets.
 *
 *   401  no session. **Search is signed-in only (§8)**, following ratings
 *        rather than the grocery list: unlike a pick, there is nothing to
 *        migrate on a later sign-in, and the §3.3 profile that makes
 *        "something I'd like tonight" answerable only exists for a reader we
 *        know. The bar is not rendered signed out either.
 *   400  no `q`, an empty one, or one past `MAX_SEARCH_QUERY_CHARS`. Rejected
 *        here rather than at the parse step, so a bad request never reaches a
 *        billable call.
 *   503  the `kind='search'` budget for this UTC day is ≥90% spent (§8), or the
 *        durable lease refused mid-call at 100%. The bar reads this and renders
 *        itself disabled with an explanation — it is never hidden.
 *   200  the results, plus the notices that say how they were arrived at.
 *
 * A 503 here is the *search* pot, never the enrichment one. Reading the
 * unfiltered daily total would let a heavy enrichment night close the search
 * bar with no clue why, which is the exact failure Phase 4's separate pot
 * exists to prevent.
 */

import { MAX_SEARCH_QUERY_CHARS } from '@recipes/shared/search';
import { runSearchQuery } from '@/lib/search-service';
import { badRequest, jsonOk, unavailable, withUser } from '@/lib/planner-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * §8's words in the 503 body.
 *
 * Not exported — a route module may only export handlers and Next's own config
 * fields, and `next build` fails the type check on anything else. The bar
 * renders its own copy of this sentence from `searchAvailable` rather than
 * reading it off an error, so the two never have to agree on a wire format;
 * they only have to agree on English.
 */
const SEARCH_RESTING_MESSAGE = 'Search is resting until tomorrow.';

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim();

  if (query === '') {
    return badRequest('Expected a `q` query param with something to search for.');
  }
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    return badRequest(
      `That search is ${query.length} characters; the limit is ${MAX_SEARCH_QUERY_CHARS}.`,
    );
  }

  return withUser(async (user) => {
    const outcome = await runSearchQuery(user.id, query);
    if (outcome.result === 'budget-exhausted') {
      // `unavailable()` rather than a bespoke 503, so the client's ApiError
      // carries the message the same way it does for a database blip.
      return unavailable(new Error(SEARCH_RESTING_MESSAGE));
    }
    return jsonOk(outcome.response);
  });
}

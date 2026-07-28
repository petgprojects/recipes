/**
 * The plumbing every `/api/planner/*` handler repeats: resolve the user, parse
 * the body, and turn a thrown database error into a 503 rather than a 500.
 *
 * The status codes matter to the client, so they are decided once here:
 *
 *   401  no session. The planner reads this as "you were signed out" and falls
 *        back to `localStorage` rather than showing an error — being signed out
 *        is a normal state, not a failure (PLAN.md §5: auth adds persistence,
 *        it does not become a gate).
 *   400  the body did not match the contract in `@recipes/shared/planner`.
 *   503  the database did not answer. Same distinction `/api/recipes` draws:
 *        "you have no picks" and "we could not read your picks" must not look
 *        alike, or a blip silently reads as an empty list.
 */

import { NextResponse } from 'next/server';
import { getCurrentUser, type CurrentUser } from './current-user';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function jsonOk(body: unknown) {
  return NextResponse.json(body, { headers: NO_STORE });
}

export function unauthorized() {
  return NextResponse.json({ error: 'Not signed in.' }, { status: 401, headers: NO_STORE });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
}

export function unavailable(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 503, headers: NO_STORE },
  );
}

/**
 * Run `handler` with the signed-in user, or answer 401. Wraps the whole thing
 * so a pool timeout in any planner route lands as a 503 with a message instead
 * of an unhandled rejection.
 */
export async function withUser(
  handler: (user: CurrentUser) => Promise<NextResponse>,
): Promise<NextResponse> {
  let user: CurrentUser | null;
  try {
    user = await getCurrentUser();
  } catch (error: unknown) {
    return unavailable(error);
  }

  if (user === null) return unauthorized();

  try {
    return await handler(user);
  } catch (error: unknown) {
    return unavailable(error);
  }
}

/**
 * Just enough of a Zod schema to validate a body.
 *
 * Structural rather than `z.ZodTypeAny` because `zod` is not a dependency of
 * this app and should not become one: schemas are authored once in
 * `@recipes/shared/planner` and consumed here, so the boundary this app needs
 * is "something that can parse", not the whole library's type surface.
 */
interface BodySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/**
 * Parse a JSON body against a schema. Returns the error *response* rather than
 * throwing, so a handler reads as a straight line.
 */
export async function parseBody<T>(
  request: Request,
  schema: BodySchema<T>,
): Promise<{ data: T } | { response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { response: badRequest('Expected a JSON body.') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { response: badRequest(detail) };
  }

  return { data: parsed.data };
}

/**
 * Who is making this request, server-side.
 *
 * PLAN.md §4: "`getCurrentUser()` returns [`dev@local`] when
 * `NODE_ENV !== 'production'` and no session is present; in production, no
 * session means no user."
 *
 * The plan's fallback is implemented, but **opt-in** rather than automatic —
 * PROGRESS.md amendment A15. The fallback existed so Phases 1–3 could exercise
 * the `user_id` columns before Auth.js existed. Phase 4 is Auth.js existing,
 * and two of its own requirements are that the planner keeps working signed out
 * and that `localStorage` picks migrate on first sign-in. An always-on fallback
 * makes a development request permanently signed in as `dev@local`, so neither
 * is reachable outside a production build. `DEV_AUTH_FALLBACK=true` restores
 * the documented behaviour for anyone who wants it; production ignores it
 * outright.
 */

import { db, eq, users } from '@recipes/db';
// Imported rather than retyped: if the seed ever renames the stand-in, this
// lookup has to move with it or the fallback silently stops resolving.
import { DEV_USER_EMAIL } from '@recipes/db/seed';
import { env, isProduction } from '@recipes/shared/env';
import { auth, isAuthConfigured } from './auth';

/**
 * The client-safe projection of a user. Deliberately not the `users` row: this
 * crosses into a client component as a prop, so it carries no timestamps and
 * nothing that is not already visible to the person signed in.
 */
export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Skipped entirely when the Phase 4 secrets are absent: `auth()` on a config
  // with no secret and no providers is a guaranteed miss, and calling it would
  // mean a database round-trip on every render of a signed-out planner.
  if (isAuthConfigured) {
    const session = await auth();
    const sessionUser = session?.user;
    if (sessionUser?.id !== undefined && sessionUser.email != null) {
      return {
        id: sessionUser.id,
        email: sessionUser.email,
        name: sessionUser.name ?? null,
        image: sessionUser.image ?? null,
      };
    }
  }

  if (isProduction || !env.DEV_AUTH_FALLBACK) return null;

  const [devUser] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
    })
    .from(users)
    .where(eq(users.email, DEV_USER_EMAIL))
    .limit(1);

  return devUser ?? null;
}

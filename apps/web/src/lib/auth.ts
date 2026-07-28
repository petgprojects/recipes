/**
 * Auth.js v5 with the Google provider and the Drizzle adapter.
 *
 * PLAN.md §5, Phase 4: "Auth.js with the Google provider; `saved_recipes` and
 * `grocery_checks` move server-side."
 *
 * Three things about this file are deliberate.
 *
 * **Auth is optional at boot.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
 * `AUTH_SECRET` are phase-gated in `@recipes/shared/env`, so a `.env` without
 * them must still start. Calling `requireEnv()` at module scope would turn
 * importing this file into a boot requirement and take the whole planner down
 * with it — and the planner is explicitly meant to keep working signed out.
 * Instead {@link isAuthConfigured} reports whether the three are present, the
 * provider list is empty when they are not, and every caller checks the flag
 * before reaching for a session.
 *
 * **`trustHost` is on.** The app runs under Compose on a mapped port, so
 * Auth.js has to take the request's own `Host` for the callback URL. Without it
 * v5 refuses to infer a host outside Vercel and the callback 500s.
 *
 * **Sessions are database-backed**, which is the adapter default but is stated
 * here because it is load-bearing: `saved_recipes` and `grocery_checks` are
 * keyed on `users.id`, and a JWT-only session would have no row to key on. The
 * whole app is Node runtime (see the `runtime` export on each route), so the
 * Edge incompatibility that usually pushes projects to `jwt` does not apply.
 */

import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db, accounts, sessions, users, verificationTokens } from '@recipes/db';
import { env } from '@recipes/shared/env';

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

/**
 * Whether Google sign-in can work at all. False on a `.env` that has not been
 * given the Phase 4 secrets; the UI hides the sign-in control and the planner
 * falls back to `localStorage`, which is exactly the Phase 3 behaviour.
 */
export const isAuthConfigured =
  env.GOOGLE_CLIENT_ID !== undefined &&
  env.GOOGLE_CLIENT_SECRET !== undefined &&
  env.AUTH_SECRET !== undefined;

/**
 * The adapter's own table-shape type for a Postgres client. Named rather than
 * inlined so the cast below points at something readable — the bare
 * `Parameters<…>` form resolves to a union across all three SQL dialects.
 */
type PostgresAuthSchema = NonNullable<Parameters<typeof DrizzleAdapter<typeof db>>[1]>;

/**
 * `users.email` is `citext` (PLAN.md §4, so `A@b.com` and `a@b.com` cannot
 * become two accounts). Drizzle types a `customType` column as `PgCustomColumn`
 * and the adapter's schema type only admits `PgVarchar | PgText`, so the *type*
 * is rejected even though `citext` is text at runtime and every adapter query
 * against it is a plain equality. The cast is confined to this one expression
 * rather than loosened anywhere in the schema.
 */
const adapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts,
  sessionsTable: sessions,
  verificationTokensTable: verificationTokens,
} as unknown as PostgresAuthSchema);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  trustHost: true,
  secret: env.AUTH_SECRET,
  session: { strategy: 'database' },
  providers: isAuthConfigured
    ? [
        Google({
          // Named for the provider rather than `AUTH_GOOGLE_ID`, because
          // `.env.example` has carried these two names since Phase 0 and
          // renaming them would invalidate every existing local `.env`.
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        }),
      ]
    : [],
  callbacks: {
    /**
     * The adapter hands the whole user row to this callback, but the default
     * session shape drops everything except name/email/image. `id` is the key
     * every per-user table joins on, so it has to survive.
     */
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});

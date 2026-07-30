/**
 * The Auth.js catch-all. Everything under `/api/auth/*` — the Google redirect,
 * the `/api/auth/callback/google` callback, sign-out and the session endpoint —
 * is served from here.
 *
 * The callback path is fixed, but its origin is `AUTH_URL`, and every origin the
 * app is served from needs that full URL registered on the OAuth client as an
 * authorized redirect URI. One client can hold several, so `http://localhost:3000`
 * and the deployed origin coexist (PROGRESS.md amendments A16 and A22).
 *
 * Node runtime, not Edge: the adapter writes sessions through the postgres.js
 * pool in `@recipes/db`, which opens raw TCP sockets.
 */

import { handlers } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = handlers;

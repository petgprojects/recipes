/**
 * The Auth.js catch-all. Everything under `/api/auth/*` — the Google redirect,
 * the `http://localhost:3000/api/auth/callback/google` callback registered on
 * the OAuth client, sign-out and the session endpoint — is served from here.
 *
 * Node runtime, not Edge: the adapter writes sessions through the postgres.js
 * pool in `@recipes/db`, which opens raw TCP sockets.
 */

import { handlers } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = handlers;

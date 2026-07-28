'use server';

/**
 * Sign-in and sign-out as server actions.
 *
 * A `<form action={…}>` rather than a client-side `signIn()` call: the form
 * works before hydration and without JavaScript, and it keeps `lib/auth.ts` —
 * which imports `@recipes/shared/env` and opens the database pool — out of the
 * client bundle. A client component may import these two functions; Next
 * replaces them with a reference to the server, so the module itself never
 * crosses over.
 */

import { signIn, signOut } from './auth';

/**
 * Both of these end in a redirect, which Auth.js raises as an exception for
 * Next to catch. That is the framework's control flow, not an error — do not
 * wrap either in a try/catch that would swallow it.
 */
export async function signInWithGoogle(): Promise<void> {
  await signIn('google', { redirectTo: '/' });
}

export async function signOutOfAccount(): Promise<void> {
  await signOut({ redirectTo: '/' });
}

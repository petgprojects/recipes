'use client';

/**
 * The sign-in / sign-out control in the masthead eyebrow.
 *
 * Renders nothing at all when the Phase 4 secrets are absent, because offering
 * a button that can only fail is worse than offering none — the planner still
 * works, it just keeps its picks in this browser.
 */

import { signInWithGoogle, signOutOfAccount } from '@/lib/auth-actions';
import type { PlannerUser } from '@/lib/saved-store';

interface AuthControlsProps {
  user: PlannerUser | null;
  /** `isAuthConfigured` from the server; the client cannot read the secrets. */
  enabled: boolean;
}

export function AuthControls({ user, enabled }: AuthControlsProps) {
  if (!enabled) return null;

  if (user === null) {
    return (
      <form action={signInWithGoogle}>
        <button className="mp-auth-btn" type="submit">
          Sign in with Google
        </button>
      </form>
    );
  }

  return (
    <span className="mp-auth">
      {/* The account, not a greeting: the point of showing it is so someone on
          a shared machine can see whose picks these are before saving more. */}
      <span className="mp-auth-who" title={user.email}>
        {user.name ?? user.email}
      </span>
      <form action={signOutOfAccount}>
        <button className="mp-auth-btn" type="submit">
          Sign out
        </button>
      </form>
    </span>
  );
}

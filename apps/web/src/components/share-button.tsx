'use client';

/**
 * "Share" — the button that hands over a link to *this* site's page for a
 * recipe, rather than the source's URL sitting a few lines above it in the
 * sheet.
 *
 * Three behaviours, in the order they are preferred:
 *
 *   1. `navigator.share`, when the browser has it. On a phone this is the real
 *      share sheet — Messages, WhatsApp, AirDrop — which is where a recipe link
 *      actually wants to go, and it is the only one of the three that does not
 *      require the reader to then paste it somewhere themselves.
 *   2. `navigator.clipboard`, on a desktop browser. Copy, and say so.
 *   3. The URL, shown and pre-selected, when neither exists.
 *
 * The third is not defensive padding. Both APIs are gated on a secure context,
 * and this app is routinely reached at `http://<lan-ip>:3000` — where
 * `localhost` is a secure origin and an IP address is not. On that origin the
 * first two are simply absent, and a share button that silently did nothing
 * would be indistinguishable from a broken one.
 *
 * The URL is built in the handler rather than at render, from
 * `window.location.origin`: the server does not know which host the reader
 * typed, and rendering `NEXT_PUBLIC_APP_URL` into the markup would hand out a
 * `localhost` link to someone browsing over the LAN.
 */

import { useEffect, useRef, useState } from 'react';
import { recipeSharePath } from '@recipes/shared/share';
import type { RecipeSummary } from '@/lib/recipe-types';

interface ShareButtonProps {
  recipe: Pick<RecipeSummary, 'title' | 'slug' | 'shareCode'>;
}

type State = 'idle' | 'copied' | 'manual';

export function ShareButton({ recipe: { title, slug, shareCode } }: ShareButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [url, setUrl] = useState('');
  const manualRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // "Copied" is a transient acknowledgement, so it expires; the manual URL is
  // a thing the reader is still using, so it does not.
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (state === 'manual') manualRef.current?.select();
  }, [state]);

  function settle(next: State) {
    clearTimeout(timer.current);
    setState(next);
    if (next === 'copied') timer.current = setTimeout(() => setState('idle'), 2400);
  }

  async function onShare() {
    const link = `${window.location.origin}${recipeSharePath(slug, shareCode)}`;
    setUrl(link);

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url: link });
        return;
      } catch (error: unknown) {
        // Dismissing the share sheet rejects with `AbortError`, and that is a
        // decision rather than a failure — falling through to "copied" would
        // announce something the reader just declined to do.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }

    if (navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(link);
        settle('copied');
        return;
      } catch {
        // Permission denied, or a context the API exists in but will not serve.
      }
    }

    settle('manual');
  }

  return (
    <>
      <button
        className="mp-btn"
        onClick={() => {
          void onShare();
        }}
        aria-label={`Share ${title}`}
      >
        {state === 'copied' ? 'Link copied' : 'Share'}
      </button>

      {state === 'manual' && (
        <label className="mp-share-manual">
          <span className="mp-share-manual-label">Copy this link</span>
          <input
            ref={manualRef}
            className="mp-share-url"
            type="text"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </>
  );
}

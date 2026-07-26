'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from './ops.module.css';

type RequestState =
  | { kind: 'idle'; message: null }
  | { kind: 'pending'; message: null }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

export function ScanNowButton() {
  const router = useRouter();
  const [state, setState] = useState<RequestState>({ kind: 'idle', message: null });

  async function enqueue() {
    setState({ kind: 'pending', message: null });
    try {
      const response = await fetch('/api/ops/scan', { method: 'POST' });
      const payload = (await response.json()) as {
        status?: 'queued' | 'coalesced';
        jobId?: string | null;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? 'The scan could not be queued.');
      }

      setState({
        kind: 'success',
        message:
          payload.status === 'coalesced'
            ? 'A scan is already queued or running.'
            : `Scan queued${payload.jobId ? ` · ${payload.jobId.slice(0, 8)}` : ''}.`,
      });
      router.refresh();
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The scan could not be queued.',
      });
    }
  }

  return (
    <div className={styles.scanControl}>
      <button
        className={styles.scanButton}
        type="button"
        onClick={enqueue}
        disabled={state.kind === 'pending'}
      >
        <span>{state.kind === 'pending' ? 'Queueing' : 'Scan now'}</span>
        <span className={styles.buttonMark} aria-hidden="true">
          {state.kind === 'pending' ? '···' : '↗'}
        </span>
      </button>
      <p
        className={state.kind === 'error' ? styles.requestError : styles.requestStatus}
        aria-live="polite"
      >
        {state.message ?? 'Runs asynchronously; repeated requests are coalesced.'}
      </p>
    </div>
  );
}

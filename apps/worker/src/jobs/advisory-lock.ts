import { client } from '@recipes/db/client';

/**
 * Two stable signed-int lock keys ("reci", "scan"). Session-level locking is
 * intentional: the reserved connection holds the lock for the entire scan
 * while recipe writes use the normal Drizzle pool.
 */
export const SCAN_ADVISORY_LOCK_KEYS = [0x72656369, 0x7363616e] as const;

export type AdvisoryLockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

export async function withScanAdvisoryLock<T>(
  task: () => Promise<T>,
  sqlClient: Pick<typeof client, 'reserve'> = client,
): Promise<AdvisoryLockResult<T>> {
  const connection = await sqlClient.reserve();
  let acquired = false;
  try {
    const rows = await connection.unsafe<Array<{ acquired: boolean }>>(
      'select pg_try_advisory_lock($1::integer, $2::integer) as acquired',
      [...SCAN_ADVISORY_LOCK_KEYS],
    );
    acquired = rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await task() };
  } finally {
    try {
      if (acquired) {
        await connection.unsafe(
          'select pg_advisory_unlock($1::integer, $2::integer)',
          [...SCAN_ADVISORY_LOCK_KEYS],
        );
      }
    } finally {
      // Never leak the reserved session, even if Postgres reports an unlock
      // error while the connection is already failing.
      connection.release();
    }
  }
}

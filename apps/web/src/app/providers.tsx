'use client';

/**
 * The TanStack Query client.
 *
 * Created inside `useState` rather than at module scope: a module-level client
 * is shared by every request in a server process, which leaks one user's cache
 * into another's render. Per-component-instance is the documented pattern and
 * costs nothing here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The recipe corpus changes when a scan lands, not while you read.
            staleTime: 60_000,
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

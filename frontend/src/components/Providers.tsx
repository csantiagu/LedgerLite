'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState((): QueryClient => {
    const client: QueryClient = new QueryClient({
      // Every change is recorded in the audit log, so any history on screen is out of date after one.
      mutationCache: new MutationCache({
        // Periods too: their For Review counts and lock state change with posting and locking
        onSuccess: () => Promise.all([
          client.invalidateQueries({ queryKey: ['audit'] }),
          client.invalidateQueries({ queryKey: ['periods'] }),
        ]),
      }),
      defaultOptions: {
        queries: {
          staleTime: 60_000,
          retry: (count, err) => {
            if (err instanceof Error && err.message === 'Unauthenticated') return false;
            return count < 2;
          },
        },
      },
    });
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

"use client";

// Must stay first: configures Zod before any schema is created (see lib/zodConfig.ts).
import "@/lib/zodConfig";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface QueryProviderProps {
  children: React.ReactNode;
}

/**
 * Provides a scoped TanStack QueryClient instance across the dashboard app.
 * Initialized in useState to avoid recreating the client on re-renders
 * while keeping it isolated to the client session.
 */
export function QueryProvider({ children }: QueryProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

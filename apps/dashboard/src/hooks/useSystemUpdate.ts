"use client";

import { useQuery } from "@tanstack/react-query";
import type { SystemUpdateInfo } from "@vexlyx/shared/schemas/systemUpdate";
import { fetchAPI } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

/**
 * Update availability for the running panel version (F5.33).
 * ADMIN-only — the API answers 403 for everyone else, so the query is only
 * issued for admins. The server caches the GitHub lookup for hours, which
 * makes a long client staleTime safe.
 */
export function useSystemUpdate() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const query = useQuery({
    queryKey: ["system", "update"],
    queryFn: () => fetchAPI<SystemUpdateInfo>("/api/system/update"),
    enabled: isAdmin,
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });

  return { update: query.data, isAdmin };
}

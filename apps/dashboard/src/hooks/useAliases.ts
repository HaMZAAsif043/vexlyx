"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import type { AliasResponse, CreateAliasInput } from "@vexlyx/shared";

export function useAliases() {
  const [aliases, setAliases] = useState<AliasResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh: runRefresh } = useRefreshAnimation();
  const [error, setError] = useState<string | null>(null);

  const fetchAliases = useCallback(async () => {
    try {
      const data = await fetchAPI<{ aliases: AliasResponse[] }>("/api/aliases");
      setAliases(data.aliases ?? []);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Failed to load aliases";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await runRefresh(() => fetchAliases());
  }, [fetchAliases, runRefresh]);

  useEffect(() => {
    void fetchAliases();
  }, [fetchAliases]);

  const createAlias = async (input: CreateAliasInput): Promise<AliasResponse> => {
    try {
      const result = await fetchAPI<{ alias: AliasResponse }>("/api/aliases", {
        method: "POST", body: JSON.stringify(input),
      });
      return result.alias;
    } finally {
      await fetchAliases();
    }
  };

  const updateAliasDestinations = async (id: string, destinations: string[]): Promise<void> => {
    try {
      await fetchAPI(`/api/aliases/${id}/destinations`, {
        method: "PATCH", body: JSON.stringify({ destinations }),
      });
    } finally {
      await fetchAliases();
    }
  };

  const deleteAlias = async (id: string): Promise<void> => {
    try {
      await fetchAPI(`/api/aliases/${id}`, { method: "DELETE" });
    } finally {
      await fetchAliases();
    }
  };

  return {
    aliases,
    isLoading,
    isRefreshing,
    error,
    refresh,
    createAlias,
    updateAliasDestinations,
    deleteAlias,
  };
}

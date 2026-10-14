"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import type { MailboxResponse, CreateMailboxInput, QuotaPreset } from "@vexlyx/shared";

function showWarnings(warnings: string[] | undefined): void {
  for (const warning of warnings ?? []) {
    toast.warning(warning, { duration: 10_000 });
  }
}

export function useMailboxes() {
  const [mailboxes, setMailboxes] = useState<MailboxResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh: runRefresh } = useRefreshAnimation();
  const [error, setError] = useState<string | null>(null);

  const fetchMailboxes = useCallback(async () => {
    try {
      const data = await fetchAPI<{ mailboxes: MailboxResponse[] }>("/api/mailboxes");
      setMailboxes(data.mailboxes ?? []);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Failed to load mailboxes";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await runRefresh(() => fetchMailboxes());
  }, [fetchMailboxes, runRefresh]);

  useEffect(() => {
    void fetchMailboxes();
  }, [fetchMailboxes]);

  const createMailbox = async (
    input: CreateMailboxInput,
  ): Promise<{ mailbox: MailboxResponse; password: string }> => {
    const result = await fetchAPI<{
      mailbox: MailboxResponse;
      password: string;
      warnings?: string[];
    }>("/api/mailboxes", { method: "POST", body: JSON.stringify(input) });
    showWarnings(result.warnings);
    await fetchMailboxes();
    return result;
  };

  const deleteMailbox = async (id: string): Promise<void> => {
    const result = await fetchAPI<{ warnings?: string[] } | undefined>(`/api/mailboxes/${id}`, {
      method: "DELETE",
    });
    showWarnings(result?.warnings);
    await fetchMailboxes();
  };

  const updateQuota = async (id: string, quota: QuotaPreset): Promise<void> => {
    const result = await fetchAPI<{ warnings?: string[] }>(`/api/mailboxes/${id}/quota`, {
      method: "PATCH",
      body: JSON.stringify({ quota }),
    });
    showWarnings(result.warnings);
    await fetchMailboxes();
  };

  const resetPassword = async (id: string): Promise<{ password: string }> => {
    const result = await fetchAPI<{ password: string; warnings?: string[] }>(
      `/api/mailboxes/${id}/reset-password`,
      { method: "POST" },
    );
    showWarnings(result.warnings);
    return { password: result.password };
  };

  return {
    mailboxes,
    isLoading,
    isRefreshing,
    error,
    refresh,
    createMailbox,
    deleteMailbox,
    updateQuota,
    resetPassword,
  };
}

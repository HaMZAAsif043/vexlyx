"use client";

import { useState, useCallback, useEffect } from "react";
import { fetchAPI } from "@/lib/api";

export interface ContainerStatusResponse {
  containerStatus: string;
  containerHealth: string | null;
  containerId: string | null;
}

export interface ContainerLogsResponse {
  logs: string;
}

export function useContainerAction(projectId: string) {
  const [isExecuting, setIsExecuting] = useState(false);

  const executeAction = useCallback(
    async (
      action: "start" | "stop" | "restart" | "remove",
    ): Promise<{ message: string; containerStatus: string }> => {
      setIsExecuting(true);
      try {
        const res = await fetchAPI<{ message: string; containerStatus: string }>(
          `/api/projects/${projectId}/container/${action}`,
          { method: "POST" },
        );
        return res;
      } finally {
        setIsExecuting(false);
      }
    },
    [projectId],
  );

  return { executeAction, isExecuting };
}

export function useContainerStatus(projectId: string, enabled = true, intervalMs = 5000) {
  const [status, setStatus] = useState<ContainerStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await fetchAPI<ContainerStatusResponse>(
        `/api/projects/${projectId}/container/status`,
      );
      setStatus(data);
    } catch {
      // Keep previous status on network blip
    } finally {
      setIsLoading(false);
    }
  }, [projectId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    setIsLoading(true);
    void fetchStatus();

    const interval = setInterval(() => {
      void fetchStatus();
    }, intervalMs);

    return () => clearInterval(interval);
  }, [enabled, fetchStatus, intervalMs]);

  return { status, isLoading, refetch: fetchStatus };
}

export function useContainerLogs(projectId: string, enabled = false, tail = 100) {
  const [logs, setLogs] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const data = await fetchAPI<ContainerLogsResponse>(
        `/api/projects/${projectId}/logs?tail=${tail}`,
      );
      setLogs(data.logs);
      setError(null);
    } catch {
      setError("Failed to fetch container logs");
    } finally {
      setIsLoading(false);
    }
  }, [projectId, enabled, tail]);

  useEffect(() => {
    if (!enabled) return;
    void fetchLogs();
  }, [enabled, fetchLogs]);

  return { logs, isLoading, error, refetch: fetchLogs };
}

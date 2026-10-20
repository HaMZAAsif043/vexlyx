import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAPI } from "@/lib/api";
import type {
  ScheduledTaskResponse,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  ScheduledTaskRunResponse,
} from "@vexlyx/shared/schemas/scheduledTasks";

export function useScheduledTasks(projectId: string) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["scheduledTasks", projectId],
    queryFn: async () => {
      const res = await fetchAPI<{ tasks: ScheduledTaskResponse[] }>(
        `/api/projects/${projectId}/scheduled-tasks`,
      );
      return res.tasks;
    },
    enabled: !!projectId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["scheduledTasks", projectId] });
    queryClient.invalidateQueries({ queryKey: ["scheduledTaskRuns", projectId] });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateScheduledTaskInput) =>
      fetchAPI<ScheduledTaskResponse>(`/api/projects/${projectId}/scheduled-tasks`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: UpdateScheduledTaskInput }) =>
      fetchAPI<ScheduledTaskResponse>(`/api/projects/${projectId}/scheduled-tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) =>
      fetchAPI<void>(`/api/projects/${projectId}/scheduled-tasks/${taskId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const runNowMutation = useMutation({
    mutationFn: (taskId: string) =>
      fetchAPI<{ message: string; run: ScheduledTaskRunResponse }>(
        `/api/projects/${projectId}/scheduled-tasks/${taskId}/run`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: invalidate,
  });

  return {
    tasks: data ?? [],
    // Distinguishes "nothing loaded yet" from a cached (possibly empty) list,
    // so a failed background refresh never replaces cached data with an error
    // state that would unmount open dialogs and discard in-progress edits.
    hasData: data !== undefined,
    isLoading,
    error,
    refetch,
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    deleteTask: deleteMutation.mutateAsync,
    runNow: runNowMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isRunningNow: runNowMutation.isPending,
  };
}

/** Run history for one task — always called unconditionally (rules of hooks), gated by `enabled`. */
export function useScheduledTaskRuns(
  projectId: string,
  taskId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["scheduledTaskRuns", projectId, taskId],
    queryFn: async () => {
      const res = await fetchAPI<{ runs: ScheduledTaskRunResponse[] }>(
        `/api/projects/${projectId}/scheduled-tasks/${taskId}/runs?limit=50`,
      );
      return res.runs;
    },
    enabled: !!projectId && !!taskId && (options.enabled ?? true),
  });
}

"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Edit,
  Loader2,
  Play,
  RefreshCw,
  SkipBack,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import cronstrue from "cronstrue";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ApiRequestError } from "@/lib/api";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { useScheduledTasks, useScheduledTaskRuns } from "@/hooks/useScheduledTasks";
import type { ScheduledTaskResponse, ScheduledTaskRunResponse } from "@vexlyx/shared/schemas/scheduledTasks";

// ---------------------------------------------------------------------------
// Cron presets
// ---------------------------------------------------------------------------

const CRON_PRESETS: { label: string; value: string; description: string }[] = [
  { label: "Every minute", value: "* * * * *", description: "Runs every minute (e.g. Laravel scheduler)" },
  { label: "Every 5 minutes", value: "*/5 * * * *", description: "Runs every 5 minutes (e.g. WP-Cron)" },
  { label: "Hourly", value: "0 * * * *", description: "Runs at minute 0 of every hour" },
  { label: "Daily at midnight", value: "0 0 * * *", description: "Runs daily at 00:00" },
  { label: "Weekly (Sunday)", value: "0 0 * * 0", description: "Runs weekly on Sunday at 00:00" },
  { label: "Custom", value: "custom", description: "Enter your own 5-field cron expression" },
];

const CUSTOM_PRESET = "custom";

function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof ApiRequestError) return err.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    SUCCESS: "default",
    FAILED: "destructive",
    RUNNING: "secondary",
    TIMEOUT: "destructive",
    SKIPPED: "outline",
  };

  const icons: Record<string, React.ReactNode> = {
    SUCCESS: <CheckCircle className="h-3 w-3" />,
    FAILED: <XCircle className="h-3 w-3" />,
    RUNNING: <Loader2 className="h-3 w-3 animate-spin" />,
    TIMEOUT: <AlertCircle className="h-3 w-3" />,
    SKIPPED: <SkipBack className="h-3 w-3" />,
  };

  return (
    <Badge variant={variants[status] ?? "secondary"} className="gap-1">
      {icons[status] ?? null}
      {status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Human-readable cron description (cronstrue)
// ---------------------------------------------------------------------------

function CronDescription({ schedule, timezone }: { schedule: string; timezone?: string }) {
  let description = "";
  try {
    description = cronstrue.toString(schedule, {
      use24HourTimeFormat: true,
      locale: "en",
      ...(timezone && { timezone }),
    });
  } catch {
    description = "Invalid cron expression";
  }

  return (
    <div className="space-y-0.5">
      <div className="font-mono text-xs">{schedule}</div>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create/edit dialog — one controlled dialog, no nesting
// ---------------------------------------------------------------------------

interface TaskFormDialogProps {
  projectId: string;
  open: boolean;
  task: ScheduledTaskResponse | null;
  onClose: () => void;
  timezone?: string;
}

function TaskFormDialog({ projectId, open, task, onClose, timezone }: TaskFormDialogProps) {
  const { create, update, isCreating, isUpdating } = useScheduledTasks(projectId);
  const isEditing = task !== null;

  const [name, setName] = useState(task?.name ?? "");
  const [command, setCommand] = useState(task?.command ?? "");
  const [schedule, setSchedule] = useState(task?.schedule ?? "* * * * *");
  const [timeoutSeconds, setTimeoutSeconds] = useState(task?.timeoutSeconds ?? 300);
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(task?.notifyOnFailure ?? true);
  const [presetValue, setPresetValue] = useState(
    CRON_PRESETS.some((p) => p.value === (task?.schedule ?? "* * * * *"))
      ? (task?.schedule ?? "* * * * *")
      : CUSTOM_PRESET,
  );

  const isCustom = presetValue === CUSTOM_PRESET;
  const isSaving = isCreating || isUpdating;

  const handlePresetChange = (value: string) => {
    setPresetValue(value);
    if (value !== CUSTOM_PRESET) setSchedule(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isEditing) {
        await update({ taskId: task.id, input: { name, command, schedule, timeoutSeconds, enabled, notifyOnFailure } });
        toast.success("Task updated");
      } else {
        await create({ name, command, schedule, timeoutSeconds, enabled, notifyOnFailure });
        toast.success("Task created");
      }
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Scheduled Task" : "Create Scheduled Task"}</DialogTitle>
            <DialogDescription>
              The command runs inside this project&apos;s container on the configured schedule.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="task-name">Name</Label>
              <Input
                id="task-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Laravel scheduler"
                required
                maxLength={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="task-command">Command</Label>
              <Textarea
                id="task-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. php artisan schedule:run"
                required
                maxLength={2000}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">{command.length}/2000 characters</p>
            </div>

            <div className="space-y-2">
              <Label>Schedule</Label>
              <Select value={presetValue} onValueChange={handlePresetChange}>
                <SelectTrigger aria-label="Schedule preset">
                  <SelectValue placeholder="Select a preset or choose Custom" />
                </SelectTrigger>
                <SelectContent>
                  {CRON_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      <div className="flex flex-col">
                        <span>{preset.label}</span>
                        <span className="text-xs text-muted-foreground">{preset.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {isCustom && (
                <>
                  <Input
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder="* * * * *"
                    required
                    aria-label="Cron expression"
                  />
                  <p className="text-xs text-muted-foreground">
                    5-field cron (minute hour day month weekday). No seconds field.
                  </p>
                </>
              )}
              <CronDescription schedule={schedule} timezone={timezone} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="task-timeout">Timeout (seconds)</Label>
                <Input
                  id="task-timeout"
                  type="number"
                  min={1}
                  max={3600}
                  value={timeoutSeconds}
                  onChange={(e) => setTimeoutSeconds(Math.min(3600, Math.max(1, parseInt(e.target.value) || 1)))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="task-notify">Notify on failure</Label>
                <Switch id="task-notify" checked={notifyOnFailure} onCheckedChange={setNotifyOnFailure} />
                <p className="text-xs text-muted-foreground">
                  Email after 3 consecutive failures (once per streak)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch id="task-enabled" checked={enabled} onCheckedChange={setEnabled} />
              <Label htmlFor="task-enabled" className="mb-0">
                Enabled
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : isEditing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog (destructive actions always confirm)
// ---------------------------------------------------------------------------

function DeleteTaskDialog({
  projectId,
  task,
  onClose,
}: {
  projectId: string;
  task: ScheduledTaskResponse | null;
  onClose: () => void;
}) {
  const { deleteTask, isDeleting } = useScheduledTasks(projectId);

  const handleDelete = async () => {
    if (!task) return;
    try {
      await deleteTask(task.id);
      toast.success("Task deleted");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete scheduled task?</DialogTitle>
          <DialogDescription>
            &quot;{task?.name}&quot; and its run history will be permanently deleted. Its schedule stops
            immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Run history dialog — output in the always-dark terminal style
// ---------------------------------------------------------------------------

function RunHistoryDialog({
  projectId,
  task,
  onClose,
}: {
  projectId: string;
  task: ScheduledTaskResponse | null;
  onClose: () => void;
}) {
  const { data: runs, isLoading, error, refetch } = useScheduledTaskRuns(projectId, task?.id ?? null, {
    enabled: task !== null,
  });
  const { isRefreshing, refresh } = useRefreshAnimation();

  // A failed load must never look like an empty history (CLAUDE.md: surface
  // errors through a toast *and* inline).
  useEffect(() => {
    if (error) toast.error(errorMessage(error, "Failed to load run history"));
  }, [error]);

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Run history — {task?.name}</DialogTitle>
          <DialogDescription>Latest 50 runs, newest first.</DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refresh(() => refetch())}
            disabled={isLoading}
            className={refreshIconClassName(isRefreshing)}
            aria-label="Refresh run history"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="space-y-3 py-8 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-destructive/70" />
            <p className="text-sm text-destructive">{errorMessage(error, "Failed to load run history")}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : !runs || runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No runs yet</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Exit</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Output</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run: ScheduledTaskRunResponse) => {
                  const duration =
                    run.finishedAt && run.startedAt
                      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
                      : null;
                  return (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Badge variant={run.trigger === "MANUAL" ? "default" : "secondary"}>
                          {run.trigger}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                      </TableCell>
                      <TableCell className="font-mono text-sm">{run.exitCode ?? "—"}</TableCell>
                      <TableCell className="font-mono text-sm">
                        {duration !== null ? `${(duration / 1000).toFixed(1)}s` : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(run.startedAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {run.output ? (
                          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 font-mono text-xs leading-relaxed text-slate-100">
                            {run.output}
                          </pre>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ScheduledTasksPanel({ projectId, timezone }: { projectId: string; timezone?: string }) {
  const {
    tasks,
    hasData,
    isLoading,
    error,
    refetch,
    update,
    runNow,
    isRunningNow,
    isUpdating,
  } = useScheduledTasks(projectId);
  const { isRefreshing, refresh } = useRefreshAnimation();

  // Surface a failed list load (toast + the inline state below), never a
  // silent "No scheduled tasks yet".
  useEffect(() => {
    if (error) toast.error(errorMessage(error, "Failed to load scheduled tasks"));
  }, [error]);

  const [formOpen, setFormOpen] = useState(false);
  const [formTask, setFormTask] = useState<ScheduledTaskResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskResponse | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTaskResponse | null>(null);

  const openCreate = () => {
    setFormTask(null);
    setFormOpen(true);
  };

  const openEdit = (task: ScheduledTaskResponse) => {
    setFormTask(task);
    setFormOpen(true);
  };

  const handleRunNow = async (task: ScheduledTaskResponse) => {
    try {
      await runNow(task.id);
      toast.success(`Run finished for "${task.name}"`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleToggle = async (task: ScheduledTaskResponse, checked: boolean) => {
    try {
      await update({ taskId: task.id, input: { enabled: checked } });
      toast.success(checked ? `Enabled "${task.name}"` : `Paused "${task.name}"`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Scheduled Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Blocking states only when nothing is cached: a background refresh failure
  // must keep the (cached) list — and any open dialog — mounted instead of
  // discarding the user's in-progress edits.
  if (error && !hasData) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Scheduled Tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 py-12 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-destructive/70" />
          <p className="mt-3 text-sm font-medium text-destructive">
            {errorMessage(error, "Failed to load scheduled tasks")}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => void refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Scheduled Tasks</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refresh(() => refetch())}
            disabled={isLoading}
            className={refreshIconClassName(isRefreshing)}
            aria-label="Refresh tasks"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={openCreate}>Create Task</Button>
        </div>
      </CardHeader>

      {/* Stale data with a failed refresh: keep the list visible and show the
          error inline (repo guide: toast + inline error), never a blank panel. */}
      {error && (
        <CardContent className="pb-0">
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">
              {errorMessage(error, "Failed to load scheduled tasks")}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        </CardContent>
      )}

      {tasks.length === 0 ? (
        <CardContent className="py-12 text-center">
          <Terminal className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No scheduled tasks yet</h3>
          <p className="mt-1 text-muted-foreground">
            Run commands on a schedule inside your project&apos;s container — schedulers, cron jobs and
            cleanup scripts.
          </p>
          <Button className="mt-4" onClick={openCreate}>
            Create your first task
          </Button>
        </CardContent>
      ) : (
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead className="w-48">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-medium">{task.name}</TableCell>
                    <TableCell>
                      <CronDescription schedule={task.schedule} timezone={timezone} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {task.consecutiveFailures > 0 ? (
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            {task.consecutiveFailures} failed
                          </Badge>
                        ) : (
                          <Badge variant={task.enabled ? "default" : "secondary"}>
                            {task.enabled ? "Active" : "Paused"}
                          </Badge>
                        )}
                        <Switch
                          checked={task.enabled}
                          onCheckedChange={(checked) => void handleToggle(task, checked)}
                          disabled={isUpdating}
                          aria-label={task.enabled ? `Pause ${task.name}` : `Enable ${task.name}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {task.enabled && task.nextRunAt
                        ? new Date(task.nextRunAt).toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void handleRunNow(task)}
                          disabled={isRunningNow}
                          title="Run now"
                          aria-label={`Run ${task.name} now`}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setHistoryTask(task)}
                          title="Run history"
                          aria-label={`View run history for ${task.name}`}
                        >
                          <Clock className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(task)}
                          title="Edit task"
                          aria-label={`Edit ${task.name}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteTarget(task)}
                          title="Delete task"
                          aria-label={`Delete ${task.name}`}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}

      {/* Remounted on every open (key) so the form state always reflects the
          selected task instead of whatever was last edited. */}
      {formOpen && (
        <TaskFormDialog
          key={formTask?.id ?? "create-task"}
          projectId={projectId}
          open={formOpen}
          task={formTask}
          onClose={() => setFormOpen(false)}
          timezone={timezone}
        />
      )}
      <DeleteTaskDialog projectId={projectId} task={deleteTarget} onClose={() => setDeleteTarget(null)} />
      <RunHistoryDialog projectId={projectId} task={historyTask} onClose={() => setHistoryTask(null)} />
    </Card>
  );
}

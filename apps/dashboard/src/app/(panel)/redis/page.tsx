"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Layers,
  Plus,
  Search,
  RefreshCw,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  Play,
  Square,
  RotateCw,
  SlidersHorizontal,
  Loader2,
  FolderGit2,
  Gauge,
  KeyRound,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useUsage } from "@/hooks/useUsage";
import { QuotaBadge, isQuotaAtLimit } from "@/components/quota/QuotaBadge";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import {
  useRefreshAnimation,
  refreshIconClassName,
} from "@/hooks/useRefreshAnimation";
import type {
  RedisInstanceDetail,
  RedisInstanceSummary,
  RedisInstanceListResponse,
  RedisInstanceStats,
  RedisInstanceStatus,
  RedisEvictionPolicy,
  RedisPersistence,
  RedisImage,
  Project,
} from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Helpers & constants
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<
  RedisInstanceStatus,
  { label: string; className: string }
> = {
  RUNNING: {
    label: "Running",
    className:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  STOPPED: {
    label: "Stopped",
    className: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 border-zinc-500/20",
  },
  CREATING: {
    label: "Creating",
    className:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  ERROR: {
    label: "Error",
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
};

const IMAGE_LABEL: Record<string, string> = {
  "valkey/valkey:8.0": "Valkey 8.0",
  "redis:7.2-alpine": "Redis 7.2",
};

const PRESETS: {
  key: "cache" | "queue" | "persistent";
  label: string;
  hint: string;
  evictionPolicy: RedisEvictionPolicy;
  persistence: RedisPersistence;
}[] = [
  {
    key: "cache",
    label: "Cache",
    hint: "LRU eviction, no persistence",
    evictionPolicy: "allkeys-lru",
    persistence: "NONE",
  },
  {
    key: "queue",
    label: "Queue",
    hint: "BullMQ / Celery, AOF durability",
    evictionPolicy: "noeviction",
    persistence: "AOF",
  },
  {
    key: "persistent",
    label: "Persistent",
    hint: "Session store, RDB snapshots",
    evictionPolicy: "noeviction",
    persistence: "RDB",
  },
];

const EVICTION_OPTIONS: RedisEvictionPolicy[] = [
  "noeviction",
  "allkeys-lru",
  "volatile-lru",
  "allkeys-lfu",
  "volatile-lfu",
  "allkeys-random",
  "volatile-random",
  "volatile-ttl",
];

const PERSISTENCE_OPTIONS: RedisPersistence[] = ["NONE", "RDB", "AOF"];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function RedisListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="border border-border">
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-6 w-3/4" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <div className="flex justify-between pt-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function RedisInstancesPage() {
  const [instances, setInstances] = useState<RedisInstanceSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh } = useRefreshAnimation();
  const timezone = useTimezone();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | RedisInstanceStatus>(
    "ALL",
  );

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createImage, setCreateImage] = useState<RedisImage>("valkey/valkey:8.0");
  const [createPreset, setCreatePreset] = useState<"cache" | "queue" | "persistent">(
    "cache",
  );
  const [createEviction, setCreateEviction] =
    useState<RedisEvictionPolicy>("allkeys-lru");
  const [createPersistence, setCreatePersistence] =
    useState<RedisPersistence>("NONE");
  const [createMemory, setCreateMemory] = useState("64");
  const [createProjectId, setCreateProjectId] = useState("none");
  const [createAutoInject, setCreateAutoInject] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Detail dialog (connection URL + live stats)
  const [detail, setDetail] = useState<RedisInstanceDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [stats, setStats] = useState<RedisInstanceStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Configure dialog state
  const [configInstance, setConfigInstance] =
    useState<RedisInstanceSummary | null>(null);
  const [configMemory, setConfigMemory] = useState("64");
  const [configEviction, setConfigEviction] =
    useState<RedisEvictionPolicy>("noeviction");
  const [configPersistence, setConfigPersistence] =
    useState<RedisPersistence>("RDB");
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Row-level busy indicator (start/stop/restart/rotate) and delete state
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RedisInstanceSummary | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const { usage, isLoading: isUsageLoading } = useUsage();

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true);
    try {
      const [instRes, projRes] = await Promise.all([
        fetchAPI<RedisInstanceListResponse>("/api/redis"),
        fetchAPI<{ projects: Project[] }>("/api/projects?limit=100").catch(() => ({
          projects: [],
        })),
      ]);
      setInstances(instRes.instances ?? []);
      setProjects(projRes.projects ?? []);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError ? err.message : "Failed to load Redis instances",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleRefresh = () =>
    refresh(async () => {
      await fetchData(true);
      toast.success("Redis instances refreshed");
    });

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Keep the open detail card's stats fresh after a refresh.
  useEffect(() => {
    if (!detail) return;
    const fresh = instances.find((i) => i.id === detail.id);
    if (fresh && (fresh.status !== detail.status || fresh.updatedAt !== detail.updatedAt)) {
      setDetail((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
    }
  }, [instances, detail]);

  // ---------------------------------------------------------------------------
  // Copy helper
  // ---------------------------------------------------------------------------

  const handleCopy = (text: string, field: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedField(null), 2000);
  };

  // ---------------------------------------------------------------------------
  // Load full detail (for the connection URL)
  // ---------------------------------------------------------------------------

  const openDetail = async (id: string) => {
    setShowPassword(false);
    setStats(null);
    setStatsError(null);
    setDetailOpen(true);
    try {
      const full = await fetchAPI<RedisInstanceDetail>(`/api/redis/${id}`);
      setDetail(full);
      if (full.status === "RUNNING") void loadStats(full);
      else setStatsError("Instance is not running");
    } catch (err) {
      setDetail(null);
      setDetailOpen(false);
      toast.error(
        err instanceof ApiRequestError ? err.message : "Failed to load instance",
      );
    }
  };

  const loadStats = async (instance: RedisInstanceDetail) => {
    setIsLoadingStats(true);
    setStatsError(null);
    try {
      const res = await fetchAPI<RedisInstanceStats>(`/api/redis/${instance.id}/stats`);
      setStats(res);
    } catch (err) {
      setStats(
        null,
      );
      setStatsError(
        err instanceof ApiRequestError ? err.message : "Failed to read stats",
      );
    } finally {
      setIsLoadingStats(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Create instance
  // ---------------------------------------------------------------------------

  const applyPreset = (presetKey: "cache" | "queue" | "persistent") => {
    const preset = PRESETS.find((p) => p.key === presetKey)!;
    setCreatePreset(presetKey);
    setCreateEviction(preset.evictionPolicy);
    setCreatePersistence(preset.persistence);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) {
      toast.error("Instance name is required");
      return;
    }

    setIsCreating(true);
    try {
      const created = await fetchAPI<RedisInstanceDetail>("/api/redis", {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          image: createImage,
          evictionPolicy: createEviction,
          persistence: createPersistence,
          memoryLimitMb: Number(createMemory),
          projectId: createProjectId === "none" ? undefined : createProjectId,
          autoInjectEnv: createProjectId !== "none" ? createAutoInject : false,
        }),
      });

      toast.success(`Redis instance "${created.name}" is up and running`);
      setCreateOpen(false);
      setCreateName("");
      setCreateProjectId("none");
      void fetchData(true);
      void openDetail(created.id);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to provision Redis instance",
      );
    } finally {
      setIsCreating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Lifecycle actions
  // ---------------------------------------------------------------------------

  const handlePower = async (
    instance: RedisInstanceSummary,
    action: "start" | "stop" | "restart",
  ) => {
    setBusyId(instance.id);
    try {
      await fetchAPI(`/api/redis/${instance.id}/${action}`, { method: "POST" });
      toast.success(
        action === "stop"
          ? `Instance "${instance.name}" stopped`
          : action === "start"
            ? `Instance "${instance.name}" started`
            : `Instance "${instance.name}" restarted`,
      );
      await fetchData(true);
      if (detail?.id === instance.id) void openDetail(instance.id);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : `Failed to ${action} instance`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRotatePassword = async (instance: RedisInstanceDetail) => {
    setBusyId(instance.id);
    try {
      const updated = await fetchAPI<RedisInstanceDetail>(
        `/api/redis/${instance.id}/rotate-password`,
        { method: "POST" },
      );
      toast.success("Password rotated — update your app's REDIS_URL");
      setDetail(updated);
      setShowPassword(true);
      await fetchData(true);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to rotate password",
      );
    } finally {
      setBusyId(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Configure (limits / eviction / persistence)
  // ---------------------------------------------------------------------------

  const openConfigure = (instance: RedisInstanceSummary) => {
    setConfigInstance(instance);
    setConfigMemory(String(instance.memoryLimitMb));
    setConfigEviction(instance.evictionPolicy as RedisEvictionPolicy);
    setConfigPersistence(instance.persistence);
  };

  const handleSaveConfig = async () => {
    if (!configInstance) return;
    setIsSavingConfig(true);
    try {
      await fetchAPI(`/api/redis/${configInstance.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          memoryLimitMb: Number(configMemory),
          evictionPolicy: configEviction,
          persistence: configPersistence,
        }),
      });
      toast.success(`Configuration saved for "${configInstance.name}"`);
      setConfigInstance(null);
      await fetchData(true);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError ? err.message : "Failed to save configuration",
      );
    } finally {
      setIsSavingConfig(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await fetchAPI(`/api/redis/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`Instance "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      void fetchData(true);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError ? err.message : "Failed to delete instance",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Filtered list
  // ---------------------------------------------------------------------------

  const filtered = instances.filter((inst) => {
    const q = search.toLowerCase();
    const matchesSearch =
      inst.name.toLowerCase().includes(q) ||
      (inst.projectName?.toLowerCase().includes(q) ?? false);
    const matchesStatus = statusFilter === "ALL" || inst.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Redis Instances
          </h1>
          <p className="text-sm text-muted-foreground">
            Dedicated, password-protected Redis containers for caches, queues
            and session stores.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <QuotaBadge
            label="Redis"
            usage={usage?.redisInstance}
            isLoading={isUsageLoading}
          />
          <Button
            id="create-redis-btn"
            onClick={() => setCreateOpen(true)}
            size="sm"
            className="flex items-center gap-2"
            disabled={isQuotaAtLimit(usage?.redisInstance)}
            title={
              isQuotaAtLimit(usage?.redisInstance)
                ? "You've reached your Redis instance limit"
                : undefined
            }
          >
            <Plus className="h-4 w-4" />
            New Instance
          </Button>
        </div>
      </div>

      <Separator />

      {/* Filter and search bar */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search instances or projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card border-border"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Status filter toggle */}
          <div className="flex items-center rounded-lg border border-border bg-card p-1">
            {(["ALL", "RUNNING", "STOPPED"] as const).map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === status
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {status === "ALL"
                  ? "All"
                  : status === "RUNNING"
                    ? "Running"
                    : "Stopped"}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || isLoading}
            aria-label="Refresh Redis instance list"
            className="border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-4 w-4")} />
          </Button>
        </div>
      </div>

      {/* Main Instance Grid */}
      {isLoading ? (
        <RedisListSkeleton />
      ) : filtered.length === 0 ? (
        <Card className="border border-dashed border-border bg-card/50">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-4">
              <Layers className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {search || statusFilter !== "ALL"
                ? "No matching Redis instances found"
                : "No Redis instances yet"}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {search || statusFilter !== "ALL"
                ? "Try adjusting your search criteria or clearing your active filters."
                : "Give your app a cache, job queue or session store without bundling Redis into your project."}
            </p>
            {!search && statusFilter === "ALL" && (
              <Button
                onClick={() => setCreateOpen(true)}
                className="mt-6"
                size="sm"
                disabled={isQuotaAtLimit(usage?.redisInstance)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Your First Instance
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((inst) => {
            const status = STATUS_BADGE[inst.status];
            const isBusy = busyId === inst.id;

            return (
              <Card
                key={inst.id}
                className="flex flex-col justify-between border border-border bg-card transition-colors hover:border-border/80"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wider",
                        status.className,
                      )}
                    >
                      {inst.status === "CREATING" && (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      )}
                      {status.label}
                    </Badge>
                    <span className="text-xs font-medium text-muted-foreground">
                      {IMAGE_LABEL[inst.image] ?? inst.image}
                    </span>
                  </div>

                  <CardTitle className="pt-2 text-base font-semibold text-foreground flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate">{inst.name}</span>
                  </CardTitle>

                  <CardDescription className="text-xs text-muted-foreground flex items-center gap-2">
                    <Gauge className="h-3 w-3 shrink-0" />
                    <span>
                      {inst.memoryLimitMb} MB max • {inst.evictionPolicy}
                    </span>
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4 pt-0">
                  <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Project:</span>
                      {inst.projectId && inst.projectName ? (
                        <Link
                          href={`/projects/${inst.projectId}`}
                          className="flex items-center gap-1 text-primary hover:underline font-medium truncate max-w-[170px]"
                        >
                          <FolderGit2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{inst.projectName}</span>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Standalone
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Persistence:</span>
                      <span className="font-mono text-foreground font-medium">
                        {inst.persistence}
                      </span>
                    </div>

                    <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground border-t border-border/40">
                      <span>Created</span>
                      <span>{formatDateTime(inst.createdAt, timezone)}</span>
                    </div>
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs border-border hover:bg-muted"
                      onClick={() => void openDetail(inst.id)}
                    >
                      <KeyRound className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                      Details &amp; URI
                    </Button>

                    {inst.status === "STOPPED" ? (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0 border-border hover:bg-muted"
                        title="Start Instance"
                        disabled={isBusy}
                        onClick={() => void handlePower(inst, "start")}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                        ) : (
                          <Play className="h-3.5 w-3.5 text-emerald-500" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0 border-border hover:bg-muted"
                        title="Stop Instance"
                        disabled={isBusy || inst.status !== "RUNNING"}
                        onClick={() => void handlePower(inst, "stop")}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                        ) : (
                          <Square className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0 border-border hover:bg-muted"
                      title="Configure Limits"
                      onClick={() => openConfigure(inst)}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                    </Button>

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                      title="Delete Instance"
                      onClick={() => setDeleteTarget(inst)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Create Instance Dialog ────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-foreground">
                <Layers className="h-5 w-5 text-primary" />
                New Redis Instance
              </DialogTitle>
              <DialogDescription>
                Starts a dedicated, password-protected container on the
                internal network — reachable only from your project containers.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Image selection */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Image (pinned)
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setCreateImage("valkey/valkey:8.0")}
                    aria-pressed={createImage === "valkey/valkey:8.0"}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3.5 transition-all text-center select-none",
                      createImage === "valkey/valkey:8.0"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      Valkey 8.0
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      BSD licensed • Redis-compatible
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCreateImage("redis:7.2-alpine")}
                    aria-pressed={createImage === "redis:7.2-alpine"}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3.5 transition-all text-center select-none",
                      createImage === "redis:7.2-alpine"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      Redis 7.2
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Last BSD-licensed release
                    </div>
                  </button>
                </div>
              </div>

              {/* Instance name */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-redis-name"
                  className="text-xs font-medium text-foreground"
                >
                  Instance Name
                </Label>
                <Input
                  id="create-redis-name"
                  placeholder="e.g. app_cache"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="font-mono text-sm bg-card border-border"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  2-63 characters: letters, numbers, dots, underscores or
                  hyphens.
                </p>
              </div>

              {/* Preset */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Preset
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.key}
                      onClick={() => applyPreset(preset.key)}
                      aria-pressed={createPreset === preset.key}
                      className={cn(
                        "cursor-pointer rounded-lg border p-2.5 transition-all text-center select-none",
                        createPreset === preset.key
                          ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                          : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                      )}
                    >
                      <div className="font-semibold text-xs text-foreground">
                        {preset.label}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                        {preset.hint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Memory limit */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-redis-memory"
                  className="text-xs font-medium text-foreground"
                >
                  Memory Limit (MB)
                </Label>
                <Input
                  id="create-redis-memory"
                  type="number"
                  min={16}
                  value={createMemory}
                  onChange={(e) => setCreateMemory(e.target.value)}
                  className="font-mono text-sm bg-card border-border"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  maxmemory is set to this value; the container gets a small
                  headroom above it.
                </p>
              </div>

              {/* Advanced: eviction + persistence */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-foreground">
                    Eviction Policy
                  </Label>
                  <Select
                    value={createEviction}
                    onValueChange={(v) =>
                      setCreateEviction(v as RedisEvictionPolicy)
                    }
                  >
                    <SelectTrigger className="bg-card border-border text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EVICTION_OPTIONS.map((policy) => (
                        <SelectItem key={policy} value={policy}>
                          {policy}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-foreground">
                    Persistence
                  </Label>
                  <Select
                    value={createPersistence}
                    onValueChange={(v) =>
                      setCreatePersistence(v as RedisPersistence)
                    }
                  >
                    <SelectTrigger className="bg-card border-border text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERSISTENCE_OPTIONS.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Attach to project */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-redis-project"
                  className="text-xs font-medium text-foreground"
                >
                  Attach to Project (Optional)
                </Label>
                <Select
                  value={createProjectId}
                  onValueChange={(val) => setCreateProjectId(val)}
                >
                  <SelectTrigger
                    id="create-redis-project"
                    className="bg-card border-border"
                  >
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No project (Standalone)</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Auto-inject env vars checkbox */}
              {createProjectId !== "none" && (
                <div className="flex items-start gap-2.5 rounded-lg border border-border/80 bg-muted/30 p-3">
                  <input
                    type="checkbox"
                    id="redis-auto-inject-env"
                    checked={createAutoInject}
                    onChange={(e) => setCreateAutoInject(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <Label
                    htmlFor="redis-auto-inject-env"
                    className="text-xs leading-relaxed text-foreground cursor-pointer"
                  >
                    <span className="font-semibold block">
                      Auto-inject environment variables
                    </span>
                    Automatically set{" "}
                    <code className="text-primary font-mono text-[11px]">
                      REDIS_URL
                    </code>
                    ,{" "}
                    <code className="text-primary font-mono text-[11px]">
                      REDIS_HOST
                    </code>{" "}
                    and{" "}
                    <code className="text-primary font-mono text-[11px]">
                      REDIS_PORT
                    </code>{" "}
                    in the selected project.
                  </Label>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Instance
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Detail Dialog: connection URI + stats ─────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between pr-4">
                  <DialogTitle className="flex items-center gap-2 text-foreground">
                    <Layers className="h-5 w-5 text-primary" />
                    {detail.name}
                  </DialogTitle>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs uppercase font-semibold",
                      STATUS_BADGE[detail.status].className,
                    )}
                  >
                    {STATUS_BADGE[detail.status].label}
                  </Badge>
                </div>
                <DialogDescription>
                  Connection URL and live stats for your application.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-3 text-sm">
                {/* Connection URL */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Internal Connection URL
                    </Label>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setShowPassword(!showPassword)}
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                        title={
                          showPassword ? "Hide password" : "Reveal password"
                        }
                      >
                        {showPassword ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                        {showPassword ? "Hide" : "Reveal"}
                      </button>
                      <button
                        onClick={() =>
                          handleCopy(detail.connectionUrl, "connection_url")
                        }
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        {copiedField === "connection_url" ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        Copy URL
                      </button>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/60 p-2.5 font-mono text-xs break-all select-all text-foreground">
                    {showPassword
                      ? detail.connectionUrl
                      : detail.connectionUrl.replace(
                          /:[^:@/]+@/,
                          ":••••••••••••@",
                        )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Use this URL inside your Vexlyx project containers. No host
                    port is published — external tools cannot reach it.
                  </p>
                </div>

                <Separator />

                {/* Live stats */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Live Stats
                    </Label>
                    {detail.status === "RUNNING" && (
                      <button
                        onClick={() => void loadStats(detail)}
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                        disabled={isLoadingStats}
                      >
                        <RotateCw
                          className={cn(
                            "h-3.5 w-3.5",
                            isLoadingStats && "animate-spin",
                          )}
                        />
                        Refresh
                      </button>
                    )}
                  </div>

                  {detail.status !== "RUNNING" ? (
                    <p className="text-xs text-muted-foreground italic">
                      Start the instance to see stats.
                    </p>
                  ) : isLoadingStats && !stats ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 rounded-lg" />
                      ))}
                    </div>
                  ) : statsError ? (
                    <p className="text-xs text-rose-500">{statsError}</p>
                  ) : stats ? (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg border border-border bg-card p-2.5">
                        <div className="text-muted-foreground">Used memory</div>
                        <div className="font-mono font-semibold text-foreground text-sm mt-0.5">
                          {formatBytes(stats.usedMemoryBytes)}
                          {stats.usedMemoryPercent !== null && (
                            <span className="text-muted-foreground font-normal">
                              {" "}
                              ({stats.usedMemoryPercent}%
                              {" max"})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-2.5">
                        <div className="text-muted-foreground">Total keys</div>
                        <div className="font-mono font-semibold text-foreground text-sm mt-0.5">
                          {stats.totalKeys}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-2.5">
                        <div className="text-muted-foreground">
                          Connected clients
                        </div>
                        <div className="font-mono font-semibold text-foreground text-sm mt-0.5">
                          {stats.connectedClients}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-2.5">
                        <div className="text-muted-foreground">Uptime</div>
                        <div className="font-mono font-semibold text-foreground text-sm mt-0.5">
                          {formatUptime(stats.uptimeSeconds)}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <Separator />

                {/* Settings summary */}
                <div className="rounded-lg border border-border divide-y divide-border bg-card text-xs">
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Image</span>
                    <span className="font-mono text-foreground font-medium">
                      {detail.image}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Memory limit</span>
                    <span className="font-mono text-foreground font-medium">
                      {detail.memoryLimitMb} MB
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Eviction</span>
                    <span className="font-mono text-foreground font-medium">
                      {detail.evictionPolicy}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Persistence</span>
                    <span className="font-mono text-foreground font-medium">
                      {detail.persistence}
                    </span>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex sm:justify-between items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  disabled={busyId === detail.id}
                  onClick={() => void handleRotatePassword(detail)}
                >
                  {busyId === detail.id ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Rotate Password
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-foreground hover:bg-muted"
                    disabled={
                      busyId === detail.id || detail.status !== "RUNNING"
                    }
                    onClick={() => void handlePower(detail, "restart")}
                  >
                    <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                    Restart
                  </Button>
                  <Button size="sm" onClick={() => setDetailOpen(false)}>
                    Done
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Configure Dialog ──────────────────────────────────────────────── */}
      <Dialog
        open={!!configInstance}
        onOpenChange={(open) => !open && setConfigInstance(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <SlidersHorizontal className="h-5 w-5 text-primary" />
              Configure &ldquo;{configInstance?.name}&rdquo;
            </DialogTitle>
            <DialogDescription>
              Saving recreates the container with the same volume, so stored
              data and the connection hostname are preserved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-sm">
            <div className="space-y-1.5">
              <Label
                htmlFor="config-redis-memory"
                className="text-xs font-medium text-foreground"
              >
                Memory Limit (MB)
              </Label>
              <Input
                id="config-redis-memory"
                type="number"
                min={16}
                value={configMemory}
                onChange={(e) => setConfigMemory(e.target.value)}
                className="font-mono text-sm bg-card border-border"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground">
                Eviction Policy
              </Label>
              <Select
                value={configEviction}
                onValueChange={(v) => setConfigEviction(v as RedisEvictionPolicy)}
              >
                <SelectTrigger className="bg-card border-border text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVICTION_OPTIONS.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {policy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground">
                Persistence
              </Label>
              <Select
                value={configPersistence}
                onValueChange={(v) =>
                  setConfigPersistence(v as RedisPersistence)
                }
              >
                <SelectTrigger className="bg-card border-border text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERSISTENCE_OPTIONS.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfigInstance(null)}
              disabled={isSavingConfig}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSaveConfig()}
              disabled={isSavingConfig}
            >
              {isSavingConfig && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ────────────────────────────────────── */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Instance &ldquo;{deleteTarget?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              This removes the container, its volume and every stored key. Any
              app currently connected via{" "}
              <code className="font-mono text-foreground">REDIS_URL</code> will
              lose connectivity. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Instance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

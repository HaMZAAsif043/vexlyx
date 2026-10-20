"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Trash2,
  GitBranch,
  Terminal,
  Globe,
  Loader2,
  AlertTriangle,
  FolderOpen,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { GitSettings } from "@/components/projects/GitSettings";
import { BuildPanel } from "@/components/projects/BuildPanel";
import { ContainerControls } from "@/components/projects/ContainerControls";
import { EnvVarEditor } from "@/components/projects/EnvVarEditor";
import { WordPressPanel } from "@/components/projects/WordPressPanel";
import { DockerfilePanel } from "@/components/projects/DockerfilePanel";
import { DatabasePanel } from "@/components/projects/DatabasePanel";
import { DomainPanel } from "@/components/projects/DomainPanel";
import { FileManagerCard } from "@/components/projects/FileManagerCard";
import { SftpPanel } from "@/components/projects/SftpPanel";
import { ScheduledTasksPanel } from "@/components/projects/ScheduledTasksPanel";
import type { Project, ProjectStatus, ProjectType } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Type + status display helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<ProjectType, string> = {
  NODEJS: "Node.js",
  NEXTJS: "Next.js",
  PYTHON: "Python",
  REACT: "React",
  STATIC: "Static Site",
  PHP: "PHP",
  WORDPRESS: "WordPress",
  DOCKER: "Docker",
};

const STATUS_CONFIG: Record<ProjectStatus, { label: string; className: string }> = {
  ACTIVE: {
    label: "Active",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  CREATING: {
    label: "Creating",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  STOPPED: {
    label: "Stopped",
    className: "bg-slate-500/10 text-slate-500 border-slate-500/20",
  },
  ERROR: {
    label: "Error",
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
  DELETED: {
    label: "Deleted",
    className: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  },
};

const TAB_VALUES = [
  "overview",
  "deploy",
  "environment",
  "database",
  "domains",
  "files",
  "advanced",
] as const;

type TabValue = (typeof TAB_VALUES)[number];

function isTabValue(value: string | null): value is TabValue {
  return TAB_VALUES.includes(value as TabValue);
}

function formatDate(date: Date | string, timezone?: string) {
  return formatDateTime(date, timezone);
}

// ---------------------------------------------------------------------------
// Skeleton shown while loading
// ---------------------------------------------------------------------------

function ProjectDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border border-border">
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-5 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info row used inside detail cards
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right break-all">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = params.id;
  const timezone = useTimezone();

  const activeTab: TabValue = isTabValue(searchParams.get("tab"))
    ? (searchParams.get("tab") as TabValue)
    : "overview";

  const handleTabChange = (value: string) => {
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", value);
    router.replace(`/projects/${id}?${query.toString()}`, { scroll: false });
  };

  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deployTriggerCount, setDeployTriggerCount] = useState(0);

  const fetchProject = useCallback(async () => {
    try {
      const data = await fetchAPI<Project>(`/api/projects/${id}`);
      setProject(data);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setNotFound(true);
      } else {
        toast.error("Failed to load project");
      }
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchProject();
  }, [fetchProject]);

  const handleDelete = async () => {
    if (!project) return;
    setIsDeleting(true);
    try {
      await fetchAPI(`/api/projects/${project.id}`, { method: "DELETE" });
      toast.success(`"${project.name}" deleted`);
      router.push("/projects");
    } catch {
      toast.error("Failed to delete project");
      setIsDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  // ── Not found ────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertTriangle className="h-10 w-10 text-muted-foreground" />
        <h2 className="mt-4 text-sm font-semibold text-foreground">Project not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This project may have been deleted or never existed.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-6">
          <Link href="/projects">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Projects
          </Link>
        </Button>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-5 w-32" />
        </div>
        <ProjectDetailSkeleton />
      </div>
    );
  }

  if (!project) return null;

  const statusCfg = STATUS_CONFIG[project.status];

  // ── Loaded ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Breadcrumb + title */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Button asChild variant="ghost" size="icon" aria-label="Back to projects">
            <Link href="/projects">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="truncate text-xl font-semibold text-foreground">
            {project.name}
          </h1>
          <Badge
            variant="outline"
            className={cn("shrink-0 text-xs font-medium", statusCfg.className)}
          >
            {statusCfg.label}
          </Badge>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <Button asChild variant="outline" size="sm" className="gap-1.5 shadow-xs">
            <Link
              href={`/projects/${project.id}/files`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open File Manager in a new tab"
            >
              <FolderOpen className="h-4 w-4 text-amber-500" />
              File Manager
              <ExternalLink className="h-3 w-3 text-muted-foreground ml-0.5" />
            </Link>
          </Button>
          <Button
            id="delete-project-btn"
            variant="outline"
            size="sm"
            className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <Separator />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="deploy">Deploy/Build</TabsTrigger>
          <TabsTrigger value="environment">Environment</TabsTrigger>
          <TabsTrigger value="database">Database</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="advanced">Git & Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Overview */}
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Overview
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                <InfoRow label="Type" value={TYPE_LABELS[project.type] ?? project.type} />
                <InfoRow label="Status" value={statusCfg.label} />
                <InfoRow label="Project ID" value={project.id} />
              </CardContent>
            </Card>

            {/* Repository */}
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <GitBranch className="h-3.5 w-3.5" />
                  Repository
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                <InfoRow
                  label="Git URL"
                  value={project.gitUrl ?? "Not connected"}
                />
                <InfoRow label="Branch" value={project.branch} />
              </CardContent>
            </Card>

            {/* Build settings */}
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Terminal className="h-3.5 w-3.5" />
                  Build Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                <InfoRow label="Build Command" value={project.buildCmd ?? "—"} />
                <InfoRow label="Start Command" value={project.startCmd ?? "—"} />
                <InfoRow label="Port" value={project.port?.toString() ?? "—"} />
              </CardContent>
            </Card>

            {/* Network */}
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" />
                  Timestamps
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                <InfoRow label="Created" value={formatDate(project.createdAt, timezone)} />
                <InfoRow label="Updated" value={formatDate(project.updatedAt, timezone)} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="deploy" className="space-y-6">
          {/* Live container controls */}
          <ContainerControls
            project={project}
            onProjectUpdate={fetchProject}
          />

          {/* Build & deployment panel */}
          <BuildPanel
            projectId={project.id}
            buildCmd={project.buildCmd}
            onDeploySuccess={fetchProject}
            refreshTrigger={deployTriggerCount}
          />
        </TabsContent>

        <TabsContent value="environment" className="space-y-6">
          {/* Environment variables editor */}
          <EnvVarEditor
            projectId={project.id}
            onDeployTrigger={() => {
              setDeployTriggerCount((c) => c + 1);
              void fetchProject();
            }}
          />
        </TabsContent>

        <TabsContent value="database" className="space-y-6">
          {/* Provisioned Databases Panel (F2.6) */}
          <DatabasePanel
            project={project}
            onProjectUpdate={fetchProject}
          />
        </TabsContent>

        <TabsContent value="domains" className="space-y-6">
          {/* Custom Domains Panel (F3.1) */}
          <DomainPanel
            project={project}
            onProjectUpdate={fetchProject}
          />
        </TabsContent>

        <TabsContent value="files" className="space-y-6">
          {/* File Manager (F2.8) */}
          <FileManagerCard projectId={project.id} />

          {/* SFTP Access (F2.8) */}
          <SftpPanel projectId={project.id} />
        </TabsContent>

        <TabsContent value="advanced" className="space-y-6">
          {/* Git settings — full interactive panel */}
          <GitSettings
            projectId={project.id}
            initialGitUrl={project.gitUrl}
            initialBranch={project.branch}
            onProjectUpdate={fetchProject}
          />

          {/* WordPress Management Panel */}
          {project.type === "WORDPRESS" && (
            <WordPressPanel
              project={project}
              onProjectUpdate={fetchProject}
            />
          )}

          {/* Custom Dockerfile Management Panel (F2.5) */}
          {(project.type === "DOCKER" || !project.gitUrl) && (
            <DockerfilePanel
              project={project}
              onProjectUpdate={fetchProject}
              onDeployTrigger={() => {
                setDeployTriggerCount((c) => c + 1);
                void fetchProject();
              }}
            />
          )}

          {/* Scheduled Tasks (Cron Jobs) (F5.28) */}
          <ScheduledTasksPanel projectId={project.id} timezone={timezone} />
        </TabsContent>
      </Tabs>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{project.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This will permanently delete the project and schedule all associated
              resources (containers, volumes) for cleanup. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              id="confirm-delete-project-btn"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

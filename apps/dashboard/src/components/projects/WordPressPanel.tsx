"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  Globe,
  Upload,
  RefreshCw,
  Loader2,
  Package,
  Palette,
  ExternalLink,
  Server,
  Database,
  Sparkles,
  Download,
  FolderInput,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { fetchAPI } from "@/lib/api";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { useDomains } from "@/hooks/useDomains";
import type { Project, DatabaseDetail } from "@vexlyx/shared";

interface WordPressStatus {
  installed: boolean;
  coreVersion: string;
  plugins: string[];
  themes: string[];
}

interface WordPressPanelProps {
  project: Project;
  onProjectUpdate?: () => void;
}

export function WordPressPanel({ project, onProjectUpdate }: WordPressPanelProps) {
  const [status, setStatus] = useState<WordPressStatus | null>(null);
  const { isRefreshing, refresh } = useRefreshAnimation();
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [availableDbs, setAvailableDbs] = useState<DatabaseDetail[]>([]);

  // Form state for DB settings
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");
  const [dbPrefix, setDbPrefix] = useState("wp_");

  // Upload state
  const [uploadType, setUploadType] = useState<"plugin" | "theme">("plugin");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Export/import state
  const [isExporting, setIsExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importDatabaseId, setImportDatabaseId] = useState("");
  const importFileRef = useRef<HTMLInputElement | null>(null);

  // F5.10: prefer an attached, verified custom Domain over the default
  // deployedDomain — both now resolve over real HTTPS.
  const { domains } = useDomains({ projectId: project.id });

  const loadDatabases = useCallback(async () => {
    try {
      const res = await fetchAPI<{ databases: DatabaseDetail[] }>(
        `/api/databases?projectId=${project.id}`,
      );
      const mysqlDbs = (res.databases ?? []).filter((d) => d.type === "MYSQL");
      setAvailableDbs(mysqlDbs);
      const first = mysqlDbs[0];
      if (first) {
        setSelectedDatabaseId((current) => current || first.id);
        setImportDatabaseId((current) => current || first.id);
      }
    } catch {
      // Ignore error if database list fails
    }
  }, [project.id]);

  useEffect(() => {
    if (installModalOpen || importOpen) {
      void loadDatabases();
    }
  }, [installModalOpen, importOpen, loadDatabases]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await fetchAPI<WordPressStatus>(`/api/projects/${project.id}/wordpress/status`);
      setStatus(data);
    } catch {
      // Ignored if not yet installed or project newly created
    }
  }, [project.id]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleRefresh = () => refresh(() => fetchStatus());

  const handleInstall = async () => {
    if (!selectedDatabaseId) {
      toast.error("Select a MySQL database first");
      return;
    }
    setIsInstalling(true);
    try {
      const result = await fetchAPI<{ message: string; success: boolean }>(
        `/api/projects/${project.id}/wordpress/install`,
        {
          method: "POST",
          body: JSON.stringify({
            databaseId: selectedDatabaseId,
            dbPrefix,
          }),
        },
      );
      toast.success(result.message || "WordPress installed successfully!");
      setInstallModalOpen(false);
      await fetchStatus();
      if (onProjectUpdate) onProjectUpdate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to install WordPress");
    } finally {
      setIsInstalling(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("Please upload a valid .zip archive");
      return;
    }

    setIsUploading(true);
    try {
      // Multipart upload — real theme/plugin archives are routinely several
      // MB, far past the API's 1 MiB JSON body limit that base64-in-JSON
      // requests used to hit with a 413 (#154).
      const form = new FormData();
      form.append("assetType", uploadType);
      form.append("file", file, file.name);
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000"}/api/projects/${project.id}/wordpress/upload`;
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error ?? "Upload failed");
      }
      const data = (await res.json()) as { message: string };
      toast.success(data.message);
      await fetchStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload asset");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const triggerUploadDialog = (type: "plugin" | "theme") => {
    setUploadType(type);
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const activeDomain = domains.find((d) => d.status === "ACTIVE");
  const viewDomain = activeDomain?.hostname ?? project.deployedDomain;
  const siteUrl = viewDomain ? `https://${viewDomain}` : null;

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000"}/api/projects/${project.id}/wordpress/export`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `wp-export-${project.id}.tar.gz`;
      a.click();
      toast.success("WordPress site exported successfully");
    } catch {
      toast.error("Export failed. Make sure WordPress is installed and deployed.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async () => {
    const file = importFileRef.current?.files?.[0];
    if (!file) { toast.error("Select a .tar.gz archive first"); return; }
    if (!importDatabaseId) { toast.error("Select a MySQL database first"); return; }
    setIsImporting(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("databaseId", importDatabaseId);
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000"}/api/projects/${project.id}/wordpress/import`;
      const res = await fetch(url, { method: "POST", credentials: "include", body: form });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Import failed");
      }
      toast.success("WordPress site imported! Redeploy to apply changes.");
      setImportOpen(false);
      onProjectUpdate?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Globe className="h-4 w-4 text-indigo-500" />
            WordPress Management
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-1">
            Manage WordPress core scaffolding, database connection, plugins, and themes.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            aria-label="Refresh status"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-4 w-4")} />
          </Button>
          {siteUrl && (
            <Button asChild variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <a href={`${siteUrl}/wp-admin`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                WP Admin
              </a>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
              <Server className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">WordPress Core</span>
                {status?.installed ? (
                  <Badge
                    variant="outline"
                    className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-xs py-0"
                  >
                    Installed
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 text-xs py-0"
                  >
                    Not Installed
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {status?.coreVersion && status.coreVersion !== "unknown"
                  ? `Version ${status.coreVersion}`
                  : "Latest Release"}
              </p>
            </div>
          </div>

          {!status?.installed ? (
            <Button
              id="wp-one-click-btn"
              size="sm"
              className="h-8 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs"
              onClick={() => setInstallModalOpen(true)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              1-Click Install WordPress
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => setInstallModalOpen(true)}
            >
              <Database className="h-3.5 w-3.5" />
              Reconfigure DB
            </Button>
          )}
        </div>

        {/* Hidden file input for uploads */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => void handleFileUpload(e)}
        />

        {/* Plugins & Themes sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Plugins */}
          <div className="p-4 rounded-lg border border-border bg-card space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Plugins ({status?.plugins?.length ?? 0})
                </h3>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={isUploading}
                onClick={() => triggerUploadDialog("plugin")}
              >
                {isUploading && uploadType === "plugin" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                Upload Plugin
              </Button>
            </div>

            {status?.plugins && status.plugins.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pt-1">
                {status.plugins.map((plugin) => (
                  <Badge key={plugin} variant="secondary" className="text-xs font-normal">
                    {plugin}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic py-2">
                No custom plugins installed yet.
              </p>
            )}
          </div>

          {/* Themes */}
          <div className="p-4 rounded-lg border border-border bg-card space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Themes ({status?.themes?.length ?? 0})
                </h3>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={isUploading}
                onClick={() => triggerUploadDialog("theme")}
              >
                {isUploading && uploadType === "theme" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                Upload Theme
              </Button>
            </div>

            {status?.themes && status.themes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pt-1">
                {status.themes.map((theme) => (
                  <Badge key={theme} variant="secondary" className="text-xs font-normal">
                    {theme}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic py-2">
                No custom themes installed yet.
              </p>
            )}
          </div>
        </div>
      </CardContent>

      {/* 1-Click Install Dialog */}
      <Dialog open={installModalOpen} onOpenChange={setInstallModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              1-Click WordPress Setup
            </DialogTitle>
            <DialogDescription>
              WordPress core ships in the official image — pick the MySQL database to connect it to.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3.5 py-2">
            {availableDbs.length === 0 ? (
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <Database className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  No MySQL database found for this project.{" "}
                  <a href="/databases" className="underline font-medium">
                    Create one on the Databases page
                  </a>{" "}
                  first.
                </span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="wp-db-select" className="text-xs">Database</Label>
                <Select value={selectedDatabaseId} onValueChange={setSelectedDatabaseId}>
                  <SelectTrigger id="wp-db-select" className="h-8 text-xs">
                    <SelectValue placeholder="Select a MySQL database" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableDbs.map((db) => (
                      <SelectItem key={db.id} value={db.id}>
                        {db.name} ({db.internalHost}:{db.port})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="wp-db-prefix" className="text-xs">Table Prefix</Label>
              <Input
                id="wp-db-prefix"
                value={dbPrefix}
                onChange={(e) => setDbPrefix(e.target.value)}
                placeholder="wp_"
                className="h-8 text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInstallModalOpen(false)}
              disabled={isInstalling}
            >
              Cancel
            </Button>
            <Button
              id="confirm-wp-install-btn"
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
              onClick={() => void handleInstall()}
              disabled={isInstalling || availableDbs.length === 0}
            >
              {isInstalling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Install WordPress
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export / Import section */}
      <div className="border-t border-border p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Backup & Migration</p>
        <div className="flex flex-wrap gap-2">
          <Button
            id="wp-export-btn"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void handleExport()}
            disabled={isExporting}
          >
            {isExporting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Download className="h-3.5 w-3.5" />
            }
            Export Site (.tar.gz)
          </Button>
          <Button
            id="wp-import-btn"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setImportOpen(true)}
          >
            <FolderInput className="h-3.5 w-3.5" />
            Import Site
          </Button>
        </div>
      </div>

      {/* Import dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import WordPress Site</DialogTitle>
            <DialogDescription>
              Upload a tar.gz backup (files + database.sql). The SQL dump will be imported and wp-config.php updated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Backup Archive (.tar.gz)</Label>
              <input
                ref={importFileRef}
                type="file"
                accept=".tar.gz,.tgz"
                className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-border file:text-xs file:font-medium file:bg-background file:text-foreground hover:file:bg-muted"
              />
            </div>
            {availableDbs.length === 0 ? (
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <Database className="h-4 w-4 shrink-0 mt-0.5" />
                <span>No MySQL database found for this project. Create one first.</span>
              </div>
            ) : (
              <div>
                <Label className="text-xs text-muted-foreground">Database</Label>
                <Select value={importDatabaseId} onValueChange={setImportDatabaseId}>
                  <SelectTrigger className="mt-1 h-8 text-sm">
                    <SelectValue placeholder="Select a MySQL database" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableDbs.map((db) => (
                      <SelectItem key={db.id} value={db.id}>
                        {db.name} ({db.internalHost}:{db.port})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(false)} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              id="confirm-wp-import-btn"
              size="sm"
              onClick={() => void handleImport()}
              disabled={isImporting || availableDbs.length === 0}
            >
              {isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import Site
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UpdateProjectSchema, type Project } from "@vexlyx/shared";
import { fetchAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const runtimes = [
  {
    label: "Node version",
    key: "NIXPACKS_NODE_VERSION",
    versions: ["20", "22", "24"],
  },
  {
    label: "Python version",
    key: "NIXPACKS_PYTHON_VERSION",
    versions: ["3.10", "3.11", "3.12", "3.13", "3.14"],
  },
  {
    label: "PHP version",
    key: "NIXPACKS_PHP_VERSION",
    versions: ["8.2", "8.3", "8.4", "8.5"],
  },
];

export function RuntimeVersionSettings({ projectId }: { projectId: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    void (async () => {
      try {
        const { variables } = await fetchAPI<{
          variables: Array<{ key: string }>;
        }>(`/api/projects/${projectId}/env`);
        const entries = await Promise.all(
          runtimes.map(async (runtime) => {
            if (!variables.some((variable) => variable.key === runtime.key))
              return [runtime.key, ""];
            const { value } = await fetchAPI<{ value: string }>(
              `/api/projects/${projectId}/env/${runtime.key}/reveal`,
            );
            return [runtime.key, value];
          }),
        );
        if (active) {
          const initial = Object.fromEntries(entries);
          setValues(initial);
          setStored(initial);
          setReady(true);
        }
      } catch (error) {
        if (active)
          toast.error(
            error instanceof Error
              ? error.message
              : "Unable to load runtime versions",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  async function save() {
    setBusy(true);
    try {
      for (const { key } of runtimes) {
        if (values[key] === stored[key]) continue;
        if (values[key])
          await fetchAPI(`/api/projects/${projectId}/env`, {
            method: "POST",
            body: JSON.stringify({ key, value: values[key] }),
          });
        else
          await fetchAPI(`/api/projects/${projectId}/env/${key}`, {
            method: "DELETE",
          });
        // Keep successful writes if a later request fails, allowing a safe retry.
        setStored((previous) => ({ ...previous, [key]: values[key]! }));
      }
      toast.success("Runtime versions saved. Redeploy to apply.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save versions",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Runtime versions for Nixpacks builds. Auto uses repository configuration
        and detection. Custom Dockerfiles choose their own runtime.
      </p>
      {runtimes.map((runtime) => (
        <div key={runtime.key} className="space-y-1">
          <Label htmlFor={runtime.key}>{runtime.label}</Label>
          <select
            id={runtime.key}
            className="w-full rounded-md border bg-background p-2"
            disabled={!ready || busy}
            value={values[runtime.key] ?? ""}
            onChange={(event) =>
              setValues((previous) => ({
                ...previous,
                [runtime.key]: event.target.value,
              }))
            }
          >
            <option value="">Auto</option>
            {values[runtime.key] &&
              !runtime.versions.includes(values[runtime.key]!) && (
                <option value={values[runtime.key]}>
                  {values[runtime.key]} (existing)
                </option>
              )}
            {runtime.versions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </div>
      ))}
      <Button disabled={!ready || busy} onClick={() => void save()}>
        Save runtime versions
      </Button>
    </div>
  );
}

export function AdvancedBuildSettings({
  project,
  onProjectUpdate,
}: {
  project: Project;
  onProjectUpdate?: () => void;
}) {
  const [baseDirectory, setBaseDirectory] = useState(
    project.baseDirectory ?? "",
  );
  const [memoryLimit, setMemoryLimit] = useState(project.memoryLimit ?? "");
  const [cache, setCache] = useState(project.buildCacheEnabled ?? true);
  const [busy, setBusy] = useState(false);
  async function save() {
    const parsed = UpdateProjectSchema.safeParse({
      baseDirectory: baseDirectory.trim() || null,
      memoryLimit: memoryLimit.trim() || null,
      buildCacheEnabled: cache,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid settings");
      return;
    }
    setBusy(true);
    try {
      await fetchAPI(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
      toast.success("Build controls saved. Redeploy to apply.");
      onProjectUpdate?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save controls",
      );
    } finally {
      setBusy(false);
    }
  }
  async function clearCache() {
    setBusy(true);
    try {
      await fetchAPI(`/api/projects/${project.id}/build-cache/clear`, {
        method: "POST",
      });
      toast.success("Cache reset. The next build will run from scratch.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to clear cache",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced build settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <RuntimeVersionSettings projectId={project.id} />
        <div className="space-y-1">
          <Label htmlFor="base-directory">Base directory</Label>
          <Input
            id="base-directory"
            value={baseDirectory}
            onChange={(event) => setBaseDirectory(event.target.value)}
            placeholder="apps/web"
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">
            Relative source directory for detection and builds. Blank uses the
            repository root.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="memory-limit">Container memory limit</Label>
          <Input
            id="memory-limit"
            value={memoryLimit}
            onChange={(event) => setMemoryLimit(event.target.value)}
            placeholder="512m or 1g"
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">
            Blank uses the server default. Maximum 64g.
          </p>
        </div>
        <Label>
          <input
            type="checkbox"
            checked={cache}
            disabled={busy}
            onChange={(event) => setCache(event.target.checked)}
          />{" "}
          Enable build cache
        </Label>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void save()}>
            Save build controls
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void clearCache()}
          >
            Clear build cache
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Clearing cache gives the next build a fresh cache and disables cached
          layers for that build. It does not delete shared Docker cache from
          disk.
        </p>
      </CardContent>
    </Card>
  );
}

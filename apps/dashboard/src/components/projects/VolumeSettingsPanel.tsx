"use client";

import { useState } from "react";
import { toast } from "sonner";
import { VolumePathsSchema, type Project } from "@vexlyx/shared";
import { fetchAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export function VolumeSettingsPanel({
  project,
  onProjectUpdate,
}: {
  project: Project;
  onProjectUpdate?: () => void;
}) {
  const [paths, setPaths] = useState((project.volumePaths ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  if (project.type !== "DOCKER") return null;
  async function save() {
    const parsed = VolumePathsSchema.safeParse(
      paths
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid volume paths");
      return;
    }
    setBusy(true);
    try {
      await fetchAPI(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ volumePaths: parsed.data }),
      });
      toast.success("Volume settings saved. Redeploy to apply.");
      onProjectUpdate?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save volumes",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Persistent Docker data</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="volume-paths">
          Container directories, one per line
        </Label>
        <textarea
          id="volume-paths"
          className="w-full rounded-md border bg-background p-2 font-mono text-sm"
          rows={4}
          value={paths}
          onChange={(event) => setPaths(event.target.value)}
          disabled={busy}
          placeholder="/var/lib/app"
        />
        <p className="text-sm text-muted-foreground">
          Each directory gets a private named volume kept across redeploys.
          Files in a volume hide newer image contents at that path. Refresh
          application files in your entrypoint when needed.
        </p>
        <p className="text-sm text-muted-foreground">
          Adding a path to an existing deployment creates a new volume; back up
          and migrate existing data first. Removing a path detaches its data
          without deleting it. Use Remove container and data to delete this
          project's named data.
        </p>
        <p className="text-sm text-muted-foreground">
          Images can also declare anonymous volumes. They persist across
          redeploys but may be lost on container removal. Back them up before
          changing mounts or removing the container.
        </p>
        <Button disabled={busy} onClick={() => void save()}>
          Save volume paths
        </Button>
      </CardContent>
    </Card>
  );
}

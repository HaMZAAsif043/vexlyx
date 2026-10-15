"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchAPI } from "@/lib/api";
import type { FileNode } from "@vexlyx/shared";

const ARCHIVE_PATTERN = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tbz)$/i;

export function isArchiveName(name: string): boolean {
  return ARCHIVE_PATTERN.test(name);
}

function parentOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

interface ExtractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  node: FileNode | null;
  onDone: () => void;
}

export function ExtractDialog({ open, onOpenChange, projectId, node, onDone }: ExtractDialogProps) {
  const [destination, setDestination] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !node) return;
    setDestination(parentOf(node.path));
    setOverwrite(false);
  }, [open, node]);

  const handleExtract = async () => {
    if (!node) return;
    setIsSubmitting(true);
    try {
      const res = await fetchAPI<{ extracted: number; skipped: string[] }>(
        `/api/files/${projectId}/extract`,
        {
          method: "POST",
          body: JSON.stringify({
            path: node.path,
            destination: destination.trim().replace(/^\/+|\/+$/g, "") || ".",
            overwrite,
          }),
        },
      );
      toast.success(`Extracted ${res.extracted} file${res.extracted === 1 ? "" : "s"}`);
      if (res.skipped.length > 0) {
        toast.warning(
          `Skipped ${res.skipped.length} protected file${res.skipped.length === 1 ? "" : "s"}: ${res.skipped.slice(0, 3).join(", ")}`,
        );
      }
      onDone();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to extract archive");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extract archive</DialogTitle>
          <DialogDescription>
            Unpack{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{node?.name}</code> on the
            server. Supports .zip, .tar, .tar.gz and .tar.bz2.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="extract-destination">Destination folder</Label>
            <Input
              id="extract-destination"
              className="font-mono"
              placeholder="Project root"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Created if it does not exist. Leave empty for the project root.</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="extract-overwrite">Overwrite existing files</Label>
              <p className="text-xs text-muted-foreground">
                Off: extraction stops if any file already exists.
              </p>
            </div>
            <Switch id="extract-overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleExtract()} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Extract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

interface CompressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  nodes: FileNode[];
  onDone: () => void;
}

export function CompressDialog({ open, onOpenChange, projectId, nodes, onDone }: CompressDialogProps) {
  const [name, setName] = useState("archive.zip");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const first = nodes[0];

  useEffect(() => {
    if (!open || !first) return;
    setName(nodes.length === 1 ? `${first.name}.zip` : "archive.zip");
  }, [open, nodes, first]);

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && !trimmed.includes("/") && /\.zip$/i.test(trimmed);

  const handleCompress = async () => {
    if (!first || !nameValid) return;
    setIsSubmitting(true);
    try {
      const destination = joinPath(parentOf(first.path), trimmed);
      const res = await fetchAPI<{ files: number; skippedLinks: number }>(
        `/api/files/${projectId}/compress`,
        {
          method: "POST",
          body: JSON.stringify({ paths: nodes.map((n) => n.path), destination }),
        },
      );
      toast.success(`Created ${trimmed} (${res.files} file${res.files === 1 ? "" : "s"})`);
      if (res.skippedLinks > 0) {
        toast.warning(`${res.skippedLinks} symbolic link${res.skippedLinks === 1 ? " was" : "s were"} left out`);
      }
      onDone();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create archive");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Compress to .zip</DialogTitle>
          <DialogDescription>
            {nodes.length === 1
              ? `Add “${first?.name}” to a zip archive.`
              : `Add ${nodes.length} selected items to a zip archive.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="compress-name">Archive name</Label>
          <Input
            id="compress-name"
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCompress();
            }}
            aria-invalid={!nameValid}
            autoFocus
          />
          {!nameValid && (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Use a file name ending in .zip, without slashes.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleCompress()} disabled={isSubmitting || !nameValid}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Compress
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

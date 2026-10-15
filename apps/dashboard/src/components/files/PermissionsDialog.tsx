"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, TriangleAlert } from "lucide-react";
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

interface PermissionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  node: FileNode | null;
  onChanged: () => void;
}

const OCTAL_PATTERN = /^[0-7]{3}$/;
const CLASSES = ["Owner", "Group", "Other"] as const;
const BITS = [
  { label: "Read", value: 4 },
  { label: "Write", value: 2 },
  { label: "Execute", value: 1 },
] as const;

function digitAt(mode: string, index: number): number {
  return OCTAL_PATTERN.test(mode) ? Number(mode[index]) : 0;
}

export function PermissionsDialog({
  open,
  onOpenChange,
  projectId,
  node,
  onChanged,
}: PermissionsDialogProps) {
  const [mode, setMode] = useState("644");
  const [fileMode, setFileMode] = useState("644");
  const [recursive, setRecursive] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDir = node?.type === "dir";

  useEffect(() => {
    if (!open || !node) return;
    const current = node.mode && OCTAL_PATTERN.test(node.mode) ? node.mode : isDirDefault(node);
    setMode(current);
    setFileMode("644");
    setRecursive(false);
  }, [open, node]);

  const toggleBit = (classIndex: number, bit: number) => {
    const digits = [0, 1, 2].map((i) => digitAt(mode, i));
    digits[classIndex] = digits[classIndex] ^ bit;
    setMode(digits.join(""));
  };

  const modeValid = OCTAL_PATTERN.test(mode);
  const fileModeValid = !recursive || OCTAL_PATTERN.test(fileMode);
  const worldWritable = modeValid && (digitAt(mode, 2) & 2) !== 0;

  const handleApply = async () => {
    if (!node || !modeValid || !fileModeValid) return;
    setIsSubmitting(true);
    try {
      const res = await fetchAPI<{ changed: number }>(`/api/files/${projectId}/chmod`, {
        method: "POST",
        body: JSON.stringify({
          path: node.path,
          mode,
          recursive,
          ...(recursive && { fileMode }),
        }),
      });
      toast.success(
        res.changed > 1
          ? `Permissions updated on ${res.changed} items`
          : `Permissions of ${node.name} set to ${mode}`,
      );
      onChanged();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change permissions");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Permissions</DialogTitle>
          <DialogDescription>
            Change who can read, write and execute{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{node?.name}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div role="group" aria-label="Permission checkboxes" className="rounded-lg border border-border">
            <div className="grid grid-cols-4 gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              <span />
              {BITS.map((bit) => (
                <span key={bit.label} className="text-center">
                  {bit.label}
                </span>
              ))}
            </div>
            {CLASSES.map((cls, classIndex) => (
              <div key={cls} className="grid grid-cols-4 items-center gap-2 px-3 py-2 text-sm">
                <span>{cls}</span>
                {BITS.map((bit) => (
                  <span key={bit.label} className="flex justify-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input accent-primary"
                      checked={(digitAt(mode, classIndex) & bit.value) !== 0}
                      onChange={() => toggleBit(classIndex, bit.value)}
                      aria-label={`${cls} ${bit.label.toLowerCase()}`}
                    />
                  </span>
                ))}
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="permissions-octal">{recursive ? "Folder mode (octal)" : "Mode (octal)"}</Label>
            <Input
              id="permissions-octal"
              value={mode}
              maxLength={3}
              inputMode="numeric"
              className="font-mono"
              onChange={(e) => setMode(e.target.value)}
              aria-invalid={!modeValid}
            />
            {!modeValid && (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                Enter three octal digits, for example 644 or 755.
              </p>
            )}
          </div>

          {worldWritable && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Anyone on this server could modify this item. Only use this if the app requires it.
            </p>
          )}

          {isDir && (
            <div className="space-y-3 rounded-lg border border-border px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label htmlFor="permissions-recursive">Apply to contents</Label>
                  <p className="text-xs text-muted-foreground">
                    Also change every file and folder inside. Symbolic links are skipped.
                  </p>
                </div>
                <Switch
                  id="permissions-recursive"
                  checked={recursive}
                  onCheckedChange={setRecursive}
                />
              </div>
              {recursive && (
                <div className="space-y-1.5">
                  <Label htmlFor="permissions-file-octal">File mode (octal)</Label>
                  <Input
                    id="permissions-file-octal"
                    value={fileMode}
                    maxLength={3}
                    inputMode="numeric"
                    className="font-mono"
                    onChange={(e) => setFileMode(e.target.value)}
                    aria-invalid={!fileModeValid}
                  />
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    This changes every item under {node?.name}. It cannot be undone automatically.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleApply()}
            disabled={isSubmitting || !modeValid || !fileModeValid}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {recursive ? "Apply to contents" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isDirDefault(node: FileNode): string {
  return node.type === "dir" ? "755" : "644";
}

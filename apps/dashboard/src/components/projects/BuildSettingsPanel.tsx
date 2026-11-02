"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Hammer,
  Info,
  Loader2,
  RotateCcw,
  Save,
  Wand2,
  Zap,
} from "lucide-react";
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
import { fetchAPI, ApiRequestError } from "@/lib/api";
import type { Project, BuildPlan } from "@vexlyx/shared";

// Mirrors the max length the API enforces on every command field.
const MAX_COMMAND_LENGTH = 500;

/**
 * An empty input means "no override": the API stores null, which hands the
 * decision back to Nixpacks' plan instead of running an empty command.
 */
function toOverride(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

interface CommandFieldProps {
  id: string;
  label: string;
  value: string;
  detected: string | null;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function CommandField({
  id,
  label,
  value,
  detected,
  placeholder,
  disabled,
  onChange,
}: CommandFieldProps) {
  const isOverridden = value.trim() !== "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label
          htmlFor={id}
          className="text-xs font-medium text-muted-foreground"
        >
          {label}
        </Label>
        <Badge
          variant="outline"
          className={
            isOverridden
              ? "border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
              : "border-slate-500/20 bg-slate-500/10 text-[10px] text-slate-500"
          }
        >
          {isOverridden ? "Custom" : "Auto"}
        </Badge>
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={MAX_COMMAND_LENGTH}
        placeholder={detected ?? placeholder}
        className="h-8 font-mono text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        {isOverridden
          ? `Detected: ${detected || "nothing — Nixpacks has no proposal for this project"}`
          : detected
            ? "Blank uses the detected command above."
            : "Blank lets Nixpacks decide on every build."}
      </p>
    </div>
  );
}

interface BuildSettingsPanelProps {
  project: Project;
  onProjectUpdate?: () => void;
  onDeployTrigger?: () => void;
}

export function BuildSettingsPanel({
  project,
  onProjectUpdate,
  onDeployTrigger,
}: BuildSettingsPanelProps) {
  const [installCmd, setInstallCmd] = useState(project.installCmd ?? "");
  const [buildCmd, setBuildCmd] = useState(project.buildCmd ?? "");
  const [startCmd, setStartCmd] = useState(project.startCmd ?? "");
  const [port, setPort] = useState(project.port?.toString() ?? "");

  const [detected, setDetected] = useState<BuildPlan | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);

  const isBusy = isSaving || isDeploying || isDetecting;

  const hasOverride =
    installCmd.trim() !== "" ||
    buildCmd.trim() !== "" ||
    startCmd.trim() !== "" ||
    port.trim() !== "";

  /** Returns the PUT body, or null when the port fails validation. */
  function composePayload(): Record<string, string | number | null> | null {
    const payload: Record<string, string | number | null> = {
      installCmd: toOverride(installCmd),
      buildCmd: toOverride(buildCmd),
      startCmd: toOverride(startCmd),
    };

    const trimmedPort = port.trim();
    const storedPort = project.port?.toString() ?? "";
    // An untouched field is left out of the write entirely: re-sending the
    // value we loaded could overwrite a port the Dockerfile panel synced from
    // EXPOSE between that load and this save.
    if (trimmedPort !== storedPort) {
      if (trimmedPort === "") {
        // The field held a stored port and the user deleted it — that is an
        // explicit clear, unlike a blank field that never had a port.
        payload.port = null;
      } else {
        const parsed = Number(trimmedPort);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          toast.error("Port must be a whole number between 1 and 65535");
          return null;
        }
        payload.port = parsed;
      }
    }

    return payload;
  }

  async function save(): Promise<boolean> {
    const payload = composePayload();
    if (!payload) return false;

    await fetchAPI<Project>(`/api/projects/${project.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    return true;
  }

  const handleSave = async (triggerDeploy: boolean) => {
    setIsSaving(true);
    if (triggerDeploy) setIsDeploying(true);

    try {
      await save();
      toast.success("Build settings saved");
      onProjectUpdate?.();

      if (triggerDeploy) {
        await fetchAPI(`/api/projects/${project.id}/build`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        toast.success("Deployment triggered with these settings");
        onDeployTrigger?.();
      }
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save build settings"));
    } finally {
      setIsSaving(false);
      setIsDeploying(false);
    }
  };

  const handleDetect = async () => {
    setIsDetecting(true);
    try {
      const plan = await fetchAPI<BuildPlan>(
        `/api/projects/${project.id}/build-plan`,
      );
      setDetected(plan);
      toast.success(`Nixpacks detected: ${plan.framework}`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not run detection on this source"));
    } finally {
      setIsDetecting(false);
    }
  };

  const handleClearOverrides = async () => {
    setIsSaving(true);
    try {
      await fetchAPI<Project>(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({
          installCmd: null,
          buildCmd: null,
          startCmd: null,
          port: null,
        }),
      });
      setInstallCmd("");
      setBuildCmd("");
      setStartCmd("");
      setPort("");
      toast.success("Overrides cleared — auto-detection is back in charge");
      onProjectUpdate?.();
    } catch (err) {
      toast.error(errorMessage(err, "Failed to clear build overrides"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="border border-border" id="build-settings-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Hammer className="h-4 w-4 text-indigo-500" />
              Build Settings
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Leave a field blank and Vexlyx uses what Nixpacks detects from the
              repository. Type a command to override it on every future build.
            </CardDescription>
          </div>

          <Button
            id="detect-build-plan-btn"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            onClick={() => void handleDetect()}
            disabled={isBusy}
          >
            {isDetecting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            Detect
          </Button>
        </div>

        {detected && (
          <p className="text-[11px] text-muted-foreground">
            Detection ran against the current source — framework{" "}
            <span className="font-medium text-foreground">
              {detected.framework}
            </span>
            {detected.detectedType ? ` (${detected.detectedType})` : ""}.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <CommandField
          id="project-install-cmd"
          label="Install Command"
          value={installCmd}
          detected={detected?.installCmd ?? null}
          placeholder="npm install"
          disabled={isBusy}
          onChange={setInstallCmd}
        />
        <CommandField
          id="project-build-cmd"
          label="Build Command"
          value={buildCmd}
          detected={detected?.buildCmd ?? null}
          placeholder="npm run build"
          disabled={isBusy}
          onChange={setBuildCmd}
        />
        <CommandField
          id="project-start-cmd"
          label="Start Command"
          value={startCmd}
          detected={detected?.startCmd ?? null}
          placeholder="npm run start"
          disabled={isBusy}
          onChange={setStartCmd}
        />

        <div className="space-y-1.5">
          <Label
            htmlFor="project-container-port"
            className="text-xs font-medium text-muted-foreground"
          >
            Container Port
          </Label>
          <Input
            id="project-container-port"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={isBusy}
            placeholder={detected ? "auto-detected" : "e.g. 3000"}
            className="h-8 w-32 font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            The port the container listens on. For Dockerfile projects this
            follows EXPOSE unless you set it here.
          </p>
        </div>

        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>Applied to the next build.</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              id="clear-build-overrides-btn"
              variant="ghost"
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => void handleClearOverrides()}
              disabled={isBusy || !hasOverride}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Auto
            </Button>

            <Button
              id="save-build-settings-btn"
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => void handleSave(false)}
              disabled={isBusy}
            >
              {isSaving && !isDeploying ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              Save
            </Button>

            <Button
              id="save-deploy-build-settings-btn"
              size="sm"
              className="h-8 px-3 text-xs bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => void handleSave(true)}
              disabled={isBusy}
            >
              {isDeploying ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-1.5 h-3.5 w-3.5" />
              )}
              Save &amp; Deploy
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

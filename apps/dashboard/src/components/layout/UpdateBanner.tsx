"use client";

import { useEffect, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSystemUpdate } from "@/hooks/useSystemUpdate";

const DISMISSED_KEY = "vexlyx.update.dismissed";
const RELEASES_URL = "https://github.com/atlantiqshq/vexlyx/releases";
const UPGRADE_DOCS_URL = "https://docs.vexlyx.atlantiqs.org/guide/operations#upgrading";

/**
 * Admin-only notice that a newer stable release exists, linking to the
 * release notes and the installer-backed upgrade guide. Dismissal is
 * remembered per version, so the next release shows up again.
 */
export function UpdateBanner() {
  const { update, isAdmin } = useSystemUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    setDismissedVersion(window.localStorage.getItem(DISMISSED_KEY));
  }, []);

  if (!isAdmin || !update?.updateAvailable || !update.latestVersion) {
    return null;
  }
  if (dismissedVersion === update.latestVersion) {
    return null;
  }

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, update.latestVersion ?? "");
    setDismissedVersion(update.latestVersion);
  };

  return (
    <div className="px-6 pt-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
        <ArrowUpCircle className="h-4 w-4 shrink-0" />
        <p className="flex-1">
          Vexlyx <strong>{update.latestVersion}</strong> is available — you are running{" "}
          {update.currentVersion}.
        </p>
        <a
          href={update.releaseUrl ?? RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-2"
        >
          Release notes
        </a>
        <a
          href={UPGRADE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-2"
        >
          How to upgrade
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-current hover:bg-amber-500/20"
          onClick={dismiss}
          aria-label="Dismiss update notice"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

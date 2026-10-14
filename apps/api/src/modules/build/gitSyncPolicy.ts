export const INVALID_GIT_URL_CODE = "INVALID_GIT_URL";

/**
 * A failed git sync normally falls back to the files already in the workspace.
 * That is not acceptable when the repository was rejected by the URL policy
 * (the stored URL is no longer one we may fetch from), or when the project is
 * linked to a GitHub installation: building stale files would deploy code from
 * a repository the project no longer legitimately points at.
 */
export function isFatalGitSyncError(err: unknown, hasGitHubInstallation: boolean): boolean {
  if (hasGitHubInstallation) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === INVALID_GIT_URL_CODE
  );
}

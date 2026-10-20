import { spawn } from "node:child_process";

export interface MailSnapshot {
  domains: string[];
  mailboxes: Array<{ address: string; passwordHash: string; quotaMb: number }>;
  aliases: Array<{ source: string; destinations: string[] }>;
}

export class MailStateSyncError extends Error {
  constructor(
    message: string,
    public code: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function reconcileMailState(
  python: string,
  script: string,
  snapshot: () => Promise<MailSnapshot>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, "reconcile_locked"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let started = false;
    let completed = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill();
        reject(error);
      } else resolve();
    };
    const timeout = setTimeout(
      () =>
        finish(
          new MailStateSyncError(
            "Mail synchronization timed out. Retry Synchronize after checking the mail containers.",
            "MAIL_SYNC_TIMEOUT",
          ),
        ),
      // Allow the lock wait, bounded service commands, and both rollback reloads to finish.
      420_000,
    );
    const consume = (line: string) => {
      if (!line.trim() || settled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(
          new MailStateSyncError(
            "Mail synchronization returned an invalid response.",
            "MAIL_SYNC_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        finish(
          new MailStateSyncError(
            "Invalid mail synchronization response.",
            "MAIL_SYNC_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      const frame = parsed as Record<string, unknown>;
      if (typeof frame.error === "string") {
        finish(
          new MailStateSyncError(
            frame.error,
            typeof frame.code === "string" ? frame.code : "MAIL_SYNC_FAILED",
            frame.details &&
              typeof frame.details === "object" &&
              !Array.isArray(frame.details)
              ? (frame.details as Record<string, unknown>)
              : {},
          ),
        );
      } else if (frame.ready === true && !started) {
        started = true;
        // The Python process holds the cross-process lock before the database snapshot is read.
        void snapshot()
          .then((data) => {
            if (settled) return;
            child.stdin.end(JSON.stringify(data) + "\n");
          })
          .catch(() =>
            finish(
              new MailStateSyncError(
                "Could not read the authoritative mail configuration.",
                "MAIL_SYNC_DATABASE_ERROR",
              ),
            ),
          );
      } else if (frame.success === true && started) completed = true;
      else
        finish(
          new MailStateSyncError(
            "Unexpected mail synchronization response.",
            "MAIL_SYNC_PROTOCOL_ERROR",
          ),
        );
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.resume();
    child.stdin.on("error", () =>
      finish(
        new MailStateSyncError(
          "The mail-state process stopped before accepting the configuration.",
          "MAIL_SYNC_PROCESS_ERROR",
        ),
      ),
    );
    child.on("error", () =>
      finish(
        new MailStateSyncError(
          "Cannot start the mail-state synchronizer.",
          "MAIL_SYNC_PROCESS_ERROR",
        ),
      ),
    );
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      if (code === 0 && completed) finish();
      else
        finish(
          new MailStateSyncError(
            "Mail synchronization did not complete. Check the mail containers and retry Synchronize.",
            "MAIL_SYNC_PROCESS_ERROR",
          ),
        );
    });
  });
}

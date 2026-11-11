import { spawn } from "node:child_process";
import { resolvePythonScript } from "../../utils/pythonScript.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import {
  PYTHON_SCRIPT_TIMEOUT_MS,
  watchChildTimeout,
} from "../../utils/processWatchdog.js";
import { MailError } from "./errors.js";

function getPostfixManagerScriptPath(): string {
  return resolvePythonScript("postfix_manager.py", import.meta.url);
}

function getDovecotManagerScriptPath(): string {
  return resolvePythonScript("dovecot_manager.py", import.meta.url);
}

function getWebmailManagerScriptPath(): string {
  return resolvePythonScript("webmail_manager.py", import.meta.url);
}

export async function runPostfixManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getPostfixManagerScriptPath();
  const pythonExe = getPythonBin();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn postfix_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `postfix_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function runDovecotManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getDovecotManagerScriptPath();
  const pythonExe = getPythonBin();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn dovecot_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `dovecot_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function runWebmailManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getWebmailManagerScriptPath();
  const pythonExe = getPythonBin();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn webmail_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `webmail_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

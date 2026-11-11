import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

function isFile(filename: string): boolean {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

/** Discover Windows development installs without binding to a Python version. */
function localWindowsPython(): string | undefined {
  const roots = [
    path.resolve(process.cwd(), "Python"),
    path.resolve(process.cwd(), "apps/api/Python"),
    path.resolve(process.cwd(), "../../apps/api/Python"),
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, "Python")]
      : []),
    ...(process.env.USERPROFILE
      ? [path.join(process.env.USERPROFILE, "AppData/Local/Python")]
      : []),
  ];
  const architecture =
    process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "32" : "64";
  for (const root of new Set(roots)) {
    try {
      const directories = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.endsWith(`-${architecture}`) &&
            /^pythoncore-\d+(?:\.\d+)+-(?:32|64|arm64)$/.test(entry.name),
        )
        .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
      for (const directory of directories) {
        const executable = path.join(root, directory.name, "python.exe");
        if (isFile(executable)) return executable;
      }
    } catch {
      /* Missing or inaccessible install roots: try the next location. */
    }
  }
  return undefined;
}

/** Explicit config wins; Python resolves its own packages from that interpreter. */
export function getPythonBin(): string {
  if (env.PYTHON_BIN) return env.PYTHON_BIN;
  if (process.env.PYTHON_PATH && isFile(process.env.PYTHON_PATH))
    return process.env.PYTHON_PATH;
  return process.platform === "win32"
    ? (localWindowsPython() ?? "python")
    : "python3";
}

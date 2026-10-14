import { env } from "../config/env.js";

/**
 * Interpreter used to run the system/python/*.py scripts.
 *
 * Honors the validated `PYTHON_BIN` setting, otherwise falls back to the
 * platform's conventional name. Every module that spawns a Python script must
 * use this rather than hardcoding "python" (which does not exist on stock
 * Linux hosts, where the binary is `python3`).
 */
export function getPythonBin(): string {
  return env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
}

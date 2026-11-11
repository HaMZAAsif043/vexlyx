import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Preserve the source/build and repo/API working-directory lookup order. */
export function resolvePythonScript(name: string, callerUrl: string): string {
  if (!/^[a-z][a-z0-9_]*\.py$/.test(name))
    throw new Error("Invalid Python helper name");
  const directory = dirname(fileURLToPath(callerUrl));
  const candidates = [
    resolve(directory, "../../../../../system/python", name),
    resolve(directory, "../../../../system/python", name),
    resolve(process.cwd(), "../../system/python", name),
    resolve(process.cwd(), "system/python", name),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

import fs from "node:fs";
import { execFileSync } from "node:child_process";

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function stableNodeExecutable() {
  const override = process.env.CODING_USAGE_BAR_NODE?.trim();
  if (override) {
    if (!override.startsWith("/") || !executable(override)) {
      throw new Error(`CODING_USAGE_BAR_NODE must be an executable absolute path: ${override}`);
    }
    return override;
  }

  let pathNode = "";
  try {
    pathNode = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
  } catch {
    // Fall through to known stable links and the current executable.
  }

  return [pathNode, "/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]
    .find((candidate) => candidate && executable(candidate)) ?? process.execPath;
}

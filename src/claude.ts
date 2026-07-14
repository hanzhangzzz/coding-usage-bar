import fs from "node:fs";
import path from "node:path";
import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { ProviderUsage } from "./types.js";

export function usageFromClaudeStatusLine(input: unknown): ProviderUsage {
  if (input === null || typeof input !== "object") {
    throw new Error("Claude status line input must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const rateLimits = record.rate_limits as Record<string, unknown> | undefined;
  if (!rateLimits || typeof rateLimits !== "object") {
    throw new Error("Claude usage unavailable: status line input has no rate_limits field");
  }

  const fiveHour = normalizeWindow("five_hour", rateLimits.five_hour, 300);
  const sevenDay = normalizeWindow("seven_day", rateLimits.seven_day, 10080);
  if (!fiveHour || !sevenDay) {
    throw new Error("Claude usage unavailable: missing five_hour or seven_day rate limit window");
  }

  return makeProviderUsage({
    provider: "claude",
    source: "claude_statusline_stdin",
    fiveHour,
    sevenDay,
  });
}

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function readClaudeSettings(file: string): Record<string, unknown> | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Cannot read Claude settings at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(contents) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON in Claude settings at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getClaudeStatusLineCommand(settings: Record<string, unknown> | null): string | null {
  const statusLine = settings?.statusLine;
  if (statusLine && typeof statusLine === "object") {
    const command = (statusLine as Record<string, unknown>).command;
    return typeof command === "string" ? command : null;
  }
  return null;
}

function splitShellWords(command: string) {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    words.push(current);
  }
  return words;
}

function statusLineScriptCandidates(command: string) {
  const words = splitShellWords(command);
  const candidates = [command];
  const interpreter = path.basename(words[0] ?? "");
  if (["bash", "sh", "zsh", "node"].includes(interpreter)) {
    for (const word of words.slice(1)) {
      if (word === "-c") {
        break;
      }
      if (word.startsWith("-")) {
        continue;
      }
      candidates.push(word);
      break;
    }
  }
  return [...new Set(candidates)];
}

export function claudeStatusLineHasIngest(
  command: string | null,
  options: { appCliPath: string; managedScriptPath?: string },
) {
  if (!command) {
    return false;
  }
  if (
    command.includes("coding-usage-bar ingest claude-statusline")
    || command.includes(options.appCliPath)
    || command === options.managedScriptPath
  ) {
    return true;
  }
  for (const candidate of statusLineScriptCandidates(command)) {
    try {
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      const script = fs.readFileSync(candidate, "utf8");
      if (script.includes("coding-usage-bar ingest claude-statusline") || script.includes(options.appCliPath)) {
        return true;
      }
    } catch {
      // Ignore command strings that are not readable script paths.
    }
  }
  return false;
}

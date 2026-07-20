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

function stripInlineShellComment(line: string) {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
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
    if (char === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function hasBalancedShellQuotes(line: string) {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
  }
  return quote === null;
}

function executableShellLines(text: string) {
  const result: string[] = [];
  const heredocDelimiters: string[] = [];
  for (const rawLine of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (heredocDelimiters.length > 0) {
      if (rawLine.trim() === heredocDelimiters[0]) {
        heredocDelimiters.shift();
      }
      continue;
    }
    const line = stripInlineShellComment(rawLine);
    const heredocPattern = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\([^\s;|&()<>]+)|([^\s;|&()<>]+))/g;
    const heredocs = [...line.matchAll(heredocPattern)];
    if (heredocs.length > 0) {
      for (const heredoc of heredocs) {
        heredocDelimiters.push(heredoc[1] ?? heredoc[2] ?? heredoc[3] ?? heredoc[4]);
      }
      result.push(line.slice(0, heredocs[0].index));
    } else {
      result.push(line);
    }
  }
  return result;
}

export function claudeStatusLineHasIngest(
  command: string | null,
  options: { appCliPath: string; managedScriptPath?: string },
) {
  const isCliPath = (word: string) => (
    path.basename(word) === "coding-usage-bar"
    || word === options.appCliPath
    || word.endsWith("/.coding-usage-bar/app/dist/cli.js")
  );
  const hasIngestCommand = (text: string) => {
    const lines = executableShellLines(text);
    if (lines.some((line) => !hasBalancedShellQuotes(line))) {
      return false;
    }
    return lines.some((line) => {
      if (!line.trim()) {
        return false;
      }
      const words = splitShellWords(line);
      const commandStarts = [0, ...words.flatMap((word, index) => word === "|" ? [index + 1] : [])];
      return commandStarts.some((start) => {
        const executable = words[start];
        const executableIsNode = ["node", "nodejs"].includes(path.basename(executable ?? ""));
        const cliIndex = executableIsNode ? start + 1 : start;
        const finalArgument = words[cliIndex + 2]?.replace(/[;)]$/, "");
        return isCliPath(words[cliIndex] ?? "")
          && words[cliIndex + 1] === "ingest"
          && finalArgument === "claude-statusline";
      });
    });
  };
  if (!command) {
    return false;
  }
  if (
    hasIngestCommand(command)
    || command === options.managedScriptPath
  ) {
    return true;
  }
  for (const candidate of statusLineScriptCandidates(command)) {
    try {
      if (isCliPath(candidate)) {
        continue;
      }
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      const script = fs.readFileSync(candidate, "utf8");
      if (hasIngestCommand(script)) {
        return true;
      }
    } catch {
      // Ignore command strings that are not readable script paths.
    }
  }
  return false;
}

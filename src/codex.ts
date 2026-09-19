import fs from "node:fs";
import path from "node:path";
import { isDir } from "./fs-util.js";
import { normalizeWindow } from "./usage.js";
import { ProviderUsage, UsageWindow, WindowName } from "./types.js";

interface CodexCandidate {
  usage: ProviderUsage;
  observedMs: number;
}

interface CodexJsonlFile {
  file: string;
  mtimeMs: number;
}

function walkJsonlFiles(dir: string, result: CodexJsonlFile[] = []): CodexJsonlFile[] {
  if (!isDir(dir)) {
    return result;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      walkJsonlFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push({ file: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
    }
  }

  return result;
}

function codexSessionRoots(codexHome: string) {
  return ["sessions", "archived_sessions"]
    .map((name) => path.join(codexHome, name))
    .filter(isDir);
}

function parseObservedMs(raw: unknown, fallbackMs: number) {
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 10_000_000_000 ? raw : raw * 1000;
  }
  return fallbackMs;
}

export function usageFromCodexRateLimits(
  rateLimits: unknown,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  if (rateLimits === null || typeof rateLimits !== "object") {
    return null;
  }
  const record = rateLimits as Record<string, unknown>;
  if (typeof record.limit_name === "string") {
    return null;
  }

  const windows = [record.primary, record.secondary]
    .map((raw): UsageWindow | null => {
      if (raw === null || typeof raw !== "object") {
        return null;
      }
      const rawRecord = raw as Record<string, unknown>;
      const rawWindowMinutes = rawRecord.window_minutes ?? rawRecord.windowMinutes;
      const windowMinutes =
        typeof rawWindowMinutes === "number"
          ? rawWindowMinutes
          : typeof rawWindowMinutes === "string" && rawWindowMinutes.trim() !== ""
            ? Number(rawWindowMinutes)
            : null;
      const name: WindowName | null =
        windowMinutes === 300 ? "five_hour" : windowMinutes === 10080 ? "seven_day" : null;
      return name ? normalizeWindow(name, raw, name === "five_hour" ? 300 : 10080) : null;
    })
    .filter((window): window is UsageWindow => window !== null);

  if (windows.length === 0) {
    return null;
  }

  return {
    provider: "codex",
    source: options.source,
    observedAt: options.observedAt ?? new Date().toISOString(),
    planType: typeof record.plan_type === "string" ? record.plan_type : null,
    windows,
  };
}

const DEFAULT_TAIL_CHUNK_BYTES = 1024 * 1024;

function candidateFromLine(line: string, file: string, fallbackMs: number): CodexCandidate | null {
  if (!line || !line.includes("rate_limits")) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const payload = parsed.payload as Record<string, unknown> | undefined;
    const rateLimits = payload?.rate_limits ?? parsed.rate_limits;
    const observedMs = parseObservedMs(parsed.timestamp ?? parsed.ts, fallbackMs);
    const usage = usageFromCodexRateLimits(rateLimits, {
      source: file,
      observedAt: new Date(observedMs).toISOString(),
    });
    return usage ? { usage, observedMs } : null;
  } catch {
    return null;
  }
}

// Session rollouts of a long-lived Codex session can exceed V8's max string
// length (~512 MiB); readFileSync(file, "utf8") then throws and the newest
// usage silently disappears. Read the file backwards in bounded chunks and stop
// at the first complete line that carries rate_limits.
function latestCandidateFromFile(file: string, chunkBytes: number): CodexCandidate | null {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    let position = stat.size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const readSize = Math.min(chunkBytes, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;

      let lineStart = 0;
      if (position > 0) {
        const newline = combined.indexOf(0x0a);
        if (newline === -1) {
          carry = combined;
          continue;
        }
        carry = combined.subarray(0, newline);
        lineStart = newline + 1;
      } else {
        carry = Buffer.alloc(0);
      }

      const lines = combined.subarray(lineStart).toString("utf8").split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const candidate = candidateFromLine(lines[i]?.trim() ?? "", file, stat.mtimeMs);
        if (candidate) {
          return candidate;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return null;
}

export function collectCodexUsage(
  codexHome = path.join(process.env.HOME ?? "", ".codex"),
  options: { tailChunkBytes?: number } = {},
) {
  const chunkBytes = options.tailChunkBytes ?? DEFAULT_TAIL_CHUNK_BYTES;
  if (!isDir(codexHome)) {
    throw new Error(`Codex usage unavailable: ${codexHome} does not exist`);
  }

  const files = codexSessionRoots(codexHome)
    .flatMap((root) => walkJsonlFiles(root))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  let latest: CodexCandidate | null = null;

  for (const { file, mtimeMs } of files) {
    if (latest && mtimeMs < latest.observedMs) {
      break;
    }
    try {
      const candidate = latestCandidateFromFile(file, chunkBytes);
      if (candidate && (!latest || candidate.observedMs > latest.observedMs)) {
        latest = candidate;
      }
    } catch {
      continue;
    }
  }

  if (!latest) {
    throw new Error(
      "Codex usage unavailable: no local session JSONL entry with payload.rate_limits was found. Run Codex CLI/App once and try again.",
    );
  }

  return latest.usage;
}

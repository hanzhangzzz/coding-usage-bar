import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { ProviderUsage, QwenConfig } from "./types.js";

// Qwen (Alibaba Bailian) exposes no API-key quota endpoint; the official
// Bailian CLI (`bl`, npm package bailian-cli) is the supported producer.
// It owns the console login session (~/.bailian/config.json) and prints the
// quota JSON we parse here. We never touch Alibaba credentials ourselves.
const BL_TIMEOUT_MS = 30_000;

// bl usage token-plan --output json (Token Plan personal: 5h + weekly windows).
export interface QwenTokenPlanUsage {
  per5HourPercentage?: number;
  per5HourResetTime?: number;
  per1WeekPercentage?: number;
  per1WeekResetTime?: number;
}

// bl usage coding-plan --output json (Coding Plan: 5h + weekly + monthly windows).
interface QwenCodingPlanWindow {
  usedQuota?: number;
  totalQuota?: number;
  percentage?: number;
  resetTime?: number;
}

export interface QwenCodingPlanUsage {
  instanceType?: string;
  per5Hour?: QwenCodingPlanWindow;
  perWeek?: QwenCodingPlanWindow;
  perBillMonth?: QwenCodingPlanWindow;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usedPercentFromRatio(ratio: number): number {
  return Math.max(0, Math.min(100, ratio * 100));
}

// Reset times can be omitted by the gateway (same trap as GLM zero-usage
// windows); fall back to the observation time so a real percentage is never
// dropped, and never crash on a missing timestamp.
function resetIso(resetTimeMs: unknown, observedAt: string): string {
  const parsed = asFiniteNumber(resetTimeMs);
  return parsed !== null ? new Date(parsed).toISOString() : observedAt;
}

export function usageFromQwenTokenPlan(
  raw: unknown,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const data = raw as QwenTokenPlanUsage;
  const fiveHourRatio = asFiniteNumber(data.per5HourPercentage);
  const weeklyRatio = asFiniteNumber(data.per1WeekPercentage);
  if (fiveHourRatio === null || weeklyRatio === null) {
    return null;
  }

  const observedAt = options.observedAt ?? new Date().toISOString();
  const fiveHour = normalizeWindow("five_hour", {
    used_percent: usedPercentFromRatio(fiveHourRatio),
    resets_at: resetIso(data.per5HourResetTime, observedAt),
  }, 300);
  const sevenDay = normalizeWindow("seven_day", {
    used_percent: usedPercentFromRatio(weeklyRatio),
    resets_at: resetIso(data.per1WeekResetTime, observedAt),
  }, 10080);
  if (!fiveHour || !sevenDay) {
    return null;
  }

  return makeProviderUsage({
    provider: "qwen",
    source: options.source,
    observedAt,
    planType: "token-plan",
    fiveHour,
    sevenDay,
  });
}

// Prefer the ready-made ratio; derive it from counts when only counts exist.
// Both signals absent means no data for the window, never 0%.
function codingPlanUsedPercent(window: QwenCodingPlanWindow | undefined): number | null {
  if (!window) {
    return null;
  }
  const ratio = asFiniteNumber(window.percentage);
  if (ratio !== null) {
    return usedPercentFromRatio(ratio);
  }
  const total = asFiniteNumber(window.totalQuota);
  const used = asFiniteNumber(window.usedQuota);
  if (total !== null && total > 0 && used !== null) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  return null;
}

export function usageFromQwenCodingPlan(
  raw: unknown,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const data = raw as QwenCodingPlanUsage;
  const fiveHourPercent = codingPlanUsedPercent(data.per5Hour);
  const weeklyPercent = codingPlanUsedPercent(data.perWeek);
  if (fiveHourPercent === null || weeklyPercent === null) {
    return null;
  }

  const observedAt = options.observedAt ?? new Date().toISOString();
  const fiveHour = normalizeWindow("five_hour", {
    used_percent: fiveHourPercent,
    resets_at: resetIso(data.per5Hour?.resetTime, observedAt),
  }, 300);
  const sevenDay = normalizeWindow("seven_day", {
    used_percent: weeklyPercent,
    resets_at: resetIso(data.perWeek?.resetTime, observedAt),
  }, 10080);
  if (!fiveHour || !sevenDay) {
    return null;
  }

  return makeProviderUsage({
    provider: "qwen",
    source: options.source,
    observedAt,
    planType: data.instanceType ? `coding-plan ${data.instanceType}` : "coding-plan",
    fiveHour,
    sevenDay,
  });
}

// launchd strips the interactive PATH, so scan the usual install prefixes too.
function candidateBinDirs(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".npm-global", "bin"),
  );
  return [...new Set(dirs)];
}

export function resolveBlBinary(
  config: QwenConfig | undefined,
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string | null {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? "";
  if (config?.blPath) {
    return fs.existsSync(config.blPath) ? config.blPath : null;
  }
  for (const dir of candidateBinDirs(env, homeDir)) {
    const candidate = path.join(dir, "bl");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// bl may prepend banner/update lines; recover the JSON object leniently.
export function parseBlJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// bl reports failures as exit code != 0 plus a JSON envelope on stderr:
// {"error":{"code":3,"message":"No console access token found.","hint":"Run `bl auth login --console`."}}
export class QwenBlError extends Error {
  readonly isAuth: boolean;

  constructor(message: string, isAuth: boolean) {
    super(message);
    this.name = "QwenBlError";
    this.isAuth = isAuth;
  }
}

export function describeBlFailure(plan: string, stdout: string, stderr: string, fallback: string): QwenBlError {
  const envelope = parseBlJson(stderr) ?? parseBlJson(stdout);
  const error = (envelope as { error?: { message?: unknown; hint?: unknown } } | null)?.error;
  const message = typeof error?.message === "string" ? error.message : null;
  const hint = typeof error?.hint === "string" ? error.hint : null;
  const detail = [message, hint].filter(Boolean).join(" ")
    || stderr.trim()
    || stdout.trim()
    || fallback;
  // A missing or expired console session is the common case and is actionable;
  // probing the other plan would only repeat the same failure.
  const isAuth = /access token|not logged in|login|unauthor/i.test(detail);
  return new QwenBlError(`bl usage ${plan} failed: ${detail}`, isAuth);
}

function runBlUsage(binary: string, plan: "token-plan" | "coding-plan"): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["usage", plan, "--output", "json"],
      {
        timeout: BL_TIMEOUT_MS,
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(describeBlFailure(plan, `${stdout ?? ""}`, `${stderr ?? ""}`, error.message));
          return;
        }
        resolve(parseBlJson(stdout ?? ""));
      },
    );
  });
}

export async function collectQwenUsage(config: QwenConfig = {}): Promise<ProviderUsage> {
  const binary = resolveBlBinary(config);
  if (!binary) {
    throw new Error(
      "Bailian CLI (bl) not found. Install with npm install -g bailian-cli, then run bl auth login --console.",
    );
  }

  const plan = config.plan ?? "auto";
  const plans: Array<"token-plan" | "coding-plan"> =
    plan === "token-plan" ? ["token-plan"] : plan === "coding-plan" ? ["coding-plan"] : ["token-plan", "coding-plan"];

  const failures: string[] = [];
  for (const candidate of plans) {
    let raw: unknown | null;
    try {
      raw = await runBlUsage(binary, candidate);
    } catch (error) {
      if (error instanceof QwenBlError && error.isAuth) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!failures.includes(message)) {
        failures.push(message);
      }
      continue;
    }
    const usage = candidate === "token-plan"
      ? usageFromQwenTokenPlan(raw, { source: `${binary} usage token-plan` })
      : usageFromQwenCodingPlan(raw, { source: `${binary} usage coding-plan` });
    if (usage) {
      return usage;
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join(" | "));
  }
  throw new Error(
    "No active Qwen Token Plan / Coding Plan subscription data returned by bl. Verify with bl usage token-plan or bl usage coding-plan.",
  );
}

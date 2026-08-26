import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { buildPaths, installedAssetPath } from "./paths.js";
import { BurnAnalysis, RuntimePaths } from "./types.js";
import { formatDurationUntil } from "./format.js";
import { writeNotificationCard } from "./card.js";

interface NotificationRecord {
  state: string;
  notifiedAt?: string;
  resetAt?: string;
}

type NotificationState = Record<string, NotificationRecord>;

// State is keyed by provider. Legacy records were keyed `provider:state` and
// re-notified on a cooldown, which spammed osascript spawns all day; dropping
// those keys makes each provider re-notify once after upgrade, then follow the
// transition-based rules.
function readNotificationState(paths: RuntimePaths): NotificationState {
  const raw = readJsonFile<NotificationState>(paths.notificationStateFile) ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.includes(":")));
}

export function commandExists(command: string) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function notificationBackend() {
  if (process.platform === "darwin") {
    return commandExists("terminal-notifier") ? "terminal-notifier" : "osascript";
  }
  if (process.platform === "win32") {
    return "burnt-toast";
  }
  return commandExists("notify-send") ? "notify-send" : "unsupported";
}

function cooldownMinutes(profile: "low" | "high") {
  return profile === "high" ? 15 : 30;
}

// Notify only on a state transition or when the 5h window resets while the
// alert persists — never on a periodic cooldown. The cooldown only acts as a
// per-provider floor between notifications so a flapping state cannot spam.
export function shouldNotify(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
) {
  if (analysis.state === "RAW" || analysis.state === "ON_TRACK") {
    return false;
  }
  const previous = readNotificationState(paths)[analysis.provider];
  if (!previous) {
    return true;
  }
  if (previous.state === analysis.state) {
    const resetAt = analysis.fiveHour?.resetsAt;
    const sameWindow = !previous.resetAt || !resetAt || previous.resetAt === resetAt;
    if (sameWindow) {
      return false;
    }
  }
  if (!previous.notifiedAt) {
    return true;
  }
  const elapsedMinutes = (now.getTime() - Date.parse(previous.notifiedAt)) / 60_000;
  return elapsedMinutes >= cooldownMinutes(analysis.profile);
}

export function markNotified(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
) {
  const state = readNotificationState(paths);
  writeJsonAtomic(paths.notificationStateFile, {
    ...state,
    [analysis.provider]: {
      state: analysis.state,
      notifiedAt: now.toISOString(),
      resetAt: analysis.fiveHour?.resetsAt,
    },
  });
}

// Record recovery so the next entry into an alert state counts as a transition
// and notifies again. Keeps notifiedAt so the anti-flap floor still applies.
export function markRecovered(analysis: BurnAnalysis, paths: RuntimePaths = buildPaths()) {
  if (analysis.state !== "ON_TRACK") {
    return;
  }
  const state = readNotificationState(paths);
  const previous = state[analysis.provider];
  if (!previous || previous.state === "ON_TRACK") {
    return;
  }
  writeJsonAtomic(paths.notificationStateFile, {
    ...state,
    [analysis.provider]: { ...previous, state: "ON_TRACK" },
  });
}

function notificationText(analysis: BurnAnalysis) {
  const provider = analysis.provider === "claude" ? "Claude" : analysis.provider === "glm" ? "GLM" : analysis.provider === "minimax" ? "MiniMax" : analysis.provider === "deepseek" ? "DeepSeek" : analysis.provider === "kimi" ? "Kimi" : analysis.provider === "qwen" ? "Qwen" : "Codex";
  const suffix = analysis.fiveHour ? `剩 ${formatDurationUntil(analysis.fiveHour.resetsAt)} 重置。` : "";
  if (analysis.state === "UNDER_BURN") {
    return {
      title: `Coding Usage Bar: ${provider} 节奏偏慢`,
      message: `${analysis.message} ${suffix}`.trim(),
    };
  }
  if (analysis.state === "OVER_BURN") {
    return {
      title: `Coding Usage Bar: ${provider} 节奏过快`,
      message: `${analysis.message} ${suffix}`.trim(),
    };
  }
  return {
    title: `Coding Usage Bar: ${provider} 接近限额`,
    message: `${analysis.message} ${suffix}`.trim(),
  };
}

export function iconForAnalysis(analysis: BurnAnalysis) {
  if (analysis.state === "UNDER_BURN") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-under.png");
  }
  if (analysis.state === "OVER_BURN") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-over.png");
  }
  if (analysis.state === "LIMIT_RISK") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-limit.png");
  }
  return installedAssetPath(os.homedir(), "coding-usage-bar-ok.png");
}

function iconUrl(iconPath: string) {
  return pathToFileURL(iconPath).toString();
}

export function sendNotification(analysis: BurnAnalysis, dryRun = false) {
  const backend = notificationBackend();
  const { title, message } = notificationText(analysis);
  const appIcon = iconForAnalysis(analysis);
  if (dryRun) {
    return `[dry-run] ${backend}: dynamic-card ${title} - ${message}`;
  }

  if (backend === "terminal-notifier") {
    const args = ["-title", title, "-message", message, "-group", `coding-usage-bar.${analysis.provider}`];
    const cardPath = writeNotificationCard(analysis);
    if (existsSync(cardPath)) {
      args.push("-contentImage", iconUrl(cardPath));
    }
    if (existsSync(appIcon)) {
      args.push("-appIcon", iconUrl(appIcon));
    }
    execFileSync("terminal-notifier", args);
    return `${backend}: ${title}`;
  }
  if (backend === "osascript") {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
    return `${backend}: ${title}`;
  }
  if (backend === "notify-send") {
    execFileSync("notify-send", [title, message]);
    return `${backend}: ${title}`;
  }
  if (os.platform() === "win32") {
    throw new Error("Windows notification unavailable: install PowerShell module BurntToast.");
  }
  throw new Error("Desktop notification unavailable on this platform.");
}

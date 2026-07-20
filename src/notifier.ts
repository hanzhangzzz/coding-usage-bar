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
  notifiedAt: string;
  resetAt?: string;
}

type NotificationState = Record<string, NotificationRecord>;

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

function notificationKey(analysis: BurnAnalysis) {
  return `${analysis.provider}:${analysis.state}`;
}

export function shouldNotify(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
) {
  if (analysis.state === "RAW" || analysis.state === "ON_TRACK") {
    return false;
  }
  const state = readJsonFile<NotificationState>(paths.notificationStateFile) ?? {};
  const key = notificationKey(analysis);
  const previous = state[key];
  const resetAt = analysis.fiveHour?.resetsAt;
  if (!previous) {
    return true;
  }
  if (previous.resetAt && resetAt && previous.resetAt !== resetAt) {
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
  const state = readJsonFile<NotificationState>(paths.notificationStateFile) ?? {};
  state[notificationKey(analysis)] = {
    notifiedAt: now.toISOString(),
    resetAt: analysis.fiveHour?.resetsAt,
  };
  writeJsonAtomic(paths.notificationStateFile, state);
}

function notificationText(analysis: BurnAnalysis) {
  const provider = analysis.provider === "claude" ? "Claude" : analysis.provider === "glm" ? "GLM" : analysis.provider === "minimax" ? "MiniMax" : analysis.provider === "deepseek" ? "DeepSeek" : analysis.provider === "kimi" ? "Kimi" : "Codex";
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

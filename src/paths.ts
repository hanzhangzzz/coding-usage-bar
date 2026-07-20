import os from "node:os";
import path from "node:path";
import { RuntimePaths, ProviderId } from "./types.js";

export function buildPaths(homeDir = os.homedir()): RuntimePaths {
  const stateDir = path.join(homeDir, ".coding-usage-bar");
  return {
    homeDir,
    stateDir,
    configFile: path.join(stateDir, "config.json"),
    claudeDir: path.join(stateDir, "claude"),
    codexDir: path.join(stateDir, "codex"),
    glmDir: path.join(stateDir, "glm"),
    deepseekDir: path.join(stateDir, "deepseek"),
    minimaxDir: path.join(stateDir, "minimax"),
    kimiDir: path.join(stateDir, "kimi"),
    notificationStateFile: path.join(stateDir, "notifications.json"),
    statusFile: path.join(stateDir, "status.json"),
    starPromptFile: path.join(stateDir, "star-prompt.json"),
    cliBinDir: path.join(homeDir, ".local", "bin"),
    cliBinFile: path.join(homeDir, ".local", "bin", "coding-usage-bar"),
    swiftBarPluginDir: path.join(homeDir, "Library", "Application Support", "SwiftBar", "Plugins"),
    swiftBarPluginFile: path.join(homeDir, "Library", "Application Support", "SwiftBar", "Plugins", "coding-usage-bar.1m.js"),
    launchAgentFile: path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.duying.coding-usage-bar.plist",
    ),
    claudeSettingsFile: path.join(homeDir, ".claude", "settings.json"),
    claudeStatusLineScript: path.join(stateDir, "claude", "statusline.sh"),
  };
}

export function installedAssetPath(homeDir: string, assetName: string) {
  return path.join(homeDir, ".coding-usage-bar", "app", "assets", assetName);
}

function providerDir(paths: RuntimePaths, provider: ProviderId): string {
  if (provider === "glm") return paths.glmDir;
  if (provider === "deepseek") return paths.deepseekDir;
  if (provider === "minimax") return paths.minimaxDir;
  if (provider === "kimi") return paths.kimiDir;
  if (provider === "claude") return paths.claudeDir;
  return paths.codexDir;
}

export function providerLatestPath(paths: RuntimePaths, provider: ProviderId) {
  return path.join(providerDir(paths, provider), "latest.json");
}

export function providerSamplesPath(paths: RuntimePaths, provider: ProviderId) {
  return path.join(providerDir(paths, provider), "samples.jsonl");
}

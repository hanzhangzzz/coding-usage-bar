import fs from "node:fs";
import path from "node:path";
import { readConfig } from "./config.js";
import { collectCodexUsage } from "./codex.js";
import { claudeStatusLineHasIngest, getClaudeStatusLineCommand, readClaudeSettings } from "./claude.js";
import { isDir, isFile } from "./fs-util.js";
import { resolveKimiConfig } from "./kimi.js";
import { buildPaths, providerLatestPath } from "./paths.js";
import { notificationBackend } from "./notifier.js";
import { isSwiftBarInstalled, isSwiftBarRunning, swiftBarPluginPath } from "./menubar.js";
import { DoctorCheck } from "./types.js";

function stableClaudeIngestHint() {
  const paths = buildPaths();
  return `printf "%s" "$input" | node "${paths.stateDir}/app/dist/cli.js" ingest claude-statusline >/dev/null`;
}

function pathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function isManagedCliShim() {
  const paths = buildPaths();
  try {
    return fs.lstatSync(paths.cliBinFile).isSymbolicLink()
      && path.resolve(path.dirname(paths.cliBinFile), fs.readlinkSync(paths.cliBinFile))
        === path.join(paths.stateDir, "app", "dist", "cli.js");
  } catch {
    return false;
  }
}

export function runDoctor(options: { dryRun?: boolean } = {}): DoctorCheck[] {
  const paths = buildPaths();
  const config = readConfig(paths);
  const monitored = new Set(config.providers);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "Runtime directory",
    ok: options.dryRun ? true : isDir(paths.stateDir),
    message: options.dryRun ? `[dry-run] would use ${paths.stateDir}` : paths.stateDir,
  });

  const cliBinInPath = pathEntries().includes(paths.cliBinDir);
  checks.push({
    name: "CLI command",
    ok: options.dryRun ? true : isManagedCliShim() && cliBinInPath,
    message: options.dryRun
      ? `[dry-run] would link ${paths.cliBinFile}`
      : cliBinInPath
        ? `${paths.cliBinFile}`
        : `${paths.cliBinFile}; add ${paths.cliBinDir} to PATH to use coding-usage-bar directly`,
  });

  checks.push({
    name: "Configured providers",
    ok: true,
    message: `${config.providers.join(", ")} (${paths.configFile})`,
  });

  if (monitored.has("codex")) {
    try {
      const usage = collectCodexUsage(path.join(paths.homeDir, ".codex"));
      checks.push({
        name: "Codex usage",
        ok: true,
        message: `latest rate_limits observed at ${usage.observedAt}`,
      });
    } catch (error) {
      checks.push({
        name: "Codex usage",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      name: "Codex usage",
      ok: true,
      message: "disabled by config",
    });
  }

  const claudeLatest = providerLatestPath(paths, "claude");
  if (monitored.has("claude")) {
    checks.push({
      name: "Claude usage cache",
      ok: isFile(claudeLatest),
      message: isFile(claudeLatest)
        ? `found ${claudeLatest}`
        : `missing ${claudeLatest}; add Claude status line ingest, e.g. ${stableClaudeIngestHint()}`,
    });

    const settings = readClaudeSettings(paths.claudeSettingsFile);
    const command = getClaudeStatusLineCommand(settings);
    checks.push({
      name: "Claude status line",
      ok: claudeStatusLineHasIngest(command, {
        appCliPath: path.join(paths.stateDir, "app", "dist", "cli.js"),
        managedScriptPath: paths.claudeStatusLineScript,
      }),
      message: command
        ? `configured: ${command}`
        : "not configured; coding-usage-bar install can create a minimal collector if no status line exists",
    });
  } else {
    checks.push({
      name: "Claude usage cache",
      ok: true,
      message: "disabled by config",
    });
  }

  if (monitored.has("glm")) {
    const hasApiKey = Boolean(config.glm?.apiKey);
    checks.push({
      name: "GLM API key",
      ok: hasApiKey,
      message: hasApiKey
        ? "configured"
        : "not set; edit ~/.coding-usage-bar/config.json to set glm.apiKey",
    });

    const glmLatest = providerLatestPath(paths, "glm");
    checks.push({
      name: "GLM usage cache",
      ok: !hasApiKey || isFile(glmLatest),
      message: isFile(glmLatest)
        ? `found ${glmLatest}`
        : hasApiKey
          ? `missing ${glmLatest}; run coding-usage-bar daemon --once to collect`
          : "skipped (API key not set)",
    });
  } else {
    checks.push({
      name: "GLM",
      ok: true,
      message: "disabled by config",
    });
  }

  if (monitored.has("deepseek")) {
    const hasApiKey = Boolean(config.deepseek?.apiKey);
    checks.push({
      name: "DeepSeek API key",
      ok: hasApiKey,
      message: hasApiKey
        ? "configured"
        : "not set; edit ~/.coding-usage-bar/config.json to set deepseek.apiKey",
    });

    const deepseekLatest = providerLatestPath(paths, "deepseek");
    checks.push({
      name: "DeepSeek balance cache",
      ok: !hasApiKey || isFile(deepseekLatest),
      message: isFile(deepseekLatest)
        ? `found ${deepseekLatest}`
        : hasApiKey
          ? `missing ${deepseekLatest}; run coding-usage-bar daemon --once to collect`
          : "skipped (API key not set)",
    });
  } else {
    checks.push({
      name: "DeepSeek",
      ok: true,
      message: "disabled by config",
    });
  }

  if (monitored.has("minimax")) {
    const hasApiKey = Boolean(config.minimax?.apiKey);
    checks.push({
      name: "MiniMax API key",
      ok: hasApiKey,
      message: hasApiKey
        ? `configured (region: ${config.minimax?.region ?? "cn"})`
        : "not set; edit ~/.coding-usage-bar/config.json to set minimax.apiKey",
    });

    const minimaxLatest = providerLatestPath(paths, "minimax");
    checks.push({
      name: "MiniMax usage cache",
      ok: !hasApiKey || isFile(minimaxLatest),
      message: isFile(minimaxLatest)
        ? `found ${minimaxLatest}`
        : hasApiKey
          ? `missing ${minimaxLatest}; run coding-usage-bar daemon --once to collect`
          : "skipped (API key not set)",
    });
  } else {
    checks.push({
      name: "MiniMax",
      ok: true,
      message: "disabled by config",
    });
  }

  if (monitored.has("kimi")) {
    const kimiConfig = resolveKimiConfig(config.kimi, paths.homeDir);
    const hasApiKey = Boolean(kimiConfig.apiKey);
    const keySource = config.kimi?.apiKey
      ? "coding-usage-bar config"
      : "claude-lanes config.env";
    checks.push({
      name: "Kimi API key",
      ok: hasApiKey,
      message: hasApiKey
        ? `configured (${keySource})`
        : "not set; edit ~/.coding-usage-bar/config.json to set kimi.apiKey, or configure a kimi.com lane in ~/.config/claude-lanes/config.env",
    });

    const kimiLatest = providerLatestPath(paths, "kimi");
    checks.push({
      name: "Kimi usage cache",
      ok: !hasApiKey || isFile(kimiLatest),
      message: isFile(kimiLatest)
        ? `found ${kimiLatest}`
        : hasApiKey
          ? `missing ${kimiLatest}; run coding-usage-bar daemon --once to collect`
          : "skipped (API key not set)",
    });
  } else {
    checks.push({
      name: "Kimi",
      ok: true,
      message: "disabled by config",
    });
  }

  const backend = notificationBackend();
  const notificationOk = backend !== "unsupported" && backend !== "burnt-toast";
  checks.push({
    name: "Notification",
    ok: notificationOk,
    message:
      backend === "burnt-toast"
        ? "Windows design target: install PowerShell module BurntToast with Install-Module BurntToast -Scope CurrentUser"
        : `backend=${backend}`,
  });

  checks.push({
    name: "Daemon",
    ok: process.platform === "darwin" ? fs.existsSync(paths.launchAgentFile) || Boolean(options.dryRun) : false,
    message:
      process.platform === "darwin"
        ? options.dryRun
          ? `[dry-run] would use ${paths.launchAgentFile}`
          : paths.launchAgentFile
        : "daemon install is only implemented for macOS launchd in v1",
  });

  const swiftBarInstalled = isSwiftBarInstalled();
  const swiftBarPlugin = swiftBarPluginPath(paths);
  const pluginPresent = swiftBarInstalled && isFile(swiftBarPlugin.file);
  const swiftBarRunning = pluginPresent && isSwiftBarRunning();
  checks.push({
    name: "Menu bar",
    ok: pluginPresent,
    message: swiftBarInstalled
      ? isFile(swiftBarPlugin.file)
        ? swiftBarRunning
          ? `SwiftBar plugin installed and SwiftBar running: ${swiftBarPlugin.file}`
          : `SwiftBar plugin installed but SwiftBar is not running (menu bar item hidden); run: open -a SwiftBar`
        : `SwiftBar found; run coding-usage-bar menubar install`
      : "SwiftBar not found; install SwiftBar, then run coding-usage-bar menubar install",
  });

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]) {
  return checks
    .map((check) => `${check.ok ? "OK" : "MISSING"}  ${check.name}: ${check.message}`)
    .join("\n");
}

export function doctorHasFailures(checks: DoctorCheck[]) {
  return checks.some((check) => !check.ok);
}

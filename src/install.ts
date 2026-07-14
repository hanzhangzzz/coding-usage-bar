import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeStatusLineHasIngest, getClaudeStatusLineCommand, readClaudeSettings } from "./claude.js";
import { ensureConfig, readConfig } from "./config.js";
import { ensureDir, isFile, readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { addSwiftBarToLoginItems, ensureSwiftBarInstalled, installMenuBar, openSwiftBar, uninstallMenuBar } from "./menubar.js";
import { buildPaths } from "./paths.js";
import { stableNodeExecutable } from "./node-runtime.js";
import { RuntimePaths, BurnConfig } from "./types.js";

export const LAUNCHD_LABEL = "com.duying.coding-usage-bar";
const MARKER = "coding-usage-bar managed";

interface StatusLineUpdateContext {
  existingCommand: string;
  wrapperScript: string;
  originalCommandFile: string;
  stableIngestCommand: string;
}

interface ClaudeStatusLineInstallOptions {
  dryRun: boolean;
  confirmStatusLineUpdate?: (context: StatusLineUpdateContext) => boolean;
}

interface OriginalStatusLineMetadata {
  statusLine?: unknown;
}

function appInstallDir(paths: RuntimePaths) {
  return path.join(paths.stateDir, "app");
}

function appCliPath(paths: RuntimePaths) {
  return path.join(appInstallDir(paths), "dist", "cli.js");
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stableIngestCommand(paths: RuntimePaths) {
  return `${shellSingleQuote(stableNodeExecutable())} ${shellSingleQuote(appCliPath(paths))} ingest claude-statusline`;
}

function originalStatusLineFile(paths: RuntimePaths) {
  return path.join(paths.claudeDir, "statusline-original.json");
}

function originalStatusLineFromMetadata(paths: RuntimePaths) {
  const metadata = readJsonFile<OriginalStatusLineMetadata>(originalStatusLineFile(paths));
  const statusLine = metadata?.statusLine;
  if (statusLine && typeof statusLine === "object") {
    const command = (statusLine as Record<string, unknown>).command;
    if (typeof command === "string") {
      return statusLine as Record<string, unknown>;
    }
  }
  return null;
}

function currentPackageRoot() {
  const entry = fs.realpathSync(process.argv[1]);
  return path.resolve(path.dirname(entry), "..");
}

export function isSameDirectory(left: string, right: string) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) {
    return false;
  }
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  return leftStat.isDirectory()
    && rightStat.isDirectory()
    && leftStat.dev === rightStat.dev
    && leftStat.ino === rightStat.ino;
}

function installRuntimeApp(paths: RuntimePaths, dryRun: boolean) {
  const packageRoot = currentPackageRoot();
  const sourceDist = path.join(packageRoot, "dist");
  const sourceAssets = path.join(packageRoot, "assets");
  const sourceFixtures = path.join(packageRoot, "fixtures");
  const target = appInstallDir(paths);
  const tmpTarget = path.join(paths.stateDir, `app.${process.pid}.tmp`);
  if (dryRun) {
    return [`[dry-run] would copy ${sourceDist}, ${sourceAssets}, and ${sourceFixtures} -> ${target}`];
  }
  if (isSameDirectory(packageRoot, target)) {
    return [`Runtime app already installed: ${target}`];
  }
  if (!fs.existsSync(sourceDist)) {
    throw new Error(`Cannot install runtime app: missing built dist at ${sourceDist}`);
  }
  fs.rmSync(tmpTarget, { recursive: true, force: true });
  ensureDir(tmpTarget);
  fs.cpSync(sourceDist, path.join(tmpTarget, "dist"), { recursive: true });
  if (fs.existsSync(sourceAssets)) {
    fs.cpSync(sourceAssets, path.join(tmpTarget, "assets"), { recursive: true });
  }
  if (fs.existsSync(sourceFixtures)) {
    fs.cpSync(sourceFixtures, path.join(tmpTarget, "fixtures"), { recursive: true });
  }
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(tmpTarget, "package.json"));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmpTarget, target);
  return [`Installed runtime app: ${target}`];
}

function installedCliCommand(paths: RuntimePaths) {
  return [stableNodeExecutable(), appCliPath(paths)];
}

function installedCliShimTarget(paths: RuntimePaths) {
  return appCliPath(paths);
}

function pathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function isManagedCliShim(paths: RuntimePaths) {
  try {
    return fs.lstatSync(paths.cliBinFile).isSymbolicLink()
      && path.resolve(path.dirname(paths.cliBinFile), fs.readlinkSync(paths.cliBinFile)) === installedCliShimTarget(paths);
  } catch {
    return false;
  }
}

function pathExists(file: string) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function installCliShim(paths: RuntimePaths, dryRun: boolean) {
  const target = installedCliShimTarget(paths);
  const binInPath = pathEntries().includes(paths.cliBinDir);

  if (dryRun) {
    const pathMessage = binInPath
      ? `${paths.cliBinDir} is already in PATH`
      : `${paths.cliBinDir} is not in PATH; add it to use coding-usage-bar directly`;
    return [`[dry-run] would link ${paths.cliBinFile} -> ${target}`, `[dry-run] ${pathMessage}`];
  }

  ensureDir(paths.cliBinDir);
  if (pathExists(paths.cliBinFile)) {
    if (isManagedCliShim(paths)) {
      fs.rmSync(paths.cliBinFile, { force: true });
    } else {
      return [`CLI shim already exists and is not managed by coding-usage-bar: ${paths.cliBinFile}`];
    }
  }

  fs.symlinkSync(target, paths.cliBinFile);
  const messages = [`Installed CLI shim: ${paths.cliBinFile} -> ${target}`];
  if (!binInPath) {
    messages.push(`Add ${paths.cliBinDir} to PATH to use coding-usage-bar directly.`);
  }
  return messages;
}

function plistXml(programArgs: string[]) {
  const args = programArgs
    .map((arg) => `        <string>${arg.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
        <string>daemon</string>
        <string>--once</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>${path.join(os.homedir(), ".coding-usage-bar", "daemon.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(os.homedir(), ".coding-usage-bar", "daemon.err.log")}</string>
</dict>
</plist>
`;
}

function restartLaunchAgent(plistFile: string) {
  const domain = `gui/${process.getuid?.() ?? ""}`;
  try {
    execFileSync("launchctl", ["bootout", domain, plistFile], { stdio: "ignore" });
  } catch {
    // Not loaded yet or old launchctl behavior.
  }

  try {
    execFileSync("launchctl", ["bootstrap", domain, plistFile]);
    execFileSync("launchctl", ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
    return;
  } catch {
    // Fall back to the older interface used on older macOS versions.
  }

  try {
    execFileSync("launchctl", ["unload", plistFile], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }
  execFileSync("launchctl", ["load", plistFile]);
}

type LaunchctlRunner = (file: string, args: string[], options?: { stdio?: "ignore" }) => unknown;

export function stopLaunchAgent(plistFile: string, run: LaunchctlRunner = execFileSync) {
  const domain = `gui/${process.getuid?.() ?? ""}`;
  let bootoutError: unknown;
  try {
    run("launchctl", ["bootout", domain, plistFile], { stdio: "ignore" });
    return;
  } catch (error) {
    bootoutError = error;
  }

  try {
    run("launchctl", ["unload", plistFile], { stdio: "ignore" });
  } catch {
    // Verify below whether a job still exists before deciding the failure is safe.
  }

  try {
    run("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  } catch {
    return;
  }
  throw new Error(`Could not stop launchd agent ${LAUNCHD_LABEL}: ${bootoutError instanceof Error ? bootoutError.message : String(bootoutError)}`);
}

function wrapperStatusLineScript(existingCommand: string, stableIngestCommand: string) {
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER} Claude status line wrapper`,
    `ORIGINAL_COMMAND=${shellSingleQuote(existingCommand)}`,
    'input="$(cat)"',
    `printf "%s" "$input" | ${stableIngestCommand} >/dev/null 2>&1 || true`,
    'printf "%s" "$input" | /bin/sh -c "$ORIGINAL_COMMAND"',
    "",
  ].join("\n");
}

function manualClaudeStatusLineMessages(stableIngestCommand: string) {
  return [
    "Add this near the top of your existing status line script:",
    '  input="$(cat)"',
    `  printf "%s" "$input" | ${stableIngestCommand} >/dev/null`,
    "Then make the rest of your script read from $input instead of stdin.",
    "Without this, Claude usage will stay unavailable in Coding Usage Bar; Claude burn-rate analysis, Claude notifications, and Claude menu bar data will show CLAUDE_INGEST_MISSING. Codex usage is unaffected.",
  ];
}

function defaultConfirmStatusLineUpdate(context: StatusLineUpdateContext) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const prompt = [
    "Coding Usage Bar detected an existing Claude status line command.",
    `Existing command: ${context.existingCommand}`,
    "If you continue, Coding Usage Bar will:",
    `  - write a wrapper script: ${context.wrapperScript}`,
    `  - save the original command metadata: ${context.originalCommandFile}`,
    "  - update Claude settings so the wrapper runs first",
    "  - collect Claude usage, then forward the same input to your existing command",
    "Continue? [y/N] ",
  ].join("\n");

  try {
    const answer = execFileSync(
      "/bin/sh",
      [
        "-c",
        'printf "%s" "$1" > /dev/tty; IFS= read -r answer < /dev/tty; printf "%s" "$answer"',
        "coding-usage-bar-prompt",
        prompt,
      ],
      { encoding: "utf8" },
    ).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}

export function installClaudeStatusLine(paths: RuntimePaths, options: ClaudeStatusLineInstallOptions) {
  const dryRun = options.dryRun;
  const settings = readClaudeSettings(paths.claudeSettingsFile);
  const existing = getClaudeStatusLineCommand(settings);
  const ingestCommand = stableIngestCommand(paths);

  if (claudeStatusLineHasIngest(existing, {
    appCliPath: appCliPath(paths),
    managedScriptPath: paths.claudeStatusLineScript,
  })) {
    return ["Claude status line already includes coding-usage-bar ingest."];
  }

  if (existing) {
    const context = {
      existingCommand: existing,
      wrapperScript: paths.claudeStatusLineScript,
      originalCommandFile: originalStatusLineFile(paths),
      stableIngestCommand: ingestCommand,
    };

    if (dryRun) {
      return [
        "Claude status line already exists.",
        `[dry-run] would ask whether to wrap the existing command: ${existing}`,
        `[dry-run] would write wrapper script: ${paths.claudeStatusLineScript}`,
        `[dry-run] would save original command metadata: ${context.originalCommandFile}`,
        `[dry-run] would update statusLine.command in ${paths.claudeSettingsFile}`,
        ...manualClaudeStatusLineMessages(ingestCommand),
      ];
    }

    const confirmed = (options.confirmStatusLineUpdate ?? defaultConfirmStatusLineUpdate)(context);
    if (!confirmed) {
      return [
        "Skipped Claude status line update.",
        ...manualClaudeStatusLineMessages(ingestCommand),
      ];
    }

    ensureDir(path.dirname(paths.claudeStatusLineScript));
    writeJsonAtomic(context.originalCommandFile, {
      statusLine: settings?.statusLine ?? { type: "command", command: existing },
    });
    fs.writeFileSync(paths.claudeStatusLineScript, wrapperStatusLineScript(existing, ingestCommand), { mode: 0o755 });
    writeJsonAtomic(paths.claudeSettingsFile, {
      ...(settings ?? {}),
      statusLine: {
        ...((settings?.statusLine && typeof settings.statusLine === "object") ? settings.statusLine : {}),
        type: "command",
        command: paths.claudeStatusLineScript,
      },
    });
    return [`Updated Claude status line script: ${paths.claudeStatusLineScript}`];
  }

  const lines = [`# ${MARKER}`, 'input="$(cat)"', `printf "%s" "$input" | ${ingestCommand} >/dev/null`, 'printf "Coding Usage Bar ready"'];
  const script = `${lines.join("\n")}\n`;
  const newSettings = {
    ...(settings ?? {}),
    statusLine: {
      type: "command",
      command: paths.claudeStatusLineScript,
      padding: 0,
    },
  };

  if (dryRun) {
    return [
      `[dry-run] would create ${paths.claudeStatusLineScript}`,
      `[dry-run] would write statusLine.command to ${paths.claudeSettingsFile}`,
    ];
  }

  ensureDir(path.dirname(paths.claudeStatusLineScript));
  fs.writeFileSync(paths.claudeStatusLineScript, script, { mode: 0o755 });
  writeJsonAtomic(paths.claudeSettingsFile, newSettings);
  return [`Created Claude status line collector: ${paths.claudeStatusLineScript}`];
}

export function install(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const messages: string[] = [];

  if (process.platform !== "darwin") {
    messages.push("macOS launchd install is only implemented on macOS. Windows support is designed but not implemented in v1.");
    return messages;
  }

  if (!dryRun) {
    ensureDir(paths.stateDir);
    ensureDir(path.dirname(paths.launchAgentFile));
  }

  messages.push(...installRuntimeApp(paths, dryRun));
  messages.push(...installCliShim(paths, dryRun));
  if (dryRun) {
    messages.push(`[dry-run] would ensure config file: ${paths.configFile}`);
  } else if (ensureConfig(paths)) {
    messages.push(`Created config file: ${paths.configFile}`);
  }

  if (!dryRun) {
    const config = readConfig(paths);
    if (!config.glm?.apiKey) {
      messages.push("");
      messages.push("To enable GLM Coding Plan monitoring:");
      messages.push("  Edit ~/.coding-usage-bar/config.json and set glm.apiKey to your Zhipu API key.");
      messages.push("  Get your key at: https://open.bigmodel.cn");
    }
  }
  messages.push(...ensureSwiftBarInstalled({ dryRun }));
  messages.push(...installMenuBar({ dryRun }));
  if (!dryRun) {
    messages.push(...openSwiftBar());
  }
  messages.push(...addSwiftBarToLoginItems({ dryRun }));
  messages.push(...installClaudeStatusLine(paths, { dryRun }));

  const args = installedCliCommand(paths);
  const xml = plistXml(args);
  if (dryRun) {
    messages.push(`[dry-run] would write launchd plist: ${paths.launchAgentFile}`);
    messages.push(`[dry-run] ProgramArguments: ${[...args, "daemon", "--once"].join(" ")}`);
    return messages;
  }

  fs.writeFileSync(paths.launchAgentFile, xml, "utf8");
  restartLaunchAgent(paths.launchAgentFile);
  messages.push(`Installed and restarted launchd agent: ${paths.launchAgentFile}`);
  return messages;
}

export function uninstall(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const messages: string[] = [];

  if (process.platform === "darwin" && isFile(paths.launchAgentFile)) {
    if (dryRun) {
      messages.push(`[dry-run] would unload and remove ${paths.launchAgentFile}`);
    } else {
      stopLaunchAgent(paths.launchAgentFile);
      fs.rmSync(paths.launchAgentFile, { force: true });
      messages.push(`Removed launchd agent: ${paths.launchAgentFile}`);
    }
  }

  if (isManagedCliShim(paths)) {
    if (dryRun) {
      messages.push(`[dry-run] would remove CLI shim ${paths.cliBinFile}`);
    } else {
      fs.rmSync(paths.cliBinFile, { force: true });
      messages.push(`Removed CLI shim: ${paths.cliBinFile}`);
    }
  } else if (isFile(paths.cliBinFile)) {
    messages.push(`CLI shim is user-managed; leaving it unchanged: ${paths.cliBinFile}`);
  }

  messages.push(...uninstallMenuBar({ dryRun }));

  const settings = readClaudeSettings(paths.claudeSettingsFile);
  const existing = getClaudeStatusLineCommand(settings);
  if (existing === paths.claudeStatusLineScript && settings) {
    const originalStatusLine = originalStatusLineFromMetadata(paths);
    if (dryRun) {
      if (originalStatusLine) {
        messages.push(`[dry-run] would restore user-managed statusLine.command in ${paths.claudeSettingsFile}`);
      } else {
        messages.push(`[dry-run] would remove coding-usage-bar statusLine from ${paths.claudeSettingsFile}`);
      }
    } else {
      if (originalStatusLine) {
        settings.statusLine = originalStatusLine;
      } else {
        delete settings.statusLine;
      }
      writeJsonAtomic(paths.claudeSettingsFile, settings);
      fs.rmSync(paths.claudeStatusLineScript, { force: true });
      fs.rmSync(originalStatusLineFile(paths), { force: true });
      messages.push(originalStatusLine ? "Restored user-managed Claude status line." : "Removed coding-usage-bar managed Claude status line.");
    }
  } else if (existing) {
    messages.push("Claude status line is user-managed; leaving it unchanged.");
  }

  return messages.length ? messages : ["Nothing to uninstall."];
}

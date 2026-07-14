#!/usr/bin/env node
import { usageFromClaudeStatusLine, readStdin } from "./claude.js";
import { install, uninstall } from "./install.js";
import { saveUsage } from "./store.js";
import { formatStatusRows, formatAnalysisDetail, formatIssues, formatProviderMeta } from "./format.js";
import { loadDisplayStatusSnapshot, collectStatusSnapshot } from "./runtime.js";
import { runDaemonOnce } from "./daemon.js";
import { doctorHasFailures, formatDoctor, runDoctor } from "./doctor.js";
import { installMenuBar, renderMenuBar, uninstallMenuBar, toggleCompactMode } from "./menubar.js";
import { buildPaths } from "./paths.js";
import { maybePromptForStar } from "./star.js";

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function printHelp() {
  console.log(`Coding Usage Bar

Usage:
  coding-usage-bar install [--dry-run]
  coding-usage-bar uninstall [--dry-run]
  coding-usage-bar doctor [--dry-run]
  coding-usage-bar status [--fixtures] [--json] [--refresh]
  coding-usage-bar menubar render
  coding-usage-bar menubar install [--dry-run]
  coding-usage-bar menubar uninstall [--dry-run]
  coding-usage-bar menubar toggle-compact
  coding-usage-bar ingest claude-statusline
  coding-usage-bar daemon [--once] [--dry-run]
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];
  const dryRun = hasFlag(args, "--dry-run");

  try {
    if (!command || command === "-h" || command === "--help") {
      printHelp();
      return;
    }

    if (command === "install") {
      const messages = install({ dryRun });
      console.log(messages.join("\n"));
      if (messages.some((message) => message.startsWith("Installed and restarted launchd agent:"))) {
        const starMessages = maybePromptForStar(buildPaths(), { dryRun, env: process.env });
        if (starMessages.length > 0) {
          console.log(starMessages.join("\n"));
        }
      }
      return;
    }

    if (command === "uninstall") {
      console.log(uninstall({ dryRun }).join("\n"));
      return;
    }

    if (command === "doctor") {
      const checks = runDoctor({ dryRun });
      console.log(formatDoctor(checks));
      if (doctorHasFailures(checks)) {
        process.exitCode = 1;
      }
      return;
    }

    if (command === "status") {
      const fixtures = hasFlag(args, "--fixtures");
      const json = hasFlag(args, "--json");
      const refresh = hasFlag(args, "--refresh");
      const snapshot = refresh || fixtures
        ? await collectStatusSnapshot({ fixtures })
        : loadDisplayStatusSnapshot();
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      const usages = snapshot.providers.map((provider) => provider.usage);
      const analyses = snapshot.providers.map((provider) => provider.analysis);
      console.log(formatStatusRows(usages, analyses));
      console.log("");
      for (const analysis of analyses) {
        console.log(formatAnalysisDetail(analysis));
      }
      const meta = formatProviderMeta(snapshot);
      if (meta) {
        console.log("");
        console.log(meta);
      }
      const issues = formatIssues(snapshot.issues);
      if (issues) {
        console.log("");
        console.log(issues);
      }
      return;
    }

    if (command === "menubar" && subcommand === "render") {
      console.log(renderMenuBar());
      return;
    }

    if (command === "menubar" && subcommand === "install") {
      console.log(installMenuBar({ dryRun }).join("\n"));
      return;
    }

    if (command === "menubar" && subcommand === "uninstall") {
      console.log(uninstallMenuBar({ dryRun }).join("\n"));
      return;
    }

    if (command === "menubar" && subcommand === "toggle-compact") {
      const isCompact = toggleCompactMode();
      console.log(isCompact ? "Compact" : "Expanded");
      return;
    }

    if (command === "ingest" && subcommand === "claude-statusline") {
      const input = await readStdin();
      const parsed = JSON.parse(input);
      const usage = usageFromClaudeStatusLine(parsed);
      saveUsage(usage);
      return;
    }

    if (command === "daemon") {
      console.log((await runDaemonOnce({ dryRun })).join("\n"));
      return;
    }

    throw new Error(`Unknown command: ${args.join(" ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();

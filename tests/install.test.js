import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPaths } from "../dist/paths.js";
import { installClaudeStatusLine, isSameDirectory, stopLaunchAgent, uninstall } from "../dist/install.js";
import { writeJsonAtomic } from "../dist/fs-util.js";
import { stableNodeExecutable } from "../dist/node-runtime.js";

function createCustomStatusLine(home) {
  const paths = buildPaths(home);
  const script = path.join(home, "custom-statusline.sh");
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(script, "#!/usr/bin/env bash\nprintf \"custom\"\n", { mode: 0o755 });
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: {
      type: "command",
      command: script,
    },
  });
  return { paths, script };
}

test("isSameDirectory recognizes a symlinked HOME path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-path-"));
  const target = path.join(root, "target");
  const alias = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias);
  assert.equal(isSameDirectory(target, alias), true);
});

test("installClaudeStatusLine wraps custom status line after confirmation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const { paths, script } = createCustomStatusLine(home);

  const messages = installClaudeStatusLine(paths, {
    dryRun: false,
    confirmStatusLineUpdate: () => true,
  });

  const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, "utf8"));
  const wrapper = fs.readFileSync(paths.claudeStatusLineScript, "utf8");
  assert.equal(settings.statusLine.command, paths.claudeStatusLineScript);
  assert.equal(fs.readFileSync(script, "utf8"), "#!/usr/bin/env bash\nprintf \"custom\"\n");
  assert.match(wrapper, /ingest claude-statusline/);
  assert.match(wrapper, /ORIGINAL_COMMAND=/);
  assert.match(wrapper, /\/bin\/sh -c "\$ORIGINAL_COMMAND"/);
  assert.ok(messages.some((message) => message.includes("Updated Claude status line script")));
});

test("installClaudeStatusLine quotes generated ingest command in wrapper", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding usage bar install-"));
  const { paths } = createCustomStatusLine(home);

  installClaudeStatusLine(paths, {
    dryRun: false,
    confirmStatusLineUpdate: () => true,
  });

  const wrapper = fs.readFileSync(paths.claudeStatusLineScript, "utf8");
  assert.match(wrapper, new RegExp(`\\| '${stableNodeExecutable().replaceAll("'", "'\\\\''")}' '`));
  assert.match(wrapper, /\/\.coding-usage-bar\/app\/dist\/cli\.js'/);
});

test("installClaudeStatusLine detects integrated scripts invoked through an interpreter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const paths = buildPaths(home);
  const script = path.join(home, "custom-statusline.sh");
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(script, "#!/usr/bin/env bash\ncoding-usage-bar ingest claude-statusline\n", { mode: 0o755 });
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: {
      type: "command",
      command: `bash ${script}`,
    },
  });

  const messages = installClaudeStatusLine(paths, {
    dryRun: false,
    confirmStatusLineUpdate: () => {
      throw new Error("should not prompt when script already contains ingest");
    },
  });

  assert.deepEqual(messages, ["Claude status line already includes coding-usage-bar ingest."]);
  assert.equal(fs.existsSync(paths.claudeStatusLineScript), false);
});

test("installClaudeStatusLine skips custom script when confirmation is rejected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const { paths, script } = createCustomStatusLine(home);

  const messages = installClaudeStatusLine(paths, {
    dryRun: false,
    confirmStatusLineUpdate: () => false,
  });

  assert.equal(fs.readFileSync(script, "utf8"), "#!/usr/bin/env bash\nprintf \"custom\"\n");
  assert.equal(fs.existsSync(`${script}.coding-usage-bar.bak`), false);
  assert.ok(messages.some((message) => message.includes("Skipped Claude status line update.")));
  assert.ok(messages.some((message) => message.includes("Claude usage will stay unavailable")));
});

test("installClaudeStatusLine refuses to overwrite invalid Claude settings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const paths = buildPaths(home);
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, "{ invalid json", "utf8");

  assert.throws(
    () => installClaudeStatusLine(paths, { dryRun: false }),
    /Invalid JSON in Claude settings/,
  );
  assert.equal(fs.readFileSync(paths.claudeSettingsFile, "utf8"), "{ invalid json");
  assert.equal(fs.existsSync(paths.claudeStatusLineScript), false);
});

test("stopLaunchAgent uses modern bootout and accepts an absent job", () => {
  const calls = [];
  const run = (_file, args) => {
    calls.push(args);
    throw new Error("not loaded");
  };

  stopLaunchAgent("/tmp/coding-usage-bar.plist", run);
  assert.deepEqual(calls.map((args) => args[0]), ["bootout", "unload", "print"]);
});

test("stopLaunchAgent exposes failure when the job remains loaded", () => {
  const run = (_file, args) => {
    if (args[0] === "print") {
      return;
    }
    throw new Error("permission denied");
  };

  assert.throws(
    () => stopLaunchAgent("/tmp/coding-usage-bar.plist", run),
    /Could not stop launchd agent/,
  );
});

test("uninstall restores wrapped custom status line command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const { paths, script } = createCustomStatusLine(home);
  fs.mkdirSync(path.dirname(paths.launchAgentFile), { recursive: true });
  fs.writeFileSync(paths.launchAgentFile, "plist", "utf8");

  installClaudeStatusLine(paths, {
    dryRun: false,
    confirmStatusLineUpdate: () => true,
  });

  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.CODING_USAGE_BAR_PLUGIN_DIR;
  process.env.HOME = home;
  // Sandbox the SwiftBar plugin dir so uninstall can't touch the real menubar plugin.
  process.env.CODING_USAGE_BAR_PLUGIN_DIR = path.join(home, "swiftbar");
  try {
    const messages = uninstall({ dryRun: false });
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, "utf8"));
    assert.equal(settings.statusLine.command, script);
    assert.ok(messages.some((message) => message.includes("Restored user-managed Claude status line.")));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPluginDir === undefined) {
      delete process.env.CODING_USAGE_BAR_PLUGIN_DIR;
    } else {
      process.env.CODING_USAGE_BAR_PLUGIN_DIR = originalPluginDir;
    }
  }
});

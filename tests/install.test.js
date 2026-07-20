import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPaths } from "../dist/paths.js";
import { installClaudeStatusLine, isSameDirectory, stopLaunchAgent, uninstall } from "../dist/install.js";
import { writeJsonAtomic } from "../dist/fs-util.js";
import { stableNodeExecutable } from "../dist/node-runtime.js";
import { claudeStatusLineHasIngest } from "../dist/claude.js";

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
  fs.writeFileSync(
    script,
    '#!/usr/bin/env bash\nnode "$HOME/.coding-usage-bar/app/dist/cli.js" ingest claude-statusline\n',
    { mode: 0o755 },
  );
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

test("installClaudeStatusLine ignores comments and wrong coding-usage-bar subcommands", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-install-"));
  const paths = buildPaths(home);
  const script = path.join(home, "custom-statusline.sh");
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      '# node "$HOME/.coding-usage-bar/app/dist/cli.js" ingest claude-statusline',
      'node "$HOME/.coding-usage-bar/app/dist/cli.js" status',
    ].join("\n"),
    { mode: 0o755 },
  );
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: { type: "command", command: `bash ${script}` },
  });

  const messages = installClaudeStatusLine(paths, { dryRun: true });

  assert.ok(messages.some((message) => message.includes("would ask whether to wrap")));
  assert.ok(!messages.some((message) => message.includes("already includes coding-usage-bar ingest")));
});

test("claudeStatusLineHasIngest requires an executable ingest command position", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-ingest-detect-"));
  const cli = path.join(home, ".coding-usage-bar", "app", "dist", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'const help = "ingest claude-statusline";\n', "utf8");
  const detects = (command) => claudeStatusLineHasIngest(command, { appCliPath: cli });

  assert.equal(detects(`node "${cli}" ingest claude-statusline`), true);
  assert.equal(detects(`printf input | node "${cli}" ingest claude-statusline;`), true);
  assert.equal(detects(`printf input | \\\nnode "${cli}" ingest claude-statusline`), true);
  assert.equal(detects(`node "${cli}" status`), false);
  assert.equal(detects(`echo ready # node "${cli}" ingest claude-statusline`), false);
  assert.equal(detects(`echo node "${cli}" ingest claude-statusline`), false);
  assert.equal(detects(`printf node "${cli}" ingest claude-statusline`), false);
  assert.equal(detects(`false && node "${cli}" ingest claude-statusline`), false);
  assert.equal(detects(`node "${cli}.bak" ingest claude-statusline`), false);
  assert.equal(detects(`cat <<'EOF'\nnode "${cli}" ingest claude-statusline\nEOF`), false);
  assert.equal(detects(`cat <<123\nnode "${cli}" ingest claude-statusline\n123`), false);
  assert.equal(detects(`cat <<'END-MARK'\nnode "${cli}" ingest claude-statusline\nEND-MARK`), false);
  assert.equal(detects(`cat <<\\EOF\nnode "${cli}" ingest claude-statusline\nEOF`), false);
  assert.equal(detects(`cat <<ONE <<TWO\nignored\nONE\nnode "${cli}" ingest claude-statusline\nTWO`), false);
  assert.equal(detects(`printf '%s\nnode "${cli}" ingest claude-statusline\n' text`), false);
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
    const launchctlCalls = [];
    const messages = uninstall({
      dryRun: false,
      launchctlRunner: (_file, args) => {
        launchctlCalls.push(args);
        if (args[0] === "bootout") {
          return;
        }
        throw new Error(`unexpected launchctl call: ${args.join(" ")}`);
      },
    });
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, "utf8"));
    assert.equal(settings.statusLine.command, script);
    assert.ok(messages.some((message) => message.includes("Restored user-managed Claude status line.")));
    assert.deepEqual(launchctlCalls.map((args) => args[0]), ["bootout"]);
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

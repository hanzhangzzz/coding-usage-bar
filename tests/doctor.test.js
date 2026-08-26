import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { doctorHasFailures, runDoctor } from "../dist/doctor.js";
import { buildPaths } from "../dist/paths.js";
import { writeJsonAtomic } from "../dist/fs-util.js";

test("runDoctor accepts custom Claude status line scripts containing coding-usage-bar ingest", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-doctor-"));
  const paths = buildPaths(home);
  const script = path.join(home, "custom-statusline.sh");
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(script, `#!/usr/bin/env bash\nnode "${paths.stateDir}/app/dist/cli.js" ingest claude-statusline\n`, "utf8");
  writeJsonAtomic(paths.configFile, { providers: ["claude"] });
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: {
      type: "command",
      command: script,
    },
  });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const checks = runDoctor({ dryRun: true });
    const statusLine = checks.find((check) => check.name === "Claude status line");
    assert.equal(statusLine?.ok, true);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("runDoctor accepts integrated scripts invoked through an interpreter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-doctor-"));
  const paths = buildPaths(home);
  const script = path.join(home, "custom-statusline.sh");
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(
    script,
    '#!/usr/bin/env bash\nnode "$HOME/.coding-usage-bar/app/dist/cli.js" ingest claude-statusline\n',
    "utf8",
  );
  writeJsonAtomic(paths.configFile, { providers: ["claude"] });
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: {
      type: "command",
      command: `bash ${script}`,
    },
  });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const checks = runDoctor({ dryRun: true });
    const statusLine = checks.find((check) => check.name === "Claude status line");
    assert.equal(statusLine?.ok, true);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("runDoctor rejects comment-only and wrong-subcommand ingest references", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-doctor-"));
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
    "utf8",
  );
  writeJsonAtomic(paths.configFile, { providers: ["claude"] });
  writeJsonAtomic(paths.claudeSettingsFile, {
    statusLine: { type: "command", command: `bash ${script}` },
  });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const checks = runDoctor({ dryRun: true });
    const statusLine = checks.find((check) => check.name === "Claude status line");
    assert.equal(statusLine?.ok, false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctorHasFailures reports any failed check", () => {
  assert.equal(doctorHasFailures([
    { name: "Runtime directory", ok: true, message: "ok" },
    { name: "Menu bar", ok: false, message: "SwiftBar plugin missing" },
  ]), true);
  assert.equal(doctorHasFailures([
    { name: "Runtime directory", ok: true, message: "ok" },
  ]), false);
});

// --- runDoctorFix and the new checks ----------------------------------------
// Effects are injected so the suite never launches SwiftBar, writes plugin
// files, or collects provider data for real.

import { runDoctorFix } from "../dist/doctor.js";

function spyEffects() {
  const calls = [];
  return {
    calls,
    effects: {
      installSwiftBar: () => { calls.push("installSwiftBar"); return ["Installed SwiftBar with Homebrew cask."]; },
      installPlugin: () => { calls.push("installPlugin"); return ["Installed SwiftBar plugin"]; },
      launchSwiftBar: () => { calls.push("launchSwiftBar"); return ["Opened SwiftBar."]; },
      addLoginItem: () => { calls.push("addLoginItem"); return ["Added SwiftBar to login items"]; },
      collectStatus: async () => { calls.push("collectStatus"); return ["Daemon ran once"]; },
    },
  };
}

test("runDoctorFix dry-run only announces", async () => {
  assert.deepEqual(
    await runDoctorFix({ dryRun: true }),
    ["[dry-run] would repair SwiftBar, the menu bar plugin, login items, and status data automatically"],
  );
});

test("runDoctorFix does nothing when everything is healthy", async () => {
  const { calls, effects } = spyEffects();
  const messages = await runDoctorFix({
    probes: {
      swiftBarInstalled: () => true,
      pluginPresent: () => true,
      swiftBarRunning: () => true,
      swiftBarInLoginItems: () => true,
      statusFilePresent: () => true,
    },
    effects,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(messages, []);
});

test("runDoctorFix repairs every detected failure exactly once", async () => {
  const { calls, effects } = spyEffects();
  // Stateful: SwiftBar reads as absent until the install effect succeeds,
  // mirroring the real fs check against a cask that just landed.
  let swiftBarInstalled = false;
  const messages = await runDoctorFix({
    probes: {
      swiftBarInstalled: () => swiftBarInstalled,
      pluginPresent: () => false,
      swiftBarRunning: () => false,
      swiftBarInLoginItems: () => false,
      statusFilePresent: () => false,
    },
    effects: {
      ...effects,
      installSwiftBar: () => {
        calls.push("installSwiftBar");
        swiftBarInstalled = true;
        return ["Installed SwiftBar with Homebrew cask."];
      },
    },
  });
  assert.deepEqual(calls, ["installSwiftBar", "installPlugin", "launchSwiftBar", "addLoginItem", "collectStatus"]);
  assert.ok(messages.some((message) => message.includes("Installed SwiftBar plugin")));
  assert.ok(messages.some((message) => message.includes("Daemon ran once")));
});

test("runDoctorFix skips the launch when SwiftBar cannot be installed", async () => {
  const { calls, effects } = spyEffects();
  await runDoctorFix({
    probes: {
      swiftBarInstalled: () => false,
      pluginPresent: () => false,
      swiftBarRunning: () => false,
      swiftBarInLoginItems: () => null,
      statusFilePresent: () => true,
    },
    effects,
  });
  assert.deepEqual(calls, ["installSwiftBar", "installPlugin"]);
});

test("runDoctorFix leaves an unknown login-item state alone", async () => {
  const { calls, effects } = spyEffects();
  await runDoctorFix({
    probes: {
      swiftBarInstalled: () => true,
      pluginPresent: () => true,
      swiftBarRunning: () => true,
      swiftBarInLoginItems: () => null,
      statusFilePresent: () => true,
    },
    effects,
  });
  assert.deepEqual(calls, []);
});

test("runDoctor reports new checks in dry-run without touching the host", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-doctor-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const checks = runDoctor({ dryRun: true });
    const loginItem = checks.find((check) => check.name === "SwiftBar login item");
    assert.equal(loginItem?.ok, true);
    assert.match(loginItem?.message ?? "", /\[dry-run\]/);
    const statusData = checks.find((check) => check.name === "Status data");
    assert.equal(statusData?.ok, true);
    assert.match(statusData?.message ?? "", /\[dry-run\]/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

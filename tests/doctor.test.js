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

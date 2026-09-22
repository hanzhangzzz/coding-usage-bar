import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("qwen-check queries only Qwen and succeeds with state writes forbidden", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-check-"));
  try {
    const bl = path.join(dir, "bl");
    fs.writeFileSync(bl, '#!/bin/sh\nprintf \'%s\\n\' \'{"per5HourPercentage":0.25,"per1WeekPercentage":0.5}\'\n', { mode: 0o755 });
    const guard = path.join(dir, "no-writes.mjs");
    fs.writeFileSync(guard, `import fs from "node:fs";
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"]) {
  fs[name] = () => { throw new Error("trial attempted state write: " + name); };
}
`);
    const result = spawnSync(process.execPath, ["--import", guard, cli, "qwen-check"], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.provider, "qwen");
    assert.equal(data.windows[0].usedPercent, 25);
    assert.equal(data.windows[1].usedPercent, 50);
    assert.equal(data.source, undefined);
    assert.ok(!result.stdout.includes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qwen-check returns the CLI auth failure instead of reporting an empty success", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-check-error-"));
  try {
    fs.writeFileSync(path.join(dir, "bl"), '#!/bin/sh\nprintf \'%s\\n\' \'{"error":{"message":"No console access token found.","hint":"Run bl auth login --console."}}\' >&2\nexit 1\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [cli, "qwen-check"], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bl auth login --console/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

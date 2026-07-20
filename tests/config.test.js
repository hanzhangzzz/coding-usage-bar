import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, ensureConfig, readConfig } from "../dist/config.js";
import { buildPaths } from "../dist/paths.js";
import { writeJsonAtomic } from "../dist/fs-util.js";

test("readConfig defaults to all supported providers", () => {
  assert.deepEqual(defaultConfig().providers, ["codex", "claude", "glm", "deepseek", "minimax", "kimi"]);
});

test("readConfig supports provider selection from config file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-config-"));
  const paths = buildPaths(home);
  writeJsonAtomic(paths.configFile, { providers: ["codex"] });

  assert.deepEqual(readConfig(paths).providers, ["codex"]);
});

test("ensureConfig creates default config once", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-config-"));
  const paths = buildPaths(home);

  assert.equal(ensureConfig(paths), true);
  assert.equal(ensureConfig(paths), false);
  assert.deepEqual(readConfig(paths).providers, ["codex", "claude", "glm", "deepseek", "minimax", "kimi"]);
});

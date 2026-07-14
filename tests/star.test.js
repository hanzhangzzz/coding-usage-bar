import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPaths } from "../dist/paths.js";
import { ghAuthStatusArgs, ghStarArgs, isStarConsent, maybePromptForStar } from "../dist/star.js";

test("GitHub star prompt requires explicit consent", () => {
  assert.equal(isStarConsent(""), false);
  assert.equal(isStarConsent("n"), false);
  assert.equal(isStarConsent("y"), true);
  assert.equal(isStarConsent("YES"), true);
});

test("maybePromptForStar asks once and stars Coding Usage Bar when accepted", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-star-"));
  const paths = buildPaths(home);
  const prompts = [];
  const starredRepos = [];

  const messages = maybePromptForStar(paths, {
    dryRun: false,
    isInteractive: true,
    env: {},
    canStarWithGh: true,
    confirmStar: (prompt) => {
      prompts.push(prompt);
      return true;
    },
    starRepo: (repo) => {
      starredRepos.push(repo);
    },
  });

  assert.deepEqual(starredRepos, ["hanzhangzzz/coding-usage-bar"]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Enjoying Coding Usage Bar\? Star it on GitHub\? \[y\/N\]/);
  assert.ok(messages.some((message) => message.includes("Starred Coding Usage Bar on GitHub.")));
  assert.equal(JSON.parse(fs.readFileSync(paths.starPromptFile, "utf8")).response, "accepted");

  maybePromptForStar(paths, {
    dryRun: false,
    isInteractive: true,
    env: {},
    confirmStar: () => {
      throw new Error("should not prompt twice");
    },
    starRepo: () => {
      throw new Error("should not star twice");
    },
  });
});

test("maybePromptForStar records declined prompts without calling gh", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-star-"));
  const paths = buildPaths(home);

  const messages = maybePromptForStar(paths, {
    dryRun: false,
    isInteractive: true,
    env: {},
    canStarWithGh: true,
    confirmStar: () => false,
    starRepo: () => {
      throw new Error("should not star when declined");
    },
  });

  assert.ok(messages.some((message) => message.includes("Skipped GitHub star prompt.")));
  assert.equal(JSON.parse(fs.readFileSync(paths.starPromptFile, "utf8")).response, "declined");
});

test("ghStarArgs uses GitHub API because gh has no repo star subcommand", () => {
  assert.deepEqual(ghStarArgs("hanzhangzzz/coding-usage-bar"), [
    "api",
    "--method",
    "PUT",
    "/user/starred/hanzhangzzz/coding-usage-bar",
    "--silent",
  ]);
});

test("ghAuthStatusArgs checks login before asking for a star", () => {
  assert.deepEqual(ghAuthStatusArgs(), ["auth", "status", "-h", "github.com"]);
});

test("maybePromptForStar skips when gh is missing or not logged in", () => {
  for (const preflight of [false, () => false]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-star-"));
    const paths = buildPaths(home);

    const messages = maybePromptForStar(paths, {
      dryRun: false,
      isInteractive: true,
      canStarWithGh: preflight,
      confirmStar: () => {
        throw new Error("should not ask when gh preflight fails");
      },
      starRepo: () => {
        throw new Error("should not call gh when preflight fails");
      },
    });

    assert.deepEqual(messages, []);
    assert.equal(fs.existsSync(paths.starPromptFile), false);
  }
});

test("maybePromptForStar retries when the previous star attempt failed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-star-"));
  const paths = buildPaths(home);
  fs.mkdirSync(path.dirname(paths.starPromptFile), { recursive: true });
  fs.writeFileSync(paths.starPromptFile, JSON.stringify({
    repo: "hanzhangzzz/coding-usage-bar",
    promptedAt: "2026-05-13T00:00:00.000Z",
    response: "accepted",
    outcome: "failed",
    error: "Command failed: gh repo star hanzhangzzz/coding-usage-bar",
  }));

  let prompted = false;
  let starred = false;
  maybePromptForStar(paths, {
    dryRun: false,
    isInteractive: true,
    env: {},
    canStarWithGh: true,
    confirmStar: () => {
      prompted = true;
      return true;
    },
    starRepo: () => {
      starred = true;
    },
  });

  assert.equal(prompted, true);
  assert.equal(starred, true);
});

test("maybePromptForStar skips dry-run, CI, and non-interactive installs", () => {
  for (const options of [
    { dryRun: true, isInteractive: true, env: {} },
    { dryRun: false, isInteractive: false, env: {} },
    { dryRun: false, isInteractive: true, env: { CI: "true" } },
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-star-"));
    const paths = buildPaths(home);

    const messages = maybePromptForStar(paths, {
      ...options,
      confirmStar: () => {
        throw new Error("should not prompt");
      },
      starRepo: () => {
        throw new Error("should not star");
      },
    });

    assert.deepEqual(messages, []);
    assert.equal(fs.existsSync(paths.starPromptFile), false);
  }
});

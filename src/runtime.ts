import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import { collectCodexUsage } from "./codex.js";
import { readJsonFile } from "./fs-util.js";
import { collectGlmUsage } from "./glm.js";
import { collectDeepseekUsage } from "./deepseek.js";
import { collectKimiUsage, resolveKimiConfig } from "./kimi.js";
import { collectMinimaxUsage } from "./minimax.js";
import { buildPaths } from "./paths.js";
import { loadLatestUsage, loadSamples, saveUsage } from "./store.js";
import { BurnAnalysis, BurnProfile, ProviderUsage, RuntimePaths, StatusIssue, StatusSnapshot } from "./types.js";
import {
  createStatusSnapshot,
  loadStatusSnapshot,
  refreshStatusSnapshotFreshness,
  saveStatusSnapshot,
} from "./status.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

export function loadFixtureUsages(fixturesDir: string): ProviderUsage[] {
  const providers = ["claude", "codex", "glm", "deepseek", "minimax", "kimi"] as const;
  return providers
    .map((provider) => readJsonFile<ProviderUsage>(path.join(fixturesDir, provider, "latest.json")))
    .filter((item): item is ProviderUsage => item !== null);
}

export async function collectLocalState(options: { fixtures?: boolean } = {}): Promise<{
  usages: ProviderUsage[];
  issues: StatusIssue[];
}> {
  if (options.fixtures) {
    return { usages: loadFixtureUsages(FIXTURES_DIR), issues: [] };
  }

  const paths = buildPaths();
  const config = readConfig(paths);
  const monitored = new Set(config.providers);
  const usages: ProviderUsage[] = [];
  const issues: StatusIssue[] = [];

  if (monitored.has("codex")) {
    try {
      const codex = collectCodexUsage(path.join(paths.homeDir, ".codex"));
      saveUsage(codex, paths);
      usages.push(codex);
    } catch (error) {
      const cached = loadLatestUsage("codex", paths);
      if (cached) {
        usages.push(cached);
        issues.push({
          provider: "codex",
          severity: "warning",
          code: "CODEX_USING_CACHE",
          message: `Codex live usage unavailable; using cached usage from ${cached.observedAt}. ${error instanceof Error ? error.message : String(error)}`,
        });
      } else {
        issues.push({
          provider: "codex",
          severity: "error",
          code: "CODEX_USAGE_MISSING",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (monitored.has("claude")) {
    const claude = loadLatestUsage("claude", paths);
    if (claude) {
      usages.push(claude);
    } else {
      issues.push({
        provider: "claude",
        severity: "warning",
        code: "CLAUDE_INGEST_MISSING",
        message: "Claude usage missing; add Coding Usage Bar ingest to Claude Code statusLine.command or remove claude from ~/.coding-usage-bar/config.json providers.",
      });
    }
  }

  if (monitored.has("glm")) {
    const glmConfig = config.glm;
    if (!glmConfig?.apiKey) {
      issues.push({
        provider: "glm",
        severity: "warning",
        code: "GLM_API_KEY_MISSING",
        message: "GLM API key not configured. Edit ~/.coding-usage-bar/config.json to set glm.apiKey.",
      });
    } else {
      try {
        const glm = await collectGlmUsage(glmConfig);
        saveUsage(glm, paths);
        usages.push(glm);
      } catch (error) {
        const cached = loadLatestUsage("glm", paths);
        if (cached) {
          usages.push(cached);
          issues.push({
            provider: "glm",
            severity: "warning",
            code: "GLM_USING_CACHE",
            message: `GLM live usage unavailable; using cached usage from ${cached.observedAt}. ${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          issues.push({
            provider: "glm",
            severity: "error",
            code: "GLM_USAGE_MISSING",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  if (monitored.has("deepseek")) {
    const deepseekConfig = config.deepseek;
    if (!deepseekConfig?.apiKey) {
      issues.push({
        provider: "deepseek",
        severity: "warning",
        code: "DEEPSEEK_API_KEY_MISSING",
        message: "DeepSeek API key not configured. Edit ~/.coding-usage-bar/config.json to set deepseek.apiKey.",
      });
    } else {
      try {
        const deepseek = await collectDeepseekUsage(deepseekConfig);
        saveUsage(deepseek, paths);
        usages.push(deepseek);
      } catch (error) {
        const cached = loadLatestUsage("deepseek", paths);
        if (cached) {
          usages.push(cached);
          issues.push({
            provider: "deepseek",
            severity: "warning",
            code: "DEEPSEEK_USING_CACHE",
            message: `DeepSeek live balance unavailable; using cached data from ${cached.observedAt}. ${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          issues.push({
            provider: "deepseek",
            severity: "error",
            code: "DEEPSEEK_USAGE_MISSING",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  if (monitored.has("minimax")) {
    const minimaxConfig = config.minimax;
    if (!minimaxConfig?.apiKey) {
      issues.push({
        provider: "minimax",
        severity: "warning",
        code: "MINIMAX_API_KEY_MISSING",
        message: "MiniMax API key not configured. Edit ~/.coding-usage-bar/config.json to set minimax.apiKey.",
      });
    } else {
      try {
        const minimax = await collectMinimaxUsage(minimaxConfig);
        saveUsage(minimax, paths);
        usages.push(minimax);
      } catch (error) {
        const cached = loadLatestUsage("minimax", paths);
        if (cached) {
          usages.push(cached);
          issues.push({
            provider: "minimax",
            severity: "warning",
            code: "MINIMAX_USING_CACHE",
            message: `MiniMax live usage unavailable; using cached usage from ${cached.observedAt}. ${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          issues.push({
            provider: "minimax",
            severity: "error",
            code: "MINIMAX_USAGE_MISSING",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  if (monitored.has("kimi")) {
    const kimiConfig = resolveKimiConfig(config.kimi, paths.homeDir);
    if (!kimiConfig.apiKey) {
      issues.push({
        provider: "kimi",
        severity: "warning",
        code: "KIMI_API_KEY_MISSING",
        message: "Kimi API key not configured. Edit ~/.coding-usage-bar/config.json to set kimi.apiKey, or configure a kimi.com lane in ~/.config/claude-lanes/config.env.",
      });
    } else {
      try {
        const kimi = await collectKimiUsage(kimiConfig);
        saveUsage(kimi, paths);
        usages.push(kimi);
      } catch (error) {
        const cached = loadLatestUsage("kimi", paths);
        if (cached) {
          usages.push(cached);
          issues.push({
            provider: "kimi",
            severity: "warning",
            code: "KIMI_USING_CACHE",
            message: `Kimi live usage unavailable; using cached usage from ${cached.observedAt}. ${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          issues.push({
            provider: "kimi",
            severity: "error",
            code: "KIMI_USAGE_MISSING",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return { usages, issues };
}

export async function collectLocalUsages(options: { fixtures?: boolean } = {}): Promise<ProviderUsage[]> {
  return (await collectLocalState(options)).usages;
}

export function analyzeUsages(usages: ProviderUsage[], profile: BurnProfile) {
  const paths = buildPaths();
  return createStatusSnapshot(usages, profile, { paths }).providers.map((provider) => provider.analysis);
}

export function readProfile(): BurnProfile {
  const profile = process.env.CODING_USAGE_BAR_PROFILE;
  return profile === "high" ? "high" : "low";
}

export function loadFixtureSamples(provider: string) {
  const file = path.join(FIXTURES_DIR, provider, "samples.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderUsage);
}

export function analyzeFixtureUsages(usages: ProviderUsage[], profile: BurnProfile): BurnAnalysis[] {
  const fixtureSamples = new Map<string, ProviderUsage[]>(
    usages.map((usage) => [usage.provider, loadFixtureSamples(usage.provider)]),
  );
  return createStatusSnapshot(usages, profile, { fixtureSamples }).providers.map((provider) => provider.analysis);
}

export async function collectStatusSnapshot(options: { fixtures?: boolean } = {}) {
  const { usages, issues } = await collectLocalState(options);
  const profile = readProfile();
  const fixtureSamples = options.fixtures
    ? new Map<string, ProviderUsage[]>(usages.map((usage) => [usage.provider, loadFixtureSamples(usage.provider)]))
    : undefined;
  const snapshot = createStatusSnapshot(usages, profile, { fixtureSamples, issues });
  if (!options.fixtures) {
    saveStatusSnapshot(snapshot);
  }
  return snapshot;
}

export function loadDisplayStatusSnapshot(
  options: { fixtures?: boolean; refresh?: boolean; paths?: RuntimePaths } = {},
): StatusSnapshot {
  if (options.fixtures || options.refresh) {
    throw new Error("Use collectStatusSnapshot() for async refresh; loadDisplayStatusSnapshot is sync (file-only)");
  }

  const snapshot = loadStatusSnapshot(options.paths);
  if (snapshot) {
    return refreshStatusSnapshotFreshness(snapshot);
  }

  return {
    generatedAt: new Date().toISOString(),
    profile: readProfile(),
    providers: [],
    issues: [
      {
        severity: "warning",
        code: "STATUS_MISSING",
        message: `No Coding Usage Bar status snapshot found at ${options.paths?.statusFile ?? buildPaths().statusFile}. Run coding-usage-bar daemon --once or coding-usage-bar status --refresh.`,
      },
    ],
  };
}

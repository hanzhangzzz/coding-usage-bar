import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { buildPaths } from "./paths.js";
import { BurnConfig, GlmConfig, DeepseekConfig, MinimaxConfig, ProviderId, RuntimePaths } from "./types.js";

const DEFAULT_PROVIDERS: ProviderId[] = ["codex", "claude", "glm", "deepseek", "minimax"];
const PROVIDERS = new Set<ProviderId>(["codex", "claude", "glm", "deepseek", "minimax"]);

function normalizeProviders(value: unknown): ProviderId[] {
  if (!Array.isArray(value)) {
    return DEFAULT_PROVIDERS;
  }
  const providers = value.filter((item): item is ProviderId => {
    return typeof item === "string" && PROVIDERS.has(item as ProviderId);
  });
  return providers.length > 0 ? [...new Set(providers)] : DEFAULT_PROVIDERS;
}

function envProviders() {
  const raw = process.env.CODING_USAGE_BAR_PROVIDERS;
  if (!raw) {
    return null;
  }
  return normalizeProviders(raw.split(",").map((item) => item.trim()));
}

export function defaultConfig(): BurnConfig {
  return {
    providers: DEFAULT_PROVIDERS,
    glm: { baseUrl: "https://open.bigmodel.cn", apiKey: "" },
    deepseek: { apiKey: "" },
    minimax: { region: "cn", apiKey: "" },
  };
}

export function readConfig(paths: RuntimePaths = buildPaths()): BurnConfig {
  const fromEnv = envProviders();
  if (fromEnv) {
    return { providers: fromEnv };
  }

  const fileConfig = readJsonFile<Partial<BurnConfig>>(paths.configFile);
  if (!fileConfig) {
    return defaultConfig();
  }
  return {
    providers: normalizeProviders(fileConfig.providers),
    glm: fileConfig.glm ?? defaultConfig().glm,
    deepseek: fileConfig.deepseek ?? defaultConfig().deepseek,
    minimax: fileConfig.minimax ?? defaultConfig().minimax,
  };
}

export function ensureConfig(paths: RuntimePaths = buildPaths()) {
  const existing = readJsonFile<Partial<BurnConfig>>(paths.configFile);
  if (!existing) {
    writeJsonAtomic(paths.configFile, defaultConfig());
    return true;
  }
  if (!existing.glm) {
    writeJsonAtomic(paths.configFile, { ...existing, glm: defaultConfig().glm });
    return true;
  }
  if (!existing.deepseek) {
    const current = readJsonFile<Partial<BurnConfig>>(paths.configFile) ?? existing;
    writeJsonAtomic(paths.configFile, { ...current, deepseek: defaultConfig().deepseek });
  }
  const latest = readJsonFile<Partial<BurnConfig>>(paths.configFile) ?? existing;
  if (!latest.minimax) {
    writeJsonAtomic(paths.configFile, { ...latest, minimax: defaultConfig().minimax });
  }
  return false;
}

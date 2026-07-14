import fs from "node:fs";
import { appendJsonLine, readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { buildPaths, providerLatestPath, providerSamplesPath } from "./paths.js";
import { ProviderId, ProviderUsage, RuntimePaths } from "./types.js";

export function saveUsage(
  usage: ProviderUsage,
  paths: RuntimePaths = buildPaths(),
) {
  writeJsonAtomic(providerLatestPath(paths, usage.provider), usage);
  appendJsonLine(providerSamplesPath(paths, usage.provider), usage);
}

export function loadLatestUsage(
  provider: ProviderId,
  paths: RuntimePaths = buildPaths(),
): ProviderUsage | null {
  return readJsonFile<ProviderUsage>(providerLatestPath(paths, provider));
}

export function loadSamples(
  provider: ProviderId,
  paths: RuntimePaths = buildPaths(),
): ProviderUsage[] {
  const file = providerSamplesPath(paths, provider);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ProviderUsage;
      } catch {
        return null;
      }
    })
    .filter((item): item is ProviderUsage => item !== null);
}

import { analyzeUsage } from "./burn.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { buildPaths } from "./paths.js";
import { loadSamples } from "./store.js";
import { BurnProfile, ProviderUsage, RuntimePaths, StatusIssue, StatusSnapshot } from "./types.js";

const DEFAULT_STALE_AFTER_SECONDS = 10 * 60;

function buildProviderMeta(usage: ProviderUsage, generatedAt: Date, staleAfterSeconds: number) {
  const ageSeconds = Math.max(
    0,
    Math.round((generatedAt.getTime() - Date.parse(usage.observedAt)) / 1000),
  );
  return {
    source: usage.source,
    observedAt: usage.observedAt,
    ageSeconds,
    stale: ageSeconds > staleAfterSeconds,
  };
}

function staleIssuesFor(providers: StatusSnapshot["providers"]): StatusIssue[] {
  return providers
    .filter((provider) => provider.meta.stale)
    .map((provider) => ({
      provider: provider.usage.provider,
      severity: "warning",
      code: "USAGE_STALE",
      message: `${provider.usage.provider} usage is stale; latest observation is ${provider.meta.ageSeconds}s old.`,
    }));
}

export function createStatusSnapshot(
  usages: ProviderUsage[],
  profile: BurnProfile,
  options: {
    paths?: RuntimePaths;
    generatedAt?: Date;
    fixtureSamples?: Map<string, ProviderUsage[]>;
    issues?: StatusIssue[];
    staleAfterSeconds?: number;
  } = {},
): StatusSnapshot {
  const paths = options.paths ?? buildPaths();
  const generatedAt = options.generatedAt ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  const providers = usages.map((usage) => {
    const fixtureSamples = options.fixtureSamples?.get(usage.provider);
    const samples = fixtureSamples ?? loadSamples(usage.provider, paths);
    return {
      usage,
      analysis: analyzeUsage(
        usage,
        samples.length > 0 ? samples : usages.filter((item) => item.provider === usage.provider),
        profile,
        generatedAt,
      ),
      meta: buildProviderMeta(usage, generatedAt, staleAfterSeconds),
    };
  });
  const staleIssues = staleIssuesFor(providers);

  return {
    generatedAt: generatedAt.toISOString(),
    profile,
    providers,
    issues: [...(options.issues ?? []), ...staleIssues],
  };
}

export function refreshStatusSnapshotFreshness(
  snapshot: StatusSnapshot,
  options: { now?: Date; staleAfterSeconds?: number } = {},
): StatusSnapshot {
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  const providers = snapshot.providers.map((provider) => ({
    ...provider,
    meta: buildProviderMeta(provider.usage, now, staleAfterSeconds),
  }));
  const nonStaleIssues = snapshot.issues.filter((issue) => issue.code !== "USAGE_STALE");
  return {
    ...snapshot,
    providers,
    issues: [...nonStaleIssues, ...staleIssuesFor(providers)],
  };
}

export function saveStatusSnapshot(
  snapshot: StatusSnapshot,
  paths: RuntimePaths = buildPaths(),
) {
  writeJsonAtomic(paths.statusFile, snapshot);
}

export function loadStatusSnapshot(paths: RuntimePaths = buildPaths()) {
  return readJsonFile<StatusSnapshot>(paths.statusFile);
}

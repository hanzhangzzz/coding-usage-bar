import fs from "node:fs";
import path from "node:path";
import { analyzeUsage, analyzeUsageWithConversionRate } from "./burn.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { buildPaths, providerLatestPath } from "./paths.js";
import { loadSamples } from "./store.js";
import { BurnProfile, ProviderUsage, RuntimePaths, StatusIssue, StatusSnapshot } from "./types.js";

const DEFAULT_STALE_AFTER_SECONDS = 10 * 60;
const STATUS_LOCK_RETRY_MS = 5;
const STATUS_LOCK_TIMEOUT_MS = 2_000;
const STATUS_LOCK_STALE_MS = 10_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function waitForStatusLock() {
  Atomics.wait(lockWaitArray, 0, 0, STATUS_LOCK_RETRY_MS);
}

export function withStatusSnapshotLock<T>(paths: RuntimePaths, action: () => T): T {
  const lockFile = `${paths.statusFile}.lock`;
  const deadline = Date.now() + STATUS_LOCK_TIMEOUT_MS;
  ensureDir(path.dirname(lockFile));

  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs > STATUS_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for status snapshot lock at ${lockFile}`);
      }
      waitForStatusLock();
    }
  }

  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function observedAtMs(usage: ProviderUsage) {
  const value = Date.parse(usage.observedAt);
  return Number.isFinite(value) ? value : null;
}

function newestUsage(usages: ProviderUsage[]) {
  return usages.reduce((latest, candidate) => {
    const latestTime = observedAtMs(latest);
    const candidateTime = observedAtMs(candidate);
    return candidateTime !== null && (latestTime === null || candidateTime > latestTime)
      ? candidate
      : latest;
  });
}

export function reconcileLatestUsages(usages: ProviderUsage[], paths: RuntimePaths) {
  return usages.map((usage) => {
    const cached = readJsonFile<ProviderUsage>(providerLatestPath(paths, usage.provider));
    if (!cached || cached.provider !== usage.provider) {
      return usage;
    }
    const cachedTime = observedAtMs(cached);
    const usageTime = observedAtMs(usage);
    return cachedTime !== null && (usageTime === null || cachedTime > usageTime)
      ? cached
      : usage;
  });
}

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

// Coarse buckets keep the message stable between renders: an exact age changes
// every second, which would defeat SwiftBar's unchanged-content guard and force
// a menu rebuild each refresh while the data itself is unchanged.
function staleAgeLabel(ageSeconds: number) {
  const buckets = [
    { seconds: 86_400, label: "1d" },
    { seconds: 43_200, label: "12h" },
    { seconds: 10_800, label: "3h" },
    { seconds: 3_600, label: "1h" },
    { seconds: 1_800, label: "30m" },
    { seconds: 600, label: "10m" },
    { seconds: 60, label: "1m" },
  ];
  const hit = buckets.find((bucket) => ageSeconds >= bucket.seconds);
  return hit ? `over ${hit.label}` : "under 1m";
}

function staleIssuesFor(providers: StatusSnapshot["providers"]): StatusIssue[] {
  return providers
    .filter((provider) => provider.meta.stale)
    .map((provider) => ({
      provider: provider.usage.provider,
      severity: "warning",
      code: "USAGE_STALE",
      message: `${provider.usage.provider} usage is stale; latest observation is ${staleAgeLabel(provider.meta.ageSeconds)} old.`,
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

export function replaceStatusSnapshotUsage(
  existing: StatusSnapshot | null,
  usage: ProviderUsage,
  now = new Date(),
) {
  if (!existing) {
    return createStatusSnapshot([usage], "low", {
      generatedAt: now,
      fixtureSamples: new Map([[usage.provider, []]]),
    });
  }

  const previous = existing.providers.find((provider) => provider.usage.provider === usage.provider);
  const selectedUsage = previous ? newestUsage([previous.usage, usage]) : usage;
  const conversionRate = previous?.analysis.target?.conversionRate ?? null;
  const provider = {
    usage: selectedUsage,
    analysis: analyzeUsageWithConversionRate(selectedUsage, conversionRate, existing.profile, now),
    meta: buildProviderMeta(selectedUsage, now, DEFAULT_STALE_AFTER_SECONDS),
  };
  const providers = previous
    ? existing.providers.map((item) => item.usage.provider === usage.provider ? provider : item)
    : [...existing.providers, provider];
  return refreshStatusSnapshotFreshness({
    ...existing,
    generatedAt: now.toISOString(),
    providers,
    issues: existing.issues.filter((issue) => (
      issue.code !== "USAGE_STALE"
      && !(issue.provider === usage.provider && issue.code === "CLAUDE_INGEST_MISSING")
    )),
  }, { now });
}

export function updateStatusSnapshotUsage(
  usage: ProviderUsage,
  paths: RuntimePaths = buildPaths(),
) {
  return withStatusSnapshotLock(paths, () => {
    const now = new Date();
    const existing = loadStatusSnapshot(paths);
    const cached = reconcileLatestUsages([usage], paths)[0];
    const snapshot = replaceStatusSnapshotUsage(existing, newestUsage([usage, cached]), now);
    saveStatusSnapshot(snapshot, paths);
    return snapshot;
  });
}

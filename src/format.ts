import { BurnAnalysis, StatusIssue, ProviderUsage, UsageWindow, StatusSnapshot } from "./types.js";

export function formatDurationUntil(iso: string, now = new Date()) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function windowLabel(window: UsageWindow) {
  return window.name === "five_hour" ? "5h" : "7d";
}

function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "glm") return "GLM";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "minimax") return "MiniMax";
  return "Codex";
}

export function formatProviderLabel(provider: string) {
  return providerLabel(provider);
}

export function formatWindowLabel(window: UsageWindow) {
  return windowLabel(window);
}

export function usageBar(usedPercent: number, width = 12) {
  const usedCells = Math.max(0, Math.min(width, Math.round((usedPercent / 100) * width)));
  return `[${"#".repeat(usedCells)}${"-".repeat(width - usedCells)}] ${Math.round(usedPercent)}%`;
}

export function formatStatusRows(usages: ProviderUsage[], analyses: BurnAnalysis[]) {
  const rows = ["Provider  Period  Usage              Reset     State"];
  for (const usage of usages) {
    const analysis = analyses.find((item) => item.provider === usage.provider);
    if (usage.balance && usage.windows.length === 0) {
      const currency = usage.balance.currency === "CNY" ? "¥" : "$";
      rows.push(
        [
          providerLabel(usage.provider).padEnd(8),
          "balance".padEnd(8),
          `${currency}${usage.balance.total}`.padEnd(19),
          "".padEnd(10),
          analysis?.state ?? "RAW",
        ].join(""),
      );
      continue;
    }
    for (const window of usage.windows) {
      rows.push(
        [
          providerLabel(usage.provider).padEnd(8),
          windowLabel(window).padEnd(8),
          usageBar(window.usedPercent).padEnd(19),
          formatDurationUntil(window.resetsAt).padEnd(10),
          analysis?.state ?? "RAW",
        ].join(""),
      );
    }
  }
  return rows.join("\n");
}

export function formatAnalysisDetail(analysis: BurnAnalysis) {
  if (!analysis.target) {
    return analysis.message;
  }
  return `${analysis.message} k=${analysis.target.conversionRate.toFixed(3)}, recommended=${analysis.target.recommendedPercent.toFixed(1)}%.`;
}

export function formatIssues(issues: StatusIssue[]) {
  if (issues.length === 0) {
    return "";
  }
  return issues
    .map((issue) => {
      const provider = issue.provider ? `${providerLabel(issue.provider)} ` : "";
      return `${issue.severity.toUpperCase()} ${provider}${issue.code}: ${issue.message}`;
    })
    .join("\n");
}

export function formatProviderMeta(snapshot: StatusSnapshot) {
  if (snapshot.providers.length === 0) {
    return "";
  }
  return snapshot.providers
    .map(({ usage, meta }) => {
      const stale = meta.stale ? "stale" : "fresh";
      return `${providerLabel(usage.provider)} source=${meta.source} age=${meta.ageSeconds}s ${stale}`;
    })
    .join("\n");
}

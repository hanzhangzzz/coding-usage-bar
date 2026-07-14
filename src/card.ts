import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fs-util.js";
import { formatDurationUntil } from "./format.js";
import { buildPaths } from "./paths.js";
import { BurnAnalysis, RuntimePaths } from "./types.js";

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "glm") return "GLM";
  if (provider === "deepseek") return "DeepSeek";
  return "Codex";
}

function cardTheme(state: string) {
  if (state === "UNDER_BURN") {
    return { accent: "#f59e0b", label: "BURN LOW" };
  }
  if (state === "OVER_BURN") {
    return { accent: "#7c3aed", label: "TOO FAST" };
  }
  if (state === "LIMIT_RISK") {
    return { accent: "#dc2626", label: "LIMIT RISK" };
  }
  return { accent: "#16a34a", label: "ON TRACK" };
}

function targetLine(analysis: BurnAnalysis) {
  if (analysis.state === "LIMIT_RISK") {
    return "near plan limit";
  }
  if (!analysis.target) {
    return "learning baseline";
  }
  return `target ${Math.round(analysis.target.minPercent)}-${Math.round(analysis.target.maxPercent)}%`;
}

export function notificationCardSvg(analysis: BurnAnalysis) {
  const theme = cardTheme(analysis.state);
  const used = analysis.fiveHour ? `${Math.round(analysis.fiveHour.usedPercent)}%` : "--";
  const reset = analysis.fiveHour ? `${formatDurationUntil(analysis.fiveHour.resetsAt)} left` : "no reset data";
  const title = `${providerLabel(analysis.provider)} 5h`;
  const target = targetLine(analysis);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180" viewBox="0 0 420 180">
  <rect width="420" height="180" rx="28" fill="#111827"/>
  <rect x="0" y="0" width="12" height="180" fill="${theme.accent}"/>
  <text x="30" y="45" fill="#f9fafb" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700">${escapeXml(title)}</text>
  <text x="30" y="116" fill="${theme.accent}" font-family="Arial, Helvetica, sans-serif" font-size="62" font-weight="800">${escapeXml(used)}</text>
  <text x="214" y="64" fill="#f9fafb" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700">${escapeXml(theme.label)}</text>
  <text x="214" y="104" fill="#d1d5db" font-family="Arial, Helvetica, sans-serif" font-size="22">${escapeXml(target)}</text>
  <text x="214" y="138" fill="#9ca3af" font-family="Arial, Helvetica, sans-serif" font-size="21">${escapeXml(reset)}</text>
</svg>
`;
}

export function cardPathForAnalysis(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
) {
  const fileName = `${analysis.provider}-${analysis.state.toLowerCase()}.png`;
  return path.join(paths.stateDir, "cards", fileName);
}

export function writeNotificationCard(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
) {
  const pngPath = cardPathForAnalysis(analysis, paths);
  const svgPath = pngPath.replace(/\.png$/, ".svg");
  ensureDir(path.dirname(pngPath));
  fs.writeFileSync(svgPath, notificationCardSvg(analysis), "utf8");
  try {
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
      stdio: "ignore",
    });
    return pngPath;
  } catch {
    return svgPath;
  }
}

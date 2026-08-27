export type ProviderId = "claude" | "codex" | "glm" | "deepseek" | "minimax" | "kimi";
export type WindowName = "five_hour" | "seven_day";
export type BurnProfile = "low" | "high";
export type BurnState =
  | "RAW"
  | "UNDER_BURN"
  | "ON_TRACK"
  | "OVER_BURN"
  | "LIMIT_RISK";

export interface UsageWindow {
  name: WindowName;
  windowMinutes: number;
  usedPercent: number;
  resetsAt: string;
}

export interface ProviderUsage {
  provider: ProviderId;
  source: string;
  observedAt: string;
  planType?: string | null;
  windows: UsageWindow[];
  balance?: {
    total: string;
    currency: string;
    isAvailable: boolean;
  };
  // Kimi-only: the billing-cycle (monthly) quota can freeze access while the
  // 5h/weekly windows still report headroom, and that quota is not exposed by
  // /v1/usages at all. When set, window numbers stay untouched; display layers
  // render the bars in a blocked style.
  blocked?: {
    reason: string;
  };
}

export interface BurnAnalysis {
  provider: ProviderId;
  state: BurnState;
  profile: BurnProfile;
  observedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  target?: {
    minPercent: number;
    maxPercent: number;
    recommendedPercent: number;
    conversionRate: number;
  };
  message: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface GlmConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface DeepseekConfig {
  apiKey?: string;
}

export interface MinimaxConfig {
  region?: "cn" | "global";
  apiKey?: string;
}

export interface KimiConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface RuntimePaths {
  homeDir: string;
  stateDir: string;
  configFile: string;
  claudeDir: string;
  codexDir: string;
  glmDir: string;
  deepseekDir: string;
  minimaxDir: string;
  kimiDir: string;
  notificationStateFile: string;
  statusFile: string;
  starPromptFile: string;
  cliBinDir: string;
  cliBinFile: string;
  swiftBarPluginDir: string;
  swiftBarPluginFile: string;
  launchAgentFile: string;
  claudeSettingsFile: string;
  claudeStatusLineScript: string;
  glyphsDir: string;
}

export interface ProviderStatus {
  usage: ProviderUsage;
  analysis: BurnAnalysis;
  meta: {
    source: string;
    observedAt: string;
    ageSeconds: number;
    stale: boolean;
  };
}

export interface StatusIssue {
  provider?: ProviderId;
  severity: "warning" | "error";
  code: string;
  message: string;
}

// Menu bar geometry measured by the producer. The menu bar is the scarcest
// real estate on the machine and a title wider than the space left over is not
// clipped by macOS -- it is pushed left, under the notch and into the app menu
// area, and silently disappears. The display layer picks a title tier from
// this budget; per the producer/display split it never measures the screen.
export interface DisplayGeometry {
  // Logical width of the menu bar screen (NSScreen.screens[0]).
  screenWidthPt: number;
  hasNotch: boolean;
  // Points actually available to menu bar extras. On a notched display that is
  // the whole right-of-notch region; otherwise the screen width minus a
  // conservative reserve for the frontmost app's own menus.
  extrasBudgetPt: number;
  measuredAt: string;
}

export interface StatusSnapshot {
  generatedAt: string;
  profile: BurnProfile;
  providers: ProviderStatus[];
  issues: StatusIssue[];
  // Absent on snapshots written before display probing, on non-macOS hosts,
  // and whenever the probe fails. Consumers must degrade, never assume.
  display?: DisplayGeometry | null;
}

export interface BurnConfig {
  providers: ProviderId[];
  glm?: GlmConfig;
  deepseek?: DeepseekConfig;
  minimax?: MinimaxConfig;
  kimi?: KimiConfig;
}

export type ProviderId = "claude" | "codex" | "glm" | "deepseek" | "minimax";
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

export interface RuntimePaths {
  homeDir: string;
  stateDir: string;
  configFile: string;
  claudeDir: string;
  codexDir: string;
  glmDir: string;
  deepseekDir: string;
  minimaxDir: string;
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

export interface StatusSnapshot {
  generatedAt: string;
  profile: BurnProfile;
  providers: ProviderStatus[];
  issues: StatusIssue[];
}

export interface BurnConfig {
  providers: ProviderId[];
  glm?: GlmConfig;
  deepseek?: DeepseekConfig;
  minimax?: MinimaxConfig;
}

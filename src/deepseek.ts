import { DeepseekConfig, ProviderUsage } from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

interface DeepseekBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface DeepseekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepseekBalanceInfo[];
}

export async function fetchDeepseekBalance(config: DeepseekConfig): Promise<DeepseekBalanceResponse> {
  const url = `${DEFAULT_BASE_URL}/user/balance`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek balance API returned HTTP ${response.status}`);
  }

  return (await response.json()) as DeepseekBalanceResponse;
}

export function usageFromDeepseekBalance(
  balance: DeepseekBalanceResponse,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  const info = balance.balance_infos?.[0];
  if (!info) {
    return null;
  }

  return {
    provider: "deepseek",
    source: options.source,
    observedAt: options.observedAt ?? new Date().toISOString(),
    planType: null,
    windows: [],
    balance: {
      total: info.total_balance,
      currency: info.currency,
      isAvailable: balance.is_available,
    },
  };
}

export async function collectDeepseekUsage(config: DeepseekConfig): Promise<ProviderUsage> {
  if (!config.apiKey) {
    throw new Error("DeepSeek API key not configured. Edit ~/.coding-usage-bar/config.json to set deepseek.apiKey.");
  }

  const balance = await fetchDeepseekBalance(config);
  const usage = usageFromDeepseekBalance(balance, {
    source: `${DEFAULT_BASE_URL}/user/balance`,
  });

  if (!usage) {
    throw new Error("DeepSeek balance response did not contain expected data");
  }

  return usage;
}

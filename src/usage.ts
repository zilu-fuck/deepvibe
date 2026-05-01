import { sumUsageField } from "./engine.js";
import type { DeepSeekUsage } from "./llm/deepseek-client.js";
import type { ReplProfileSelection } from "./model-profile.js";

export interface SessionUsageSnapshot {
  estimatedCostUsd: number;
  turnCount: number;
  usage: DeepSeekUsage | null;
}

export function createSessionUsageSnapshot(): SessionUsageSnapshot {
  return {
    estimatedCostUsd: 0,
    turnCount: 0,
    usage: null
  };
}

export function formatUsageSummaryLine(selection: ReplProfileSelection, usage: DeepSeekUsage): string {
  const estimatedCost = estimateUsageCost(selection.model, usage);
  return `[Usage] prompt=${formatTokenCount(getPromptUsageTokens(usage))} completion=${formatTokenCount(getCompletionUsageTokens(usage))} total=${formatTokenCount(usage.total_tokens)} est=${formatUsd(estimatedCost)}`;
}

export function formatUsageDetails(
  selection: ReplProfileSelection,
  usage: DeepSeekUsage,
  label: string,
  estimatedCostOverride?: number
): string[] {
  const estimatedCost = estimatedCostOverride ?? estimateUsageCost(selection.model, usage);
  const promptTokens = getPromptUsageTokens(usage);
  const completionTokens = getCompletionUsageTokens(usage);

  return [
    `${label}: prompt=${formatTokenCount(promptTokens)}, completion=${formatTokenCount(completionTokens)}, total=${formatTokenCount(usage.total_tokens)}, est=${formatUsd(estimatedCost)}`,
    `${label} cache: hit=${formatTokenCount(usage.prompt_cache_hit_tokens)}, miss=${formatTokenCount(usage.prompt_cache_miss_tokens)}, reasoning=${formatTokenCount(usage.reasoning_tokens)}`
  ];
}

export function estimateUsageCost(model: "deepseek-v4-pro" | "deepseek-v4-flash", usage: DeepSeekUsage): number {
  const pricing =
    model === "deepseek-v4-flash"
      ? {
          promptCacheHitPerMillion: 0.0028,
          promptCacheMissPerMillion: 0.14,
          completionPerMillion: 0.28
        }
      : {
          promptCacheHitPerMillion: 0.003625,
          promptCacheMissPerMillion: 0.435,
          completionPerMillion: 0.87
        };
  const promptCacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const promptCacheMissTokens =
    usage.prompt_cache_miss_tokens ??
    Math.max((usage.prompt_tokens ?? 0) - promptCacheHitTokens, 0);
  const completionTokens = getCompletionUsageTokens(usage) ?? 0;

  return (
    (promptCacheHitTokens / 1_000_000) * pricing.promptCacheHitPerMillion +
    (promptCacheMissTokens / 1_000_000) * pricing.promptCacheMissPerMillion +
    (completionTokens / 1_000_000) * pricing.completionPerMillion
  );
}

function getPromptUsageTokens(usage: DeepSeekUsage): number | undefined {
  return usage.prompt_tokens ?? sumUsageField(usage.prompt_cache_hit_tokens, usage.prompt_cache_miss_tokens);
}

function getCompletionUsageTokens(usage: DeepSeekUsage): number | undefined {
  if (usage.completion_tokens !== undefined) {
    return usage.completion_tokens;
  }

  if (usage.total_tokens !== undefined) {
    return Math.max(usage.total_tokens - (getPromptUsageTokens(usage) ?? 0), 0);
  }

  return undefined;
}

function formatTokenCount(value?: number): string {
  return value === undefined ? "-" : value.toLocaleString("en-US");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

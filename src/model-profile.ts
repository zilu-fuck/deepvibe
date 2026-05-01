import type { ExecutionProfile } from "./engine.js";

export interface ModelProfileSettings {
  contextLengthTokens: number;
  defaultScanCandidates: number;
  maxContextFiles: number;
  model: "deepseek-v4-pro" | "deepseek-v4-flash";
  reasoningEffort: "high" | "max";
  reservedResponseTokens: number;
}

export type ReplModelFamily = "deepseek-v4-flash" | "deepseek-v4-pro";
export type ReplReasoningEffect = "low" | "medium" | "high" | "xhigh";

export interface ReplProfileSelection {
  effect: ReplReasoningEffect;
  model: ReplModelFamily;
}

const ONE_MILLION = 1_000_000;
const SIXTY_FOUR_K = 64_000;

export function resolveModelProfile(profile: ExecutionProfile): ModelProfileSettings {
  if (profile === "flash") {
    return {
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      contextLengthTokens: ONE_MILLION,
      reservedResponseTokens: SIXTY_FOUR_K,
      defaultScanCandidates: 12,
      maxContextFiles: 12
    };
  }

  if (profile === "deep") {
    return {
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      contextLengthTokens: ONE_MILLION,
      reservedResponseTokens: SIXTY_FOUR_K,
      defaultScanCandidates: 16,
      maxContextFiles: 16
    };
  }

  return {
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    contextLengthTokens: ONE_MILLION,
    reservedResponseTokens: SIXTY_FOUR_K,
    defaultScanCandidates: 12,
    maxContextFiles: 12
  };
}

export function resolveReplProfileSelection(profile: ExecutionProfile): ReplProfileSelection {
  if (profile === "flash") {
    return {
      model: "deepseek-v4-flash",
      effect: "high"
    };
  }

  if (profile === "deep") {
    return {
      model: "deepseek-v4-pro",
      effect: "xhigh"
    };
  }

  return {
    model: "deepseek-v4-pro",
    effect: "high"
  };
}

export function resolveReplModelProfile(selection: ReplProfileSelection): ModelProfileSettings {
  const reasoningEffort = selection.effect === "xhigh" ? "max" : "high";
  const isDeep = reasoningEffort === "max";

  return {
    model: selection.model,
    reasoningEffort,
    contextLengthTokens: ONE_MILLION,
    reservedResponseTokens: SIXTY_FOUR_K,
    defaultScanCandidates: isDeep ? 16 : 12,
    maxContextFiles: isDeep ? 16 : 12
  };
}

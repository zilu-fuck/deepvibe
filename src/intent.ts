import { loadConfig } from "./config.js";
import type { ChatMessage, CreateCompletionOptions, DeepSeekCompletionResult, DeepSeekClient } from "./llm/deepseek-client.js";
import { DeepSeekClient as DeepSeekApiClient } from "./llm/deepseek-client.js";
import type { ModelProfileSettings } from "./model-profile.js";

export interface EngineeringIntentDecision {
  confidence: "high" | "low" | "medium";
  engineeringIntent: boolean;
  reason: string;
  requiresWriteAccess: boolean;
  source: "heuristic" | "model";
}

export interface DetectEngineeringIntentOptions {
  conversationMessages?: ChatMessage[];
  cwd: string;
  instruction: string;
  profileSettings?: ModelProfileSettings;
}

export interface DetectEngineeringIntentDependencies {
  createClient?: (apiKey: string) => Pick<DeepSeekClient, "createCompletion">;
}

const STRONG_WRITE_PATTERNS = [
  /\b(implement|build|create|scaffold|generate|write|edit|modify|refactor|fix|patch|add|remove|rename|delete)\b/u,
  /\b(api|endpoint|project|app|feature|module|component|test|tests|bug|code|file|files|repository|repo|cli|package)\b/u,
  /\b(start|bootstrap|initialize)\b.{0,24}\b(project|app|repo|repository|package|service|library)\b/u,
  /(?:\u5B9E\u73B0|\u7F16\u5199|\u4FEE\u6539|\u91CD\u6784|\u4FEE\u590D|\u521B\u5EFA|\u65B0\u5EFA|\u642D\u5EFA|\u751F\u6210|\u6DFB\u52A0|\u5220\u9664|\u91CD\u547D\u540D|\u63A5\u53E3|\u9879\u76EE|\u529F\u80FD|\u6A21\u5757|\u7EC4\u4EF6|\u6D4B\u8BD5|\u4EE3\u7801|\u6587\u4EF6|\u4ED3\u5E93)/u
];

const DISCUSSION_PATTERNS = [
  /^\s*(explain|compare|review|describe|brainstorm|discuss|analyze|summarize|what|why|how)\b/u,
  /^\s*(?:\u89E3\u91CA|\u5206\u6790|\u8BA8\u8BBA|\u603B\u7ED3|\u4E3A\u4EC0\u4E48|\u600E\u4E48)\b/u
];

const WRITELESS_ENGINEERING_PATTERNS = [
  /\b(plan|design|approach|architecture|debug|investigate)\b/u,
  /(?:\u65B9\u6848|\u8BBE\u8BA1|\u601D\u8DEF|\u8C03\u8BD5|\u6392\u67E5)/u
];

const INTENT_SYSTEM_PROMPT = [
  "You classify whether the latest user message is asking an AI coding assistant to enter active engineering execution.",
  "Return only JSON with this exact shape:",
  '{"engineeringIntent":true,"requiresWriteAccess":true,"confidence":"high","reason":"short reason"}',
  "Set engineeringIntent=true when the user is asking for code changes, project setup, scaffolding, repository actions, or hands-on implementation work.",
  "Set requiresWriteAccess=true only when fulfilling the request now would normally require creating, editing, deleting, or running project code/files.",
  "Set both fields false for explanation, discussion, brainstorming, architecture review, or read-only analysis requests.",
  "Prefer conservative false only when the latest message is clearly discussion-only."
].join("\n");

export async function detectEngineeringIntent(
  options: DetectEngineeringIntentOptions,
  dependencies: DetectEngineeringIntentDependencies = {}
): Promise<EngineeringIntentDecision> {
  const heuristic = detectEngineeringIntentHeuristically(options.instruction);
  const config = loadConfig({ cwd: options.cwd });

  if (!config.apiKey) {
    return heuristic;
  }

  const client =
    dependencies.createClient?.(config.apiKey) ??
    new DeepSeekApiClient({
      apiKey: config.apiKey
    });

  try {
    const completion = await client.createCompletion(
      [
        {
          role: "system",
          content: INTENT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: buildIntentPrompt(options)
        }
      ],
      {
        model: options.profileSettings?.model ?? "deepseek-v4-flash",
        reasoningEffort: options.profileSettings?.reasoningEffort ?? "high",
        responseFormat: "json_object",
        stream: false,
        thinking: "disabled",
        toolChoice: "none"
      } satisfies CreateCompletionOptions
    );

    return parseIntentDecision(completion, heuristic);
  } catch {
    return heuristic;
  }
}

export function detectEngineeringIntentHeuristically(instruction: string): EngineeringIntentDecision {
  const normalized = instruction.trim().toLowerCase();

  if (normalized.length === 0) {
    return {
      engineeringIntent: false,
      requiresWriteAccess: false,
      confidence: "high",
      reason: "Empty message.",
      source: "heuristic"
    };
  }

  if (DISCUSSION_PATTERNS.some((pattern) => pattern.test(normalized)) && !STRONG_WRITE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      engineeringIntent: false,
      requiresWriteAccess: false,
      confidence: "high",
      reason: "Read-only discussion wording matched.",
      source: "heuristic"
    };
  }

  const strongWriteHits = STRONG_WRITE_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
  const writelessEngineeringHit = WRITELESS_ENGINEERING_PATTERNS.some((pattern) => pattern.test(normalized));

  if (strongWriteHits >= 2) {
    return {
      engineeringIntent: true,
      requiresWriteAccess: true,
      confidence: "high",
      reason: "Explicit implementation and project-write wording matched.",
      source: "heuristic"
    };
  }

  if (strongWriteHits === 1) {
    return {
      engineeringIntent: true,
      requiresWriteAccess: !writelessEngineeringHit,
      confidence: writelessEngineeringHit ? "medium" : "high",
      reason: writelessEngineeringHit
        ? "Engineering request detected, but it may still be discussion-first."
        : "Direct engineering action wording matched.",
      source: "heuristic"
    };
  }

  if (writelessEngineeringHit) {
    return {
      engineeringIntent: true,
      requiresWriteAccess: false,
      confidence: "medium",
      reason: "Engineering context detected without an explicit write request.",
      source: "heuristic"
    };
  }

  return {
    engineeringIntent: false,
    requiresWriteAccess: false,
    confidence: "low",
    reason: "No strong engineering signal matched.",
    source: "heuristic"
  };
}

function buildIntentPrompt(options: DetectEngineeringIntentOptions): string {
  const historyLines = (options.conversationMessages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map((message) => {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      return `${message.role}: ${content}`;
    })
    .filter((line) => line.trim().length > 0);

  return [
    historyLines.length > 0 ? "Recent conversation:\n" + historyLines.join("\n") : "Recent conversation:\n(none)",
    "",
    `Latest user message:\n${options.instruction}`
  ].join("\n");
}

function parseIntentDecision(
  completion: DeepSeekCompletionResult,
  fallback: EngineeringIntentDecision
): EngineeringIntentDecision {
  const raw = completion.content.trim();

  if (raw.length === 0) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const confidence = parsed.confidence;

    if (
      typeof parsed.engineeringIntent !== "boolean" ||
      typeof parsed.requiresWriteAccess !== "boolean" ||
      (confidence !== "low" && confidence !== "medium" && confidence !== "high")
    ) {
      return fallback;
    }

    return {
      engineeringIntent: parsed.engineeringIntent,
      requiresWriteAccess: parsed.requiresWriteAccess,
      confidence,
      reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : "Model classified the request.",
      source: "model"
    };
  } catch {
    return fallback;
  }
}

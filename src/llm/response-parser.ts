import { DeepSeekCompletionResult } from "./deepseek-client.js";

export type FileAction = "modify" | "create" | "delete";

export interface ParsedFileChange {
  action: FileAction;
  diff: string;
  path: string;
}

export interface ParsedModelResponse {
  files: ParsedFileChange[];
  summary: string;
}

export type ParseFailureCode =
  | "EMPTY_CONTENT"
  | "TRUNCATED"
  | "INVALID_JSON"
  | "INVALID_SCHEMA";

export interface ParseFailure {
  canRetry: boolean;
  code: ParseFailureCode;
  message: string;
  rawContent: string;
}

export type ParseOutcome =
  | {
      ok: true;
      value: ParsedModelResponse;
    }
  | {
      ok: false;
      error: ParseFailure;
    };

const VALID_ACTIONS = new Set<FileAction>(["modify", "create", "delete"]);

export function parseResponse(result: DeepSeekCompletionResult): ParseOutcome {
  const content = result.content.trim();

  if (content.length === 0) {
    return failure("EMPTY_CONTENT", "Model returned an empty content payload.", result.content, true);
  }

  if (result.finishReason === "length") {
    return failure("TRUNCATED", "Model output was truncated before completion.", result.content, true);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return failure("INVALID_JSON", "Model content was not valid JSON.", result.content, true);
  }

  const validationError = validateParsedResponse(parsed);

  if (validationError) {
    return failure("INVALID_SCHEMA", validationError, result.content, true);
  }

  return {
    ok: true,
    value: parsed as ParsedModelResponse
  };
}

function validateParsedResponse(value: unknown): string | null {
  if (!isRecord(value)) {
    return "Top-level response must be a JSON object.";
  }

  if (typeof value.summary !== "string") {
    return 'Top-level field "summary" must be a string.';
  }

  if (!Array.isArray(value.files)) {
    return 'Top-level field "files" must be an array.';
  }

  for (const file of value.files) {
    if (!isRecord(file)) {
      return 'Each item in "files" must be an object.';
    }

    if (typeof file.path !== "string" || file.path.trim().length === 0) {
      return 'Each file item must contain a non-empty string "path".';
    }

    if (typeof file.diff !== "string") {
      return 'Each file item must contain a string "diff".';
    }

    if (typeof file.action !== "string" || !VALID_ACTIONS.has(file.action as FileAction)) {
      return 'Each file item must contain a valid "action" value.';
    }
  }

  return null;
}

function failure(
  code: ParseFailureCode,
  message: string,
  rawContent: string,
  canRetry: boolean
): ParseOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      rawContent,
      canRetry
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface PlanStep {
  index: number;
  description: string;
  files: string[];
  estimatedChanges: string;
}

export interface ParsedPlan {
  overview: string;
  steps: PlanStep[];
  notes: string;
}

export type ParsePlanFailureCode =
  | "EMPTY_CONTENT"
  | "TRUNCATED"
  | "INVALID_JSON"
  | "INVALID_PLAN_SCHEMA";

export interface ParsePlanFailure {
  canRetry: boolean;
  code: ParsePlanFailureCode;
  message: string;
  rawContent: string;
}

export type ParsePlanOutcome =
  | {
      ok: true;
      value: ParsedPlan;
    }
  | {
      ok: false;
      error: ParsePlanFailure;
    };

export function parsePlan(result: DeepSeekCompletionResult): ParsePlanOutcome {
  const content = result.content.trim();

  if (content.length === 0) {
    return planFailure("EMPTY_CONTENT", "Model returned an empty content payload.", result.content, true);
  }

  if (result.finishReason === "length") {
    return planFailure("TRUNCATED", "Model output was truncated before completion.", result.content, true);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return planFailure("INVALID_JSON", "Model content was not valid JSON.", result.content, true);
  }

  const validationError = validatePlan(parsed);

  if (validationError) {
    return planFailure("INVALID_PLAN_SCHEMA", validationError, result.content, true);
  }

  return {
    ok: true,
    value: {
      overview: (parsed as Record<string, unknown>).overview as string,
      steps: (parsed as Record<string, unknown>).steps as PlanStep[],
      notes: typeof (parsed as Record<string, unknown>).notes === "string" ? (parsed as Record<string, unknown>).notes as string : ""
    }
  };
}

function validatePlan(value: unknown): string | null {
  if (!isRecord(value)) {
    return "Plan must be a JSON object.";
  }

  if (typeof value.overview !== "string" || value.overview.trim().length === 0) {
    return 'Field "overview" must be a non-empty string.';
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return 'Field "steps" must be a non-empty array.';
  }

  for (let i = 0; i < value.steps.length; i += 1) {
    const step = value.steps[i];

    if (!isRecord(step)) {
      return `Step at index ${i} must be an object.`;
    }

    if (typeof step.index !== "number" || !Number.isInteger(step.index) || step.index < 1) {
      return `Step at index ${i} must have a positive integer "index".`;
    }

    if (typeof step.description !== "string" || step.description.trim().length === 0) {
      return `Step at index ${i} must have a non-empty "description".`;
    }

    if (!Array.isArray(step.files)) {
      return `Step at index ${i} must have a "files" array.`;
    }

    for (let j = 0; j < step.files.length; j += 1) {
      if (typeof step.files[j] !== "string" || step.files[j].trim().length === 0) {
        return `Step at index ${i}, file at index ${j} must be a non-empty string.`;
      }
    }

    if (typeof step.estimatedChanges !== "string") {
      return `Step at index ${i} must have a string "estimatedChanges".`;
    }
  }

  if (value.notes !== undefined && typeof value.notes !== "string") {
    return 'Field "notes" must be a string.';
  }

  return null;
}

function planFailure(
  code: ParsePlanFailureCode,
  message: string,
  rawContent: string,
  canRetry: boolean
): ParsePlanOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      rawContent,
      canRetry
    }
  };
}

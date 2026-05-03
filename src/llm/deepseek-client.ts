import { ContextMessage } from "../context/token-counter.js";

export type ThinkingMode = "enabled" | "disabled";
export type ResponseFormat = "text" | "json_object";
export type ReasoningEffort = "high" | "max";
export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export interface ChatCompletionTool {
  type: "function";
  function: {
    description: string;
    name: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: "function";
}

export type ChatMessage =
  | ContextMessage
  | {
      content: string | null;
      reasoning_content?: string;
      role: "assistant";
      tool_calls?: ChatCompletionToolCall[];
    }
  | {
      content: string;
      role: "tool";
      tool_call_id: string;
    };

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  sleepFn?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

export interface CreateCompletionOptions {
  abortSignal?: AbortSignal;
  maxTokens?: number;
  model: string;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: ResponseFormat;
  stream?: boolean;
  thinking?: ThinkingMode;
  toolChoice?: ToolChoice;
  tools?: ChatCompletionTool[];
}

export interface CreateFimCompletionOptions {
  abortSignal?: AbortSignal;
  echo?: boolean;
  logprobs?: number;
  maxTokens?: number;
  model: "deepseek-v4-pro";
  prompt: string;
  stop?: string | string[];
  stream?: boolean;
  suffix?: string;
  temperature?: number;
  topP?: number;
}

export interface StreamingCallbacks {
  onContent?: (chunk: string) => void;
  onReasoningContent?: (chunk: string) => void;
}

export interface DeepSeekUsage {
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface DeepSeekCompletionResult {
  content: string;
  finishReason: string | null;
  id: string | null;
  reasoningContent: string;
  toolCalls: ChatCompletionToolCall[];
  usage: DeepSeekUsage | null;
}

export interface DeepSeekFimCompletionResult {
  content: string;
  finishReason: string | null;
  id: string | null;
  logprobs: Record<string, unknown> | null;
  usage: DeepSeekUsage | null;
}

interface DeepSeekChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      role?: string;
      tool_calls?: DeepSeekChunkToolCallDelta[];
    };
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
  }>;
  id?: string;
  usage?: DeepSeekUsage | null;
}

interface DeepSeekTextCompletionChunk {
  choices?: Array<{
    finish_reason?: string | null;
    logprobs?: Record<string, unknown> | null;
    text?: string | null;
  }>;
  id?: string;
  usage?: DeepSeekUsage | null;
}

export class DeepSeekClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DeepSeekClientError";
    this.status = status;
  }
}

export class DeepSeekClientAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekClientAbortError";
  }
}

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (delayMs: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.deepseek.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.sleepFn = options.sleepFn ?? sleep;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async createCompletion(
    messages: ChatMessage[],
    options: CreateCompletionOptions
  ): Promise<DeepSeekCompletionResult> {
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("Completion was aborted before the request was sent.");
        }

        const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildChatCompletionBody(messages, options)),
          signal: controller.signal
        });

        if (!response.ok) {
          const error = new DeepSeekClientError(response.status, await response.text());

          if (!isRetriableStatus(error.status) || attempt >= this.maxRetries) {
            throw error;
          }

          await this.sleepFn(resolveRetryDelayMs(response, attempt, this.retryBaseDelayMs));
          attempt += 1;
          continue;
        }

        return options.stream ? await readStreamingResponse(response) : await readJsonResponse(response);
      } catch (error) {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("Completion was aborted.");
        }

        if (!isRetriableError(error) || attempt >= this.maxRetries) {
          throw error;
        }

        await this.sleepFn(resolveExponentialDelayMs(attempt, this.retryBaseDelayMs));
        attempt += 1;
      } finally {
        options.abortSignal?.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutId);
      }
    }
  }

  async createStreamingCompletion(
    messages: ChatMessage[],
    options: CreateCompletionOptions,
    callbacks: StreamingCallbacks
  ): Promise<DeepSeekCompletionResult> {
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("Completion was aborted before the request was sent.");
        }

        const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildChatCompletionBody(messages, { ...options, stream: true })),
          signal: controller.signal
        });

        if (!response.ok) {
          const error = new DeepSeekClientError(response.status, await response.text());

          if (!isRetriableStatus(error.status) || attempt >= this.maxRetries) {
            throw error;
          }

          await this.sleepFn(resolveRetryDelayMs(response, attempt, this.retryBaseDelayMs));
          attempt += 1;
          continue;
        }

        return await readStreamingResponseWithCallbacks(response, callbacks);
      } catch (error) {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("Completion was aborted.");
        }

        if (!isRetriableError(error) || attempt >= this.maxRetries) {
          throw error;
        }

        await this.sleepFn(resolveExponentialDelayMs(attempt, this.retryBaseDelayMs));
        attempt += 1;
      } finally {
        options.abortSignal?.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutId);
      }
    }
  }

  async createFimCompletion(
    options: CreateFimCompletionOptions
  ): Promise<DeepSeekFimCompletionResult> {
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const abortHandler = () => controller.abort();
      options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("FIM completion was aborted before the request was sent.");
        }

        const fimBaseUrl = this.baseUrl.endsWith("/beta") ? this.baseUrl : `${this.baseUrl}/beta`;
        const response = await this.fetchFn(`${fimBaseUrl}/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildFimCompletionBody(options)),
          signal: controller.signal
        });

        if (!response.ok) {
          const error = new DeepSeekClientError(response.status, await response.text());

          if (!isRetriableStatus(error.status) || attempt >= this.maxRetries) {
            throw error;
          }

          await this.sleepFn(resolveRetryDelayMs(response, attempt, this.retryBaseDelayMs));
          attempt += 1;
          continue;
        }

        return options.stream
          ? await readStreamingTextCompletionResponse(response)
          : await readTextCompletionResponse(response);
      } catch (error) {
        if (options.abortSignal?.aborted) {
          throw new DeepSeekClientAbortError("FIM completion was aborted.");
        }

        if (!isRetriableError(error) || attempt >= this.maxRetries) {
          throw error;
        }

        await this.sleepFn(resolveExponentialDelayMs(attempt, this.retryBaseDelayMs));
        attempt += 1;
      } finally {
        options.abortSignal?.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutId);
      }
    }
  }
}

export function buildChatCompletionBody(
  messages: ChatMessage[],
  options: CreateCompletionOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    thinking: {
      type: options.thinking ?? "enabled"
    },
    response_format: {
      type: options.responseFormat ?? "json_object"
    }
  };

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  return body;
}

export function buildFimCompletionBody(
  options: CreateFimCompletionOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt
  };

  if (options.echo !== undefined) {
    body.echo = options.echo;
  }

  if (options.logprobs !== undefined) {
    body.logprobs = options.logprobs;
  }

  if (options.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens;
  }

  if (options.stop !== undefined) {
    body.stop = options.stop;
  }

  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  if (options.suffix !== undefined) {
    body.suffix = options.suffix;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.topP !== undefined) {
    body.top_p = options.topP;
  }

  return body;
}

async function readJsonResponse(response: Response): Promise<DeepSeekCompletionResult> {
  const json = (await response.json()) as DeepSeekChunk;
  const choice = json.choices?.[0];

  return {
    id: json.id ?? null,
    content: choice?.message?.content ?? "",
    reasoningContent: choice?.message?.reasoning_content ?? "",
    finishReason: choice?.finish_reason ?? null,
    toolCalls: choice?.message?.tool_calls ?? [],
    usage: json.usage ?? null
  };
}

async function readTextCompletionResponse(response: Response): Promise<DeepSeekFimCompletionResult> {
  const json = (await response.json()) as DeepSeekTextCompletionChunk;
  const choice = json.choices?.[0];

  return {
    id: json.id ?? null,
    content: choice?.text ?? "",
    finishReason: choice?.finish_reason ?? null,
    logprobs: choice?.logprobs ?? null,
    usage: json.usage ?? null
  };
}

async function readStreamingResponse(response: Response): Promise<DeepSeekCompletionResult> {
  if (!response.body) {
    throw new DeepSeekClientError(response.status, "Streaming response body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  const toolCalls: ChatCompletionToolCall[] = [];
  let usage: DeepSeekUsage | null = null;

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const data = extractEventData(part);

      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = JSON.parse(data) as DeepSeekChunk;
      id = parsed.id ?? id;
      usage = parsed.usage ?? usage;

      const choice = parsed.choices?.[0];

      if (!choice) {
        continue;
      }

      finishReason = choice.finish_reason ?? finishReason;
      content += choice.delta?.content ?? "";
      reasoningContent += choice.delta?.reasoning_content ?? "";
      if (choice.delta?.tool_calls) {
        mergeToolCalls(toolCalls, choice.delta.tool_calls);
      }
    }
  }

  if (buffer.length > 0) {
    const data = extractEventData(buffer);

    if (data && data !== "[DONE]") {
      const parsed = JSON.parse(data) as DeepSeekChunk;
      id = parsed.id ?? id;
      usage = parsed.usage ?? usage;

      const choice = parsed.choices?.[0];

      if (choice) {
        finishReason = choice.finish_reason ?? finishReason;
        content += choice.delta?.content ?? "";
        reasoningContent += choice.delta?.reasoning_content ?? "";
        if (choice.delta?.tool_calls) {
          mergeToolCalls(toolCalls, choice.delta.tool_calls);
        }
      }
    }
  }

  return {
    id,
    content,
    reasoningContent,
    finishReason,
    toolCalls,
    usage
  };
}

async function readStreamingTextCompletionResponse(response: Response): Promise<DeepSeekFimCompletionResult> {
  if (!response.body) {
    throw new DeepSeekClientError(response.status, "Streaming response body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let id: string | null = null;
  let usage: DeepSeekUsage | null = null;
  let logprobs: Record<string, unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");

      if (boundary === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = extractEventData(rawEvent);

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        return {
          id,
          content,
          finishReason,
          logprobs,
          usage
        };
      }

      const chunk = JSON.parse(data) as DeepSeekTextCompletionChunk;
      id = chunk.id ?? id;
      usage = chunk.usage ?? usage;
      const choice = chunk.choices?.[0];

      if (!choice) {
        continue;
      }

      if (choice.text) {
        content += choice.text;
      }

      if (choice.logprobs) {
        logprobs = choice.logprobs;
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  if (buffer.length > 0) {
    const data = extractEventData(buffer);

    if (data && data !== "[DONE]") {
      const chunk = JSON.parse(data) as DeepSeekTextCompletionChunk;
      id = chunk.id ?? id;
      usage = chunk.usage ?? usage;
      const choice = chunk.choices?.[0];

      if (choice) {
        if (choice.text) {
          content += choice.text;
        }

        if (choice.logprobs) {
          logprobs = choice.logprobs;
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
  }

  return {
    id,
    content,
    finishReason,
    logprobs,
    usage
  };
}

async function readStreamingResponseWithCallbacks(
  response: Response,
  callbacks: StreamingCallbacks
): Promise<DeepSeekCompletionResult> {
  if (!response.body) {
    throw new DeepSeekClientError(response.status, "Streaming response body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  const toolCalls: ChatCompletionToolCall[] = [];
  let usage: DeepSeekUsage | null = null;

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const data = extractEventData(part);

      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = JSON.parse(data) as DeepSeekChunk;
      id = parsed.id ?? id;
      usage = parsed.usage ?? usage;

      const choice = parsed.choices?.[0];

      if (!choice) {
        continue;
      }

      finishReason = choice.finish_reason ?? finishReason;

      if (choice.delta?.content) {
        content += choice.delta.content;
        callbacks.onContent?.(choice.delta.content);
      }

      if (choice.delta?.reasoning_content) {
        reasoningContent += choice.delta.reasoning_content;
        callbacks.onReasoningContent?.(choice.delta.reasoning_content);
      }

      if (choice.delta?.tool_calls) {
        mergeToolCalls(toolCalls, choice.delta.tool_calls);
      }
    }
  }

  if (buffer.length > 0) {
    const data = extractEventData(buffer);

    if (data && data !== "[DONE]") {
      const parsed = JSON.parse(data) as DeepSeekChunk;
      id = parsed.id ?? id;
      usage = parsed.usage ?? usage;

      const choice = parsed.choices?.[0];

      if (choice) {
        finishReason = choice.finish_reason ?? finishReason;

        if (choice.delta?.content) {
          content += choice.delta.content;
          callbacks.onContent?.(choice.delta.content);
        }

        if (choice.delta?.reasoning_content) {
          reasoningContent += choice.delta.reasoning_content;
          callbacks.onReasoningContent?.(choice.delta.reasoning_content);
        }

        if (choice.delta?.tool_calls) {
          mergeToolCalls(toolCalls, choice.delta.tool_calls);
        }
      }
    }
  }

  return {
    id,
    content,
    reasoningContent,
    finishReason,
    toolCalls,
    usage
  };
}

interface DeepSeekChunkToolCallDelta {
  function?: {
    arguments?: string | null;
    name?: string | null;
  };
  id?: string | null;
  index?: number;
  type?: "function" | null;
}

function mergeToolCalls(
  currentToolCalls: ChatCompletionToolCall[],
  incomingToolCalls: DeepSeekChunkToolCallDelta[]
): void {
  for (const toolCall of incomingToolCalls) {
    const index = toolCall.index ?? currentToolCalls.length;
    const existing = currentToolCalls[index] ?? {
      id: toolCall.id ?? "",
      type: "function" as const,
      function: {
        name: "",
        arguments: ""
      }
    };

    currentToolCalls[index] = {
      id: toolCall.id ?? existing.id,
      type: toolCall.type ?? existing.type,
      function: {
        name: toolCall.function?.name ?? existing.function.name,
        arguments: `${existing.function.arguments}${toolCall.function?.arguments ?? ""}`
      }
    };
  }
}

function extractEventData(eventChunk: string): string | null {
  const lines = eventChunk
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"));

  if (lines.length === 0) {
    return null;
  }

  return lines
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
}

function isRetriableError(error: unknown): boolean {
  if (error instanceof DeepSeekClientAbortError) {
    return false;
  }

  if (error instanceof DeepSeekClientError) {
    return isRetriableStatus(error.status);
  }

  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  return error instanceof Error;
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function resolveRetryDelayMs(
  response: Response,
  attempt: number,
  retryBaseDelayMs: number
): number {
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfterDelayMs = parseRetryAfterHeader(retryAfterHeader);

  if (retryAfterDelayMs !== null) {
    return retryAfterDelayMs;
  }

  return resolveExponentialDelayMs(attempt, retryBaseDelayMs);
}

function resolveExponentialDelayMs(attempt: number, retryBaseDelayMs: number): number {
  return retryBaseDelayMs * 2 ** attempt;
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const asSeconds = Number(value);

  if (Number.isFinite(asSeconds)) {
    return Math.max(0, asSeconds * 1000);
  }

  const asTimestamp = Date.parse(value);

  if (Number.isNaN(asTimestamp)) {
    return null;
  }

  return Math.max(0, asTimestamp - Date.now());
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

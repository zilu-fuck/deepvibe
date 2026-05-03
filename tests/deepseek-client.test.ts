import { describe, expect, it, vi } from "vitest";

import { ContextMessage } from "../src/context/token-counter.js";
import {
  buildChatCompletionBody,
  buildFimCompletionBody,
  DeepSeekClient,
  DeepSeekClientError,
  type ChatCompletionTool
} from "../src/llm/deepseek-client.js";

const messages: ContextMessage[] = [
  { role: "system", content: "Return JSON." },
  { role: "user", content: "Summarize this file." }
];
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file"
    }
  }
];

describe("buildChatCompletionBody", () => {
  it("builds a JSON-output request body with thinking defaults", () => {
    const body = buildChatCompletionBody(messages, {
      model: "deepseek-v4-pro",
      reasoningEffort: "high"
    });

    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      response_format: { type: "json_object" }
    });
  });

  it("adds streaming usage options when stream is enabled", () => {
    const body = buildChatCompletionBody(messages, {
      model: "deepseek-v4-flash",
      stream: true,
      thinking: "disabled"
    });

    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "disabled" }
    });
  });

  it("includes tools and tool_choice when tool calling is enabled", () => {
    const body = buildChatCompletionBody(messages, {
      model: "deepseek-v4-pro",
      tools,
      toolChoice: "auto"
    });

    expect(body).toMatchObject({
      tools,
      tool_choice: "auto"
    });
  });
});

describe("buildFimCompletionBody", () => {
  it("builds a beta completion payload with suffix support", () => {
    const body = buildFimCompletionBody({
      model: "deepseek-v4-pro",
      prompt: "function test() {",
      suffix: "}",
      maxTokens: 64,
      stream: true
    });

    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      prompt: "function test() {",
      suffix: "}",
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true }
    });
  });
});

describe("DeepSeekClient", () => {
  it("parses non-stream JSON responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chat_1",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "{\"ok\":true}",
                reasoning_content: "reasoning"
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    const result = await client.createCompletion(messages, {
      model: "deepseek-v4-pro",
      stream: false
    });

    expect(result).toMatchObject({
      id: "chat_1",
      content: "{\"ok\":true}",
      reasoningContent: "reasoning",
      finishReason: "stop",
      usage: { total_tokens: 18 }
    });
  });

  it("parses non-stream tool calls from the assistant message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chat_tool",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                reasoning_content: "inspect a file first",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"src/api.ts\"}"
                    }
                  }
                ]
              }
            }
          ],
          usage: {
            total_tokens: 20
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    const result = await client.createCompletion(messages, {
      model: "deepseek-v4-pro",
      tools
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"src/api.ts\"}"
        }
      }
    ]);
  });

  it("parses streaming SSE responses and accumulates deltas", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              "data: {\"id\":\"chat_2\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"think \"},\"finish_reason\":null}],\"usage\":null}\n\n",
              "data: {\"id\":\"chat_2\",\"choices\":[{\"delta\":{\"content\":\"{\\\"files\\\":\"},\"finish_reason\":null}],\"usage\":null}\n\n",
              "data: {\"id\":\"chat_2\",\"choices\":[{\"delta\":{\"content\":\"[]}\"},\"finish_reason\":\"stop\"}],\"usage\":null}\n\n",
              "data: {\"id\":\"chat_2\",\"choices\":[],\"usage\":{\"total_tokens\":42}}\n\n",
              "data: [DONE]\n\n"
            ].join("")
          )
        );
        controller.close();
      }
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );

    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    const result = await client.createCompletion(messages, {
      model: "deepseek-v4-pro",
      stream: true
    });

    expect(result).toMatchObject({
      id: "chat_2",
      content: "{\"files\":[]}",
      reasoningContent: "think ",
      finishReason: "stop",
      usage: { total_tokens: 42 }
    });
  });

  it("throws a typed error for non-200 responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("bad request", { status: 400 })
    );
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    await expect(
      client.createCompletion(messages, {
        model: "deepseek-v4-pro"
      })
    ).rejects.toThrowError(DeepSeekClientError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses the beta completions endpoint for FIM requests", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "fim_1",
          choices: [
            {
              text: "return value;",
              finish_reason: "stop",
              logprobs: null
            }
          ],
          usage: {
            total_tokens: 9
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    const result = await client.createFimCompletion({
      model: "deepseek-v4-pro",
      prompt: "if (value) {",
      suffix: "}"
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/beta/completions");
    expect(result).toMatchObject({
      id: "fim_1",
      content: "return value;",
      finishReason: "stop",
      usage: { total_tokens: 9 }
    });
  });

  it("parses streaming FIM completion chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              "data: {\"id\":\"fim_stream\",\"choices\":[{\"text\":\"return \",\"finish_reason\":null}],\"usage\":null}\n\n",
              "data: {\"id\":\"fim_stream\",\"choices\":[{\"text\":\"value;\",\"finish_reason\":\"stop\"}],\"usage\":null}\n\n",
              "data: {\"id\":\"fim_stream\",\"choices\":[],\"usage\":{\"total_tokens\":11}}\n\n",
              "data: [DONE]\n\n"
            ].join("")
          )
        );
        controller.close();
      }
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn
    });

    const result = await client.createFimCompletion({
      model: "deepseek-v4-pro",
      prompt: "if (value) {",
      suffix: "}",
      stream: true
    });

    expect(result).toMatchObject({
      id: "fim_stream",
      content: "return value;",
      finishReason: "stop",
      usage: { total_tokens: 11 }
    });
  });

  it("retries network errors before succeeding", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "chat_retry",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "{\"ok\":true}",
                  reasoning_content: "retry reasoning"
                }
              }
            ],
            usage: {
              total_tokens: 12
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const sleepFn = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn,
      sleepFn
    });

    const result = await client.createCompletion(messages, {
      model: "deepseek-v4-pro"
    });

    expect(result.id).toBe("chat_retry");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 500);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 1000);
  });

  it("honors Retry-After when retrying a 429 response", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "2" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "chat_rate_limit",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "{\"ok\":true}",
                  reasoning_content: "retried"
                }
              }
            ],
            usage: {
              total_tokens: 9
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const sleepFn = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn,
      sleepFn
    });

    const result = await client.createCompletion(messages, {
      model: "deepseek-v4-pro"
    });

    expect(result.id).toBe("chat_rate_limit");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(2000);
  });

  it("stops retrying once the retry budget is exhausted", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("server unavailable", { status: 503 }));
    const sleepFn = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetchFn,
      maxRetries: 2,
      sleepFn
    });

    await expect(
      client.createCompletion(messages, {
        model: "deepseek-v4-pro"
      })
    ).rejects.toThrowError(DeepSeekClientError);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 500);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 1000);
  });
});

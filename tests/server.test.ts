import { afterEach, describe, expect, it, vi } from "vitest";

import { startService, type StartedService } from "../src/server.js";

const runningServices: StartedService[] = [];

afterEach(async () => {
  while (runningServices.length > 0) {
    const service = runningServices.pop();

    if (service) {
      await service.close();
    }
  }
});

describe("service server", () => {
  it("serves a health endpoint", async () => {
    const service = await startService({ port: 0 });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/health`);
    const json = (await response.json()) as { ok: boolean; service: string };

    expect(response.status).toBe(200);
    expect(json).toEqual({
      ok: true,
      service: "deepvibe",
      version: "0.1.0"
    });
  });

  it("runs the /run endpoint through the injected engine", async () => {
    const runEngine = vi.fn().mockResolvedValue({
      message: "run ok"
    });
    const service = await startService({
      port: 0,
      dependencies: {
        runEngine
      }
    });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "summarize the project",
        dryRun: true
      })
    });
    const json = (await response.json()) as { ok: boolean; result: { message: string } };

    expect(response.status).toBe(200);
    expect(runEngine).toHaveBeenCalledTimes(1);
    expect(json.result.message).toBe("run ok");
  });

  it("serves the FIM completion endpoint through the injected handler", async () => {
    const createFimCompletion = vi.fn().mockResolvedValue({
      id: "fim_1",
      content: "completed()",
      finishReason: "stop",
      logprobs: null,
      usage: { total_tokens: 7 }
    });
    const service = await startService({
      port: 0,
      dependencies: {
        createFimCompletion
      }
    });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/completions/fim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "function hello() {",
        suffix: "}"
      })
    });
    const json = (await response.json()) as { ok: boolean; result: { content: string } };

    expect(response.status).toBe(200);
    expect(createFimCompletion).toHaveBeenCalledTimes(1);
    expect(json.result.content).toBe("completed()");
  });

  it("runs the /undo endpoint through the injected undo handler", async () => {
    const undoLastAiChange = vi.fn().mockResolvedValue({
      kind: "operation",
      reference: "op_123"
    });
    const service = await startService({
      port: 0,
      dependencies: {
        undoLastAiChange
      }
    });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const json = (await response.json()) as { ok: boolean; result: { kind: string; reference: string } };

    expect(response.status).toBe(200);
    expect(undoLastAiChange).toHaveBeenCalledTimes(1);
    expect(json.result.reference).toBe("op_123");
  });

  it("supports JSON-RPC run requests", async () => {
    const runEngine = vi.fn().mockResolvedValue({
      message: "rpc ok"
    });
    const service = await startService({
      port: 0,
      dependencies: {
        runEngine
      }
    });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "deepvibe.run",
        params: {
          instruction: "summarize the project",
          dryRun: true
        }
      })
    });
    const json = (await response.json()) as { jsonrpc: string; id: number; result: { message: string } };

    expect(response.status).toBe(200);
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        message: "rpc ok"
      }
    });
  });

  it("supports JSON-RPC FIM completion requests", async () => {
    const createFimCompletion = vi.fn().mockResolvedValue({
      id: "fim_rpc",
      content: "return 1;",
      finishReason: "stop",
      logprobs: null,
      usage: { total_tokens: 6 }
    });
    const service = await startService({
      port: 0,
      dependencies: {
        createFimCompletion
      }
    });
    runningServices.push(service);

    const response = await fetch(`http://${service.host}:${service.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "deepvibe.completion.fim",
        params: {
          prompt: "if (value) {",
          suffix: "}"
        }
      })
    });
    const json = (await response.json()) as { jsonrpc: string; id: number; result: { content: string } };

    expect(response.status).toBe(200);
    expect(createFimCompletion).toHaveBeenCalledTimes(1);
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        id: "fim_rpc",
        content: "return 1;",
        finishReason: "stop",
        logprobs: null,
        usage: {
          total_tokens: 6
        }
      }
    });
  });

  it("creates a background task and streams SSE events", async () => {
    const runEngine = vi.fn().mockImplementation(async (_options, dependencies) => {
      dependencies.emitEvent?.({
        type: "custom.progress",
        payload: { step: "halfway" }
      });
      return {
        message: "task done"
      };
    });
    const service = await startService({
      port: 0,
      dependencies: {
        runEngine
      }
    });
    runningServices.push(service);

    const createResponse = await fetch(`http://${service.host}:${service.port}/tasks/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "summarize the project",
        dryRun: true
      })
    });
    const created = (await createResponse.json()) as {
      ok: boolean;
      task: { taskId: string; status: string };
    };
    const streamResponse = await fetch(`http://${service.host}:${service.port}/tasks/${created.task.taskId}/events`);
    const streamText = await streamResponse.text();
    const events = parseSseEvents(streamText);

    expect(created.task.status).toBe("running");
    expect(events.map((event) => event.type)).toEqual([
      "task.started",
      "custom.progress",
      "task.completed"
    ]);
    expect(events[0]).toMatchObject({
      source: "task",
      status: "running",
      terminal: false,
      version: 1
    });
    expect(events[1]).toMatchObject({
      source: "engine",
      status: "running",
      terminal: false,
      version: 1
    });
    expect(events[2]).toMatchObject({
      source: "task",
      status: "completed",
      terminal: true,
      version: 1
    });
  });

  it("supports task cancellation over HTTP", async () => {
    const runEngine = vi.fn().mockImplementation(async (_options, dependencies) => {
      while (!dependencies.abortSignal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      throw new Error("Execution was canceled.");
    });
    const service = await startService({
      port: 0,
      dependencies: {
        runEngine
      }
    });
    runningServices.push(service);

    const createResponse = await fetch(`http://${service.host}:${service.port}/tasks/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "summarize the project",
        dryRun: true
      })
    });
    const created = (await createResponse.json()) as {
      task: { taskId: string };
    };

    const cancelResponse = await fetch(`http://${service.host}:${service.port}/tasks/${created.task.taskId}/cancel`, {
      method: "POST"
    });
    const canceled = (await cancelResponse.json()) as {
      task: { status: string };
    };

    expect(cancelResponse.status).toBe(202);
    expect(canceled.task.status).toBe("running");

    const taskUrl = `http://${service.host}:${service.port}/tasks/${created.task.taskId}`;

    await waitForTaskStatus(taskUrl, "canceled", 2000);

    const streamResponse = await fetch(`http://${service.host}:${service.port}/tasks/${created.task.taskId}/events`);
    const streamText = await streamResponse.text();
    const events = parseSseEvents(streamText);

    expect(events.map((event) => event.type)).toContain("task.cancel_requested");
    expect(events.map((event) => event.type)).toContain("task.canceled");
    expect(events.at(-1)).toMatchObject({
      type: "task.canceled",
      source: "task",
      status: "canceled",
      terminal: true,
      version: 1
    });
  });

  it("supports JSON-RPC task methods", async () => {
    const runEngine = vi.fn().mockResolvedValue({
      message: "task ok"
    });
    const service = await startService({
      port: 0,
      dependencies: {
        runEngine
      }
    });
    runningServices.push(service);

    const startResponse = await fetch(`http://${service.host}:${service.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "deepvibe.task.start",
        params: {
          instruction: "summarize the project",
          dryRun: true
        }
      })
    });
    const startJson = (await startResponse.json()) as {
      result: { taskId: string };
    };
    const getResponse = await fetch(`http://${service.host}:${service.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "deepvibe.task.get",
        params: {
          taskId: startJson.result.taskId
        }
      })
    });
    const getJson = (await getResponse.json()) as {
      result: { status: string };
    };

    expect(getJson.result.status === "running" || getJson.result.status === "completed").toBe(true);
  });
});

async function waitForTaskStatus(url: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(url);
    const json = (await response.json()) as { task: { status: string } };

    if (json.task.status === expected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Task did not reach "${expected}" within ${timeoutMs}ms.`);
}

function parseSseEvents(streamText: string): Array<Record<string, unknown>> {
  return streamText
    .trim()
    .split("\n\n")
    .map((chunk) => chunk.split("\n"))
    .map((lines) => {
      const dataLine = lines.find((line) => line.startsWith("data: "));

      if (!dataLine) {
        throw new Error(`Missing SSE data line in chunk: ${lines.join("\\n")}`);
      }

      return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
    });
}

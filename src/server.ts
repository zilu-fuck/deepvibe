import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { runEngine, type RunEngineDependencies, type RunEngineOptions } from "./engine.js";
import { undoLastAiChange } from "./project/git-manager.js";
import { TaskManager, type ServiceTaskEvent, type ServiceTaskSnapshot } from "./task-manager.js";
import {
  loadContextStore,
  loadChatHistory,
  listSessions,
  startNewSession,
  switchSession,
  updateChatHistory
} from "./context-store.js";
import type { ChatMessage } from "./llm/deepseek-client.js";

export interface ServiceDependencies extends RunEngineDependencies {
  runEngine?: typeof runEngine;
  taskManager?: TaskManager;
  undoLastAiChange?: typeof undoLastAiChange;
}

export interface StartServiceOptions {
  cwd?: string;
  dependencies?: ServiceDependencies;
  host?: string;
  port?: number;
}

export interface StartedService {
  close: () => Promise<void>;
  host: string;
  port: number;
  server: http.Server;
}

export interface JsonRpcRequest {
  id?: number | string | null;
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
}

type JsonRpcSuccess = {
  id: number | string | null;
  jsonrpc: "2.0";
  result: unknown;
};

type JsonRpcError = {
  id: number | string | null;
  jsonrpc: "2.0";
  error: {
    code: number;
    message: string;
  };
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4242;

function withServiceDependencies(dependencies: ServiceDependencies | undefined): ServiceDependencies {
  return {
    ...dependencies,
    executionMode: "service"
  };
}

export function createServiceServer(options: StartServiceOptions = {}): http.Server {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const executeRunEngine = options.dependencies?.runEngine ?? runEngine;
  const executeUndo = options.dependencies?.undoLastAiChange ?? undoLastAiChange;
  const taskManager = options.dependencies?.taskManager ?? new TaskManager();

  return http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 400, { error: "Missing request URL." });
        return;
      }

      const url = new URL(request.url, `http://${host}:${port}`);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "deepvibe",
          version: "0.1.0"
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/run") {
        const body = await readJsonBody(request);
        const result = await executeRunEngine(
          normalizeRunOptions(body, cwd),
          withServiceDependencies(options.dependencies)
        );
        sendJson(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tasks/run") {
        const body = await readJsonBody(request);
        const task = taskManager.createRunTask(
          normalizeRunOptions(body, cwd),
          withServiceDependencies(options.dependencies),
          executeRunEngine
        );
        sendJson(response, 202, {
          ok: true,
          task
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/events")) {
        const taskId = decodeTaskId(url.pathname, "/events");
        const events = taskManager.getTaskEvents(taskId);

        if (!events) {
          sendJson(response, 404, { error: `Unknown task: ${taskId}` });
          return;
        }

        await streamTaskEvents(response, taskManager, taskId, events);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const taskId = decodeTaskId(url.pathname);
        const task = taskManager.getTaskSnapshot(taskId);

        if (!task) {
          sendJson(response, 404, { error: `Unknown task: ${taskId}` });
          return;
        }

        sendJson(response, 200, { ok: true, task });
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/cancel")) {
        const taskId = decodeTaskId(url.pathname, "/cancel");
        const task = taskManager.cancelTask(taskId);

        sendJson(response, 202, {
          ok: true,
          task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/undo") {
        const body = await readJsonBody(request);
        const result = await executeUndo(
          typeof body.cwd === "string" && body.cwd.trim().length > 0 ? body.cwd : cwd
        );
        sendJson(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        const store = loadContextStore(cwd);
        sendJson(response, 200, {
          ok: true,
          currentSessionId: store.currentSessionId,
          sessions: listSessions(store)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions/new") {
        const store = startNewSession(cwd);
        sendJson(response, 200, {
          ok: true,
          currentSessionId: store.currentSessionId,
          sessions: listSessions(store)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions/switch") {
        const body = await readJsonBody(request);

        if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
          sendJson(response, 400, { ok: false, error: "Missing sessionId." });
          return;
        }

        const store = switchSession(cwd, body.sessionId);

        if (!store) {
          sendJson(response, 404, { ok: false, error: `Session not found: ${body.sessionId}` });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          currentSessionId: store.currentSessionId,
          sessions: listSessions(store)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions/history") {
        const url = new URL(request.url, `http://${host}:${port}`);
        const sessionId = url.searchParams.get("sessionId") || undefined;
        const store = loadContextStore(cwd);
        const targetId = sessionId || store.currentSessionId;

        if (!store.sessions.some((s) => s.id === targetId)) {
          sendJson(response, 404, { ok: false, error: `Session not found: ${targetId}` });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          sessionId: targetId,
          messages: loadChatHistory(store, targetId)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/rpc") {
        const rpcRequest = (await readJsonBody(request)) as JsonRpcRequest;
        const rpcResponse = await handleJsonRpcRequest(rpcRequest, {
          cwd,
          dependencies: options.dependencies,
          executeRunEngine,
          executeUndo,
          taskManager
        });
        sendJson(response, 200, rpcResponse);
        return;
      }

      sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      sendJson(response, 500, {
        ok: false,
        error: message
      });
    }
  });
}

export async function startService(options: StartServiceOptions = {}): Promise<StartedService> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = createServiceServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the bound service address.");
  }

  return {
    server,
    host: address.address,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  options: {
    cwd: string;
    dependencies?: ServiceDependencies;
    executeRunEngine: typeof runEngine;
    executeUndo: typeof undoLastAiChange;
    taskManager: TaskManager;
  }
): Promise<JsonRpcSuccess | JsonRpcError> {
  const id = request.id ?? null;

  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return rpcError(id, -32600, "Invalid JSON-RPC request.");
  }

  try {
    if (request.method === "deepvibe.run") {
      const result = await options.executeRunEngine(
        normalizeRunOptions(request.params, options.cwd),
        withServiceDependencies(options.dependencies)
      );

      return rpcResult(id, result);
    }

    if (request.method === "deepvibe.task.start") {
      const task = options.taskManager.createRunTask(
        normalizeRunOptions(request.params, options.cwd),
        withServiceDependencies(options.dependencies),
        options.executeRunEngine
      );

      return rpcResult(id, task);
    }

    if (request.method === "deepvibe.task.get") {
      const params = readTaskParams(request.params);
      const task = options.taskManager.getTaskSnapshot(params.taskId);

      if (!task) {
        return rpcError(id, -32004, `Unknown task: ${params.taskId}`);
      }

      return rpcResult(id, task);
    }

    if (request.method === "deepvibe.task.cancel") {
      const params = readTaskParams(request.params);
      const task = options.taskManager.cancelTask(params.taskId);

      return rpcResult(id, task);
    }

    if (request.method === "deepvibe.undo") {
      const params = isRecord(request.params) ? request.params : {};
      const result = await options.executeUndo(
        typeof params.cwd === "string" && params.cwd.trim().length > 0 ? params.cwd : options.cwd
      );

      return rpcResult(id, result);
    }

    if (request.method === "deepvibe.health") {
      return rpcResult(id, {
        ok: true,
        service: "deepvibe"
      });
    }

    if (request.method === "deepvibe.session.list") {
      const store = loadContextStore(options.cwd);
      return rpcResult(id, {
        currentSessionId: store.currentSessionId,
        sessions: listSessions(store)
      });
    }

    if (request.method === "deepvibe.session.new") {
      const store = startNewSession(options.cwd);
      return rpcResult(id, {
        currentSessionId: store.currentSessionId,
        sessions: listSessions(store)
      });
    }

    if (request.method === "deepvibe.session.switch") {
      const params = isRecord(request.params) ? request.params : {};

      if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
        return rpcError(id, -32602, "Missing sessionId.");
      }

      const store = switchSession(options.cwd, params.sessionId);

      if (!store) {
        return rpcError(id, -32004, `Session not found: ${params.sessionId}`);
      }

      return rpcResult(id, {
        currentSessionId: store.currentSessionId,
        sessions: listSessions(store)
      });
    }

    if (request.method === "deepvibe.session.history") {
      const params = isRecord(request.params) ? request.params : {};
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const store = loadContextStore(options.cwd);
      const targetId = sessionId || store.currentSessionId;

      if (!store.sessions.some((s) => s.id === targetId)) {
        return rpcError(id, -32004, `Session not found: ${targetId}`);
      }

      return rpcResult(id, {
        sessionId: targetId,
        messages: loadChatHistory(store, targetId)
      });
    }

    if (request.method === "deepvibe.session.updateHistory") {
      const params = isRecord(request.params) ? request.params : {};

      if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
        return rpcError(id, -32602, "Missing sessionId.");
      }

      if (!Array.isArray(params.messages)) {
        return rpcError(id, -32602, "Missing messages array.");
      }

      const store = loadContextStore(options.cwd);

      if (!store.sessions.some((s) => s.id === params.sessionId)) {
        return rpcError(id, -32004, `Session not found: ${params.sessionId}`);
      }

      updateChatHistory(options.cwd, params.sessionId, params.messages as ChatMessage[]);
      return rpcResult(id, { ok: true });
    }

    return rpcError(id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return rpcError(id, -32000, error instanceof Error ? error.message : "Unknown JSON-RPC error.");
  }
}

function normalizeRunOptions(input: unknown, cwd: string): RunEngineOptions {
  if (!isRecord(input)) {
    throw new Error("Run request body must be an object.");
  }

  if (typeof input.instruction !== "string" || input.instruction.trim().length === 0) {
    throw new Error('Run request requires a non-empty "instruction" string.');
  }

  const profile = input.profile;

  if (profile !== undefined && profile !== "default" && profile !== "flash" && profile !== "deep") {
    throw new Error('Run request "profile" must be one of default|flash|deep.');
  }

  return {
    cwd: typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : cwd,
    instruction: input.instruction,
    dryRun: Boolean(input.dryRun),
    profile: profile ?? "default"
  };
}

function readTaskParams(input: unknown): { taskId: string } {
  if (!isRecord(input) || typeof input.taskId !== "string" || input.taskId.trim().length === 0) {
    throw new Error('JSON-RPC task method requires a non-empty "taskId" string.');
  }

  return {
    taskId: input.taskId
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      throw new Error("JSON body must decode to an object.");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function streamTaskEvents(
  response: ServerResponse,
  taskManager: TaskManager,
  taskId: string,
  existingEvents: ServiceTaskEvent[]
): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");

  for (const event of existingEvents) {
    writeSseEvent(response, event);
  }

  const snapshot = taskManager.getTaskSnapshot(taskId);

  if (snapshot && isTerminalTaskStatus(snapshot)) {
    response.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = taskManager.subscribe(taskId, (event) => {
      writeSseEvent(response, event);

      const latest = taskManager.getTaskSnapshot(taskId);

      if (latest && isTerminalTaskStatus(latest)) {
        unsubscribe?.();
        response.end();
        resolve();
      }
    });

    response.on("close", () => {
      unsubscribe?.();
      resolve();
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeSseEvent(response: ServerResponse, event: ServiceTaskEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function rpcResult(id: number | string | null, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function decodeTaskId(pathname: string, suffix = ""): string {
  const trimmed = suffix ? pathname.slice(0, -suffix.length) : pathname;
  const segments = trimmed.split("/").filter(Boolean);
  const taskId = segments[1];

  if (!taskId) {
    throw new Error("Task id is missing from the route.");
  }

  return taskId;
}

function isTerminalTaskStatus(task: ServiceTaskSnapshot): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "canceled";
}

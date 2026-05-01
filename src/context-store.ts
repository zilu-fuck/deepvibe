import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ChatMessage } from "./llm/deepseek-client.js";

export interface ContextStore {
  currentSessionId: string;
  sessions: ContextSession[];
  version: 1;
}

export interface ContextSession {
  chatHistory?: ChatMessage[];
  createdAt: string;
  id: string;
  turns: ContextTurn[];
  updatedAt: string;
}

export interface ContextTurn {
  createdAt: string;
  files: string[];
  id: string;
  instruction: string;
  result: {
    appliedFiles: number;
    kind: "dry-run" | "operation" | "commit";
    ok: boolean;
    reference?: string;
    toolCallsUsed: boolean;
  };
  search?: {
    query: string;
    results: Array<{ title: string; url: string }>;
  };
  summary: string;
  tools?: {
    names: string[];
  };
}

export interface AppendContextTurnOptions {
  files: string[];
  instruction: string;
  result: ContextTurn["result"];
  rootDir: string;
  search?: ContextTurn["search"];
  summary: string;
  tools?: ContextTurn["tools"];
}

const CONTEXT_FILE = "context.json";
const CONTEXT_DIR = ".deepvibe";
const MAX_STORED_TURNS = 50;
const DEFAULT_HISTORY_TURNS = 5;
const MAX_SESSIONS = 20;
const MAX_CHAT_HISTORY_MESSAGES = 200;

export function loadContextStore(rootDir: string): ContextStore {
  const storePath = getContextStorePath(rootDir);

  if (!existsSync(storePath)) {
    return createEmptyStore();
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Partial<ContextStore>;

    if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || typeof parsed.currentSessionId !== "string") {
      return createEmptyStore();
    }

    const sessions = parsed.sessions.filter(isContextSession);

    if (sessions.length === 0) {
      return createEmptyStore();
    }

    return {
      version: 1,
      currentSessionId: sessions.some((session) => session.id === parsed.currentSessionId)
        ? parsed.currentSessionId
        : sessions[0].id,
      sessions
    };
  } catch {
    return createEmptyStore();
  }
}

export function appendContextTurn(options: AppendContextTurnOptions): ContextStore {
  const store = loadContextStore(options.rootDir);
  const activeSession = getOrCreateActiveSession(store);
  const now = new Date().toISOString();
  const turn: ContextTurn = {
    createdAt: now,
    id: createTurnId(),
    instruction: options.instruction,
    files: [...new Set(options.files)],
    result: options.result,
    search: options.search,
    summary: options.summary,
    tools: options.tools
  };
  const nextSession: ContextSession = {
    ...activeSession,
    updatedAt: now,
    turns: [...activeSession.turns, turn].slice(-MAX_STORED_TURNS)
  };
  const nextStore: ContextStore = {
    ...store,
    sessions: store.sessions.map((session) => (session.id === nextSession.id ? nextSession : session))
  };

  persistContextStore(options.rootDir, nextStore);

  return nextStore;
}

export function buildSessionHistorySummary(
  store: ContextStore,
  maxTurns: number = DEFAULT_HISTORY_TURNS
): string | undefined {
  const session = getActiveSession(store);

  if (!session || session.turns.length === 0) {
    return undefined;
  }

  const recentTurns = session.turns.slice(-maxTurns);
  const droppedCount = Math.max(0, session.turns.length - recentTurns.length);
  const lines = ["最近会话摘要："];

  if (droppedCount > 0) {
    lines.push(`- 更早的 ${droppedCount} 轮已折叠为摘要`);
  }

  for (const turn of recentTurns) {
    const parts = [
      `- 指令: ${turn.instruction}`,
      `结果: ${turn.result.kind}${turn.result.reference ? `(${turn.result.reference})` : ""}`,
      `文件: ${turn.files.length > 0 ? turn.files.join(", ") : "无"}`
    ];

    if (turn.search) {
      parts.push(`搜索: ${turn.search.query}`);
    }

    if (turn.tools?.names && turn.tools.names.length > 0) {
      parts.push(`工具: ${turn.tools.names.join(", ")}`);
    }

    parts.push(`摘要: ${turn.summary}`);
    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}

export function startNewSession(rootDir: string): ContextStore {
  const store = loadContextStore(rootDir);
  const session = createSession();
  let sessions = [...store.sessions, session];

  if (sessions.length > MAX_SESSIONS) {
    sessions = sessions.slice(-MAX_SESSIONS);
  }

  const nextStore: ContextStore = {
    ...store,
    currentSessionId: session.id,
    sessions
  };

  persistContextStore(rootDir, nextStore);

  return nextStore;
}

export function listSessions(store: ContextStore): Array<{ createdAt: string; id: string; turnCount: number; updatedAt: string }> {
  return store.sessions.map((session) => ({
    createdAt: session.createdAt,
    id: session.id,
    turnCount: session.turns.length,
    updatedAt: session.updatedAt
  }));
}

export function switchSession(rootDir: string, sessionId: string): ContextStore | null {
  const store = loadContextStore(rootDir);

  if (!store.sessions.some((session) => session.id === sessionId)) {
    return null;
  }

  const nextStore: ContextStore = {
    ...store,
    currentSessionId: sessionId
  };

  persistContextStore(rootDir, nextStore);

  return nextStore;
}

export function updateChatHistory(rootDir: string, sessionId: string, messages: ChatMessage[]): void {
  const store = loadContextStore(rootDir);
  const trimmed = messages.length > MAX_CHAT_HISTORY_MESSAGES
    ? messages.slice(-MAX_CHAT_HISTORY_MESSAGES)
    : messages;
  const nextStore: ContextStore = {
    ...store,
    sessions: store.sessions.map((session) =>
      session.id === sessionId
        ? { ...session, chatHistory: trimmed, updatedAt: new Date().toISOString() }
        : session
    )
  };

  persistContextStore(rootDir, nextStore);
}

export function loadChatHistory(store: ContextStore, sessionId?: string): ChatMessage[] {
  const targetId = sessionId ?? store.currentSessionId;
  const session = store.sessions.find((s) => s.id === targetId);

  return session?.chatHistory ?? [];
}

function persistContextStore(rootDir: string, store: ContextStore): void {
  const storePath = getContextStorePath(rootDir);

  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getContextStorePath(rootDir: string): string {
  return path.join(rootDir, CONTEXT_DIR, CONTEXT_FILE);
}

function createEmptyStore(): ContextStore {
  const session = createSession();

  return {
    version: 1,
    currentSessionId: session.id,
    sessions: [session]
  };
}

function createSession(): ContextSession {
  const now = new Date().toISOString();

  return {
    chatHistory: [],
    createdAt: now,
    id: createSessionId(),
    turns: [],
    updatedAt: now
  };
}

function getActiveSession(store: ContextStore): ContextSession | undefined {
  return store.sessions.find((session) => session.id === store.currentSessionId);
}

function getOrCreateActiveSession(store: ContextStore): ContextSession {
  const activeSession = getActiveSession(store);

  if (activeSession) {
    return activeSession;
  }

  const session = createSession();
  store.currentSessionId = session.id;
  store.sessions.push(session);

  return session;
}

function createSessionId(): string {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isContextSession(value: unknown): value is ContextSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    Array.isArray(record.turns)
  );
}

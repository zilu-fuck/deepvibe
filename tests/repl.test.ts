import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadChatHistory,
  loadContextStore,
  listSessions,
  startNewSession,
  switchSession,
  updateChatHistory
} from "../src/context-store.js";
import type { ReplTurnResult } from "../src/engine.js";
import { completeReplInput, confirmReplExecution, startRepl } from "../src/repl.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

function mockRepoState(isRepository = false, isDirty = false) {
  return { isRepository, isDirty, currentHead: isRepository ? "abc123" : null };
}

function mockInspectRepo(isRepository = false) {
  return vi.fn<typeof import("../src/project/git-manager.js").inspectRepository>().mockResolvedValue(mockRepoState(isRepository));
}

describe("session management", () => {
  it("starts a new session", () => {
    const rootDir = createWorkspace({});
    const store = startNewSession(rootDir);

    expect(store.sessions.length).toBeGreaterThanOrEqual(2);
    expect(store.currentSessionId).not.toBe(store.sessions[0].id);
  });

  it("lists sessions", () => {
    const rootDir = createWorkspace({});
    startNewSession(rootDir);
    const store = loadContextStore(rootDir);
    const sessions = listSessions(store);

    expect(sessions.length).toBe(2);
    expect(sessions[0]).toHaveProperty("id");
    expect(sessions[0]).toHaveProperty("turnCount");
  });

  it("switches sessions", () => {
    const rootDir = createWorkspace({});
    const store1 = startNewSession(rootDir);
    const newSessionId = store1.currentSessionId;
    startNewSession(rootDir);

    const switched = switchSession(rootDir, newSessionId);

    expect(switched).not.toBeNull();
    expect(switched!.currentSessionId).toBe(newSessionId);
  });

  it("returns null for nonexistent session switch", () => {
    const rootDir = createWorkspace({});
    const result = switchSession(rootDir, "nonexistent");

    expect(result).toBeNull();
  });

  it("saves and loads chat history", () => {
    const rootDir = createWorkspace({});
    const store = startNewSession(rootDir);
    const sessionId = store.currentSessionId;
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" }
    ];

    updateChatHistory(rootDir, sessionId, messages);

    const reloaded = loadContextStore(rootDir);
    const history = loadChatHistory(reloaded, sessionId);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(messages[0]);
    expect(history[1]).toEqual(messages[1]);
  });

  it("returns empty array for session with no chat history", () => {
    const rootDir = createWorkspace({});
    const store = loadContextStore(rootDir);
    const history = loadChatHistory(store);

    expect(history).toEqual([]);
  });
});

describe("REPL", () => {
  it("starts and displays welcome message", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("DeepVibe REPL session started");
  });

  it("renders the welcome banner and ready state", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("DeepVibe Chat ready.");
    expect(output).toContain("+-- Status");
  });

  it("shows the workspace mode in the status panel", async () => {
    const rootDir = createWorkspace({});
    const sandboxDir = path.join(rootDir, ".sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      {
        cwd: sandboxDir,
        profile: "default",
        requestedCwd: rootDir,
        workspaceMode: "sandbox"
      },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Workspace: sandbox");
    expect(output).toContain(`Workspace Path: ${rootDir}`);
  });

  it("pins the status panel by reserving a dedicated top scroll region", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      {
        cwd: rootDir,
        profile: "default",
        requestedCwd: rootDir,
        workspaceMode: "full"
      },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("\x1B[10;24r");
    expect(output).toContain("+-- Status");
  });

  it("redraws the status panel after /clear", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/clear\n/quit\n");

    await startRepl(
      {
        cwd: rootDir,
        profile: "default",
        requestedCwd: rootDir,
        workspaceMode: "full"
      },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Workspace: full");
    expect(output.match(/\+-- Status/g)?.length).toBe(2);
  });

  it("refreshes the pinned status panel when the active session changes", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/new\n/quit\n");

    await startRepl(
      {
        cwd: rootDir,
        profile: "default",
        requestedCwd: rootDir,
        workspaceMode: "full"
      },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Started new session");
    expect(output.match(/\x1B7/g)?.length).toBeGreaterThanOrEqual(1);
    expect(output.match(/\+-- Status/g)?.length).toBe(2);
  });

  it("shows chat-only mode when no Git repository is detected", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        inspectRepository: async () => ({
          isRepository: false,
          isDirty: false,
          currentHead: null
        })
      }
    );

    expect(stdout.readAsString()).toContain("Chat-only mode");
  });

  it("offers git init when engineering intent is detected in chat-only mode", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
    stdin.isTTY = true;

    setImmediate(() => {
      stdin.write("implement a new api\n", "utf8");
      setTimeout(() => {
        stdin.write("y\n", "utf8");
      }, 250);
      setTimeout(() => {
        stdin.write("/quit\n", "utf8");
        stdin.end();
      }, 500);
    });
    let repoInitialized = false;
    const executeTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Implemented."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: executeTurn,
        inspectRepository: vi.fn().mockImplementation(async () => ({
          isRepository: repoInitialized,
          isDirty: false,
          currentHead: repoInitialized ? "abc123" : null
        })),
        initializeRepository: vi.fn().mockImplementation(async () => {
          repoInitialized = true;
          return {
            isRepository: true,
            isDirty: false,
            currentHead: null
          };
        })
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("╭─ You");
    expect(output).toContain("Initialize one now");
    expect(output).toContain("+-- Workspace");
    expect(output).toContain("Switched to project mode");
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  it("stays in chat-only mode when git init is declined", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
    stdin.isTTY = true;

    setImmediate(() => {
      stdin.write("create a project\n", "utf8");
      setTimeout(() => {
        stdin.write("n\n", "utf8");
      }, 250);
      setTimeout(() => {
        stdin.write("/quit\n", "utf8");
        stdin.end();
      }, 500);
    });
    const executeTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("I can help plan it once you enter a repository."));
    const initializeRepository = vi.fn();

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: executeTurn,
        inspectRepository: async () => ({
          isRepository: false,
          isDirty: false,
          currentHead: null
        }),
        initializeRepository
      }
    );

    const output = stdout.readAsString();
    expect(initializeRepository).not.toHaveBeenCalled();
    expect(output).toContain("+-- Workspace");
    expect(output).toContain("Continuing in chat-only mode");
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  it("handles /help command", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/help\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("+-- Commands");
    expect(output).toContain("/effect [mode]");
    expect(output).toContain("/model [name]");
    expect(output).toContain("/cost");
    expect(output).toContain("/multiline");
    expect(output).toContain("/new");
    expect(output).toContain("/quit");
  });

  it("shows plugin discovery status in the pinned status panel", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "index.js"
      }),
      ".deepvibe/plugins/demo/index.js": "export function createTools() { return []; }"
    });
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("Plugins: 1 enabled");
  });

  it("cycles the model strength with /effect and uses it on the next turn", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/effect\nship it\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Reasoning strength set to xhigh");
    expect(output).toContain("Profile: pro/xhigh -> deepseek-v4-pro/max");
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSettings: expect.objectContaining({
          model: "deepseek-v4-pro",
          reasoningEffort: "max"
        })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("supports explicitly setting the model strength with /effect <mode>", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/effect medium\nship it\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "deep" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(stdout.readAsString()).toContain("Reasoning strength set to medium");
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSettings: expect.objectContaining({
          model: "deepseek-v4-pro",
          reasoningEffort: "high"
        })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("shows a usage hint for unsupported /effect values", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/effect turbo\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Unknown reasoning strength: turbo");
    expect(output).toContain("Usage: /effect [low|medium|high|xhigh]");
  });

  it("toggles the model family with /model and uses the new profile on the next turn", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/model\nship it\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Model family set to flash");
    expect(output).toContain("Profile: flash/high -> deepseek-v4-flash/high");
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSettings: expect.objectContaining({
          model: "deepseek-v4-flash",
          reasoningEffort: "high"
        })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("keeps deep reasoning when switching back to pro with /model pro", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/model pro\nship it\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "deep" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Model family set to pro");
    expect(output).toContain("Profile: pro/xhigh -> deepseek-v4-pro/max");
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSettings: expect.objectContaining({
          model: "deepseek-v4-pro",
          reasoningEffort: "max"
        })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("maps xhigh to max even on the flash model", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/model flash\n/effect xhigh\nship it\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(stdout.readAsString()).toContain("Profile: flash/xhigh -> deepseek-v4-flash/max");
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSettings: expect.objectContaining({
          model: "deepseek-v4-flash",
          reasoningEffort: "max"
        })
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("shows a usage hint for unsupported /model values", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/model ultra\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Unknown model family: ultra");
    expect(output).toContain("Usage: /model [flash|pro]");
  });

  it("shows per-turn usage and session totals with /cost", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("ship it\n/cost\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue({
      ...createChatOnlyReplResult("Done."),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140
      }
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("[Usage] prompt=100 completion=40 total=140");
    expect(output).toContain("+-- Usage");
    expect(output).toContain("Session Total: prompt=100, completion=40, total=140");
  });

  it("supports explicit multi-line capture with /multiline", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/multiline\nline 1\nline 2\n\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "line 1\nline 2" }),
      expect.anything(),
      expect.anything()
    );
    expect(stdout.readAsString()).toContain("Multi-line capture started");
  });

  it("cancels explicit multi-line capture with .cancel", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/multiline\nline 1\n.cancel\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(mockTurn).not.toHaveBeenCalled();
    expect(stdout.readAsString()).toContain("Multi-line capture canceled");
  });

  it("auto-captures pasted multi-line input as a single turn", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
    stdin.isTTY = true;
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    setImmediate(() => {
      stdin.write("line 1\n", "utf8");
      stdin.write("line 2\n", "utf8");
      stdin.write("line 3\n", "utf8");
      setTimeout(() => {
        stdin.write("/quit\n", "utf8");
        stdin.end();
      }, 140);
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(mockTurn).toHaveBeenCalledTimes(1);
    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "line 1\nline 2\nline 3" }),
      expect.anything(),
      expect.anything()
    );
  });

  it("auto-captures fenced multi-line input as a single turn", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("```ts\nconst answer = 42;\n```\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(mockTurn).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "```ts\nconst answer = 42;\n```" }),
      expect.anything(),
      expect.anything()
    );
  });

  it("cancels fenced multi-line capture with .cancel", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("```ts\nconst answer = 42;\n.cancel\n/quit\n");
    const mockTurn = vi.fn().mockResolvedValue(createChatOnlyReplResult("Done."));

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    expect(mockTurn).not.toHaveBeenCalled();
    expect(stdout.readAsString()).toContain("Multi-line capture canceled");
  });

  it("handles /new command", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/new\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("Started new session");
  });

  it("handles /sessions command", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/sessions\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("active");
  });

  it("handles /history with empty history", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/history\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("No conversation history");
  });

  it("reports unknown commands", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/foobar\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("Unknown command");
  });

  it("executes a turn and streams content", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("do something\n/quit\n");

    const mockResult: ReplTurnResult = {
      context: {
        messages: [],
        files: [],
        projectMetadata: "",
        tokenEstimate: 0,
        maxPromptTokens: 100_000,
        truncated: false
      },
      conversationMessages: [
        { role: "user", content: "do something" },
        { role: "assistant", content: "Done!" }
      ],
      parsedResponse: {
        files: [],
        summary: "No changes needed."
      },
      repositoryState: {
        isRepository: true,
        isDirty: false,
        currentHead: "abc123"
      },
      scanResult: {
        candidates: [],
        explicitPaths: [],
        scannedFiles: 0
      },
      searchResults: [],
      toolCallsUsed: false,
      toolMutations: [],
      usage: null
    };

    const mockTurn = vi.fn().mockImplementation(async (_opts: unknown, _deps: unknown, callbacks?: { onContent?: (chunk: string) => void }) => {
      callbacks?.onContent?.("Done!");
      return mockResult;
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("╭─ You");
    expect(output).toContain("Done!");
  });

  it("shows thinking status, streams assistant output, and keeps reasoning hidden by default", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("do something\n/quit\n");

    const mockTurn = vi.fn().mockImplementation(async (_opts: unknown, _deps: unknown, callbacks?: { onContent?: (chunk: string) => void; onReasoningContent?: (chunk: string) => void }) => {
      callbacks?.onReasoningContent?.("I will inspect the request carefully.");
      callbacks?.onContent?.("Here is the final answer.");
      return createChatOnlyReplResult("Here is the final answer.");
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("[Thinking...]");
    expect(output).toContain("╭─ DeepVibe");
    expect(output).toContain("Here is the final answer.");
    expect(output).toContain("Thought process hidden");
    expect(output).not.toContain("I will inspect the request carefully.");
  });

  it("opens the latest thought trace with /thoughts and returns back to the REPL", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("do something\n/thoughts\n\n/quit\n");

    const mockTurn = vi.fn().mockImplementation(async (_opts: unknown, _deps: unknown, callbacks?: { onContent?: (chunk: string) => void; onReasoningContent?: (chunk: string) => void }) => {
      callbacks?.onReasoningContent?.("Detailed reasoning trace.");
      callbacks?.onContent?.("Visible answer.");
      return createChatOnlyReplResult("Visible answer.");
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Thought Trace");
    expect(output).toContain("Detailed reasoning trace.");
    expect(output).toContain("Press Enter, q, or Esc to return.");
  });

  it("supports returning from /thoughts with q", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("do something\n/thoughts\nq\n/quit\n");

    const mockTurn = vi.fn().mockImplementation(async (_opts: unknown, _deps: unknown, callbacks?: { onContent?: (chunk: string) => void; onReasoningContent?: (chunk: string) => void }) => {
      callbacks?.onReasoningContent?.("Another reasoning trace.");
      callbacks?.onContent?.("Visible answer.");
      return createChatOnlyReplResult("Visible answer.");
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: mockTurn,
        inspectRepository: mockInspectRepo()
      }
    );

    const output = stdout.readAsString();
    expect(output).toContain("Thought Trace");
    expect(output).toContain("Another reasoning trace.");
  });

  it("continues after turn error", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stderr = createWritableStream();
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
    stdin.isTTY = true;

    setImmediate(() => {
      stdin.write("fail\n", "utf8");
      setTimeout(() => {
        stdin.write("/help\n", "utf8");
      }, 800);
      setTimeout(() => {
        stdin.write("/quit\n", "utf8");
        stdin.end();
      }, 1600);
    });

    let callCount = 0;
    const mockTurn = vi.fn().mockImplementation(async () => {
      callCount++;

      if (callCount === 1) {
        throw new Error("API error");
      }

      return {
        context: {
          messages: [],
          files: [],
          projectMetadata: "",
          tokenEstimate: 0,
          maxPromptTokens: 100_000,
          truncated: false
        },
        conversationMessages: [],
        parsedResponse: { files: [], summary: "ok" },
        repositoryState: { isRepository: true, isDirty: false, currentHead: "abc" },
        scanResult: { candidates: [], explicitPaths: [], scannedFiles: 0 },
        searchResults: [],
        toolCallsUsed: false,
        toolMutations: [],
        usage: null
      };
    });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        stderr,
        executeReplTurn: mockTurn
      }
    );

    expect(stderr.readAsString()).toContain("Error: API error");
    expect(stdout.readAsString()).toContain("+-- Commands");
    expect(mockTurn).toHaveBeenCalledTimes(1);
  });

  it("prompts for confirmation when changes exist", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("make changes\na\n/quit\n");

    const mockResult: ReplTurnResult = {
      context: {
        messages: [],
        files: [],
        projectMetadata: "",
        tokenEstimate: 0,
        maxPromptTokens: 100_000,
        truncated: false
      },
      conversationMessages: [
        { role: "user", content: "make changes" },
        { role: "assistant", content: "changed" }
      ],
      parsedResponse: {
        files: [{ path: "src/a.ts", action: "modify", diff: "@@ -1 +1 @@\n-old\n+new" }],
        summary: "changed"
      },
      repositoryState: {
        isRepository: true,
        isDirty: false,
        currentHead: "abc123"
      },
      scanResult: {
        candidates: ["src/a.ts"],
        explicitPaths: [],
        scannedFiles: 1
      },
      searchResults: [],
      toolCallsUsed: false,
      toolMutations: [],
      usage: null
    };

    const mockApply = vi.fn().mockResolvedValue({ message: "ok" });

    await startRepl(
      { cwd: rootDir, profile: "default" },
      {
        stdin,
        stdout,
        executeReplTurn: vi.fn().mockResolvedValue(mockResult),
        applyPreparedExecution: mockApply,
        confirmReplExecution: vi.fn().mockResolvedValue(true)
      }
    );

    expect(mockApply).toHaveBeenCalled();
  });
});

describe("confirmReplExecution", () => {
  it("accepts with 'a'", async () => {
    const result = createReplResult();
    const input = createInputStream("a\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(true);
    expect(output.readAsString()).toContain("+-- Proposed Changes");
  });

  it("rejects with 'n'", async () => {
    const result = createReplResult();
    const input = createInputStream("n\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(false);
  });

  it("shows diffs on review then accepts", async () => {
    const result = createReplResult();
    const input = createInputStream("r\ny\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(true);
    expect(output.readAsString()).toContain("DIFF");
  });

  it("adds ANSI colors to diffs in TTY review mode", async () => {
    const result = createReplResult();
    result.parsedResponse.files[0]!.diff = "@@ -1 +1 @@\n-old\n+new";
    const input = createInputStream("r\ny\n");
    const output = createWritableStream();

    await confirmReplExecution(result, { input, output });

    const rendered = output.readAsString();
    expect(rendered).toContain("\x1B[35m@@ -1 +1 @@\x1B[0m");
    expect(rendered).toContain("\x1B[31m-old\x1B[0m");
    expect(rendered).toContain("\x1B[32m+new\x1B[0m");
  });

  it("review: selects files individually with yes/skip", async () => {
    const result = createMultiFileReplResult();
    const input = createInputStream("r\ny\ns\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(true);
    expect(result.parsedResponse.files).toHaveLength(1);
    expect(result.parsedResponse.files[0].path).toBe("src/a.ts");
  });

  it("review: select all remaining with 'a'", async () => {
    const result = createMultiFileReplResult();
    const input = createInputStream("r\na\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(true);
    expect(result.parsedResponse.files).toHaveLength(2);
  });

  it("review: quit cancels everything", async () => {
    const result = createMultiFileReplResult();
    const input = createInputStream("r\nq\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(false);
  });

  it("review: skip all files returns true but with empty selection", async () => {
    const result = createMultiFileReplResult();
    const input = createInputStream("r\ns\ns\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output });

    expect(confirmed).toBe(true);
    expect(result.parsedResponse.files).toHaveLength(0);
    expect(output.readAsString()).toContain("Selected 0 of 2");
  });
});

describe("completeReplInput", () => {
  it("completes slash commands and parameter values", () => {
    expect(completeReplInput("/co", { sessionIds: [] })[0]).toContain("/cost");
    expect(completeReplInput("/effect h", { sessionIds: [] })[0]).toEqual(["high"]);
    expect(completeReplInput("/model p", { sessionIds: [] })[0]).toEqual(["pro"]);
    expect(completeReplInput("/switch ses", { sessionIds: ["session-a", "other"] })[0]).toEqual(["session-a"]);
  });
});

describe("i18n", () => {
  it("displays Chinese welcome message when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("DeepVibe REPL 会话已启动");
  });

  it("displays Chinese help when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/help\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    const output = stdout.readAsString();
    expect(output).toContain("命令：");
    expect(output).toContain("开始新会话");
    expect(output).toContain("退出 REPL");
  });

  it("displays Chinese /new message when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/new\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("已开始新会话");
  });

  it("displays Chinese /history message when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/history\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("暂无对话历史");
  });

  it("displays Chinese /sessions message when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/sessions\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("当前");
  });

  it("displays Chinese unknown command message when lang is zh", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/foobar\n/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "zh" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("未知命令");
  });

  it("displays Chinese confirmation prompt when lang is zh", async () => {
    const result = createReplResult();
    const input = createInputStream("a\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output, lang: "zh" });

    expect(confirmed).toBe(true);
    expect(output.readAsString()).toContain("应用变更？");
  });

  it("displays Chinese review prompt when lang is zh", async () => {
    const result = createReplResult();
    const input = createInputStream("r\ny\n");
    const output = createWritableStream();

    const confirmed = await confirmReplExecution(result, { input, output, lang: "zh" });

    expect(confirmed).toBe(true);
    expect(output.readAsString()).toContain("应用此文件？");
  });

  it("displays English messages when lang is en", async () => {
    const rootDir = createWorkspace({});
    const stdout = createWritableStream();
    const stdin = createInputStream("/quit\n");

    await startRepl(
      { cwd: rootDir, profile: "default", lang: "en" },
      { stdin, stdout, inspectRepository: mockInspectRepo() }
    );

    expect(stdout.readAsString()).toContain("DeepVibe REPL session started");
  });
});

function createReplResult(): ReplTurnResult {
  return {
    context: {
      messages: [],
      files: [],
      projectMetadata: "",
      tokenEstimate: 0,
      maxPromptTokens: 100_000,
      truncated: false
    },
    conversationMessages: [],
    parsedResponse: {
      files: [{ path: "src/a.ts", action: "modify", diff: "DIFF" }],
      summary: "test change"
    },
    repositoryState: {
      isRepository: true,
      isDirty: false,
      currentHead: "abc123"
    },
    scanResult: {
      candidates: [],
      explicitPaths: [],
      scannedFiles: 0
    },
    searchResults: [],
    toolCallsUsed: false,
    toolMutations: [],
    usage: null
  };
}

function createChatOnlyReplResult(summary: string): ReplTurnResult {
  return {
    context: {
      messages: [],
      files: [],
      projectMetadata: "Chat-only mode",
      tokenEstimate: 0,
      maxPromptTokens: 100_000,
      truncated: false
    },
    conversationMessages: [],
    parsedResponse: {
      files: [],
      summary
    },
    repositoryState: {
      isRepository: false,
      isDirty: false,
      currentHead: null
    },
    scanResult: {
      candidates: [],
      explicitPaths: [],
      scannedFiles: 0
    },
    searchResults: [],
    toolCallsUsed: false,
    toolMutations: [],
    usage: null
  };
}

function createMultiFileReplResult(): ReplTurnResult {
  return {
    context: {
      messages: [],
      files: [],
      projectMetadata: "",
      tokenEstimate: 0,
      maxPromptTokens: 100_000,
      truncated: false
    },
    conversationMessages: [],
    parsedResponse: {
      files: [
        { path: "src/a.ts", action: "modify", diff: "DIFF_A" },
        { path: "src/b.ts", action: "modify", diff: "DIFF_B" }
      ],
      summary: "two file changes"
    },
    repositoryState: {
      isRepository: true,
      isDirty: false,
      currentHead: "abc123"
    },
    scanResult: {
      candidates: [],
      explicitPaths: [],
      scannedFiles: 0
    },
    searchResults: [],
    toolCallsUsed: false,
    toolMutations: [],
    usage: null
  };
}

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-repl-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

function createInputStream(contents: string, lineDelayMs = 40): NodeJS.ReadableStream {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;

  const lines = contents.split("\n");
  let i = 0;

  const writeNext = () => {
    if (i < lines.length) {
      stream.write(`${lines[i]}\n`, "utf8");
      i++;
      setTimeout(writeNext, lineDelayMs);
    } else {
      stream.end();
    }
  };

  setImmediate(writeNext);

  return stream;
}

function createWritableStream() {
  const stream = new PassThrough() as PassThrough & NodeJS.WritableStream & {
    isTTY?: boolean;
    rows?: number;
    readAsString: () => string;
  };
  stream.isTTY = true;
  stream.rows = 24;
  stream.readAsString = () => stream.read()?.toString("utf8") ?? "";

  return stream;
}

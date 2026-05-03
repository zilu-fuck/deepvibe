import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContext } from "../src/context/builder.js";
import { REPL_SYSTEM_PROMPT } from "../src/context/prompts.js";
import { REPL_CHAT_ONLY_SYSTEM_PROMPT } from "../src/context/repl-chat-only-prompt.js";
import { loadContextStore } from "../src/context-store.js";
import { ConfigError } from "../src/config.js";
import { applyPreparedExecution, EngineError, executePlanSteps, executeReplTurn, generatePlan, runEngine } from "../src/engine.js";
import type { ChatMessage } from "../src/llm/deepseek-client.js";
import { resolveModelProfile } from "../src/model-profile.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }

  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe("runEngine", () => {
  it("allows dry-run execution without an API key", async () => {
    const cwd = createWorkspace();

    const result = await runEngine(
      {
        cwd,
        dryRun: true,
        instruction: "summarize the project",
        profile: "default"
      },
      {
        searchWeb: vi.fn().mockResolvedValue([])
      }
    );

    expect(result.message).toContain("Dry run ready");
    expect(result.message).toContain("apiKeyConfigured=no");
  });

  it("requires a git repository for non-dry-run execution", async () => {
    const cwd = createWorkspace();

    await expect(
      runEngine({
        cwd,
        dryRun: false,
        instruction: "apply changes",
        profile: "default"
      })
    ).rejects.toThrowError(EngineError);
  });

  it("requires an API key once repository preconditions are satisfied", async () => {
    const cwd = createWorkspace();

    await expect(
      runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "apply changes",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: false,
            currentHead: "abc123"
          })
        }
      )
    ).rejects.toThrowError(ConfigError);
  });

  it("supports @web in dry-run mode and reports injected search results", async () => {
    const cwd = createWorkspace();

    const result = await runEngine(
      {
        cwd,
        dryRun: true,
        instruction: "summarize the project @web",
        profile: "default"
      },
      {
        searchWeb: vi.fn().mockResolvedValue([
          {
            title: "Example Result",
            url: "https://example.com",
            snippet: "Example snippet."
          }
        ])
      }
    );

    expect(result.message).toContain('instruction="summarize the project"');
    expect(result.message).toContain("searchResults=1");
  });

  it("records dry-run turns into .deepvibe/context.json", async () => {
    const cwd = createWorkspace();

    await runEngine(
      {
        cwd,
        dryRun: true,
        instruction: "summarize the project",
        profile: "default"
      },
      {
        searchWeb: vi.fn().mockResolvedValue([])
      }
    );

    const store = loadContextStore(cwd);

    expect(store.sessions[0]?.turns).toHaveLength(1);
    expect(store.sessions[0]?.turns[0]?.instruction).toBe("summarize the project");
  });

  it("loads .deepvibe/prompt.md into the built context", async () => {
    const cwd = createWorkspace({
      ".deepvibe/prompt.md": "请优先遵循项目中的错误处理约定。\n"
    });

    const buildContextSpy = vi.fn().mockImplementation(buildContext);

    await runEngine(
      {
        cwd,
        dryRun: true,
        instruction: "summarize the project",
        profile: "default"
      },
      {
        buildContext: buildContextSpy,
        searchWeb: vi.fn().mockResolvedValue([])
      }
    );

    const firstCallArgs = buildContextSpy.mock.calls[0]?.[0];

    expect(firstCallArgs?.projectPrompt).toContain("错误处理约定");
  });
});

describe("applyPreparedExecution", () => {
  it("returns a no-op result when no files are selected for apply", async () => {
    const applyFileChangesMock = vi.fn();
    const createAiCommitMock = vi.fn();
    const recordOperationMock = vi.fn();

    const result = await applyPreparedExecution(
      "F:/workspace",
      {
        context: {
          messages: [],
          files: [],
          maxPromptTokens: 1000,
          projectMetadata: "",
          tokenEstimate: 0,
          truncated: false
        },
        hasApiKey: true,
        instruction: "update api",
        parsedResponse: {
          files: [],
          summary: "No-op"
        },
        profile: {
          model: "deepseek-v4-pro",
          reasoningEffort: "high",
          contextLengthTokens: 1_000_000,
          reservedResponseTokens: 64_000,
          defaultScanCandidates: 12,
          maxContextFiles: 12
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
        toolMutations: [],
        toolCallsUsed: false
      },
      {
        applyFileChanges: applyFileChangesMock,
        createAiCommit: createAiCommitMock,
        recordOperation: recordOperationMock
      }
    );

    expect(result.message).toContain("No changes were applied");
    expect(applyFileChangesMock).not.toHaveBeenCalled();
    expect(createAiCommitMock).not.toHaveBeenCalled();
    expect(recordOperationMock).not.toHaveBeenCalled();
  });
});

describe("executeReplTurn", () => {
  it("supports chat-only mode outside a Git repository", async () => {
    const cwd = createWorkspace({});
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");

    const createStreamingCompletion = vi.fn().mockImplementation(async (_messages, _options, callbacks) => {
      callbacks?.onContent?.("Hello from chat mode.");
      return {
        id: "chat_1",
        content: "Hello from chat mode.",
        reasoningContent: "",
        finishReason: "stop",
        toolCalls: [],
        usage: null
      };
    });

    const result = await executeReplTurn(
      {
        conversationMessages: [],
        cwd,
        instruction: "Hello",
        profileSettings: resolveModelProfile("default")
      },
      {
        inspectRepository: async () => ({
          isRepository: false,
          isDirty: false,
          currentHead: null
        }),
        createClient: () => ({
          createCompletion: vi.fn(),
          createStreamingCompletion
        })
      }
    );

    expect(createStreamingCompletion).toHaveBeenCalledTimes(1);
    expect(result.repositoryState.isRepository).toBe(false);
    expect(result.scanResult.scannedFiles).toBe(0);
    expect(result.parsedResponse.files).toEqual([]);
    expect(result.parsedResponse.summary).toContain("Hello from chat mode.");
    expect(result.toolCallsUsed).toBe(false);
  });

  it("refreshes stale chat-only history after entering a Git repository", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");

    let capturedMessages: ChatMessage[] | undefined;
    const createStreamingCompletion = vi.fn().mockImplementation(async (
      messages: ChatMessage[],
      _options: unknown,
      callbacks?: { onContent?: (chunk: string) => void }
    ) => {
      capturedMessages = messages.map((message) => ({ ...message }));
      callbacks?.onContent?.("Ready in project mode.");
      return {
        id: "chat_2",
        content: "Ready in project mode.",
        reasoningContent: "",
        finishReason: "stop",
        toolCalls: [],
        usage: null
      };
    });

    await executeReplTurn(
      {
        conversationMessages: [
          { role: "system", content: REPL_CHAT_ONLY_SYSTEM_PROMPT },
          { role: "user", content: "User message:\ncreate a project" },
          { role: "assistant", content: "Run git init first." }
        ],
        cwd,
        instruction: "create src/app.ts",
        profileSettings: resolveModelProfile("default")
      },
      {
        createClient: () => ({
          createCompletion: vi.fn(),
          createStreamingCompletion
        }),
        createTools: () => [],
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        loadPluginTools: async () => [],
        scanProject: async () => ({
          candidates: ["src/index.ts"],
          explicitPaths: [],
          scannedFiles: 1
        })
      }
    );

    expect(createStreamingCompletion).toHaveBeenCalledTimes(1);
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages?.[0]).toEqual({
      role: "system",
      content: REPL_SYSTEM_PROMPT
    });
    expect(capturedMessages?.some((message) => message.role === "assistant" && message.content === "Run git init first.")).toBe(false);
    expect(capturedMessages?.[2]).toMatchObject({
      role: "user"
    });
    expect(capturedMessages?.[2]?.content).toContain("create src/app.ts");
  });
});

describe("generatePlan", () => {
  it("returns a parsed plan from the model response", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    const planJson = JSON.stringify({
      overview: "Add a greeting function",
      steps: [
        {
          index: 1,
          description: "Create greeting module",
          files: ["src/greeting.ts"],
          estimatedChanges: "~10 lines"
        }
      ],
      notes: ""
    });

    const result = await generatePlan(
      {
        cwd,
        dryRun: false,
        instruction: "add a greeting function",
        profile: "default"
      },
      {
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        createClient: () => ({
          createCompletion: vi.fn().mockResolvedValue({
            content: planJson,
            finishReason: "stop",
            toolCalls: []
          })
        })
      }
    );

    expect(result.plan.overview).toBe("Add a greeting function");
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0].description).toBe("Create greeting module");
  });

  it("throws when model returns invalid JSON", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    await expect(
      generatePlan(
        {
          cwd,
          dryRun: false,
          instruction: "add a greeting function",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: false,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion: vi.fn().mockResolvedValue({
              content: "not json",
              finishReason: "stop",
              toolCalls: []
            })
          })
        }
      )
    ).rejects.toThrowError(EngineError);
  });
});

describe("executePlanSteps", () => {
  it("executes all steps and returns results", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    const plan = {
      overview: "Add greeting",
      steps: [
        {
          index: 1,
          description: "Create greeting module",
          files: ["src/greeting.ts"],
          estimatedChanges: "~10 lines"
        }
      ],
      notes: ""
    };

    const fileChangeJson = JSON.stringify({
      summary: "Created greeting module",
      files: [
        {
          path: "src/greeting.ts",
          action: "create",
          diff: "--- /dev/null\n+++ b/src/greeting.ts\n@@ -0,0 +1 @@\n+export const greet = () => 'hello';\n"
        }
      ]
    });

    const results = await executePlanSteps(
      plan,
      {
        cwd,
        dryRun: false,
        instruction: "add greeting",
        profile: "default"
      },
      {
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        createClient: () => ({
          createCompletion: vi.fn().mockResolvedValue({
            content: fileChangeJson,
            finishReason: "stop",
            toolCalls: []
          })
        }),
        applyFileChanges: vi.fn().mockResolvedValue([]),
        createAiCommit: vi.fn().mockResolvedValue({ hash: "deadbeef", message: "test" }),
        recordOperation: vi.fn()
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(results[0].stepIndex).toBe(1);
  });

  it("stops on step failure and returns failed result", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    const plan = {
      overview: "Two-step plan",
      steps: [
        {
          index: 1,
          description: "First step",
          files: ["src/first.ts"],
          estimatedChanges: "~5 lines"
        },
        {
          index: 2,
          description: "Second step",
          files: ["src/second.ts"],
          estimatedChanges: "~5 lines"
        }
      ],
      notes: ""
    };

    let callCount = 0;

    const results = await executePlanSteps(
      plan,
      {
        cwd,
        dryRun: false,
        instruction: "two-step plan",
        profile: "default"
      },
      {
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        createClient: () => ({
          createCompletion: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({
                content: JSON.stringify({
                  summary: "First step done",
                  files: [{ path: "src/first.ts", action: "create", diff: "+x" }]
                }),
                finishReason: "stop",
                toolCalls: []
              });
            }
            return Promise.reject(new Error("API failure"));
          })
        }),
        applyFileChanges: vi.fn().mockResolvedValue([]),
        createAiCommit: vi.fn().mockResolvedValue({ hash: "deadbeef", message: "test" }),
        recordOperation: vi.fn()
      }
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("completed");
    expect(results[1].status).toBe("failed");
    expect(results[1].summary).toContain("API failure");
  });

  it("skips steps when confirmStep returns false", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    const plan = {
      overview: "Skippable plan",
      steps: [
        {
          index: 1,
          description: "Will be skipped",
          files: ["src/skip.ts"],
          estimatedChanges: "~5 lines"
        }
      ],
      notes: ""
    };

    const results = await executePlanSteps(
      plan,
      {
        cwd,
        dryRun: false,
        instruction: "skippable plan",
        profile: "default"
      },
      {
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        createClient: () => ({
          createCompletion: vi.fn().mockResolvedValue({
            content: JSON.stringify({
              summary: "Should not reach here",
              files: [{ path: "src/skip.ts", action: "create", diff: "+x" }]
            }),
            finishReason: "stop",
            toolCalls: []
          })
        }),
        confirmStep: vi.fn().mockResolvedValue(false)
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");
  });

  it("calls rollbackOnFailure when enabled", async () => {
    const cwd = createWorkspace({
      "src/index.ts": "console.log('hello');"
    });
    mkdirSync(path.join(cwd, ".deepvibe"), { recursive: true });
    writeFileSync(path.join(cwd, ".deepvibe", "config.json"), JSON.stringify({ apiKey: "test-key" }), "utf8");
    initGit(cwd);

    const plan = {
      overview: "Rollback plan",
      steps: [
        {
          index: 1,
          description: "Create a file",
          files: ["src/created.ts"],
          estimatedChanges: "~5 lines"
        },
        {
          index: 2,
          description: "Failing step",
          files: ["src/fail.ts"],
          estimatedChanges: "~5 lines"
        }
      ],
      notes: ""
    };

    const applyFileChangesMock = vi.fn().mockResolvedValue([]);
    let callCount = 0;

    const results = await executePlanSteps(
      plan,
      {
        cwd,
        dryRun: false,
        instruction: "rollback plan",
        profile: "default"
      },
      {
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        createClient: () => ({
          createCompletion: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({
                content: JSON.stringify({
                  summary: "Created file",
                  files: [{ path: "src/created.ts", action: "create", diff: "+x" }]
                }),
                finishReason: "stop",
                toolCalls: []
              });
            }
            return Promise.reject(new Error("Step 2 failed"));
          })
        }),
        applyFileChanges: applyFileChangesMock,
        createAiCommit: vi.fn().mockResolvedValue({ hash: "deadbeef", message: "test" }),
        recordOperation: vi.fn(),
        rollbackOnFailure: true
      }
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("completed");
    expect(results[1].status).toBe("failed");

    // Rollback should call applyFileChanges with a delete action for the created file
    const rollbackCall = applyFileChangesMock.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && call[1].some((f: { action: string }) => f.action === "delete")
    );
    expect(rollbackCall).toBeDefined();
  });
});

function initGit(cwd: string): void {
  const { execSync } = require("node:child_process");
  execSync("git init", { cwd, stdio: "ignore" });
  execSync('git config user.email "test@deepvibe.test"', { cwd, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd, stdio: "ignore" });
  execSync("git add -A", { cwd, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd, stdio: "ignore" });
}

function createWorkspace(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "deepvibe-engine-"));
  tempDirs.push(cwd);
  const homeDir = path.join(cwd, "home");
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  mkdirSync(homeDir, { recursive: true });
  const deepvibeDir = path.join(cwd, ".deepvibe");
  mkdirSync(deepvibeDir, { recursive: true });
  writeFileSync(path.join(deepvibeDir, "config.json"), '{"apiKey":""}', "utf8");
  mkdirSync(cwd, { recursive: true });

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return cwd;
}

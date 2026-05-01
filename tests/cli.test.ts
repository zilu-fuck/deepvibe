import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCommandPersistentlyApproved,
  loadCommandApprovalStore,
  rememberApprovedCommand
} from "../src/command-approval-store.js";
import {
  confirmCommandExecution,
  confirmLandingPreparedExecution,
  ensureApiKeyConfigured,
  formatLandingExecutionSummary,
  formatPreparedExecutionDiffs,
  formatPreparedExecutionSummary,
  reviewPreparedExecutionFiles,
  runCli
} from "../src/cli.js";
import { setConfigValue } from "../src/config.js";
import type { PreparedExecution } from "../src/engine.js";

const tempDirs: string[] = [];

describe("runCli", () => {
  afterEach(() => {
    process.exitCode = undefined;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();

      if (dir) {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  it("requires --force when interactive confirmation is unavailable", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    writeGlobalConfig(homeDir, { apiKey: "test-key" });
    const stdout = createWritableStream(false);
    const stderr = createWritableStream(false);

    await runCli(["node", "deepvibe", "update api"], {
      applyPreparedExecution: vi.fn(),
      cwd: () => cwd,
      homeDir,
      prepareExecution: vi.fn().mockResolvedValue(createPreparedExecution()),
      stderr,
      stdin: createInputStream("", false),
      stdout
    });

    expect(stderr.readAsString()).toContain("Interactive confirmation requires a TTY");
    expect(process.exitCode).toBe(1);
  });

  it("supports config set for global config", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");

    mkdirSync(homeDir, { recursive: true });

    const stdout = createWritableStream(false);

    await runCli(["node", "deepvibe", "config", "set", "api_key", "secret-key"], {
      cwd: () => cwd,
      homeDir,
      stderr: createWritableStream(false),
      stdin: createInputStream("", false),
      stdout
    });

    expect(readFileSync(path.join(homeDir, ".deepvibe", "config.json"), "utf8")).toContain("\"apiKey\": \"secret-key\"");
    expect(stdout.readAsString()).toContain("Saved apiKey");
  });

  it("supports config set --project for project config", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");

    mkdirSync(homeDir, { recursive: true });

    const stdout = createWritableStream(false);

    await runCli(["node", "deepvibe", "config", "set", "default_model", "deepseek-v4-flash", "--project"], {
      cwd: () => cwd,
      homeDir,
      stderr: createWritableStream(false),
      stdin: createInputStream("", false),
      stdout
    });

    expect(readFileSync(path.join(cwd, ".deepvibe", "config.json"), "utf8")).toContain("\"defaultModel\": \"deepseek-v4-flash\"");
    expect(stdout.readAsString()).toContain("Saved defaultModel");
  });

  it("supports serve and reports the listening address", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    writeGlobalConfig(homeDir, { apiKey: "test-key" });
    const stdout = createWritableStream(false);
    const startService = vi.fn().mockResolvedValue({
      host: "127.0.0.1",
      port: 4242,
      server: {} as never,
      close: async () => {}
    });

    await runCli(["node", "deepvibe", "serve", "--port", "4242"], {
      cwd: () => cwd,
      homeDir,
      startService,
      stderr: createWritableStream(false),
      stdin: createInputStream("", false),
      stdout
    });

    expect(startService).toHaveBeenCalledTimes(1);
    expect(stdout.readAsString()).toContain("DeepVibe service listening on http://127.0.0.1:4242");
  });

  it("passes workspace access mode through to the chat REPL", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    const sandboxDir = path.join(cwd, ".sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    writeGlobalConfig(homeDir, { apiKey: "test-key" });
    const startRepl = vi.fn().mockResolvedValue(undefined);

    await runCli(["node", "deepvibe", "chat"], {
      cwd: () => cwd,
      homeDir,
      prepareWorkspaceAccess: vi.fn().mockResolvedValue({
        requestedCwd: cwd,
        effectiveCwd: sandboxDir,
        mode: "sandbox"
      }),
      startRepl,
      stderr: createWritableStream(false),
      stdin: createInputStream("", false),
      stdout: createWritableStream(false)
    });

    expect(startRepl).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: sandboxDir,
        requestedCwd: cwd,
        workspaceMode: "sandbox"
      }),
      expect.any(Object)
    );
  });

  it("applies immediately when --force is provided", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    writeGlobalConfig(homeDir, { apiKey: "test-key" });
    const stdout = createWritableStream(false);
    const applyPreparedExecution = vi.fn().mockResolvedValue({
      message: "Applied with force"
    });

    await runCli(["node", "deepvibe", "--force", "update api"], {
      applyPreparedExecution,
      cwd: () => cwd,
      homeDir,
      prepareExecution: vi.fn().mockResolvedValue(createPreparedExecution()),
      stderr: createWritableStream(false),
      stdin: createInputStream("", false),
      stdout
    });

    expect(applyPreparedExecution).toHaveBeenCalledTimes(1);
    expect(stdout.readAsString()).toContain("Applied with force");
  });

  it("supports review before accepting an execution plan", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    writeGlobalConfig(homeDir, { apiKey: "test-key" });
    const stdout = createWritableStream(true);
    const applyPreparedExecution = vi.fn().mockResolvedValue({
      message: "Applied after review"
    });
    const prepared = createPreparedExecution();

    await runCli(["node", "deepvibe", "update api"], {
      applyPreparedExecution,
      cwd: () => cwd,
      homeDir,
      prepareWorkspaceAccess: vi.fn().mockResolvedValue({
        requestedCwd: cwd,
        effectiveCwd: cwd,
        mode: "full"
      }),
      confirmPreparedExecution: vi.fn().mockImplementation(async (execution, streams) => {
        streams.output.write(`${formatPreparedExecutionSummary(execution)}\n`);
        streams.output.write(`${formatPreparedExecutionDiffs(execution)}\n`);
        return true;
      }),
      prepareExecution: vi.fn().mockResolvedValue(prepared),
      stderr: createWritableStream(true),
      stdin: createInputStream("", true),
      stdout
    });

    const output = stdout.readAsString();

    expect(output).toContain("Planned changes: 1 file(s)");
    expect(output).toContain("--- MODIFY src/api.ts ---");
    expect(applyPreparedExecution).toHaveBeenCalledTimes(1);
  });

  it("applies only the files selected during review", async () => {
    const stdout = createWritableStream(true);
    const prepared = createPreparedExecution([
      {
        path: "src/api.ts",
        action: "modify",
        diff: [
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const value = 1;",
          "+export const value = 2;"
        ].join("\n")
      },
      {
        path: "src/extra.ts",
        action: "create",
        diff: [
          "--- /dev/null",
          "+++ b/src/extra.ts",
          "@@ -0,0 +1,1 @@",
          "+export const extra = true;"
        ].join("\n")
      }
    ]);
    const readline = {
      question: vi.fn()
        .mockResolvedValueOnce("y")
        .mockResolvedValueOnce("s")
    } as unknown as ReturnType<typeof import("node:readline/promises").createInterface>;

    const result = await reviewPreparedExecutionFiles(prepared, readline, stdout);

    expect(result).toBe("apply");
    expect(prepared.parsedResponse.files).toHaveLength(1);
    expect(prepared.parsedResponse.files[0]?.path).toBe("src/api.ts");
    expect(stdout.readAsString()).toContain("Selected 1 of 2 file(s) for apply.");
  });

  it("returns skip when review selects no files", async () => {
    const stdout = createWritableStream(true);
    const prepared = createPreparedExecution([
      {
        path: "src/api.ts",
        action: "modify",
        diff: [
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const value = 1;",
          "+export const value = 2;"
        ].join("\n")
      },
      {
        path: "src/extra.ts",
        action: "create",
        diff: [
          "--- /dev/null",
          "+++ b/src/extra.ts",
          "@@ -0,0 +1,1 @@",
          "+export const extra = true;"
        ].join("\n")
      }
    ]);
    const readline = {
      question: vi.fn()
        .mockResolvedValueOnce("s")
        .mockResolvedValueOnce("s")
    } as unknown as ReturnType<typeof import("node:readline/promises").createInterface>;

    const result = await reviewPreparedExecutionFiles(prepared, readline, stdout);

    expect(result).toBe("skip");
    expect(prepared.parsedResponse.files).toHaveLength(0);
    expect(stdout.readAsString()).toContain("Selected 0 of 2 file(s) for apply.");
  });

  it("formats a dedicated sandbox landing review summary", () => {
    const prepared = createPreparedExecution([
      {
        path: "src/api.ts",
        action: "modify",
        diff: [
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const value = 1;",
          "+export const value = 2;"
        ].join("\n")
      }
    ]);

    const summary = formatLandingExecutionSummary(prepared);

    expect(summary).toContain("Sandbox Landing Review");
    expect(summary).toContain("actual file changes");
    expect(summary).toContain("Landing changes: 1 file(s)");
  });

  it("supports a dedicated confirmation flow for landing sandbox changes", async () => {
    const prepared = createPreparedExecution([
      {
        path: "src/api.ts",
        action: "modify",
        diff: [
          "--- a/src/api.ts",
          "+++ b/src/api.ts",
          "@@ -1,1 +1,1 @@",
          "-export const value = 1;",
          "+export const value = 2;"
        ].join("\n")
      }
    ]);

    const confirmed = await confirmLandingPreparedExecution(prepared, {
      input: createInputStream("a\n", true),
      output: createWritableStream(true)
    });

    expect(confirmed).toBe(true);
  });

  it("fails with a clear message when API is missing in non-interactive mode", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    mkdirSync(homeDir, { recursive: true });
    const stderr = createWritableStream(false);

    await runCli(["node", "deepvibe", "--force", "update api"], {
      cwd: () => cwd,
      homeDir,
      prepareExecution: vi.fn().mockResolvedValue(createPreparedExecution()),
      stderr,
      stdin: createInputStream("", false),
      stdout: createWritableStream(false)
    });

    expect(stderr.readAsString()).toContain("DeepSeek API key is not configured");
    expect(process.exitCode).toBe(1);
  });

  it("offers persistent approval when configured and stores the approved command", async () => {
    const cwd = createCliWorkspace({
      ".deepvibe/config.json": JSON.stringify(
        {
          toolPermissions: {
            command: {
              enabled: true,
              allowedPrefixes: ["git status"],
              persistApprovals: true
            }
          }
        },
        null,
        2
      )
    });
    const stdout = createWritableStream(true);
    const decision = await confirmCommandExecution(
      {
        cwd: ".",
        command: "git status --short",
        risk: "low"
      },
      {
        allowPersistentApproval: true,
        input: createInputStream("a\n", true),
        output: stdout
      }
    );

    expect(decision).toBe("approve_and_remember");

    let store = loadCommandApprovalStore(cwd);
    store = rememberApprovedCommand(cwd, store, {
      cwd: ".",
      command: "git status --short"
    });

    expect(isCommandPersistentlyApproved(store, { cwd: ".", command: "git status --short" })).toBe(true);
    expect(readFileSync(path.join(cwd, ".deepvibe", "command-approvals.json"), "utf8")).toContain("git status --short");
    expect(stdout.readAsString()).toContain("Allow low-risk command? [Y]es once [A]lways [N]o");
  });

  it("uses one-shot confirmation wording for medium-risk commands", async () => {
    const stdout = createWritableStream(true);
    const decision = await confirmCommandExecution(
      {
        cwd: ".",
        command: "git add src/api.ts",
        risk: "medium"
      },
      {
        allowPersistentApproval: true,
        input: createInputStream("y\n", true),
        output: stdout
      }
    );

    expect(decision).toBe("approve_once");
    expect(stdout.readAsString()).toContain("Allow medium-risk command once? [Y]es [N]o");
  });

  it("requires explicit allow text for high-risk commands", async () => {
    const stdout = createWritableStream(true);
    const decision = await confirmCommandExecution(
      {
        cwd: ".",
        command: "git push origin main",
        risk: "high"
      },
      {
        allowPersistentApproval: true,
        input: createInputStream("allow\n", true),
        output: stdout
      }
    );

    expect(decision).toBe("approve_once");
    expect(stdout.readAsString()).toContain('High-risk command. Type "allow" to continue or [N]o');
  });
});

describe("ensureApiKeyConfigured", () => {
  it("returns the existing config without prompting when apiKey is already present", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    writeGlobalConfig(homeDir, { apiKey: "existing-key" });

    const result = await ensureApiKeyConfigured({
      config: {
        apiKey: "existing-key",
        globalConfigPath: path.join(homeDir, ".deepvibe", "config.json")
      } as ReturnType<typeof import("../src/config.js").loadConfig>,
      cwd,
      homeDir,
      input: createInputStream("", true),
      output: createWritableStream(true),
      setConfigValue: vi.fn()
    });

    expect(result.apiKey).toBe("existing-key");
  });

  it("prompts for and saves the API key when missing", async () => {
    const cwd = createCliWorkspace({});
    const homeDir = path.join(cwd, "home");
    mkdirSync(homeDir, { recursive: true });
    const output = createWritableStream(true);
    const readline = {
      question: vi.fn()
        .mockResolvedValueOnce("y")
        .mockResolvedValueOnce("secret-key"),
      close: vi.fn()
    };

    const result = await ensureApiKeyConfigured({
      config: {
        globalConfigPath: path.join(homeDir, ".deepvibe", "config.json")
      } as ReturnType<typeof import("../src/config.js").loadConfig>,
      createInterfaceFn: vi.fn().mockReturnValue(readline as never),
      cwd,
      homeDir,
      input: createInputStream("", true),
      output,
      setConfigValue: (options) => setConfigValue(options)
    });

    expect(result.apiKey).toBe("secret-key");
    expect(readFileSync(path.join(homeDir, ".deepvibe", "config.json"), "utf8")).toContain("\"apiKey\": \"secret-key\"");
    expect(readline.question).toHaveBeenNthCalledWith(1, "DeepSeek API key is not configured. Configure it now? [Y]es [N]o: ");
    expect(readline.question).toHaveBeenNthCalledWith(2, "Enter DeepSeek API key (will be saved to global config): ");
    expect(output.readAsString()).toContain("Saved apiKey");
  });
});

function createPreparedExecution(
  files: PreparedExecution["parsedResponse"]["files"] = [
    {
      path: "src/api.ts",
      action: "modify",
      diff: [
        "--- a/src/api.ts",
        "+++ b/src/api.ts",
        "@@ -1,1 +1,1 @@",
        "-export const value = 1;",
        "+export const value = 2;"
      ].join("\n")
    }
  ]
): PreparedExecution {
  return {
    configProjectPath: "F:/workspace/.deepvibe/config.json",
    context: {
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "Project metadata" },
        { role: "user", content: "Task payload" }
      ],
      files: [
        {
          path: "src/api.ts",
          content: "export const value = 1;\n",
          mode: "full",
          tokenEstimate: 10
        }
      ],
      maxPromptTokens: 1000,
      projectMetadata: "Project metadata",
      tokenEstimate: 120,
      truncated: false
    },
    hasApiKey: true,
    instruction: "update api",
    parsedResponse: {
      files,
      summary: "Update API value"
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
      isDirty: true,
      currentHead: "abc123"
    },
    searchResults: [],
    toolMutations: [],
    toolCallsUsed: false,
    scanResult: {
      candidates: ["src/api.ts"],
      explicitPaths: [],
      scannedFiles: 1
    }
  };
}

function createInputStream(contents: string, isTTY: boolean): NodeJS.ReadableStream {
  const chunks = contents.length > 0 ? contents.match(/[^\n]*\n?/g)?.filter((chunk) => chunk.length > 0) ?? [] : [];
  const stream = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = isTTY;

  chunks.forEach((chunk, index) => {
    setTimeout(() => {
      stream.write(chunk, "utf8");

      if (index === chunks.length - 1) {
        setTimeout(() => stream.end(), 5);
      }
    }, index * 5);
  });

  if (chunks.length === 0) {
    setTimeout(() => stream.end(), 5);
  }

  return stream;
}

function createWritableStream(isTTY: boolean) {
  let buffer = "";
  const stream = new PassThrough() as PassThrough & NodeJS.WritableStream & {
    isTTY?: boolean;
    readAsString: () => string;
  };
  stream.isTTY = isTTY;
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  stream.readAsString = () => buffer;

  return stream;
}

function createCliWorkspace(files: Record<string, string>): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "deepvibe-cli-"));
  tempDirs.push(cwd);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return cwd;
}

function writeGlobalConfig(homeDir: string, contents: Record<string, unknown>): void {
  const filePath = path.join(homeDir, ".deepvibe", "config.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(contents, null, 2), "utf8");
}

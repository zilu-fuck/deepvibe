import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDockerSandboxInvocation,
  createDockerSandboxCommandRunner,
  createDefaultTools,
  createToolMutationState,
  executeToolCalls,
  listToolMutations,
  resolveConfiguredCommandRunner,
  resolveCommandPermissions,
  rollbackToolMutations
} from "../src/tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("tools", () => {
  it("creates read-only default tools and adds web_search when @web is present", () => {
    const basicTools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect the project"
    });
    const webTools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect the project @web"
    });

    expect(basicTools.map((tool) => tool.definition.function.name)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "delete_file"
    ]);
    expect(webTools.map((tool) => tool.definition.function.name)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "delete_file",
      "web_search"
    ]);
  });

  it("executes list_files and read_file tool calls", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      "src/other.ts": "export const other = 2;\n"
    });
    const tools = createDefaultTools({
      rootDir,
      instruction: "inspect files"
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "list_files",
            arguments: "{\"directory\":\"src\",\"limit\":10}"
          }
        },
        {
          id: "call_2",
          type: "function",
          function: {
            name: "read_file",
            arguments: "{\"path\":\"src/api.ts\"}"
          }
        }
      ],
      tools,
      {
        rootDir,
        instruction: "inspect files"
      }
    );

    expect(results[0]?.content).toContain("src/api.ts");
    expect(results[1]?.content).toContain("export const value = 1;");
  });

  it("returns structured tool errors for unknown tools", async () => {
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files"
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_unknown",
          type: "function",
          function: {
            name: "missing_tool",
            arguments: "{}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files"
      }
    );

    expect(results[0]?.content).toContain("Unknown tool");
  });

  it("tracks safe write and delete mutations and can roll them back", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });
    const mutations = createToolMutationState();
    const tools = createDefaultTools({
      rootDir,
      instruction: "modify files",
      mutations
    });

    await executeToolCalls(
      [
        {
          id: "call_write",
          type: "function",
          function: {
            name: "write_file",
            arguments: "{\"path\":\"src/api.ts\",\"content\":\"export const value = 2;\\n\"}"
          }
        },
        {
          id: "call_delete",
          type: "function",
          function: {
            name: "delete_file",
            arguments: "{\"path\":\"src/api.ts\"}"
          }
        }
      ],
      tools,
      {
        rootDir,
        instruction: "modify files",
        mutations
      }
    );

    const recordedMutations = listToolMutations(mutations);

    expect(recordedMutations).toHaveLength(1);
    expect(recordedMutations[0]).toMatchObject({
      action: "delete",
      beforeContent: "export const value = 1;\n",
      afterContent: null,
      path: "src/api.ts"
    });

    rollbackToolMutations(mutations, rootDir);
    expect(readFileSync(path.join(rootDir, "src/api.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("only exposes run_command when command permissions are enabled", () => {
    const withoutPermissions = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files"
    });
    const withPermissions = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: resolveCommandPermissions({
        enabled: true,
        commandPolicies: [{ prefix: "git status", risk: "low" }]
      })
    });

    expect(withoutPermissions.some((tool) => tool.definition.function.name === "run_command")).toBe(false);
    expect(withPermissions.some((tool) => tool.definition.function.name === "run_command")).toBe(true);
  });

  it("executes allowed run_command calls through the injected runner", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: " M src/api.ts\n",
      stderr: ""
    });
    const commandApproval = vi.fn().mockResolvedValue(true);
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: resolveCommandPermissions({
        enabled: true,
        commandPolicies: [{ prefix: "git status", risk: "low" }]
      }),
      commandRunner: runner,
      commandApproval,
      approvedCommands: new Set<string>()
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: resolveCommandPermissions({
          enabled: true,
          commandPolicies: [{ prefix: "git status", risk: "low" }]
        }),
        commandRunner: runner,
        commandApproval,
        approvedCommands: new Set<string>()
      }
    );

    expect(commandApproval).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(results[0]?.content).toContain("\"exitCode\":0");
    expect(results[0]?.content).toContain("src/api.ts");
  });

  it("rejects run_command calls outside the configured allowlist", async () => {
    const runner = vi.fn();
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: resolveCommandPermissions({
        enabled: true,
        commandPolicies: [{ prefix: "git status", risk: "low" }]
      }),
      commandRunner: runner
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git reset --hard\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: resolveCommandPermissions({
          enabled: true,
          commandPolicies: [{ prefix: "git status", risk: "low" }]
        }),
        commandRunner: runner
      }
    );

    expect(runner).not.toHaveBeenCalled();
    expect(results[0]?.content).toContain("Detected a potentially dangerous command");
    expect(results[0]?.content).toContain("Allowed prefixes");
  });

  it("rejects run_command when interactive approval is denied", async () => {
    const runner = vi.fn();
    const commandApproval = vi.fn().mockResolvedValue(false);
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: resolveCommandPermissions({
        enabled: true,
        commandPolicies: [{ prefix: "git status", risk: "low" }]
      }),
      commandRunner: runner,
      commandApproval,
      approvedCommands: new Set<string>()
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: resolveCommandPermissions({
          enabled: true,
          commandPolicies: [{ prefix: "git status", risk: "low" }]
        }),
        commandRunner: runner,
        commandApproval,
        approvedCommands: new Set<string>()
      }
    );

    expect(commandApproval).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    expect(results[0]?.content).toContain("Approval was denied");
    expect(results[0]?.content).toContain("Suggested safer path");
  });

  it("prefers the most specific matching command policy", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });
    const permissions = resolveCommandPermissions({
      enabled: true,
      requireApproval: false,
      timeoutMs: 5000,
      maxOutputChars: 4000,
      commandPolicies: [
        { prefix: "git status", risk: "low", timeoutMs: 5000, maxOutputChars: 4000 },
        { prefix: "git status --short", risk: "medium", timeoutMs: 9000, maxOutputChars: 1200 }
      ]
    });
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner
    });

    await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner
      }
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 9000,
        maxOutputChars: 1200
      })
    );
  });

  it("rejects run_command in service mode when the policy disallows it", async () => {
    const runner = vi.fn();
    const permissions = resolveCommandPermissions({
      enabled: true,
      commandPolicies: [{ prefix: "git status", risk: "low", allowInService: false }]
    });
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner
    });

    const results = await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        executionMode: "service",
        commandPermissions: permissions,
        commandRunner: runner
      }
    );

    expect(runner).not.toHaveBeenCalled();
    expect(results[0]?.content).toContain("not allowed in service mode");
    expect(results[0]?.content).toContain("interactive local session");
  });

  it("rejects run_command outside allowed directories and on dirty trees when required", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      "tests/api.test.ts": "export const testValue = 1;\n"
    });
    const runner = vi.fn();
    const permissions = resolveCommandPermissions({
      enabled: true,
      commandPolicies: [
        {
          prefix: "git add",
          risk: "medium",
          allowedDirectories: ["src"],
          requireCleanGit: true
        }
      ]
    });
    const tools = createDefaultTools({
      rootDir,
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner
    });

    const dirtyResults = await executeToolCalls(
      [
        {
          id: "call_dirty",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git add api.ts\",\"cwd\":\"src\"}"
          }
        }
      ],
      tools,
      {
        rootDir,
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner,
        repositoryState: { isDirty: true }
      }
    );

    const directoryResults = await executeToolCalls(
      [
        {
          id: "call_dir",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git add api.ts\",\"cwd\":\"tests\"}"
          }
        }
      ],
      tools,
      {
        rootDir,
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner,
        repositoryState: { isDirty: false }
      }
    );

    expect(runner).not.toHaveBeenCalled();
    expect(dirtyResults[0]?.content).toContain("requires a clean Git working tree");
    expect(dirtyResults[0]?.content).toContain("git status or git diff");
    expect(directoryResults[0]?.content).toContain("not allowed in working directory");
    expect(directoryResults[0]?.content).toContain("Allowed directories");
  });

  it("supports legacy allowedPrefixes compatibility mode", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });
    const permissions = resolveCommandPermissions({
      enabled: true,
      requireApproval: false,
      allowedPrefixes: ["git status", "pnpm test"]
    });
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner
    });

    await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner
      }
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git status --short"
      })
    );
  });

  it("uses global timeoutMs and maxOutputChars fallback when per-policy values are not set", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });
    const permissions = resolveCommandPermissions({
      enabled: true,
      requireApproval: false,
      timeoutMs: 15000,
      maxOutputChars: 32000,
      commandPolicies: [
        { prefix: "git status", risk: "low" }
      ]
    });
    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner
    });

    await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner
      }
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 15000,
        maxOutputChars: 32000
      })
    );
  });

  it("allows persistent approval when policy permits it", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });
    const commandApproval = vi.fn().mockResolvedValue(true);
    const permissions = resolveCommandPermissions({
      enabled: true,
      commandPolicies: [
        { prefix: "git status", risk: "low", allowPersistentApproval: true }
      ]
    });
    const approvedCommands = new Set<string>();

    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner,
      commandApproval,
      approvedCommands
    });

    await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner,
        commandApproval,
        approvedCommands
      }
    );

    expect(commandApproval).toHaveBeenCalledTimes(1);
    expect(commandApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPersistentApproval: true,
        risk: "low"
      })
    );
  });

  it("skips approval for already-approved commands", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });
    const commandApproval = vi.fn().mockResolvedValue(true);
    const permissions = resolveCommandPermissions({
      enabled: true,
      commandPolicies: [
        { prefix: "git status", risk: "low" }
      ]
    });
    const approvedCommands = new Set<string>();
    approvedCommands.add(".::git status --short");

    const tools = createDefaultTools({
      rootDir: "F:/workspace",
      instruction: "inspect files",
      commandPermissions: permissions,
      commandRunner: runner,
      commandApproval,
      approvedCommands
    });

    await executeToolCalls(
      [
        {
          id: "call_cmd",
          type: "function",
          function: {
            name: "run_command",
            arguments: "{\"command\":\"git status --short\"}"
          }
        }
      ],
      tools,
      {
        rootDir: "F:/workspace",
        instruction: "inspect files",
        commandPermissions: permissions,
        commandRunner: runner,
        commandApproval,
        approvedCommands
      }
    );

    expect(commandApproval).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("builds a readonly docker sandbox invocation for commands", () => {
    const invocation = buildDockerSandboxInvocation(
      "F:/workspace",
      {
        command: "git status --short",
        cwd: "F:/workspace/src",
        maxOutputChars: 4000,
        timeoutMs: 5000
      },
      {
        image: "node:20-alpine",
        mountPath: "/workspace",
        network: "none",
        readOnlyRootFilesystem: true,
        tmpfsPaths: ["/tmp", "/var/tmp"]
      }
    );

    expect(invocation.file).toBe("docker");
    expect(invocation.args).toContain("--read-only");
    expect(invocation.args).toContain("node:20-alpine");
    expect(invocation.args).toContain("git status --short");
    expect(invocation.args).toContain("/workspace/src");
    expect(invocation.args.join(" ")).toContain("readonly");
  });

  it("resolves a docker sandbox runner from config", () => {
    const runner = resolveConfiguredCommandRunner("F:/workspace", {
      enabled: true,
      sandbox: {
        enabled: true,
        image: "node:20-alpine"
      }
    });

    expect(runner).toBeDefined();
  });

  it("returns a clear result or error for docker sandbox execution", async () => {
    const runner = createDockerSandboxCommandRunner("F:/workspace", {
      image: "node:20-alpine"
    });

    try {
      const result = await runner({
        command: "git status --short",
        cwd: "F:/workspace",
        maxOutputChars: 4000,
        timeoutMs: 1000
      });

      expect(typeof result.exitCode).toBe("number");
    } catch (error) {
      expect(String(error)).toMatch(/Docker executable was not found|spawn docker|timed out/i);
    }
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-tools-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

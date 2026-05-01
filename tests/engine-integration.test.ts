import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runEngine } from "../src/engine.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("runEngine integration", () => {
  it("applies model-produced changes and records an operation for dirty repositories", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2)
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "update api value",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion: async () => ({
              id: "chat_1",
              content: JSON.stringify({
                files: [
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
                ],
                summary: "Updated API value"
              }),
              reasoningContent: "reasoning",
              finishReason: "stop",
              toolCalls: [],
              usage: { total_tokens: 42 }
            })
          })
        }
      );

      expect(readFileSync(path.join(cwd, "src/api.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(result.message).toContain("appliedFiles=1");
      expect(result.message).toContain("operation=op_");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("fails before write stage when the model response is invalid", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2)
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      await expect(
        runEngine(
          {
            cwd,
            dryRun: false,
            instruction: "break api value",
            profile: "default"
          },
          {
            inspectRepository: async () => ({
              isRepository: true,
              isDirty: true,
              currentHead: "abc123"
            }),
            createClient: () => ({
              createCompletion: async () => ({
                id: "chat_2",
                content: "{not json}",
                reasoningContent: "",
                finishReason: "stop",
                toolCalls: [],
                usage: null
              })
            })
          }
        )
      ).rejects.toThrowError();

      expect(readFileSync(path.join(cwd, "src/api.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("repairs an invalid JSON response with one automatic retry", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2)
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const createCompletion = vi
        .fn()
        .mockResolvedValueOnce({
          id: "chat_invalid_1",
          content: "{not json}",
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        })
        .mockResolvedValueOnce({
          id: "chat_invalid_2",
          content: JSON.stringify({
            files: [
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
            ],
            summary: "Recovered from invalid JSON"
          }),
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        });

      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "repair invalid json",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion
          })
        }
      );

      expect(createCompletion).toHaveBeenCalledTimes(2);
      expect(readFileSync(path.join(cwd, "src/api.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(result.message).toContain('summary="Recovered from invalid JSON"');
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("executes a tool-call round before parsing the final model response", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2)
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const createCompletion = vi
        .fn()
        .mockResolvedValueOnce({
          id: "chat_tool_1",
          content: "",
          reasoningContent: "inspect file",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"src/api.ts\"}"
              }
            }
          ],
          usage: null
        })
        .mockResolvedValueOnce({
          id: "chat_tool_2",
          content: JSON.stringify({
            files: [
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
            ],
            summary: "Updated via tool loop"
          }),
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        });

      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "update api with tools",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion
          })
        }
      );

      expect(createCompletion).toHaveBeenCalledTimes(2);
      expect(readFileSync(path.join(cwd, "src/api.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(result.message).toContain("toolCallsUsed=yes");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("can finish via safe write tool calls with an empty final files array", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2)
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const createCompletion = vi
        .fn()
        .mockResolvedValueOnce({
          id: "chat_write_1",
          content: "",
          reasoningContent: "update file directly",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: "{\"path\":\"src/api.ts\",\"content\":\"export const value = 2;\\n\"}"
              }
            }
          ],
          usage: null
        })
        .mockResolvedValueOnce({
          id: "chat_write_2",
          content: JSON.stringify({
            files: [],
            summary: "Updated through write tool"
          }),
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        });

      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "update api through tool write",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion
          })
        }
      );

      expect(createCompletion).toHaveBeenCalledTimes(2);
      expect(readFileSync(path.join(cwd, "src/api.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(result.message).toContain("appliedFiles=1");
      expect(result.message).toContain("toolCallsUsed=yes");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("passes command approval into run_command tool calls", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n",
      ".deepvibe/config.json": JSON.stringify(
        {
          apiKey: "project-key",
          toolPermissions: {
            command: {
              enabled: true,
              allowedPrefixes: ["git status"]
            }
          }
        },
        null,
        2
      )
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const createCompletion = vi
        .fn()
        .mockResolvedValueOnce({
          id: "chat_cmd_1",
          content: "",
          reasoningContent: "inspect git state",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_cmd",
              type: "function",
              function: {
                name: "run_command",
                arguments: "{\"command\":\"git status --short\"}"
              }
            }
          ],
          usage: null
        })
        .mockResolvedValueOnce({
          id: "chat_cmd_2",
          content: JSON.stringify({
            files: [],
            summary: "Checked git status"
          }),
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        });
      const commandApproval = vi.fn().mockResolvedValue(true);
      const commandRunner = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: " M src/api.ts\n",
        stderr: ""
      });

      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "inspect repo through command tool",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion
          }),
          commandApproval,
          commandRunner
        }
      );

      expect(commandApproval).toHaveBeenCalledTimes(1);
      expect(commandRunner).toHaveBeenCalledTimes(1);
      expect(result.message).toContain("toolCallsUsed=yes");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });

  it("loads plugin-contributed tools into the tool-call loop", async () => {
    const { cwd, homeDir } = createWorkspace({
      ".deepvibe/config.json": JSON.stringify({ apiKey: "project-key" }, null, 2),
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_echo', description: 'Echo a message' } },",
        "    async execute(argumentsJson) {",
        "      const args = JSON.parse(argumentsJson);",
        "      return JSON.stringify({ ok: true, echoed: args.message });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = homeDir;

    try {
      const createCompletion = vi
        .fn()
        .mockResolvedValueOnce({
          id: "chat_plugin_1",
          content: "",
          reasoningContent: "use plugin",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_plugin",
              type: "function",
              function: {
                name: "plugin_echo",
                arguments: "{\"message\":\"hello\"}"
              }
            }
          ],
          usage: null
        })
        .mockResolvedValueOnce({
          id: "chat_plugin_2",
          content: JSON.stringify({
            files: [],
            summary: "Used plugin tool"
          }),
          reasoningContent: "",
          finishReason: "stop",
          toolCalls: [],
          usage: null
        });

      const result = await runEngine(
        {
          cwd,
          dryRun: false,
          instruction: "use plugin tool",
          profile: "default"
        },
        {
          inspectRepository: async () => ({
            isRepository: true,
            isDirty: true,
            currentHead: "abc123"
          }),
          createClient: () => ({
            createCompletion
          })
        }
      );

      expect(createCompletion).toHaveBeenCalledTimes(2);
      expect(result.message).toContain("toolCallsUsed=yes");
    } finally {
      process.env.USERPROFILE = originalHome;
    }
  });
});

function createWorkspace(files: Record<string, string>): { cwd: string; homeDir: string } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "deepvibe-engine-int-"));
  const cwd = path.join(baseDir, "workspace");
  const homeDir = path.join(baseDir, "home");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  tempDirs.push(baseDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return { cwd, homeDir };
}

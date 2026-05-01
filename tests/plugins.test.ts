import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPluginTools, PluginLoadError } from "../src/plugins.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("plugins", () => {
  it("loads plugin tools from .deepvibe/plugins", async () => {
    const rootDir = createWorkspace({
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

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.name).toBe("demo");
    expect(plugins[0]?.tools[0]?.definition.function.name).toBe("plugin_echo");
  });

  it("ignores disabled plugins", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        enabled: false
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": "export function createTools() { return []; }"
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });

    expect(plugins).toHaveLength(0);
  });

  it("rejects invalid plugin permission shapes", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        permissions: {
          runCommands: "yes"
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": "export function createTools() { return []; }"
    });

    await expect(
      loadPluginTools(rootDir, {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError(PluginLoadError);
  });

  it("blocks plugin tools in service mode when allowInService is false", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        permissions: {
          allowInService: false
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_echo', description: 'Echo a message' } },",
        "    async execute() {",
        "      return JSON.stringify({ ok: true, echoed: true });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools",
      executionMode: "service"
    });

    await expect(
      plugins[0]?.tools[0]?.execute("{}", {
        rootDir,
        instruction: "use plugin tools",
        executionMode: "service"
      })
    ).rejects.toThrowError(PluginLoadError);
  });

  it("blocks plugin tools in service mode by default when no permissions declared", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_echo', description: 'Echo a message' } },",
        "    async execute() {",
        "      return JSON.stringify({ ok: true });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools",
      executionMode: "service"
    });

    await expect(
      plugins[0]?.tools[0]?.execute("{}", {
        rootDir,
        instruction: "use plugin tools",
        executionMode: "service"
      })
    ).rejects.toThrowError(PluginLoadError);
  });

  it("strips write and command capabilities when plugin permissions do not allow them", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        permissions: {
          writeProject: false,
          runCommands: false
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools(context) {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_probe', description: 'Probe context' } },",
        "    async execute() {",
        "      return JSON.stringify({",
        "        hasMutations: Boolean(context.mutations),",
        "        hasCommandPermissions: Boolean(context.commandPermissions),",
        "        hasCommandRunner: Boolean(context.commandRunner)",
        "      });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools",
      mutations: { applied: new Map() },
      commandPermissions: {
        enabled: true,
        policies: [],
        requireApproval: true,
        timeoutMs: 1000,
        maxOutputChars: 1000
      },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    const output = await plugins[0]?.tools[0]?.execute("{}", {
      rootDir,
      instruction: "use plugin tools",
      mutations: { applied: new Map() },
      commandPermissions: {
        enabled: true,
        policies: [],
        requireApproval: true,
        timeoutMs: 1000,
        maxOutputChars: 1000
      },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    expect(output).toContain("\"hasMutations\":false");
    expect(output).toContain("\"hasCommandPermissions\":false");
    expect(output).toContain("\"hasCommandRunner\":false");
  });

  it("passes through commandRunner when runCommands permission is granted", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        permissions: {
          runCommands: true
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools(context) {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_probe', description: 'Probe context' } },",
        "    async execute() {",
        "      return JSON.stringify({",
        "        hasCommandRunner: Boolean(context.commandRunner)",
        "      });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools",
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    const output = await plugins[0]?.tools[0]?.execute("{}", {
      rootDir,
      instruction: "use plugin tools",
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    });

    expect(output).toContain("\"hasCommandRunner\":true");
  });

  it("uses the current execution context for plugin tool calls", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_context', description: 'Show execution context' } },",
        "    async execute(_argumentsJson, context) {",
        "      return JSON.stringify({",
        "        instruction: context.instruction,",
        "        isDirty: context.repositoryState?.isDirty ?? null",
        "      });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "load-time instruction",
      repositoryState: { isDirty: false }
    });

    const output = await plugins[0]?.tools[0]?.execute("{}", {
      rootDir,
      instruction: "run-time instruction",
      repositoryState: { isDirty: true }
    });

    expect(output).toContain("\"instruction\":\"run-time instruction\"");
    expect(output).toContain("\"isDirty\":true");
  });

  it("rejects plugin code that accesses process globals", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "const leak = process.cwd();",
        "export function createTools() {",
        "  return [];",
        "}"
      ].join("\n")
    });

    await expect(
      loadPluginTools(rootDir, {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError();
  });

  it("rejects plugin modules with static imports", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "import path from 'node:path';",
        "export function createTools() {",
        "  return [];",
        "}"
      ].join("\n")
    });

    await expect(
      loadPluginTools(rootDir, {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError(PluginLoadError);
  });

  it("supports plugin lifecycle hooks", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "globalThis.__events = [];",
        "export async function initialize() { globalThis.__events.push('init'); }",
        "export async function dispose() { globalThis.__events.push('dispose'); }",
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_events', description: 'Show events' } },",
        "    async execute() {",
        "      return JSON.stringify({ ok: true, events: globalThis.__events });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });
    const output = await plugins[0]?.tools[0]?.execute("{}", {
      rootDir,
      instruction: "use plugin tools"
    });

    expect(output).toContain("\"init\"");
  });

  it("propagates plugin dispose hook failures", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export async function dispose() { throw new Error('dispose failed'); }",
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_dispose', description: 'Dispose hook test' } },",
        "    async execute() {",
        "      return JSON.stringify({ ok: true });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    await expect(
      loadPluginTools(rootDir, {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError();
  });

  it("attempts dispose even when plugin execution fails", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js"
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "globalThis.__failDispose = false;",
        "export async function dispose() { if (globalThis.__failDispose) { throw new Error('dispose failed'); } }",
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_fail', description: 'Fail during execute' } },",
        "    async execute() {",
        "      globalThis.__failDispose = true;",
        "      throw new Error('execute failed');",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });

    await expect(
      plugins[0]?.tools[0]?.execute("{}", {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError(/execute failed \(dispose also failed: dispose failed\)/);
  });

  it("rejects invalid runtime config", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        runtime: {
          timeoutMs: "fast"
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": "export function createTools() { return []; }"
    });

    await expect(
      loadPluginTools(rootDir, {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError(PluginLoadError);
  });

  it("rejects oversized plugin tool results", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        runtime: {
          maxResultChars: 256
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_large', description: 'Return a large payload' } },",
        "    async execute() {",
        "      return JSON.stringify({ ok: true, payload: 'x'.repeat(512) });",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });

    await expect(
      plugins[0]?.tools[0]?.execute("{}", {
        rootDir,
        instruction: "use plugin tools"
      })
    ).rejects.toThrowError(/exceeded the maximum result size/i);
  });

  it("aborts plugin host calls when the execution signal is cancelled", async () => {
    const rootDir = createWorkspace({
      ".deepvibe/plugins/demo/plugin.json": JSON.stringify({
        name: "demo",
        entry: "./index.js",
        runtime: {
          timeoutMs: 10000
        }
      }, null, 2),
      ".deepvibe/plugins/demo/index.js": [
        "export function createTools() {",
        "  return [{",
        "    definition: { type: 'function', function: { name: 'plugin_hang', description: 'Hang forever' } },",
        "    async execute() {",
        "      while (true) {}",
        "    }",
        "  }];",
        "}"
      ].join("\n")
    });

    const plugins = await loadPluginTools(rootDir, {
      rootDir,
      instruction: "use plugin tools"
    });

    const controller = new AbortController();
    const execution = plugins[0]?.tools[0]?.execute("{}", {
      rootDir,
      instruction: "use plugin tools",
      abortSignal: controller.signal
    });

    setTimeout(() => controller.abort(), 50);

    await expect(execution).rejects.toThrowError(/aborted/i);
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-plugins-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

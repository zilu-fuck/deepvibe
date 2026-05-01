import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, requireApiKey, setConfigValue } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("loadConfig", () => {
  it("merges global and project config with project overrides", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(homeDir, ".deepvibe", "config.json"), {
      apiKey: "global-key",
      defaultModel: "deepseek-v4-pro",
      ignore: ["dist"]
    });

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      defaultModel: "deepseek-v4-flash",
      ignore: ["build"]
    });

    const config = loadConfig({ cwd, homeDir });

    expect(config.apiKey).toBe("global-key");
    expect(config.defaultModel).toBe("deepseek-v4-flash");
    expect(config.ignore).toEqual(["build"]);
    expect(config.projectConfigPath).toBe(path.join(cwd, ".deepvibe", "config.json"));
  });

  it("throws a recognizable error when the API key is missing", () => {
    const { cwd, homeDir } = createWorkspace();
    const config = loadConfig({ cwd, homeDir });

    expect(() => requireApiKey(config)).toThrowError(ConfigError);
    expect(() => requireApiKey(config)).toThrowError(/DeepSeek API key not found/);
  });

  it("loads command tool permissions from config", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          commandPolicies: [
            {
              prefix: "git status",
              risk: "low",
              allowInService: true,
              allowPersistentApproval: true,
              allowedDirectories: ["."],
              timeoutMs: 7000,
              maxOutputChars: 1024
            },
            { prefix: "git add", risk: "medium" },
            { prefix: "git push", risk: "high" }
          ],
          sandbox: {
            enabled: true,
            image: "node:20-alpine",
            network: "none",
            readOnlyRootFilesystem: true,
            tmpfsPaths: ["/tmp", "/var/tmp"]
          },
          requireApproval: false,
          timeoutMs: 5000,
          maxOutputChars: 2048
        }
      }
    });

    const config = loadConfig({ cwd, homeDir });

    expect(config.toolPermissions?.command).toEqual({
      enabled: true,
      commandPolicies: [
        {
          prefix: "git status",
          risk: "low",
          allowInService: true,
          allowPersistentApproval: true,
          allowedDirectories: ["."],
          timeoutMs: 7000,
          maxOutputChars: 1024
        },
        { prefix: "git add", risk: "medium" },
        { prefix: "git push", risk: "high" }
      ],
      sandbox: {
        enabled: true,
        image: "node:20-alpine",
        network: "none",
        readOnlyRootFilesystem: true,
        tmpfsPaths: ["/tmp", "/var/tmp"]
      },
      requireApproval: false,
      timeoutMs: 5000,
      maxOutputChars: 2048
    });
  });

  it("rejects invalid command tool permission shapes", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          allowedPrefixes: [""]
        }
      }
    });

    expect(() => loadConfig({ cwd, homeDir })).toThrowError(ConfigError);
  });

  it("rejects invalid per-policy timeout and output overrides", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          commandPolicies: [
            { prefix: "git status", risk: "low", timeoutMs: 0 },
            { prefix: "git diff", risk: "low", maxOutputChars: -1 }
          ]
        }
      }
    });

    expect(() => loadConfig({ cwd, homeDir })).toThrowError(ConfigError);
  });

  it("rejects invalid command sandbox config", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          sandbox: {
            image: "",
            network: "offline"
          }
        }
      }
    });

    expect(() => loadConfig({ cwd, homeDir })).toThrowError(ConfigError);
  });

  it("rejects unknown command policy keys", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          commandPolicies: [
            { prefix: "git status", risk: "low", unexpectedKey: true }
          ]
        }
      }
    });

    expect(() => loadConfig({ cwd, homeDir })).toThrowError(ConfigError);
  });

  it("rejects invalid command policy risk levels", () => {
    const { cwd, homeDir } = createWorkspace();

    writeConfig(path.join(cwd, ".deepvibe", "config.json"), {
      apiKey: "project-key",
      toolPermissions: {
        command: {
          enabled: true,
          commandPolicies: [{ prefix: "git status", risk: "critical" }]
        }
      }
    });

    expect(() => loadConfig({ cwd, homeDir })).toThrowError(ConfigError);
  });

  it("writes a global config value using CLI-style aliases", () => {
    const { cwd, homeDir } = createWorkspace();

    const result = setConfigValue({
      cwd,
      homeDir,
      key: "api_key",
      target: "global",
      value: "deepseek-key"
    });
    const config = loadConfig({ cwd, homeDir });

    expect(result.key).toBe("apiKey");
    expect(config.apiKey).toBe("deepseek-key");
  });

  it("writes a project config value", () => {
    const { cwd, homeDir } = createWorkspace();

    const result = setConfigValue({
      cwd,
      homeDir,
      key: "default_model",
      target: "project",
      value: "deepseek-v4-flash"
    });
    const config = loadConfig({ cwd, homeDir });

    expect(result.key).toBe("defaultModel");
    expect(config.defaultModel).toBe("deepseek-v4-flash");
    expect(config.projectConfigPath).toBeDefined();
  });
});

function createWorkspace(): { cwd: string; homeDir: string } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "deepvibe-"));
  const cwd = path.join(baseDir, "workspace");
  const homeDir = path.join(baseDir, "home");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  tempDirs.push(baseDir);

  return { cwd, homeDir };
}

function writeConfig(filePath: string, contents: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(contents, null, 2), "utf8");
}

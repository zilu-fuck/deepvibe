import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearWorkspaceTrust,
  getDefaultWorkspaceSandboxConfig,
  getWorkspaceTrust,
  prepareWorkspaceAccess,
  setWorkspaceTrust
} from "../src/workspace-access.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("workspace access", () => {
  it("persists and clears workspace trust", () => {
    const { cwd, homeDir } = createWorkspace();

    setWorkspaceTrust(cwd, "full", homeDir);
    expect(getWorkspaceTrust(cwd, homeDir)?.mode).toBe("full");

    clearWorkspaceTrust(cwd, homeDir);
    expect(getWorkspaceTrust(cwd, homeDir)).toBeUndefined();
  });

  it("defaults to sandbox mode in non-interactive sessions", async () => {
    const { cwd, homeDir } = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });

    const result = await prepareWorkspaceAccess({
      cwd,
      homeDir,
      input: createInputStream("", false),
      output: createWritableStream(false)
    });

    expect(result.mode).toBe("sandbox");
    expect(result.effectiveCwd).not.toBe(cwd);
    expect(readFileSync(path.join(result.effectiveCwd, "src", "api.ts"), "utf8")).toContain("value = 1");
  });

  it("accepts a trusted workspace choice interactively", async () => {
    const { cwd, homeDir } = createWorkspace();
    const readline = {
      question: vi.fn().mockResolvedValue("f"),
      close: vi.fn()
    };

    const result = await prepareWorkspaceAccess({
      cwd,
      homeDir,
      input: createInputStream("", true),
      output: createWritableStream(true),
      createInterfaceFn: vi.fn().mockReturnValue(readline as never)
    });

    expect(result.mode).toBe("full");
    expect(result.effectiveCwd).toBe(path.resolve(cwd));
    expect(getWorkspaceTrust(cwd, homeDir)?.mode).toBe("full");
  });

  it("exposes a readonly docker sandbox default config", () => {
    expect(getDefaultWorkspaceSandboxConfig()).toEqual({
      enabled: true,
      image: "node:20-alpine",
      mountPath: "/workspace",
      network: "none",
      readOnlyRootFilesystem: true,
      tmpfsPaths: ["/tmp", "/var/tmp"]
    });
  });
});

function createWorkspace(files: Record<string, string> = {}): { cwd: string; homeDir: string } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "deepvibe-workspace-access-"));
  const cwd = path.join(baseDir, "workspace");
  const homeDir = path.join(baseDir, "home");
  tempDirs.push(baseDir);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

  return { cwd, homeDir };
}

function createInputStream(contents: string, isTTY: boolean): NodeJS.ReadableStream {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = isTTY;
  stream.end(contents, "utf8");
  return stream;
}

function createWritableStream(isTTY: boolean): NodeJS.WritableStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WritableStream & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream;
}

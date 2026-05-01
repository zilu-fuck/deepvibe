import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAiCommit,
  inspectRepository,
  recordOperation,
  undoLastAiChange
} from "../src/project/git-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("inspectRepository", () => {
  it("reports non-git directories safely", async () => {
    const rootDir = createWorkspace({});

    const state = await inspectRepository(rootDir);

    expect(state).toEqual({
      isRepository: false,
      isDirty: false,
      currentHead: null
    });
  });
});

describe("recordOperation", () => {
  it("writes an operation record under .deepvibe/operations", () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 2;\n"
    });

    const record = recordOperation(
      rootDir,
      {
        isRepository: true,
        isDirty: true,
        currentHead: "abc123"
      },
      [
        {
          beforeContent: "export const value = 1;\n",
          afterContent: "export const value = 2;\n",
          path: "src/api.ts"
        }
      ],
      "Update API value"
    );

    const operationPath = path.join(rootDir, ".deepvibe", "operations", `${record.operationId}.json`);
    const persisted = JSON.parse(readFileSync(operationPath, "utf8")) as {
      baseHead: string;
      files: Array<{ beforeContent: string; path: string }>;
      operationId: string;
    };

    expect(persisted.baseHead).toBe("abc123");
    expect(persisted.operationId).toBe(record.operationId);
    expect(persisted.files[0]?.path).toBe("src/api.ts");
    expect(persisted.files[0]?.beforeContent).toBe("export const value = 1;\n");
  });
});

describe("createAiCommit", () => {
  it("creates a commit for the provided paths in a git repository", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });

    await initializeGitRepository(rootDir);
    writeFileSync(path.join(rootDir, "src/api.ts"), "export const value = 2;\n", "utf8");

    const record = await createAiCommit(rootDir, ["src/api.ts"], "Update API value");

    expect(record.summary).toBe("Update API value");
    expect(record.commitHash.length).toBeGreaterThan(0);
  });
});

describe("undoLastAiChange", () => {
  it("restores the previous file contents for a dirty-worktree operation", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 2;\n"
    });

    const record = recordOperation(
      rootDir,
      {
        isRepository: true,
        isDirty: true,
        currentHead: "abc123"
      },
      [
        {
          beforeContent: "export const value = 1;\n",
          afterContent: "export const value = 2;\n",
          path: "src/api.ts"
        }
      ],
      "Update API value"
    );

    const result = await undoLastAiChange(rootDir);

    expect(result).toEqual({
      kind: "operation",
      reference: record.operationId
    });
    expect(readFileSync(path.join(rootDir, "src/api.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(existsSync(path.join(rootDir, ".deepvibe", "last-action.json"))).toBe(false);
  });

  it("rejects undo when the operation target changed after apply", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 2;\n"
    });

    recordOperation(
      rootDir,
      {
        isRepository: true,
        isDirty: true,
        currentHead: "abc123"
      },
      [
        {
          beforeContent: "export const value = 1;\n",
          afterContent: "export const value = 2;\n",
          path: "src/api.ts"
        }
      ],
      "Update API value"
    );

    writeFileSync(path.join(rootDir, "src/api.ts"), "export const value = 3;\n", "utf8");

    await expect(undoLastAiChange(rootDir)).rejects.toThrowError(/has changed since the AI operation/);
  });

  it("reverts the latest AI commit when HEAD matches the recorded commit", { timeout: 15000 }, async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });

    await initializeGitRepository(rootDir);
    writeFileSync(path.join(rootDir, "src/api.ts"), "export const value = 2;\n", "utf8");
    const record = await createAiCommit(rootDir, ["src/api.ts"], "Update API value");

    const result = await undoLastAiChange(rootDir);

    expect(result).toEqual({
      kind: "commit",
      reference: record.commitHash
    });
    expect(normalizeLineEndings(readFileSync(path.join(rootDir, "src/api.ts"), "utf8"))).toBe("export const value = 1;\n");
    expect(existsSync(path.join(rootDir, ".deepvibe", "last-action.json"))).toBe(false);
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-git-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

async function initializeGitRepository(rootDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("git", ["init"], { cwd: rootDir });
  await execFileAsync("git", ["config", "user.name", "DeepVibe Test"], { cwd: rootDir });
  await execFileAsync("git", ["config", "user.email", "deepvibe@example.com"], { cwd: rootDir });
  await execFileAsync("git", ["add", "."], { cwd: rootDir });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: rootDir });
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

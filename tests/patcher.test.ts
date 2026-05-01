import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyFileChanges, PatcherError } from "../src/patcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("applyFileChanges", () => {
  it("applies a modify diff to an existing file", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });

    await applyFileChanges(rootDir, [
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

    expect(readFileSync(path.join(rootDir, "src/api.ts"), "utf8")).toBe("export const value = 2;\n");
  });

  it("rolls back earlier writes if a later patch fails", async () => {
    const rootDir = createWorkspace({
      "src/first.ts": "export const first = 1;\n",
      "src/second.ts": "export const second = 2;\n"
    });

    await expect(
      applyFileChanges(rootDir, [
        {
          path: "src/first.ts",
          action: "modify",
          diff: [
            "--- a/src/first.ts",
            "+++ b/src/first.ts",
            "@@ -1,1 +1,1 @@",
            "-export const first = 1;",
            "+export const first = 3;"
          ].join("\n")
        },
        {
          path: "src/second.ts",
          action: "modify",
          diff: [
            "--- a/src/second.ts",
            "+++ b/src/second.ts",
            "@@ -1,1 +1,1 @@",
            "-export const second = 999;",
            "+export const second = 4;"
          ].join("\n")
        }
      ])
    ).rejects.toThrowError(PatcherError);

    expect(readFileSync(path.join(rootDir, "src/first.ts"), "utf8")).toBe("export const first = 1;\n");
    expect(readFileSync(path.join(rootDir, "src/second.ts"), "utf8")).toBe("export const second = 2;\n");
  });

  it("rejects traversal and reserved-directory targets", async () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const value = 1;\n"
    });

    await expect(
      applyFileChanges(rootDir, [
        {
          path: "../outside.ts",
          action: "create",
          diff: [
            "--- a/../outside.ts",
            "+++ b/../outside.ts",
            "@@ -0,0 +1,1 @@",
            "+export const value = 1;"
          ].join("\n")
        }
      ])
    ).rejects.toThrowError(PatcherError);

    await expect(
      applyFileChanges(rootDir, [
        {
          path: ".git/config",
          action: "modify",
          diff: ""
        }
      ])
    ).rejects.toThrowError(PatcherError);
  });

  it("rejects symlink escapes for new files", async () => {
    const rootDir = createWorkspace({});
    const externalDir = createDetachedDirectory();

    mkdirSync(path.join(rootDir, "linked"), { recursive: true });
    rmSync(path.join(rootDir, "linked"), { recursive: true, force: true });
    symlinkSync(externalDir, path.join(rootDir, "linked"), "junction");

    await expect(
      applyFileChanges(rootDir, [
        {
          path: "linked/escaped.ts",
          action: "create",
          diff: [
            "--- a/linked/escaped.ts",
            "+++ b/linked/escaped.ts",
            "@@ -0,0 +1,1 @@",
            "+export const escaped = true;"
          ].join("\n")
        }
      ])
    ).rejects.toThrowError(PatcherError);
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-patcher-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

function createDetachedDirectory(): string {
  const detachedDir = mkdtempSync(path.join(tmpdir(), "deepvibe-external-"));
  tempDirs.push(detachedDir);

  return detachedDir;
}

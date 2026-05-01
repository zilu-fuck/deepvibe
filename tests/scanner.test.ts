import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanProject } from "../src/project/scanner.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("scanProject", () => {
  it("respects ignore files and default ignore directories", async () => {
    const rootDir = createWorkspace({
      ".gitignore": "coverage/\nignored.ts\n",
      ".deepvibeignore": "private/\n",
      "src/api/request.ts": "export const request = true;\n",
      "src/api/request.test.ts": "export const requestTest = true;\n",
      "ignored.ts": "ignore me\n",
      "coverage/out.txt": "ignore me\n",
      "private/secret.ts": "ignore me\n",
      "node_modules/pkg/index.js": "ignore me\n",
      "dist/bundle.js": "ignore me\n"
    });

    const result = await scanProject({
      rootDir,
      instruction: "update request timeout"
    });

    expect(result.scannedFiles).toBe(4);
    expect(result.candidates).toContain("src/api/request.ts");
    expect(result.candidates).not.toContain("ignored.ts");
    expect(result.candidates).not.toContain("private/secret.ts");
  });

  it("forces explicit @file references into the candidate list", async () => {
    const rootDir = createWorkspace({
      "src/services/api.ts": "export const api = true;\n",
      "src/features/auth/login.ts": "export const login = true;\n",
      "README.md": "# demo\n"
    });

    const result = await scanProject({
      rootDir,
      instruction: "refactor auth flow @src/features/auth/login.ts",
      maxCandidates: 1,
      recentGitFiles: ["src/services/api.ts"]
    });

    expect(result.explicitPaths).toEqual(["src/features/auth/login.ts"]);
    expect(result.candidates[0]).toBe("src/features/auth/login.ts");
    expect(result.candidates).toContain("src/services/api.ts");
  });

  it("uses recent git files and keyword matches to produce stable ordering", async () => {
    const rootDir = createWorkspace({
      "src/api/request.ts": "export const request = true;\n",
      "src/api/request.test.ts": "export const requestTest = true;\n",
      "src/auth/login.ts": "export const login = true;\n",
      "docs/notes.md": "notes\n"
    });

    const result = await scanProject({
      rootDir,
      instruction: "update request flow",
      recentGitFiles: ["src/auth/login.ts"]
    });

    expect(result.candidates.slice(0, 3)).toEqual([
      "src/api/request.test.ts",
      "src/api/request.ts",
      "src/auth/login.ts"
    ]);
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-scanner-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectEngineeringIntentHeuristically } from "../src/intent.js";
import { applyBootstrapGuidance } from "../src/project-bootstrap.js";
import { detectVerificationCommands } from "../src/verification.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("detectEngineeringIntentHeuristically", () => {
  it("marks direct implementation requests as write access", () => {
    const decision = detectEngineeringIntentHeuristically("implement a new api endpoint");

    expect(decision.engineeringIntent).toBe(true);
    expect(decision.requiresWriteAccess).toBe(true);
  });

  it("keeps explanation requests read-only", () => {
    const decision = detectEngineeringIntentHeuristically("explain how this architecture works");

    expect(decision.engineeringIntent).toBe(false);
    expect(decision.requiresWriteAccess).toBe(false);
  });
});

describe("applyBootstrapGuidance", () => {
  it("adds scaffold guidance for an empty freshly initialized repository", () => {
    const cwd = createWorkspace({});
    const result = applyBootstrapGuidance({
      cwd,
      instruction: "create a new cli project",
      repositoryJustInitialized: true
    });

    expect(result.applied).toBe(true);
    expect(result.notice).toContain("minimal project scaffold");
    expect(result.instruction).toContain("Additional execution guidance");
  });
});

describe("detectVerificationCommands", () => {
  it("prefers package-based test and build commands when scripts exist", () => {
    const cwd = createWorkspace({
      "package.json": JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "tsc -p tsconfig.build.json"
        }
      }, null, 2),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"
    });

    const commands = detectVerificationCommands(cwd);

    expect(commands.map((command) => command.command)).toEqual(["pnpm test", "pnpm build"]);
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-intent-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

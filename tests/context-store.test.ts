import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendContextTurn,
  buildSessionHistorySummary,
  loadContextStore
} from "../src/context-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("context store", () => {
  it("appends turns and rebuilds a session history summary", () => {
    const rootDir = createWorkspace();

    appendContextTurn({
      rootDir,
      instruction: "summarize the project",
      files: ["src/api.ts"],
      summary: "Scanned the API module.",
      result: {
        ok: true,
        kind: "dry-run",
        appliedFiles: 0,
        toolCallsUsed: false
      }
    });
    appendContextTurn({
      rootDir,
      instruction: "update api timeout",
      files: ["src/api.ts", "src/request.ts"],
      summary: "Updated timeout handling.",
      result: {
        ok: true,
        kind: "operation",
        appliedFiles: 2,
        toolCallsUsed: true,
        reference: "op_123"
      },
      tools: {
        names: ["tool_calls", "write_tool"]
      }
    });

    const store = loadContextStore(rootDir);
    const summary = buildSessionHistorySummary(store);

    expect(store.sessions[0]?.turns).toHaveLength(2);
    expect(summary).toContain("summarize the project");
    expect(summary).toContain("update api timeout");
    expect(summary).toContain("tool_calls");
    expect(readFileSync(path.join(rootDir, ".deepvibe", "context.json"), "utf8")).toContain("Updated timeout handling.");
  });
});

function createWorkspace(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-context-"));
  tempDirs.push(rootDir);
  mkdirSync(rootDir, { recursive: true });

  return rootDir;
}

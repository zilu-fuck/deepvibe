import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isCommandPersistentlyApproved,
  loadCommandApprovalStore,
  rememberApprovedCommand
} from "../src/command-approval-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("command approval store", () => {
  it("persists and reloads approved commands", () => {
    const rootDir = createWorkspace();
    const initialStore = loadCommandApprovalStore(rootDir);

    const nextStore = rememberApprovedCommand(rootDir, initialStore, {
      cwd: ".",
      command: "git status --short"
    });

    expect(isCommandPersistentlyApproved(nextStore, { cwd: ".", command: "git status --short" })).toBe(true);

    const reloaded = loadCommandApprovalStore(rootDir);

    expect(isCommandPersistentlyApproved(reloaded, { cwd: ".", command: "git status --short" })).toBe(true);
    expect(readFileSync(path.join(rootDir, ".deepvibe", "command-approvals.json"), "utf8")).toContain("git status --short");
  });
});

function createWorkspace(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-approvals-"));
  tempDirs.push(rootDir);
  mkdirSync(rootDir, { recursive: true });

  return rootDir;
}

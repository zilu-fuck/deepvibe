import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createPatch } from "diff";

import type { ParsedFileChange } from "./llm/response-parser.js";

export interface WorkspaceSnapshotChange {
  afterContent: string | null;
  beforeContent: string | null;
  path: string;
}

const IGNORED_PREFIXES = [".git/", ".deepvibe/"];

export function collectWorkspaceSnapshotChanges(baseDir: string, sandboxDir: string): WorkspaceSnapshotChange[] {
  const baseFiles = collectFiles(baseDir);
  const sandboxFiles = collectFiles(sandboxDir);
  const allPaths = [...new Set([...baseFiles, ...sandboxFiles])].sort();
  const changes: WorkspaceSnapshotChange[] = [];

  for (const relativePath of allPaths) {
    if (IGNORED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
      continue;
    }

    const basePath = path.join(baseDir, relativePath);
    const sandboxPath = path.join(sandboxDir, relativePath);
    const beforeContent = existsSync(basePath) ? readFileSync(basePath, "utf8") : null;
    const afterContent = existsSync(sandboxPath) ? readFileSync(sandboxPath, "utf8") : null;

    if (beforeContent === afterContent) {
      continue;
    }

    changes.push({
      path: normalizeRelativePath(relativePath),
      beforeContent,
      afterContent
    });
  }

  return changes;
}

export function applyWorkspaceSnapshotChanges(rootDir: string, changes: WorkspaceSnapshotChange[]): void {
  for (const change of changes) {
    const targetPath = path.join(rootDir, change.path);

    if (change.afterContent === null) {
      if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true });
      }
      continue;
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, change.afterContent, "utf8");
  }
}

export function snapshotChangesToParsedFileChanges(changes: WorkspaceSnapshotChange[]): ParsedFileChange[] {
  return changes.map((change) => ({
    path: change.path,
    action:
      change.beforeContent === null
        ? "create"
        : change.afterContent === null
          ? "delete"
          : "modify",
    diff: createPatch(change.path, change.beforeContent ?? "", change.afterContent ?? "", "", "")
  }));
}

function collectFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const result: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();

    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, fullPath));

      if (entry.isDirectory()) {
        if (IGNORED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
          continue;
        }

        stack.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  }

  return result;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

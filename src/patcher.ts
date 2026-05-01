import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyPatch } from "diff";

import { ParsedFileChange } from "./llm/response-parser.js";
import { PathSafetyError, resolveProjectTargetPath } from "./path-safety.js";

export interface AppliedFileChange {
  action: ParsedFileChange["action"];
  afterContent: string | null;
  beforeContent: string | null;
  path: string;
}

export class PatcherError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PatcherError";
  }
}

export async function applyFileChanges(
  rootDir: string,
  changes: ParsedFileChange[]
): Promise<AppliedFileChange[]> {
  const rootPath = realpathSync(path.resolve(rootDir));
  const backups = new Map<string, string | null>();
  const applied: AppliedFileChange[] = [];

  try {
    for (const change of changes) {
      const targetPath = validateTargetPath(rootPath, change.path);
      const originalContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;

      backups.set(targetPath, originalContent);

      const nextContent = computeNextContent(originalContent, change);

      if (change.action === "delete") {
        if (nextContent.length !== 0) {
          throw new PatcherError("DELETE_DIFF_INVALID", `Delete action for ${change.path} did not resolve to an empty file.`);
        }

        if (existsSync(targetPath)) {
          rmSync(targetPath);
        }
      } else {
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, nextContent, "utf8");
      }

      applied.push({
        action: change.action,
        afterContent: change.action === "delete" ? null : nextContent,
        beforeContent: originalContent,
        path: change.path
      });
    }

    return applied;
  } catch (error) {
    try {
      rollbackChanges(backups);
    } catch (rollbackError) {
      throw new PatcherError(
        "ROLLBACK_FAILED",
        `Failed to apply changes and rollback also failed. Original: ${error instanceof Error ? error.message : error}. Rollback: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`
      );
    }

    throw error;
  }
}

function validateTargetPath(rootPath: string, relativePath: string): string {
  try {
    return resolveProjectTargetPath(rootPath, relativePath);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw new PatcherError(error.code, error.message);
    }

    throw error;
  }
}

function computeNextContent(originalContent: string | null, change: ParsedFileChange): string {
  const source = originalContent ?? "";
  const patched = applyPatch(source, change.diff);

  if (patched === false) {
    throw new PatcherError("PATCH_FAILED", `Failed to apply diff for ${change.path}.`);
  }

  return patched;
}

function rollbackChanges(backups: Map<string, string | null>): void {
  for (const [targetPath, originalContent] of backups.entries()) {
    if (originalContent === null) {
      if (existsSync(targetPath)) {
        rmSync(targetPath);
      }

      continue;
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, originalContent, "utf8");
  }
}

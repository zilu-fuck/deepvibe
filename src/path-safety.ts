import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const RESERVED_DIRECTORIES = new Set([".git", ".deepvibe"]);

export class PathSafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PathSafetyError";
  }
}

export function resolveProjectTargetPath(rootDir: string, relativePath: string): string {
  const rootPath = realpathSync(path.resolve(rootDir));
  const normalizedRelativePath = normalizeRelativePath(relativePath);

  if (normalizedRelativePath.length === 0) {
    throw new PathSafetyError("PATH_INVALID", "Target path must not be empty.");
  }

  if (path.isAbsolute(normalizedRelativePath) || normalizedRelativePath.startsWith("//")) {
    throw new PathSafetyError("PATH_INVALID", `Absolute paths are not allowed: ${relativePath}`);
  }

  const segments = normalizedRelativePath.split("/");

  if (segments.some((segment) => segment === "..")) {
    throw new PathSafetyError("PATH_INVALID", `Path traversal is not allowed: ${relativePath}`);
  }

  if (segments.some((segment) => RESERVED_DIRECTORIES.has(segment))) {
    throw new PathSafetyError("PATH_RESERVED", `Reserved directories cannot be modified: ${relativePath}`);
  }

  const targetPath = path.resolve(rootPath, normalizedRelativePath);
  const boundaryPath = findBoundaryPath(rootPath, targetPath);
  const normalizedBoundary = normalizeForComparison(boundaryPath);
  const normalizedRoot = normalizeForComparison(rootPath);

  if (normalizedBoundary !== normalizedRoot && !normalizedBoundary.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new PathSafetyError("PATH_ESCAPE", `Resolved path escapes the project root: ${relativePath}`);
  }

  return targetPath;
}

export function resolveExistingProjectPath(rootDir: string, relativePath: string): string {
  const targetPath = resolveProjectTargetPath(rootDir, relativePath);

  if (!existsSync(targetPath)) {
    throw new PathSafetyError("PATH_MISSING", `Path does not exist: ${relativePath}`);
  }

  return realpathSync(targetPath);
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function findBoundaryPath(rootPath: string, targetPath: string): string {
  if (existsSync(targetPath)) {
    return realpathSync(targetPath);
  }

  let currentPath = path.dirname(targetPath);

  while (normalizeForComparison(currentPath) !== normalizeForComparison(rootPath)) {
    if (existsSync(currentPath)) {
      return realpathSync(currentPath);
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return rootPath;
}

function normalizeForComparison(targetPath: string): string {
  return path.normalize(targetPath).toLowerCase();
}

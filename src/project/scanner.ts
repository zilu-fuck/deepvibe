import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import ignore from "ignore";
import { simpleGit } from "simple-git";

const DEFAULT_IGNORES = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**"
];

const IGNORE_FILES = [".gitignore", ".deepvibeignore"];

export interface ScanProjectOptions {
  rootDir: string;
  instruction: string;
  maxCandidates?: number;
  ignorePatterns?: string[];
  recentGitFiles?: string[];
}

export interface ScanProjectResult {
  candidates: string[];
  explicitPaths: string[];
  scannedFiles: number;
}

export async function scanProject(options: ScanProjectOptions): Promise<ScanProjectResult> {
  const rootDir = path.resolve(options.rootDir);
  const maxCandidates = options.maxCandidates ?? 5;
  const explicitPaths = extractExplicitPaths(options.instruction);
  const files = await fg("**/*", {
    cwd: rootDir,
    dot: true,
    ignore: DEFAULT_IGNORES,
    onlyFiles: true
  });

  const fileSet = new Set(files.map(normalizeRelativePath));
  const ignoreEngine = buildIgnoreEngine(rootDir, options.ignorePatterns);
  const filteredFiles = files
    .map(normalizeRelativePath)
    .filter((filePath) => !ignoreEngine.ignores(filePath));
  const recentGitFiles = new Set(
    normalizeRelativePaths(options.recentGitFiles ?? (await listRecentGitFiles(rootDir)))
  );
  const keywords = extractKeywords(options.instruction);

  const scored = filteredFiles
    .filter((filePath) => !explicitPaths.includes(filePath))
    .map((filePath) => ({
      filePath,
      score: scoreFile(filePath, keywords, recentGitFiles, fileSet)
    }))
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));

  const forcedPaths = explicitPaths.filter((filePath) => fileSet.has(filePath));
  const candidates = [
    ...forcedPaths,
    ...scored.slice(0, maxCandidates).map((item) => item.filePath)
  ];

  return {
    candidates,
    explicitPaths: forcedPaths,
    scannedFiles: filteredFiles.length
  };
}

async function listRecentGitFiles(rootDir: string): Promise<string[]> {
  try {
    const git = simpleGit(rootDir);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return [];
    }

    const status = await git.status();

    return status.files.map((file) => normalizeRelativePath(file.path));
  } catch {
    return [];
  }
}

function buildIgnoreEngine(rootDir: string, extraPatterns: string[] | undefined) {
  const matcher = ignore();

  for (const ignoreFile of IGNORE_FILES) {
    const ignorePath = path.join(rootDir, ignoreFile);

    if (!existsSync(ignorePath)) {
      continue;
    }

    matcher.add(readIgnoreLines(readFileSync(ignorePath, "utf8")));
  }

  if (extraPatterns && extraPatterns.length > 0) {
    matcher.add(extraPatterns);
  }

  return matcher;
}

function readIgnoreLines(contents: string): string[] {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function extractExplicitPaths(instruction: string): string[] {
  const references = new Set<string>();
  const pattern = /@([^\s"'`]+\.[a-zA-Z0-9]+)/gu;

  for (const match of instruction.matchAll(pattern)) {
    const rawPath = match[1]?.replace(/[),.;:!?]+$/u, "");

    if (!rawPath) {
      continue;
    }

    references.add(normalizeRelativePath(rawPath));
  }

  return [...references];
}

function extractKeywords(instruction: string): string[] {
  const matches = instruction.toLowerCase().match(/[a-z0-9_-]{2,}/gu) ?? [];

  return [...new Set(matches)];
}

function scoreFile(
  filePath: string,
  keywords: string[],
  recentGitFiles: Set<string>,
  allFiles: Set<string>
): number {
  let score = 0;
  const normalized = filePath.toLowerCase();

  if (recentGitFiles.has(filePath)) {
    score += 10;
  }

  if (keywords.some((keyword) => normalized.includes(keyword))) {
    score += 8;
  }

  if (hasCompanionTest(filePath, allFiles)) {
    score += 3;
  }

  return score;
}

function hasCompanionTest(filePath: string, allFiles: Set<string>): boolean {
  const extension = path.posix.extname(filePath);
  const withoutExtension = filePath.slice(0, -extension.length);

  if (isTestFile(filePath)) {
    const sourceCandidate = withoutExtension
      .replace(/(\.test|\.spec)$/u, "")
      .replace(/^tests\//u, "src/");

    return extension.length > 0 && allFiles.has(`${sourceCandidate}${extension}`);
  }

  const parsed = path.posix.parse(filePath);
  const siblingTests = [
    path.posix.join(parsed.dir, `${parsed.name}.test${parsed.ext}`),
    path.posix.join(parsed.dir, `${parsed.name}.spec${parsed.ext}`),
    path.posix.join("tests", parsed.dir, `${parsed.name}.test${parsed.ext}`),
    path.posix.join("tests", parsed.dir, `${parsed.name}.spec${parsed.ext}`)
  ];

  return siblingTests.some((candidate) => allFiles.has(candidate));
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");

  return normalized.startsWith("tests/") || normalized.includes(".test.") || normalized.includes(".spec.");
}

function normalizeRelativePaths(filePaths: string[]): string[] {
  return filePaths.map(normalizeRelativePath);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

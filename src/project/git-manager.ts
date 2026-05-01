import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { simpleGit, type StatusResult } from "simple-git";

export interface RepositoryState {
  currentHead: string | null;
  isDirty: boolean;
  isRepository: boolean;
}

export interface OperationFileRecord {
  afterContent: string | null;
  afterExists: boolean;
  beforeContent: string | null;
  beforeExists: boolean;
  path: string;
  postImageHash: string;
  preImageHash: string;
}

export interface RecordedOperation {
  baseHead: string | null;
  createdAt: string;
  files: OperationFileRecord[];
  operationId: string;
}

export interface RecordedCommit {
  commitHash: string;
  summary: string;
}

export interface OperationSnapshot {
  afterContent: string | null;
  beforeContent: string | null;
  path: string;
}

export interface LastActionRecord {
  createdAt: string;
  kind: "commit" | "operation";
  reference: string;
  summary: string;
}

export interface UndoResult {
  kind: "commit" | "operation";
  reference: string;
}

const DEEPVIBE_DIR = ".deepvibe";
const COMMAND_APPROVALS_FILE = "command-approvals.json";
const CONTEXT_FILE = "context.json";
const LAST_ACTION_FILE = "last-action.json";
const OPERATIONS_DIR = "operations";
const AI_COMMIT_PREFIX = "DeepVibe:";
const INTERNAL_METADATA_PATHS = new Set([
  `${DEEPVIBE_DIR}/${LAST_ACTION_FILE}`,
  `${DEEPVIBE_DIR}/${CONTEXT_FILE}`,
  `${DEEPVIBE_DIR}/${COMMAND_APPROVALS_FILE}`
]);

export async function inspectRepository(rootDir: string): Promise<RepositoryState> {
  const git = simpleGit(rootDir);

  try {
    const isRepository = await git.checkIsRepo();

    if (!isRepository) {
      return {
        isRepository: false,
        isDirty: false,
        currentHead: null
      };
    }

    const status = await git.status();
    let currentHead: string | null = null;

    try {
      currentHead = (await git.revparse(["HEAD"])).trim();
    } catch {
      currentHead = null;
    }

    return {
      isRepository: true,
      isDirty: hasUserVisibleGitChanges(status),
      currentHead
    };
  } catch {
    return {
      isRepository: false,
      isDirty: false,
      currentHead: null
    };
  }
}

export async function initializeRepository(rootDir: string): Promise<RepositoryState> {
  const git = simpleGit(rootDir);
  await git.init();
  return inspectRepository(rootDir);
}

export function recordOperation(
  rootDir: string,
  repositoryState: RepositoryState,
  snapshots: OperationSnapshot[],
  summary: string
): RecordedOperation {
  const deepvibeDir = path.join(rootDir, DEEPVIBE_DIR);
  const operationId = createOperationId();
  const operationsDir = path.join(deepvibeDir, OPERATIONS_DIR);
  const files = snapshots.map((snapshot) => {
    const preImageHash = hashContent(snapshot.beforeContent);
    const postImageHash = hashContent(snapshot.afterContent);

    return {
      afterContent: snapshot.afterContent,
      afterExists: snapshot.afterContent !== null,
      beforeContent: snapshot.beforeContent,
      beforeExists: snapshot.beforeContent !== null,
      path: snapshot.path,
      preImageHash,
      postImageHash
    };
  });
  const record: RecordedOperation = {
    operationId,
    createdAt: new Date().toISOString(),
    baseHead: repositoryState.currentHead,
    files
  };

  mkdirSync(operationsDir, { recursive: true });
  writeFileSync(
    path.join(operationsDir, `${operationId}.json`),
    JSON.stringify(record, null, 2),
    "utf8"
  );
  writeLastAction(rootDir, {
    createdAt: record.createdAt,
    kind: "operation",
    reference: operationId,
    summary
  });

  return record;
}

export async function createAiCommit(
  rootDir: string,
  changedPaths: string[],
  summary: string
): Promise<RecordedCommit> {
  const git = simpleGit(rootDir);
  const uniquePaths = [...new Set(changedPaths)];

  await git.add(uniquePaths);
  const commit = await git.commit(`DeepVibe: ${summary || "AI change"}`);
  writeLastAction(rootDir, {
    createdAt: new Date().toISOString(),
    kind: "commit",
    reference: commit.commit,
    summary
  });

  return {
    commitHash: commit.commit,
    summary
  };
}

export async function undoLastAiChange(rootDir: string): Promise<UndoResult> {
  const lastAction = readLastAction(rootDir);

  if (!lastAction) {
    throw new Error("No recorded AI change is available to undo.");
  }

  if (lastAction.kind === "commit") {
    return undoCommit(rootDir, lastAction);
  }

  return undoOperation(rootDir, lastAction);
}

function readLastAction(rootDir: string): LastActionRecord | null {
  const lastActionPath = path.join(rootDir, DEEPVIBE_DIR, LAST_ACTION_FILE);

  if (!existsSync(lastActionPath)) {
    return null;
  }

  return JSON.parse(readFileSync(lastActionPath, "utf8")) as LastActionRecord;
}

function writeLastAction(rootDir: string, record: LastActionRecord): void {
  const deepvibeDir = path.join(rootDir, DEEPVIBE_DIR);
  mkdirSync(deepvibeDir, { recursive: true });
  writeFileSync(path.join(deepvibeDir, LAST_ACTION_FILE), JSON.stringify(record, null, 2), "utf8");
}

function clearLastAction(rootDir: string): void {
  const lastActionPath = path.join(rootDir, DEEPVIBE_DIR, LAST_ACTION_FILE);

  if (existsSync(lastActionPath)) {
    unlinkSync(lastActionPath);
  }
}

async function undoCommit(rootDir: string, lastAction: LastActionRecord): Promise<UndoResult> {
  const git = simpleGit(rootDir);
  const status = await git.status();

  if (hasUserVisibleGitChanges(status)) {
    throw new Error("Cannot undo an AI commit while the working tree has uncommitted changes.");
  }

  const currentHead = (await git.revparse(["HEAD"])).trim();

  if (currentHead !== lastAction.reference) {
    throw new Error("The latest AI commit is no longer at HEAD, so automatic undo is unsafe.");
  }

  const headMessage = (await git.show(["-s", "--format=%s", "HEAD"])).trim();

  if (!headMessage.startsWith(AI_COMMIT_PREFIX)) {
    throw new Error("HEAD is not an AI commit, so automatic undo is unsafe.");
  }

  await git.raw(["revert", "--no-edit", lastAction.reference]);
  clearLastAction(rootDir);

  return {
    kind: "commit",
    reference: lastAction.reference
  };
}

function undoOperation(rootDir: string, lastAction: LastActionRecord): UndoResult {
  const operationPath = path.join(rootDir, DEEPVIBE_DIR, OPERATIONS_DIR, `${lastAction.reference}.json`);

  if (!existsSync(operationPath)) {
    throw new Error("The recorded AI operation file could not be found.");
  }

  const operation = JSON.parse(readFileSync(operationPath, "utf8")) as RecordedOperation;

  for (const file of operation.files) {
    const absolutePath = path.join(rootDir, file.path);
    const currentExists = existsSync(absolutePath);
    const currentContent = currentExists ? readFileSync(absolutePath, "utf8") : null;
    const currentHash = hashContent(currentContent);

    if (currentHash !== file.postImageHash) {
      throw new Error(`Cannot undo ${file.path} because it has changed since the AI operation was applied.`);
    }
  }

  for (const file of operation.files) {
    const absolutePath = path.join(rootDir, file.path);

    if (!file.beforeExists) {
      if (existsSync(absolutePath)) {
        rmSync(absolutePath, { force: true });
      }

      continue;
    }

    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.beforeContent ?? "", "utf8");
  }

  clearLastAction(rootDir);

  return {
    kind: "operation",
    reference: lastAction.reference
  };
}

function createOperationId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hashContent(text: string | null): string {
  if (text === null) {
    return "missing";
  }

  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function hasUserVisibleGitChanges(status: StatusResult): boolean {
  return status.files.some((file) => !isInternalMetadataPath(file.path));
}

function isInternalMetadataPath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/gu, "/");

  if (INTERNAL_METADATA_PATHS.has(normalized)) {
    return true;
  }

  return normalized.startsWith(`${DEEPVIBE_DIR}/${OPERATIONS_DIR}/`);
}

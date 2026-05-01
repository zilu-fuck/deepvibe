import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CommandApprovalEntry {
  command: string;
  createdAt: string;
  cwd: string;
}

export interface CommandApprovalStore {
  approvals: CommandApprovalEntry[];
  version: 1;
}

const STORE_FILE = "command-approvals.json";

export function loadCommandApprovalStore(rootDir: string): CommandApprovalStore {
  const storePath = getCommandApprovalStorePath(rootDir);

  if (!existsSync(storePath)) {
    return {
      version: 1,
      approvals: []
    };
  }

  const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Partial<CommandApprovalStore>;

  if (parsed.version !== 1 || !Array.isArray(parsed.approvals)) {
    return {
      version: 1,
      approvals: []
    };
  }

  return {
    version: 1,
    approvals: parsed.approvals.filter(isApprovalEntry)
  };
}

export function isCommandPersistentlyApproved(
  store: CommandApprovalStore,
  approval: { command: string; cwd: string }
): boolean {
  return store.approvals.some(
    (entry) => normalizeApprovalKey(entry.cwd, entry.command) === normalizeApprovalKey(approval.cwd, approval.command)
  );
}

export function rememberApprovedCommand(
  rootDir: string,
  store: CommandApprovalStore,
  approval: { command: string; cwd: string }
): CommandApprovalStore {
  if (isCommandPersistentlyApproved(store, approval)) {
    return store;
  }

  const nextStore: CommandApprovalStore = {
    version: 1,
    approvals: [
      ...store.approvals,
      {
        command: approval.command,
        cwd: approval.cwd,
        createdAt: new Date().toISOString()
      }
    ]
  };

  persistCommandApprovalStore(rootDir, nextStore);

  return nextStore;
}

function persistCommandApprovalStore(rootDir: string, store: CommandApprovalStore): void {
  const storePath = getCommandApprovalStorePath(rootDir);

  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function getCommandApprovalStorePath(rootDir: string): string {
  return path.join(rootDir, ".deepvibe", STORE_FILE);
}

function normalizeApprovalKey(cwd: string, command: string): string {
  return `${cwd.trim().replace(/\\/gu, "/")}::${command.trim().replace(/\s+/gu, " ").toLowerCase()}`;
}

function isApprovalEntry(value: unknown): value is CommandApprovalEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.command === "string" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.createdAt === "string"
  );
}

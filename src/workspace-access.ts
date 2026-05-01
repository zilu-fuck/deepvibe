import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { detectLanguage, t, type Language } from "./i18n.js";

export type WorkspaceAccessMode = "sandbox" | "full";

export interface WorkspaceAccessInfo {
  effectiveCwd: string;
  mode: WorkspaceAccessMode;
  requestedCwd: string;
  sandboxRoot?: string;
}

interface WorkspaceTrustEntry {
  mode: WorkspaceAccessMode;
  updatedAt: string;
}

interface WorkspaceTrustStore {
  version: 1;
  workspaces: Record<string, WorkspaceTrustEntry>;
}

const STORE_FILE = "workspace-trust.json";
const sandboxCleanupPaths = new Set<string>();
let cleanupRegistered = false;

export function loadWorkspaceTrustStore(homeDir?: string): WorkspaceTrustStore {
  const storePath = resolveWorkspaceTrustStorePath(homeDir);

  if (!existsSync(storePath)) {
    return {
      version: 1,
      workspaces: {}
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as WorkspaceTrustStore;

    if (parsed.version !== 1 || typeof parsed.workspaces !== "object" || parsed.workspaces === null) {
      return {
        version: 1,
        workspaces: {}
      };
    }

    return parsed;
  } catch {
    return {
      version: 1,
      workspaces: {}
    };
  }
}

export function getWorkspaceTrust(cwd: string, homeDir?: string): WorkspaceTrustEntry | undefined {
  const store = loadWorkspaceTrustStore(homeDir);
  return store.workspaces[normalizeWorkspaceKey(cwd)];
}

export function setWorkspaceTrust(cwd: string, mode: WorkspaceAccessMode, homeDir?: string): WorkspaceTrustStore {
  const storePath = resolveWorkspaceTrustStorePath(homeDir);
  const store = loadWorkspaceTrustStore(homeDir);
  const key = normalizeWorkspaceKey(cwd);
  const nextStore: WorkspaceTrustStore = {
    version: 1,
    workspaces: {
      ...store.workspaces,
      [key]: {
        mode,
        updatedAt: new Date().toISOString()
      }
    }
  };

  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");

  return nextStore;
}

export function clearWorkspaceTrust(cwd: string, homeDir?: string): WorkspaceTrustStore {
  const storePath = resolveWorkspaceTrustStorePath(homeDir);
  const store = loadWorkspaceTrustStore(homeDir);
  const key = normalizeWorkspaceKey(cwd);
  const { [key]: _removed, ...remaining } = store.workspaces;
  const nextStore: WorkspaceTrustStore = {
    version: 1,
    workspaces: remaining
  };

  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");

  return nextStore;
}

export async function prepareWorkspaceAccess(options: {
  createInterfaceFn?: typeof createInterface;
  cwd: string;
  homeDir?: string;
  input: NodeJS.ReadableStream;
  lang?: Language;
  output: NodeJS.WritableStream;
}): Promise<WorkspaceAccessInfo> {
  const lang = options.lang ?? detectLanguage();
  const requestedCwd = path.resolve(options.cwd);
  const existingTrust = getWorkspaceTrust(requestedCwd, options.homeDir);
  let mode: WorkspaceAccessMode;

  if (existingTrust) {
    mode = existingTrust.mode;
  } else if ((options.input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY && (options.output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY) {
    mode = await promptWorkspaceTrust({ ...options, lang });
    setWorkspaceTrust(requestedCwd, mode, options.homeDir);
  } else {
    mode = "sandbox";
    setWorkspaceTrust(requestedCwd, mode, options.homeDir);
  }

  if (mode === "full") {
    return {
      requestedCwd,
      effectiveCwd: requestedCwd,
      mode
    };
  }

  const sandboxRoot = createSandboxWorkspace(requestedCwd);

  return {
    requestedCwd,
    effectiveCwd: sandboxRoot,
    mode,
    sandboxRoot
  };
}

export function getDefaultWorkspaceSandboxConfig() {
  return {
    enabled: true,
    image: "node:20-alpine",
    network: "none" as const,
    readOnlyRootFilesystem: true,
    mountPath: "/workspace",
    tmpfsPaths: ["/tmp", "/var/tmp"]
  };
}

function createSandboxWorkspace(sourceDir: string): string {
  const sandboxRoot = path.join(tmpdir(), `deepvibe-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(sourceDir, sandboxRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: true
  });
  registerSandboxCleanup(sandboxRoot);
  return sandboxRoot;
}

function registerSandboxCleanup(sandboxRoot: string): void {
  sandboxCleanupPaths.add(sandboxRoot);

  if (cleanupRegistered) {
    return;
  }

  const cleanup = () => {
    for (const target of sandboxCleanupPaths) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  cleanupRegistered = true;
}

async function promptWorkspaceTrust(options: {
  createInterfaceFn?: typeof createInterface;
  cwd: string;
  homeDir?: string;
  input: NodeJS.ReadableStream;
  lang: Language;
  output: NodeJS.WritableStream;
}): Promise<WorkspaceAccessMode> {
  const readline = (options.createInterfaceFn ?? createInterface)({
    input: options.input,
    output: options.output
  });

  try {
    while (true) {
      const answer = (await readline.question(
        t("workspace.trust.prompt", options.lang, { cwd: path.resolve(options.cwd) })
      )).trim().toLowerCase();

      if (answer === "" || answer === "s" || answer === "sandbox") {
        return "sandbox";
      }

      if (answer === "f" || answer === "full" || answer === "trust") {
        return "full";
      }

      if (answer === "n" || answer === "no" || answer === "cancel") {
        return "sandbox";
      }

      options.output.write(`${t("workspace.trust.bad_choice", options.lang)}\n`);
    }
  } finally {
    readline.close();
  }
}

function resolveWorkspaceTrustStorePath(homeDir?: string): string {
  const resolvedHome = homeDir ?? homedir();
  return path.join(resolvedHome, ".deepvibe", STORE_FILE);
}

function normalizeWorkspaceKey(cwd: string): string {
  return path.resolve(cwd).toLowerCase();
}

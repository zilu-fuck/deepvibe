import { fork } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LocalTool, ToolExecutionContext } from "./tools.js";

const PLUGINS_DIR = path.join(".deepvibe", "plugins");
const MANIFEST_FILE = "plugin.json";
const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS = 1_000;
const DEFAULT_PLUGIN_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_MEMORY_MB = 64;
const DEFAULT_PLUGIN_MAX_RESULT_CHARS = 64_000;

function resolvePluginHostPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(dir, "plugin-host.cjs");

  if (existsSync(sibling)) {
    return sibling;
  }

  return path.resolve(dir, "..", "plugin-host.cjs");
}

export interface PluginManifest {
  entry: string;
  enabled?: boolean;
  name: string;
  permissions?: PluginPermissions;
  runtime?: PluginRuntimeConfig;
  version?: string;
}

export interface PluginPermissions {
  allowInService?: boolean;
  runCommands?: boolean;
  webSearch?: boolean;
  writeProject?: boolean;
}

export interface PluginDefinition {
  createTools?: (context: ToolExecutionContext) => Promise<LocalTool[]> | LocalTool[];
  dispose?: () => Promise<void> | void;
  initialize?: (context: ToolExecutionContext) => Promise<void> | void;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  tools: LocalTool[];
}

export interface PluginDiscoveryInfo {
  enabledCount: number;
  errorCount: number;
}

export interface PluginRuntimeConfig {
  maxResultChars?: number;
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export interface PluginToolDefinition {
  type: "function";
  function: {
    description: string;
    name: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLoadError";
  }
}

export async function loadPluginTools(
  rootDir: string,
  context: ToolExecutionContext
): Promise<LoadedPlugin[]> {
  const manifests = discoverPluginManifests(rootDir);
  const loadedPlugins: LoadedPlugin[] = [];

  for (const manifestRecord of manifests) {
    if (manifestRecord.manifest.enabled === false) {
      continue;
    }

    const pluginContext = createRestrictedPluginContext(context, manifestRecord.manifest.permissions);
    const described = await callPluginHost({
      action: "describe",
      context: toPluginHostContext(pluginContext),
      entryPath: manifestRecord.entryPath,
      pluginName: manifestRecord.manifest.name
    }, resolvePluginTimeoutMs(manifestRecord.manifest, DEFAULT_PLUGIN_LOAD_TIMEOUT_MS), resolvePluginMemoryLimitMb(manifestRecord.manifest), pluginContext.abortSignal);
    const definitions = described.definitions as PluginToolDefinition[];
    const tools = definitions.map((definition) =>
      wrapPluginTool(
        {
          definition,
          execute: async (argumentsJson, executionContext) => {
            const runtimePluginContext = createRestrictedPluginContext(executionContext, manifestRecord.manifest.permissions);
            const executed = await callPluginHost({
              action: "execute",
              argumentsJson,
              context: toPluginHostContext(runtimePluginContext),
              entryPath: manifestRecord.entryPath,
              pluginName: manifestRecord.manifest.name,
              toolName: definition.function.name
            }, resolvePluginTimeoutMs(manifestRecord.manifest, DEFAULT_PLUGIN_EXEC_TIMEOUT_MS), resolvePluginMemoryLimitMb(manifestRecord.manifest), runtimePluginContext.abortSignal);

            const content = executed.content;

            if (typeof content !== "string") {
              throw new PluginLoadError(`Plugin "${manifestRecord.manifest.name}" returned a non-string tool result.`);
            }

            const maxResultChars = resolvePluginMaxResultChars(manifestRecord.manifest);

            if (content.length > maxResultChars) {
              throw new PluginLoadError(
                `Plugin "${manifestRecord.manifest.name}" exceeded the maximum result size of ${maxResultChars} characters.`
              );
            }

            return content;
          }
        },
        manifestRecord.manifest.permissions
      )
    );

    loadedPlugins.push({
      manifest: manifestRecord.manifest,
      tools
    });
  }

  return loadedPlugins;
}

export function inspectPluginDiscovery(rootDir: string): PluginDiscoveryInfo {
  const pluginsRoot = path.join(rootDir, PLUGINS_DIR);

  if (!existsSync(pluginsRoot)) {
    return {
      enabledCount: 0,
      errorCount: 0
    };
  }

  const entries = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  let enabledCount = 0;
  let errorCount = 0;

  for (const entry of entries) {
    try {
      const pluginDir = path.join(pluginsRoot, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE);

      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = readManifest(manifestPath);

      if (manifest.enabled !== false) {
        enabledCount += 1;
      }
    } catch {
      errorCount += 1;
    }
  }

  return {
    enabledCount,
    errorCount
  };
}

function discoverPluginManifests(rootDir: string): Array<{ entryPath: string; manifest: PluginManifest }> {
  const pluginsRoot = path.join(rootDir, PLUGINS_DIR);

  if (!existsSync(pluginsRoot)) {
    return [];
  }

  const entries = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const manifests: Array<{ entryPath: string; manifest: PluginManifest }> = [];

  for (const entry of entries) {
    const pluginDir = path.join(pluginsRoot, entry.name);
    const manifestPath = path.join(pluginDir, MANIFEST_FILE);

    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = readManifest(manifestPath);
    const entryPath = resolvePluginEntry(pluginDir, manifest.entry);

    manifests.push({
      manifest,
      entryPath
    });
  }

  return manifests;
}

function readManifest(manifestPath: string): PluginManifest {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const unknownKeys = Object.keys(parsed).filter((key) => !["name", "entry", "enabled", "permissions", "runtime", "version"].includes(key));

    if (unknownKeys.length > 0) {
      throw new PluginLoadError(`Unknown plugin manifest keys in ${manifestPath}: ${unknownKeys.join(", ")}.`);
    }

    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
      throw new PluginLoadError(`Plugin manifest ${manifestPath} requires a non-empty "name".`);
    }

    if (typeof parsed.entry !== "string" || parsed.entry.trim().length === 0) {
      throw new PluginLoadError(`Plugin manifest ${manifestPath} requires a non-empty "entry".`);
    }

    if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
      throw new PluginLoadError(`Plugin manifest ${manifestPath} field "enabled" must be boolean.`);
    }

    const permissions = readPermissions(parsed.permissions, manifestPath);
    const runtime = readRuntimeConfig(parsed.runtime, manifestPath);

    return {
      name: parsed.name.trim(),
      entry: parsed.entry.trim(),
      enabled: parsed.enabled as boolean | undefined,
      permissions,
      runtime,
      version: typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : undefined
    };
  } catch (error) {
    if (error instanceof PluginLoadError) {
      throw error;
    }

    throw new PluginLoadError(`Failed to parse plugin manifest ${manifestPath}.`);
  }
}

function resolvePluginEntry(pluginDir: string, entry: string): string {
  const entryPath = path.resolve(pluginDir, entry);
  const normalizedPluginDir = path.normalize(pluginDir).toLowerCase();
  const normalizedEntryPath = path.normalize(entryPath).toLowerCase();

  if (normalizedEntryPath !== normalizedPluginDir && !normalizedEntryPath.startsWith(`${normalizedPluginDir}${path.sep}`)) {
    throw new PluginLoadError(`Plugin entry escapes plugin directory: ${entry}`);
  }

  if (!existsSync(entryPath)) {
    throw new PluginLoadError(`Plugin entry does not exist: ${entryPath}`);
  }

  return entryPath;
}

function readPermissions(value: unknown, manifestPath: string): PluginPermissions | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    throw new PluginLoadError(`Plugin manifest ${manifestPath} field "permissions" must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !["allowInService", "runCommands", "webSearch", "writeProject"].includes(key)
  );

  if (unknownKeys.length > 0) {
    throw new PluginLoadError(
      `Unknown plugin permission keys in ${manifestPath}: ${unknownKeys.join(", ")}.`
    );
  }

  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== "boolean") {
      throw new PluginLoadError(`Plugin manifest ${manifestPath} permission "${key}" must be boolean.`);
    }
  }

  return {
    allowInService: record.allowInService as boolean | undefined,
    runCommands: record.runCommands as boolean | undefined,
    webSearch: record.webSearch as boolean | undefined,
    writeProject: record.writeProject as boolean | undefined
  };
}

function readRuntimeConfig(value: unknown, manifestPath: string): PluginRuntimeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    throw new PluginLoadError(`Plugin manifest ${manifestPath} field "runtime" must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !["timeoutMs", "memoryLimitMb", "maxResultChars"].includes(key));

  if (unknownKeys.length > 0) {
    throw new PluginLoadError(`Unknown plugin runtime keys in ${manifestPath}: ${unknownKeys.join(", ")}.`);
  }

  if (record.timeoutMs !== undefined && !isPositiveNumber(record.timeoutMs)) {
    throw new PluginLoadError(`Plugin manifest ${manifestPath} runtime.timeoutMs must be a positive number.`);
  }

  if (record.memoryLimitMb !== undefined && !isPositiveNumber(record.memoryLimitMb)) {
    throw new PluginLoadError(`Plugin manifest ${manifestPath} runtime.memoryLimitMb must be a positive number.`);
  }

  if (record.maxResultChars !== undefined && !isPositiveNumber(record.maxResultChars)) {
    throw new PluginLoadError(`Plugin manifest ${manifestPath} runtime.maxResultChars must be a positive number.`);
  }

  return {
    maxResultChars: record.maxResultChars as number | undefined,
    timeoutMs: record.timeoutMs as number | undefined,
    memoryLimitMb: record.memoryLimitMb as number | undefined
  };
}

function createRestrictedPluginContext(
  context: ToolExecutionContext,
  permissions: PluginPermissions | undefined
): ToolExecutionContext {
  return {
    ...context,
    commandApproval: permissions?.runCommands ? context.commandApproval : undefined,
    commandPermissions: permissions?.runCommands ? context.commandPermissions : undefined,
    commandRunner: permissions?.runCommands ? context.commandRunner : undefined,
    mutations: permissions?.writeProject ? context.mutations : undefined,
    searchWeb: permissions?.webSearch ? context.searchWeb : undefined
  };
}

function wrapPluginTool(tool: LocalTool, permissions: PluginPermissions | undefined): LocalTool {
  return {
    definition: tool.definition,
    execute: async (argumentsJson, context) => {
      if (context.executionMode === "service" && !permissions?.allowInService) {
        throw new PluginLoadError(`Plugin tool "${tool.definition.function.name}" is not allowed in service mode.`);
      }

      const restrictedContext = createRestrictedPluginContext(context, permissions);

      return tool.execute(argumentsJson, restrictedContext);
    }
  };
}

function toPluginHostContext(context: ToolExecutionContext): Record<string, unknown> {
  return {
    executionMode: context.executionMode,
    instruction: context.instruction,
    repositoryState: context.repositoryState ?? null,
    rootDir: context.rootDir,
    mutations: context.mutations ? { available: true } : undefined,
    commandPermissions: context.commandPermissions ? { available: true } : undefined,
    commandRunner: context.commandRunner ? { available: true } : undefined
  };
}

async function callPluginHost(
  message: Record<string, unknown>,
  timeoutMs: number,
  memoryLimitMb: number,
  abortSignal?: AbortSignal
): Promise<Record<string, unknown>> {
  const hostPath = resolvePluginHostPath();

  if (!existsSync(hostPath)) {
    throw new PluginLoadError(`Plugin host entry does not exist: ${hostPath}`);
  }

  if (abortSignal?.aborted) {
    throw new PluginLoadError("Plugin host call was aborted before execution.");
  }

  const child = fork(hostPath, [], {
    execArgv: [`--max-old-space-size=${memoryLimitMb}`],
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      callback();
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish(() => reject(new PluginLoadError(`Plugin host timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(() => reject(new PluginLoadError("Plugin host call was aborted.")));
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.once("message", (response: unknown) => {
      finish(() => {
        child.disconnect?.();
        child.kill();

        const record = response as { ok?: boolean; result?: Record<string, unknown>; error?: string };

        if (!record?.ok) {
          reject(new PluginLoadError(record?.error ?? "Plugin host returned an unknown error."));
          return;
        }

        resolve(record.result ?? {});
      });
    });

    child.once("error", (error) => {
      finish(() => reject(new PluginLoadError(`Plugin host process failed: ${error.message}`)));
    });

    child.once("exit", (code, signal) => {
      finish(() =>
        reject(
          new PluginLoadError(
            `Plugin host exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"}).`
          )
        )
      );
    });

    child.send(message);
  });
}

function resolvePluginTimeoutMs(manifest: PluginManifest, fallback: number): number {
  const value = manifest.runtime?.timeoutMs;

  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolvePluginMemoryLimitMb(manifest: PluginManifest): number {
  const value = manifest.runtime?.memoryLimitMb;

  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PLUGIN_MEMORY_MB;
}

function resolvePluginMaxResultChars(manifest: PluginManifest): number {
  const value = manifest.runtime?.maxResultChars;

  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(256, Math.floor(value))
    : DEFAULT_PLUGIN_MAX_RESULT_CHARS;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

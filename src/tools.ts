import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";

import type { ChatCompletionTool, ChatCompletionToolCall } from "./llm/deepseek-client.js";
import type { AppliedFileChange } from "./patcher.js";
import { resolveExistingProjectPath, resolveProjectTargetPath } from "./path-safety.js";
import { hasWebSearchTrigger, searchWeb } from "./search.js";
import type { SearchWebOptions, WebSearchResult } from "./search.js";
import type { CommandPolicyEntry, CommandRiskLevel, CommandToolPermissionConfig, DockerSandboxConfig } from "./config.js";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_READ_CHAR_LIMIT = 12_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_MAX_OUTPUT_CHARS = 16_000;
const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  approvedCommands?: Set<string>;
  abortSignal?: AbortSignal;
  commandApproval?: CommandApprovalHandler;
  commandPermissions?: CommandToolPermissions;
  commandRunner?: CommandRunner;
  executionMode?: "cli" | "service";
  instruction: string;
  mutations?: ToolMutationState;
  repositoryState?: { isDirty: boolean };
  rootDir: string;
  searchWeb?: (options: SearchWebOptions) => Promise<WebSearchResult[]>;
}

export interface LocalTool {
  definition: ChatCompletionTool;
  execute: (argumentsJson: string, context: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionResult {
  content: string;
  tool_call_id: string;
}

export interface ToolMutationState {
  applied: Map<string, AppliedFileChange>;
}

export interface CommandToolPermissions {
  policies: CommandPolicy[];
  enabled: boolean;
  maxOutputChars: number;
  requireApproval: boolean;
  timeoutMs: number;
}

export interface CommandPolicy {
  allowInService: boolean;
  allowPersistentApproval: boolean;
  allowedDirectories?: string[];
  maxOutputChars?: number;
  prefix: string;
  requireCleanGit: boolean;
  risk: CommandRiskLevel;
  timeoutMs?: number;
}

export interface CommandExecutionRequest {
  abortSignal?: AbortSignal;
  command: string;
  cwd: string;
  maxOutputChars: number;
  timeoutMs: number;
}

export interface CommandExecutionResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
export type CommandApprovalHandler = (request: CommandApprovalRequest) => Promise<boolean>;

export interface CommandApprovalRequest {
  allowPersistentApproval?: boolean;
  command: string;
  cwd: string;
  risk: CommandRiskLevel;
}

export function createDefaultTools(context: ToolExecutionContext): LocalTool[] {
  const tools: LocalTool[] = [
    createListFilesTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createDeleteFileTool()
  ];

  if (context.commandPermissions?.enabled && context.commandPermissions.policies.length > 0) {
    tools.push(createRunCommandTool());
  }

  if (hasWebSearchTrigger(context.instruction)) {
    tools.push(createWebSearchTool(context.searchWeb));
  }

  return tools;
}

export async function executeToolCalls(
  toolCalls: ChatCompletionToolCall[],
  tools: LocalTool[],
  context: ToolExecutionContext
): Promise<ToolExecutionResult[]> {
  const toolMap = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  const results: ToolExecutionResult[] = [];

  for (const toolCall of toolCalls) {
    if (context.abortSignal?.aborted) {
      throw new Error("Tool execution was aborted.");
    }

    const tool = toolMap.get(toolCall.function.name);

    if (!tool) {
      results.push({
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          ok: false,
          error: `Unknown tool: ${toolCall.function.name}`
        })
      });
      continue;
    }

    try {
      const content = await tool.execute(toolCall.function.arguments, context);
      results.push({
        tool_call_id: toolCall.id,
        content
      });
    } catch (error) {
      results.push({
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown tool execution error"
        })
      });
    }
  }

  return results;
}

export function createToolMutationState(): ToolMutationState {
  return {
    applied: new Map<string, AppliedFileChange>()
  };
}

export function listToolMutations(state: ToolMutationState): AppliedFileChange[] {
  return [...state.applied.values()];
}

export function rollbackToolMutations(state: ToolMutationState, rootDir: string): void {
  const mutations = [...state.applied.values()].reverse();

  for (const mutation of mutations) {
    const targetPath = resolveProjectTargetPath(rootDir, mutation.path);

    if (mutation.beforeContent === null) {
      if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true });
      }

      continue;
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, mutation.beforeContent, "utf8");
  }
}

export function resolveCommandPermissions(config: CommandToolPermissionConfig | undefined): CommandToolPermissions | undefined {
  if (!config?.enabled) {
    return undefined;
  }

  const allowedPrefixes = (config.allowedPrefixes ?? []).map((prefix) => prefix.trim()).filter(Boolean);
  const policies = normalizeCommandPolicies(config.commandPolicies, allowedPrefixes);

  if (policies.length === 0) {
    return undefined;
  }

  return {
    enabled: true,
    policies,
    requireApproval: config.requireApproval ?? true,
    timeoutMs:
      typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
        ? Math.max(1000, Math.floor(config.timeoutMs))
        : DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputChars:
      typeof config.maxOutputChars === "number" && Number.isFinite(config.maxOutputChars)
        ? Math.max(256, Math.floor(config.maxOutputChars))
        : DEFAULT_COMMAND_MAX_OUTPUT_CHARS
  };
}

export function resolveConfiguredCommandRunner(
  rootDir: string,
  config: CommandToolPermissionConfig | undefined,
  fallbackRunner?: CommandRunner
): CommandRunner | undefined {
  if (fallbackRunner) {
    return fallbackRunner;
  }

  if (!config?.sandbox || config.sandbox.enabled === false) {
    return undefined;
  }

  return createDockerSandboxCommandRunner(rootDir, config.sandbox);
}

export function createDockerSandboxCommandRunner(
  rootDir: string,
  sandbox: DockerSandboxConfig
): CommandRunner {
  const invocationDefaults = {
    image: sandbox.image.trim(),
    mountPath: sandbox.mountPath?.trim() || "/workspace",
    network: sandbox.network ?? "none",
    readOnlyRootFilesystem: sandbox.readOnlyRootFilesystem ?? true,
    tmpfsPaths: sandbox.tmpfsPaths?.length ? sandbox.tmpfsPaths : ["/tmp", "/var/tmp"]
  };

  return async (request) => {
    const invocation = buildDockerSandboxInvocation(rootDir, request, invocationDefaults);

    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
        cwd: invocation.cwd,
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputChars * 4,
        signal: request.abortSignal
      });

      return {
        exitCode: 0,
        stdout: truncateOutput(stdout, request.maxOutputChars),
        stderr: truncateOutput(stderr, request.maxOutputChars)
      };
    } catch (error) {
      const executionError = error as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stderr?: string;
        stdout?: string;
      };

      if (executionError.killed || executionError.signal === "SIGTERM") {
        throw new Error(`Sandboxed command timed out after ${request.timeoutMs}ms.`);
      }

      if (typeof executionError.stdout === "string" || typeof executionError.stderr === "string" || typeof executionError.code === "number") {
        return {
          exitCode: typeof executionError.code === "number" ? executionError.code : 1,
          stdout: truncateOutput(executionError.stdout ?? "", request.maxOutputChars),
          stderr: truncateOutput(executionError.stderr ?? "", request.maxOutputChars)
        };
      }

      if (executionError.code === "ENOENT") {
        throw new Error(`Docker executable was not found. Install Docker or disable command sandboxing.`);
      }

      throw error;
    }
  };
}

export function buildDockerSandboxInvocation(
  rootDir: string,
  request: CommandExecutionRequest,
  sandbox: {
    image: string;
    mountPath: string;
    network: "bridge" | "none";
    readOnlyRootFilesystem: boolean;
    tmpfsPaths: string[];
  }
): { args: string[]; cwd: string; file: string } {
  const mountSpec = `type=bind,src=${path.resolve(rootDir)},dst=${sandbox.mountPath},readonly`;
  const relativeCwd = normalizeRelativePath(path.relative(rootDir, request.cwd) || ".");
  const containerWorkdir = relativeCwd === "."
    ? sandbox.mountPath
    : path.posix.join(sandbox.mountPath, relativeCwd.replace(/\\/g, "/"));

  const args = [
    "run",
    "--rm",
    "--workdir",
    containerWorkdir,
    "--mount",
    mountSpec,
    "--network",
    sandbox.network
  ];

  if (sandbox.readOnlyRootFilesystem) {
    args.push("--read-only");
  }

  for (const tmpfsPath of sandbox.tmpfsPaths) {
    args.push("--tmpfs", tmpfsPath);
  }

  args.push(sandbox.image, "sh", "-lc", request.command);

  return {
    file: "docker",
    args,
    cwd: rootDir
  };
}

function createListFilesTool(): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description: "List project files under a directory, optionally filtered by a glob pattern.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Relative directory path inside the project root." },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            pattern: { type: "string", description: "Optional glob pattern such as **/*.ts." }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);
      const directory = typeof args.directory === "string" ? args.directory : ".";
      const limit = normalizeLimit(args.limit);
      const pattern = typeof args.pattern === "string" ? args.pattern : "**/*";
      const absoluteDir = resolveExistingPath(context.rootDir, directory);
      const cwd = path.relative(context.rootDir, absoluteDir) || ".";
      const files = await fg(pattern, {
        cwd: absoluteDir,
        dot: false,
        onlyFiles: true
      });
      const normalizedFiles = files
        .slice(0, limit)
        .map((filePath) => normalizeRelativePath(path.join(cwd, filePath)));

      return JSON.stringify({
        ok: true,
        directory: normalizeRelativePath(cwd),
        files: normalizedFiles
      });
    }
  };
}

function createReadFileTool(): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file from the project root.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Relative file path inside the project root." },
            max_chars: { type: "integer", minimum: 64, maximum: 50000 }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);

      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        throw new Error('read_file requires a non-empty "path" argument.');
      }

      const absolutePath = resolveExistingProjectPath(context.rootDir, args.path);
      const maxChars =
        typeof args.max_chars === "number" && Number.isFinite(args.max_chars)
          ? Math.max(64, Math.min(50_000, Math.floor(args.max_chars)))
          : DEFAULT_READ_CHAR_LIMIT;
      const content = readFileSync(absolutePath, "utf8");
      const truncated = content.length > maxChars;

      return JSON.stringify({
        ok: true,
        path: normalizeRelativePath(path.relative(context.rootDir, absolutePath)),
        truncated,
        content: truncated ? `${content.slice(0, maxChars)}\n... [truncated by tool] ...` : content
      });
    }
  };
}

function createWriteFileTool(): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write UTF-8 text to a file inside the project root. Use this only when tool-driven file updates are necessary.",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Relative file path inside the project root." },
            content: { type: "string", description: "Full file content to write." }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);

      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        throw new Error('write_file requires a non-empty "path" argument.');
      }

      if (typeof args.content !== "string") {
        throw new Error('write_file requires a string "content" argument.');
      }

      if (!context.mutations) {
        throw new Error("write_file is unavailable because mutation tracking is not enabled.");
      }

      const relativePath = normalizeRelativePath(args.path);
      const absolutePath = resolveProjectTargetPath(context.rootDir, relativePath);
      const beforeContent = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;

      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, args.content, "utf8");
      recordMutation(context.mutations, {
        action: beforeContent === null ? "create" : "modify",
        afterContent: args.content,
        beforeContent,
        path: relativePath
      });

      return JSON.stringify({
        ok: true,
        path: relativePath,
        bytes: Buffer.byteLength(args.content, "utf8")
      });
    }
  };
}

function createDeleteFileTool(): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file inside the project root.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Relative file path inside the project root." }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);

      if (typeof args.path !== "string" || args.path.trim().length === 0) {
        throw new Error('delete_file requires a non-empty "path" argument.');
      }

      if (!context.mutations) {
        throw new Error("delete_file is unavailable because mutation tracking is not enabled.");
      }

      const relativePath = normalizeRelativePath(args.path);
      const absolutePath = resolveProjectTargetPath(context.rootDir, relativePath);
      const beforeContent = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;

      if (beforeContent === null) {
        throw new Error(`File does not exist: ${relativePath}`);
      }

      rmSync(absolutePath, { force: true });
      recordMutation(context.mutations, {
        action: "delete",
        afterContent: null,
        beforeContent,
        path: relativePath
      });

      return JSON.stringify({
        ok: true,
        path: relativePath
      });
    }
  };
}

function createRunCommandTool(): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description: "Run an allowed command inside the project root. Only commands matching configured allowlist prefixes may execute.",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Shell command text to execute." },
            cwd: { type: "string", description: "Optional relative working directory inside the project root." }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);

      if (typeof args.command !== "string" || args.command.trim().length === 0) {
        throw new Error('run_command requires a non-empty "command" argument.');
      }

      const permissions = context.commandPermissions;

      if (!permissions?.enabled || permissions.policies.length === 0) {
        throw new Error(
          `Detected a potentially dangerous command request: "${args.command}". ` +
          `run_command is currently disabled by configuration. ` +
          `Use read-only commands like git status or git diff first, or test the workflow in /tmp before enabling execution.`
        );
      }

      const command = args.command.trim();
      const matchedPolicy = matchCommandPolicy(command, permissions.policies);

      if (!matchedPolicy) {
        throw new Error(formatCommandHookMessage({
          reason: "unmatched",
          command,
          allowedPrefixes: permissions.policies.map((p) => p.prefix)
        }));
      }

      const workingDirectory =
        typeof args.cwd === "string" && args.cwd.trim().length > 0
          ? resolveExistingProjectPath(context.rootDir, args.cwd)
          : context.rootDir;
      const relativeWorkingDirectory = normalizeRelativePath(path.relative(context.rootDir, workingDirectory) || ".");

      if (context.executionMode === "service" && !matchedPolicy.allowInService) {
        throw new Error(formatCommandHookMessage({
          reason: "service",
          command,
          policy: matchedPolicy
        }));
      }

      if (matchedPolicy.requireCleanGit && context.repositoryState?.isDirty) {
        throw new Error(formatCommandHookMessage({
          reason: "dirty",
          command,
          policy: matchedPolicy
        }));
      }

      if (
        matchedPolicy.allowedDirectories &&
        matchedPolicy.allowedDirectories.length > 0 &&
        !matchesAllowedDirectory(relativeWorkingDirectory, matchedPolicy.allowedDirectories)
      ) {
        throw new Error(formatCommandHookMessage({
          reason: "directory",
          command,
          policy: matchedPolicy,
          relativeWorkingDirectory
        }));
      }

      const approvalKey = `${normalizeRelativePath(path.relative(context.rootDir, workingDirectory) || ".")}::${command}`;

      if (permissions.requireApproval && !context.approvedCommands?.has(approvalKey)) {
        if (!context.commandApproval) {
          throw new Error(
            `Detected a command that requires explicit approval: "${command}". ` +
            `No approval handler is configured for this session. ` +
            `Run in an interactive terminal, review the command with git status/git diff first, or test it in /tmp.`
          );
        }

        const approved = await context.commandApproval({
          allowPersistentApproval: matchedPolicy.allowPersistentApproval,
          command,
          cwd: relativeWorkingDirectory,
          risk: matchedPolicy.risk
        });

        if (!approved) {
          throw new Error(formatCommandHookMessage({
            reason: "denied",
            command,
            policy: matchedPolicy
          }));
        }

        context.approvedCommands?.add(approvalKey);
      }

      const runner = context.commandRunner ?? runCommand;
      const effectiveMaxOutputChars = matchedPolicy.maxOutputChars ?? permissions.maxOutputChars;
      const effectiveTimeoutMs = matchedPolicy.timeoutMs ?? permissions.timeoutMs;
      const result = await runner({
        abortSignal: context.abortSignal,
        command,
        cwd: workingDirectory,
        maxOutputChars: effectiveMaxOutputChars,
        timeoutMs: effectiveTimeoutMs
      });

      return JSON.stringify({
        ok: true,
        command,
        cwd: relativeWorkingDirectory,
        risk: matchedPolicy.risk,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
  };
}

function createWebSearchTool(searchFn?: (options: SearchWebOptions) => Promise<WebSearchResult[]>): LocalTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description: "Run a web search and return the top search results.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query text." },
            max_results: { type: "integer", minimum: 1, maximum: 10 }
          }
        }
      }
    },
    async execute(argumentsJson, context) {
      const args = parseArguments(argumentsJson);

      if (typeof args.query !== "string" || args.query.trim().length === 0) {
        throw new Error('web_search requires a non-empty "query" argument.');
      }

      const executeSearch = searchFn ?? searchWeb;
      const results = await executeSearch({
        abortSignal: context.abortSignal,
        query: args.query,
        maxResults:
          typeof args.max_results === "number" && Number.isFinite(args.max_results)
            ? Math.max(1, Math.min(10, Math.floor(args.max_results)))
            : 5
      });

      return JSON.stringify({
        ok: true,
        results
      });
    }
  };
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse tool arguments: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function normalizeLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(100, Math.floor(value)));
  }

  return DEFAULT_LIST_LIMIT;
}

function resolveExistingPath(rootDir: string, relativePath: string): string {
  return resolveExistingProjectPath(rootDir, relativePath);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function recordMutation(state: ToolMutationState, mutation: AppliedFileChange): void {
  const existing = state.applied.get(mutation.path);

  if (!existing) {
    state.applied.set(mutation.path, mutation);
    return;
  }

  const merged: AppliedFileChange = {
    action:
      mutation.afterContent === null
        ? "delete"
        : existing.beforeContent === null
          ? "create"
          : "modify",
    afterContent: mutation.afterContent,
    beforeContent: existing.beforeContent,
    path: mutation.path
  };

  if (merged.beforeContent === null && merged.afterContent === null) {
    state.applied.delete(mutation.path);
    return;
  }

  state.applied.set(mutation.path, merged);
}

function matchCommandPolicy(command: string, policies: CommandPolicy[]): CommandPolicy | null {
  const normalizedCommand = normalizeCommandText(command);
  let bestMatch: CommandPolicy | null = null;
  let bestMatchPrefixLength = -1;

  for (const policy of policies) {
    const normalizedPrefix = normalizeCommandText(policy.prefix);

    if (normalizedCommand === normalizedPrefix || normalizedCommand.startsWith(`${normalizedPrefix} `)) {
      if (normalizedPrefix.length > bestMatchPrefixLength) {
        bestMatch = policy;
        bestMatchPrefixLength = normalizedPrefix.length;
      }
    }
  }

  return bestMatch;
}

function normalizeCommandPolicies(
  commandPolicies: CommandPolicyEntry[] | undefined,
  allowedPrefixes: string[]
): CommandPolicy[] {
  if (Array.isArray(commandPolicies) && commandPolicies.length > 0) {
    return commandPolicies
      .map((entry) => ({
        prefix: entry.prefix.trim(),
        risk: entry.risk ?? inferRiskFromPrefix(entry.prefix),
        allowInService: entry.allowInService ?? false,
        allowPersistentApproval: entry.allowPersistentApproval ?? (entry.risk ?? inferRiskFromPrefix(entry.prefix)) === "low",
        allowedDirectories: Array.isArray(entry.allowedDirectories)
          ? entry.allowedDirectories.map((directory) => normalizeRelativePath(directory))
          : undefined,
        requireCleanGit: entry.requireCleanGit ?? false,
        timeoutMs:
          typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs)
            ? Math.max(1000, Math.floor(entry.timeoutMs))
            : undefined,
        maxOutputChars:
          typeof entry.maxOutputChars === "number" && Number.isFinite(entry.maxOutputChars)
            ? Math.max(256, Math.floor(entry.maxOutputChars))
            : undefined
      }))
      .filter((entry) => entry.prefix.length > 0);
  }

  return allowedPrefixes.map((prefix) => ({
    prefix,
    risk: inferRiskFromPrefix(prefix),
    allowInService: false,
    allowPersistentApproval: inferRiskFromPrefix(prefix) === "low",
    allowedDirectories: undefined,
    requireCleanGit: false,
    timeoutMs: undefined,
    maxOutputChars: undefined
  }));
}

function inferRiskFromPrefix(prefix: string): CommandRiskLevel {
  const normalizedPrefix = normalizeCommandText(prefix);

  if (
    normalizedPrefix.startsWith("git status") ||
    normalizedPrefix.startsWith("git diff") ||
    normalizedPrefix.startsWith("pnpm test") ||
    normalizedPrefix.startsWith("npm test") ||
    normalizedPrefix.startsWith("pytest") ||
    normalizedPrefix.startsWith("ls") ||
    normalizedPrefix.startsWith("dir")
  ) {
    return "low";
  }

  if (
    normalizedPrefix.startsWith("git add") ||
    normalizedPrefix.startsWith("git commit") ||
    normalizedPrefix.startsWith("pnpm build") ||
    normalizedPrefix.startsWith("npm run build")
  ) {
    return "medium";
  }

  return "high";
}

function matchesAllowedDirectory(cwd: string, allowedDirectories: string[]): boolean {
  return allowedDirectories.some((directory) => {
    const normalizedDirectory = normalizeRelativePath(directory);

    if (cwd === normalizedDirectory) {
      return true;
    }

    if (normalizedDirectory === ".") {
      return true;
    }

    return cwd.startsWith(`${normalizedDirectory}/`);
  });
}

function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/gu, " ").toLowerCase();
}

function formatCommandHookMessage(options: {
  reason: "unmatched" | "service" | "dirty" | "directory" | "denied";
  command: string;
  policy?: CommandPolicy;
  allowedPrefixes?: string[];
  relativeWorkingDirectory?: string;
}): string {
  const base = `Detected a potentially dangerous command: "${options.command}".`;
  const saferAlternatives = suggestSaferAlternatives(options.command);

  switch (options.reason) {
    case "unmatched":
      return [
        base,
        `It does not match any configured command policy prefix.`,
        options.allowedPrefixes?.length ? `Allowed prefixes: ${options.allowedPrefixes.join(", ")}.` : null,
        saferAlternatives
      ].filter(Boolean).join(" ");

    case "service":
      return [
        base,
        `The matched policy "${options.policy?.prefix}" (risk: ${options.policy?.risk}) is not allowed in service mode.`,
        `Run it from an interactive local session instead.`,
        saferAlternatives
      ].filter(Boolean).join(" ");

    case "dirty":
      return [
        base,
        `The matched policy "${options.policy?.prefix}" requires a clean Git working tree.`,
        `Review the current changes with git status or git diff, then commit/stash before retrying.`,
        saferAlternatives
      ].filter(Boolean).join(" ");

    case "directory":
      return [
        base,
        `The matched policy "${options.policy?.prefix}" is not allowed in working directory "${options.relativeWorkingDirectory}".`,
        options.policy?.allowedDirectories?.length ? `Allowed directories: ${options.policy.allowedDirectories.join(", ")}.` : null,
        saferAlternatives
      ].filter(Boolean).join(" ");

    case "denied":
      return [
        base,
        `Approval was denied for the matched policy "${options.policy?.prefix}" (risk: ${options.policy?.risk}).`,
        saferAlternatives
      ].filter(Boolean).join(" ");
  }
}

function suggestSaferAlternatives(command: string): string {
  const normalized = normalizeCommandText(command);

  if (
    normalized.includes("rm ") ||
    normalized.includes("del ") ||
    normalized.includes("remove-") ||
    normalized.includes("reset --hard") ||
    normalized.includes("git clean")
  ) {
    return `Suggested safer path: inspect changes with git status or git diff first, or reproduce the command in /tmp before touching the project workspace.`;
  }

  return `Suggested safer path: start with read-only inspection commands such as git status or git diff, or test the workflow in /tmp before executing it here.`;
}

async function runCommand(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
  const shellCommand =
    process.platform === "win32"
      ? {
          file: "powershell.exe",
          args: ["-NoProfile", "-Command", request.command]
        }
      : {
          file: "sh",
          args: ["-lc", request.command]
        };
  try {
    const { stdout, stderr } = await execFileAsync(shellCommand.file, shellCommand.args, {
      cwd: request.cwd,
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputChars * 4,
      signal: request.abortSignal
    });

    return {
      exitCode: 0,
      stdout: truncateOutput(stdout, request.maxOutputChars),
      stderr: truncateOutput(stderr, request.maxOutputChars)
    };
  } catch (error) {
    const executionError = error as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stderr?: string;
      stdout?: string;
    };

    if (executionError.killed || executionError.signal === "SIGTERM") {
      throw new Error(`Command timed out after ${request.timeoutMs}ms.`);
    }

    if (typeof executionError.stdout === "string" || typeof executionError.stderr === "string" || typeof executionError.code === "number") {
      return {
        exitCode: typeof executionError.code === "number" ? executionError.code : 1,
        stdout: truncateOutput(executionError.stdout ?? "", request.maxOutputChars),
        stderr: truncateOutput(executionError.stderr ?? "", request.maxOutputChars)
      };
    }

    throw error;
  }
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n... [truncated by tool] ...`;
}

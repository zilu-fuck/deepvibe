import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SearchProviderId } from "./search.js";

export type ModelId = "deepseek-v4-pro" | "deepseek-v4-flash";
export type CommandRiskLevel = "low" | "medium" | "high";

export interface CommandPolicyEntry {
  allowInService?: boolean;
  allowPersistentApproval?: boolean;
  allowedDirectories?: string[];
  maxOutputChars?: number;
  prefix: string;
  requireCleanGit?: boolean;
  risk?: CommandRiskLevel;
  timeoutMs?: number;
}

export interface DockerSandboxConfig {
  enabled?: boolean;
  image: string;
  mountPath?: string;
  network?: "bridge" | "none";
  readOnlyRootFilesystem?: boolean;
  tmpfsPaths?: string[];
}

export interface CommandToolPermissionConfig {
  allowedPrefixes?: string[];
  commandPolicies?: CommandPolicyEntry[];
  enabled?: boolean;
  maxOutputChars?: number;
  persistApprovals?: boolean;
  requireApproval?: boolean;
  sandbox?: DockerSandboxConfig;
  timeoutMs?: number;
}

export interface ToolPermissionsConfig {
  command?: CommandToolPermissionConfig;
}

export interface RawConfig {
  apiKey?: string;
  bingApiKey?: string;
  defaultModel?: ModelId;
  ignore?: string[];
  searchProvider?: SearchProviderId;
  tavilyApiKey?: string;
  toolPermissions?: ToolPermissionsConfig;
}

export interface LoadConfigOptions {
  cwd: string;
  homeDir?: string;
}

export type ConfigTarget = "global" | "project";
export type ConfigSettableKey = "apiKey" | "bingApiKey" | "defaultModel" | "searchProvider" | "tavilyApiKey";

export interface SetConfigValueOptions extends LoadConfigOptions {
  key: string;
  target: ConfigTarget;
  value: string;
}

export interface ResolvedConfig extends RawConfig {
  globalConfigPath: string;
  projectConfigPath?: string;
}

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConfigError";
  }
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const { globalConfigPath, projectConfigPath } = resolveConfigPaths(options);

  const globalConfig = readConfigFile(globalConfigPath);
  const projectConfig = existsSync(projectConfigPath) ? readConfigFile(projectConfigPath) : undefined;

  return {
    ...globalConfig,
    ...projectConfig,
    ignore: projectConfig?.ignore ?? globalConfig?.ignore,
    toolPermissions: projectConfig?.toolPermissions ?? globalConfig?.toolPermissions,
    globalConfigPath,
    projectConfigPath: projectConfig ? projectConfigPath : undefined
  };
}

export function requireApiKey(config: ResolvedConfig): string {
  if (!config.apiKey) {
    throw new ConfigError(
      "API_KEY_MISSING",
      `DeepSeek API key not found. Expected config at ${config.globalConfigPath} or ${config.projectConfigPath ?? "project .deepvibe/config.json"}.`
    );
  }

  return config.apiKey;
}

export function loadProjectPrompt(rootDir: string): string | undefined {
  const promptPath = path.join(rootDir, ".deepvibe", "prompt.md");

  if (!existsSync(promptPath)) {
    return undefined;
  }

  const contents = readFileSync(promptPath, "utf8").trim();

  return contents.length > 0 ? contents : undefined;
}

export function setConfigValue(options: SetConfigValueOptions): {
  configPath: string;
  key: ConfigSettableKey;
  value: string;
} {
  const normalizedKey = normalizeConfigKey(options.key);
  const normalizedValue = normalizeConfigValue(normalizedKey, options.value);
  const { globalConfigPath, projectConfigPath } = resolveConfigPaths(options);
  const configPath = options.target === "project" ? projectConfigPath : globalConfigPath;
  const existingConfig = readConfigFile(configPath) ?? {};
  const nextConfig: RawConfig = {
    ...existingConfig,
    [normalizedKey]: normalizedValue
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    configPath,
    key: normalizedKey,
    value: normalizedValue
  };
}

function readConfigFile(filePath: string): RawConfig | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const contents = readFileSync(filePath, "utf8");

  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    const knownKeys: Array<keyof RawConfig> = ["apiKey", "bingApiKey", "defaultModel", "ignore", "searchProvider", "tavilyApiKey", "toolPermissions"];
    const unknownKeys = Object.keys(parsed).filter((key) => !knownKeys.includes(key as keyof RawConfig));

    if (unknownKeys.length > 0) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Unknown config keys in ${filePath}: ${unknownKeys.join(", ")}. Expected: ${knownKeys.join(", ")}.`
      );
    }

    if (parsed.ignore && !Array.isArray(parsed.ignore)) {
      throw new ConfigError("CONFIG_INVALID", `Expected "ignore" to be an array in ${filePath}.`);
    }

    validateSearchConfig(parsed, filePath);
    validateToolPermissions(parsed.toolPermissions, filePath);

    return parsed as RawConfig;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError("CONFIG_INVALID", `Failed to parse JSON config at ${filePath}.`);
  }
}

function validateSearchConfig(parsed: Record<string, unknown>, filePath: string): void {
  const provider = parsed.searchProvider;

  if (provider !== undefined && !["duckduckgo", "tavily", "bing"].includes(String(provider))) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unsupported searchProvider "${provider}" in ${filePath}. Expected duckduckgo, tavily, or bing.`
    );
  }

  if (parsed.tavilyApiKey !== undefined && typeof parsed.tavilyApiKey !== "string") {
    throw new ConfigError("CONFIG_INVALID", `Expected "tavilyApiKey" to be a string in ${filePath}.`);
  }

  if (parsed.bingApiKey !== undefined && typeof parsed.bingApiKey !== "string") {
    throw new ConfigError("CONFIG_INVALID", `Expected "bingApiKey" to be a string in ${filePath}.`);
  }
}

function validateToolPermissions(value: unknown, filePath: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "object" || value === null) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions" to be an object in ${filePath}.`);
  }

  const toolPermissions = value as Record<string, unknown>;
  const command = toolPermissions.command;

  if (command === undefined) {
    return;
  }

  if (typeof command !== "object" || command === null) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command" to be an object in ${filePath}.`);
  }

  const commandConfig = command as Record<string, unknown>;
  const unknownKeys = Object.keys(commandConfig).filter(
    (key) =>
      ![
        "enabled",
        "allowedPrefixes",
        "commandPolicies",
        "timeoutMs",
        "maxOutputChars",
        "requireApproval",
        "persistApprovals",
        "sandbox"
      ].includes(key)
  );

  if (unknownKeys.length > 0) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unknown command tool permission keys in ${filePath}: ${unknownKeys.join(", ")}.`
    );
  }

  if (commandConfig.enabled !== undefined && typeof commandConfig.enabled !== "boolean") {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.enabled" to be boolean in ${filePath}.`);
  }

  if (commandConfig.requireApproval !== undefined && typeof commandConfig.requireApproval !== "boolean") {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.requireApproval" to be boolean in ${filePath}.`
    );
  }

  if (commandConfig.persistApprovals !== undefined && typeof commandConfig.persistApprovals !== "boolean") {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.persistApprovals" to be boolean in ${filePath}.`
    );
  }

  if (commandConfig.allowedPrefixes !== undefined && !Array.isArray(commandConfig.allowedPrefixes)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.allowedPrefixes" to be an array in ${filePath}.`
    );
  }

  if (commandConfig.commandPolicies !== undefined && !Array.isArray(commandConfig.commandPolicies)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.commandPolicies" to be an array in ${filePath}.`
    );
  }

  if (commandConfig.sandbox !== undefined) {
    validateCommandSandboxConfig(commandConfig.sandbox, filePath);
  }

  if (Array.isArray(commandConfig.allowedPrefixes)) {
    for (const prefix of commandConfig.allowedPrefixes) {
      if (typeof prefix !== "string" || prefix.trim().length === 0) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.allowedPrefixes" entry to be a non-empty string in ${filePath}.`
        );
      }
    }
  }

  if (Array.isArray(commandConfig.commandPolicies)) {
    for (const entry of commandConfig.commandPolicies) {
      if (typeof entry !== "object" || entry === null) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies" entry to be an object in ${filePath}.`
        );
      }

      const record = entry as Record<string, unknown>;
      const unknownPolicyKeys = Object.keys(record).filter(
        (key) =>
          ![
            "prefix",
            "risk",
            "allowInService",
            "allowPersistentApproval",
            "allowedDirectories",
            "requireCleanGit",
            "timeoutMs",
            "maxOutputChars"
          ].includes(key)
      );

      if (unknownPolicyKeys.length > 0) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Unknown command policy keys in ${filePath}: ${unknownPolicyKeys.join(", ")}.`
        );
      }

      if (typeof record.prefix !== "string" || record.prefix.trim().length === 0) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].prefix" to be a non-empty string in ${filePath}.`
        );
      }

      if (record.risk !== undefined && !["low", "medium", "high"].includes(String(record.risk))) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].risk" to be one of low|medium|high in ${filePath}.`
        );
      }

      if (record.allowInService !== undefined && typeof record.allowInService !== "boolean") {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].allowInService" to be boolean in ${filePath}.`
        );
      }

      if (record.allowPersistentApproval !== undefined && typeof record.allowPersistentApproval !== "boolean") {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].allowPersistentApproval" to be boolean in ${filePath}.`
        );
      }

      if (record.requireCleanGit !== undefined && typeof record.requireCleanGit !== "boolean") {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].requireCleanGit" to be boolean in ${filePath}.`
        );
      }

      if (record.allowedDirectories !== undefined && !Array.isArray(record.allowedDirectories)) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].allowedDirectories" to be an array in ${filePath}.`
        );
      }

      if (Array.isArray(record.allowedDirectories)) {
        for (const directory of record.allowedDirectories) {
          if (typeof directory !== "string" || directory.trim().length === 0) {
            throw new ConfigError(
              "CONFIG_INVALID",
              `Expected every "toolPermissions.command.commandPolicies[*].allowedDirectories" entry to be a non-empty string in ${filePath}.`
            );
          }
        }
      }

      if (record.timeoutMs !== undefined && !isPositiveNumber(record.timeoutMs)) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].timeoutMs" to be a positive number in ${filePath}.`
        );
      }

      if (record.maxOutputChars !== undefined && !isPositiveNumber(record.maxOutputChars)) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.commandPolicies[*].maxOutputChars" to be a positive number in ${filePath}.`
        );
      }
    }
  }

  if (commandConfig.timeoutMs !== undefined && !isPositiveNumber(commandConfig.timeoutMs)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.timeoutMs" to be a positive number in ${filePath}.`
    );
  }

  if (commandConfig.maxOutputChars !== undefined && !isPositiveNumber(commandConfig.maxOutputChars)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.maxOutputChars" to be a positive number in ${filePath}.`
    );
  }
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateCommandSandboxConfig(value: unknown, filePath: string): void {
  if (typeof value !== "object" || value === null) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox" to be an object in ${filePath}.`);
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !["enabled", "image", "mountPath", "network", "readOnlyRootFilesystem", "tmpfsPaths"].includes(key)
  );

  if (unknownKeys.length > 0) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unknown command sandbox keys in ${filePath}: ${unknownKeys.join(", ")}.`
    );
  }

  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox.enabled" to be boolean in ${filePath}.`);
  }

  if (typeof record.image !== "string" || record.image.trim().length === 0) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox.image" to be a non-empty string in ${filePath}.`);
  }

  if (record.mountPath !== undefined && (typeof record.mountPath !== "string" || record.mountPath.trim().length === 0)) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox.mountPath" to be a non-empty string in ${filePath}.`);
  }

  if (record.network !== undefined && !["none", "bridge"].includes(String(record.network))) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox.network" to be one of none|bridge in ${filePath}.`);
  }

  if (record.readOnlyRootFilesystem !== undefined && typeof record.readOnlyRootFilesystem !== "boolean") {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Expected "toolPermissions.command.sandbox.readOnlyRootFilesystem" to be boolean in ${filePath}.`
    );
  }

  if (record.tmpfsPaths !== undefined && !Array.isArray(record.tmpfsPaths)) {
    throw new ConfigError("CONFIG_INVALID", `Expected "toolPermissions.command.sandbox.tmpfsPaths" to be an array in ${filePath}.`);
  }

  if (Array.isArray(record.tmpfsPaths)) {
    for (const entry of record.tmpfsPaths) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Expected every "toolPermissions.command.sandbox.tmpfsPaths" entry to be a non-empty string in ${filePath}.`
        );
      }
    }
  }
}

function resolveConfigPaths(options: LoadConfigOptions): {
  globalConfigPath: string;
  projectConfigPath: string;
} {
  const homeDir = options.homeDir ?? homedir();

  return {
    globalConfigPath: path.join(homeDir, ".deepvibe", "config.json"),
    projectConfigPath: path.join(options.cwd, ".deepvibe", "config.json")
  };
}

function normalizeConfigKey(key: string): ConfigSettableKey {
  const normalized = key.trim();

  if (normalized === "api_key" || normalized === "apiKey") {
    return "apiKey";
  }

  if (normalized === "default_model" || normalized === "defaultModel") {
    return "defaultModel";
  }

  if (normalized === "search_provider" || normalized === "searchProvider") {
    return "searchProvider";
  }

  if (normalized === "tavily_api_key" || normalized === "tavilyApiKey") {
    return "tavilyApiKey";
  }

  if (normalized === "bing_api_key" || normalized === "bingApiKey") {
    return "bingApiKey";
  }

  throw new ConfigError(
    "CONFIG_INVALID",
    `Unsupported config key "${key}". Supported keys: api_key, apiKey, default_model, defaultModel, search_provider, searchProvider, tavily_api_key, tavilyApiKey, bing_api_key, bingApiKey.`
  );
}

function normalizeConfigValue(key: ConfigSettableKey, value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw new ConfigError("CONFIG_INVALID", `Config value for "${key}" must not be empty.`);
  }

  if (key === "defaultModel" && !["deepseek-v4-pro", "deepseek-v4-flash"].includes(trimmedValue)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unsupported default model "${trimmedValue}". Expected deepseek-v4-pro or deepseek-v4-flash.`
    );
  }

  if (key === "searchProvider" && !["duckduckgo", "tavily", "bing"].includes(trimmedValue)) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unsupported search provider "${trimmedValue}". Expected duckduckgo, tavily, or bing.`
    );
  }

  return trimmedValue;
}

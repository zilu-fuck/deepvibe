import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.js";
import type { CommandToolPermissions } from "./tools.js";
import { resolveCommandPermissions, type CommandApprovalHandler, type CommandExecutionResult, type CommandRunner } from "./tools.js";

export interface VerificationCommand {
  command: string;
  cwd: string;
  label: string;
  reason: string;
}

export interface VerificationStepResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  label: string;
  stderr: string;
  stdout: string;
}

export interface VerificationSummary {
  reason?: string;
  status: "failed" | "passed" | "skipped";
  steps: VerificationStepResult[];
}

export async function verifyWrittenChanges(options: {
  abortSignal?: AbortSignal;
  commandApproval?: CommandApprovalHandler;
  commandPermissions?: CommandToolPermissions;
  commandRunner?: CommandRunner;
  cwd: string;
}): Promise<VerificationSummary> {
  const commandPermissions =
    options.commandPermissions ??
    resolveCommandPermissions(loadConfig({ cwd: options.cwd }).toolPermissions?.command);

  if (!commandPermissions?.enabled || commandPermissions.policies.length === 0) {
    return {
      status: "skipped",
      reason: "No allowed command policies are configured for verification.",
      steps: []
    };
  }

  if (!options.commandRunner) {
    return {
      status: "skipped",
      reason: "No command runner is available for verification.",
      steps: []
    };
  }

  const commands = detectVerificationCommands(options.cwd).filter((candidate) =>
    Boolean(findMatchingPolicy(candidate.command, commandPermissions))
  );

  if (commands.length === 0) {
    return {
      status: "skipped",
      reason: "No supported verification command was detected in this workspace.",
      steps: []
    };
  }

  const steps: VerificationStepResult[] = [];

  for (const candidate of commands) {
    const policy = findMatchingPolicy(candidate.command, commandPermissions);

    if (!policy) {
      continue;
    }

    if (commandPermissions.requireApproval && options.commandApproval) {
      const approved = await options.commandApproval({
        allowPersistentApproval: policy.allowPersistentApproval,
        command: candidate.command,
        cwd: relativeCwd(options.cwd, candidate.cwd),
        risk: policy.risk
      });

      if (!approved) {
        return {
          status: "skipped",
          reason: `Verification was skipped because approval was denied for "${candidate.command}".`,
          steps
        };
      }
    }

    const result = await options.commandRunner({
      abortSignal: options.abortSignal,
      command: candidate.command,
      cwd: candidate.cwd,
      maxOutputChars: policy.maxOutputChars ?? commandPermissions.maxOutputChars,
      timeoutMs: policy.timeoutMs ?? commandPermissions.timeoutMs
    });

    steps.push({
      command: candidate.command,
      cwd: relativeCwd(options.cwd, candidate.cwd),
      exitCode: result.exitCode,
      label: candidate.label,
      stderr: result.stderr,
      stdout: result.stdout
    });

    if (result.exitCode !== 0) {
      return {
        status: "failed",
        steps
      };
    }
  }

  return {
    status: "passed",
    steps
  };
}

export function detectVerificationCommands(rootDir: string): VerificationCommand[] {
  const packageJsonPath = path.join(rootDir, "package.json");
  const commands: VerificationCommand[] = [];

  if (existsSync(packageJsonPath)) {
    const packageJson = safeReadJson(packageJsonPath);
    const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
    const packageManager = detectNodePackageManager(rootDir);

    if (typeof scripts.test === "string" && !looksLikePlaceholderTestScript(scripts.test)) {
      commands.push({
        command: packageManager === "npm" ? "npm test" : "pnpm test",
        cwd: rootDir,
        label: "test",
        reason: "package.json declares a real test script"
      });
    }

    if (typeof scripts.build === "string") {
      commands.push({
        command: packageManager === "npm" ? "npm run build" : "pnpm build",
        cwd: rootDir,
        label: "build",
        reason: "package.json declares a build script"
      });
    }
  }

  const pytestSignals = [
    "pytest.ini",
    "pyproject.toml",
    "tox.ini",
    path.join("tests"),
    path.join("test")
  ].some((entry) => existsSync(path.join(rootDir, entry)));

  if (pytestSignals) {
    commands.push({
      command: "pytest",
      cwd: rootDir,
      label: "pytest",
      reason: "Python test layout detected"
    });
  }

  return dedupeCommands(commands).slice(0, 2);
}

export function formatVerificationSummary(result: VerificationSummary): string {
  if (result.status === "skipped") {
    return `Verification skipped: ${result.reason ?? "no verification command ran."}`;
  }

  const lines = [
    `Verification ${result.status}: ${result.steps.length} command(s) ran.`
  ];

  for (const step of result.steps) {
    lines.push(`- ${step.command} (${step.exitCode ?? "no-exit-code"}) in ${step.cwd}`);
  }

  return lines.join("\n");
}

function dedupeCommands(commands: VerificationCommand[]): VerificationCommand[] {
  const seen = new Set<string>();
  const result: VerificationCommand[] = [];

  for (const command of commands) {
    const key = `${command.cwd}::${command.command}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(command);
  }

  return result;
}

function findMatchingPolicy(command: string, permissions: CommandToolPermissions) {
  const normalizedCommand = normalizeCommand(command);
  let bestMatch = permissions.policies[0];
  let bestLength = -1;

  for (const policy of permissions.policies) {
    const normalizedPrefix = normalizeCommand(policy.prefix);

    if (normalizedCommand === normalizedPrefix || normalizedCommand.startsWith(`${normalizedPrefix} `)) {
      if (normalizedPrefix.length > bestLength) {
        bestMatch = policy;
        bestLength = normalizedPrefix.length;
      }
    }
  }

  return bestLength >= 0 ? bestMatch : undefined;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ").toLowerCase();
}

function relativeCwd(rootDir: string, absoluteCwd: string): string {
  const relative = path.relative(rootDir, absoluteCwd).replace(/\\/gu, "/");
  return relative.length === 0 ? "." : relative;
}

function detectNodePackageManager(rootDir: string): "npm" | "pnpm" {
  if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  return "npm";
}

function looksLikePlaceholderTestScript(script: string): boolean {
  const normalized = script.replace(/\s+/gu, " ").trim().toLowerCase();
  return normalized.includes("no test specified");
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import {
  isCommandPersistentlyApproved,
  loadCommandApprovalStore,
  rememberApprovedCommand,
  type CommandApprovalStore
} from "./command-approval-store.js";
import { loadConfig, setConfigValue } from "./config.js";
import { applyPreparedExecution, executePlanSteps, generatePlan, prepareExecution, runEngine, type PreparedExecution, type RunEngineDependencies, type PlanStepResult } from "./engine.js";
import type { Language } from "./i18n.js";
import { createAiCommit, inspectRepository, recordOperation, undoLastAiChange } from "./project/git-manager.js";
import { startRepl } from "./repl.js";
import { startService } from "./server.js";
import { createDockerSandboxCommandRunner, type CommandApprovalRequest } from "./tools.js";
import {
  clearWorkspaceTrust,
  getDefaultWorkspaceSandboxConfig,
  getWorkspaceTrust,
  prepareWorkspaceAccess,
  setWorkspaceTrust,
  type WorkspaceAccessInfo
} from "./workspace-access.js";
import {
  applyWorkspaceSnapshotChanges,
  collectWorkspaceSnapshotChanges,
  snapshotChangesToParsedFileChanges,
  type WorkspaceSnapshotChange
} from "./workspace-landing.js";

export interface CliDependencies extends RunEngineDependencies {
  applyPreparedExecution?: typeof applyPreparedExecution;
  confirmCommandExecution?: typeof confirmCommandExecution;
  confirmPlanStep?: typeof confirmPlanStep;
  confirmPreparedExecution?: typeof confirmPreparedExecution;
  cwd?: () => string;
  emitStepEvent?: (event: { type: string; stepIndex: number; totalSteps: number; payload?: Record<string, unknown> }) => void;
  generatePlan?: typeof generatePlan;
  homeDir?: string;
  prepareExecution?: typeof prepareExecution;
  runEngine?: typeof runEngine;
  setConfigValue?: typeof setConfigValue;
  startRepl?: typeof startRepl;
  startService?: typeof startService;
  prepareWorkspaceAccess?: typeof prepareWorkspaceAccess;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  undoLastAiChange?: typeof undoLastAiChange;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<void> {
  const executeRunEngine = dependencies.runEngine ?? runEngine;
  const executeGeneratePlan = dependencies.generatePlan ?? generatePlan;
  const executePrepare = dependencies.prepareExecution ?? prepareExecution;
  const executeApply = dependencies.applyPreparedExecution ?? applyPreparedExecution;
  const executeUndo = dependencies.undoLastAiChange ?? undoLastAiChange;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const prepareWorkspace = dependencies.prepareWorkspaceAccess ?? prepareWorkspaceAccess;
  let config = loadConfig({ cwd: cwd(), homeDir: dependencies.homeDir });
  const executeSetConfigValue = dependencies.setConfigValue ?? setConfigValue;
  const executeStartRepl = dependencies.startRepl ?? startRepl;
  const executeStartService = dependencies.startService ?? startService;
  let approvalStore = loadCommandApprovalStore(cwd());
  const program = new Command();

  program
    .name("deepvibe")
    .description("CLI-first AI coding engine for DeepSeek workflows.")
    .version("0.1.0");

  const configCommand = program
    .command("config")
    .description("read or update DeepVibe configuration");

  configCommand
    .command("set")
    .description("set a config value")
    .argument("<key>", "config key such as api_key or default_model")
    .argument("<value>", "config value")
    .option("--project", "write the value into .deepvibe/config.json in the current project")
    .action(async (key: string, value: string, options: { project?: boolean }) => {
      const result = executeSetConfigValue({
        cwd: cwd(),
        homeDir: dependencies.homeDir,
        key,
        target: options.project ? "project" : "global",
        value
      });

      stdout.write(`Saved ${result.key} to ${result.configPath}\n`);
    });

  configCommand
    .command("trust")
    .description("set workspace trust mode for the current directory")
    .argument("<mode>", "sandbox | full | clear")
    .action(async (mode: string) => {
      const currentCwd = cwd();

      if (mode === "sandbox" || mode === "full") {
        setWorkspaceTrust(currentCwd, mode, dependencies.homeDir);
        stdout.write(`Saved workspace trust for ${currentCwd}: ${mode}\n`);
        return;
      }

      if (mode === "clear") {
        clearWorkspaceTrust(currentCwd, dependencies.homeDir);
        stdout.write(`Cleared workspace trust for ${currentCwd}\n`);
        return;
      }

      throw new Error(`Unsupported trust mode "${mode}". Expected sandbox, full, or clear.`);
    });

  program
    .command("serve")
    .description("start the built-in HTTP and JSON-RPC service")
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--port <port>", "port to bind", parsePortOption, 4242)
    .action(async (options: { host: string; port: number }) => {
      const access = await prepareWorkspace({
        cwd: cwd(),
        homeDir: dependencies.homeDir,
        input: stdin,
        output: stdout
      });
      config = await ensureApiKeyConfigured({
        config: loadConfig({ cwd: access.effectiveCwd, homeDir: dependencies.homeDir }),
        cwd: access.effectiveCwd,
        homeDir: dependencies.homeDir,
        input: stdin,
        output: stdout,
        setConfigValue: executeSetConfigValue
      });

      const service = await executeStartService({
        cwd: access.effectiveCwd,
        host: options.host,
        port: options.port,
        dependencies: withWorkspaceAccessDependencies(access, config, dependencies)
      });

      stdout.write(`DeepVibe service listening on http://${service.host}:${service.port}\n`);
    });

  program
    .command("chat")
    .description("start an interactive REPL session")
    .option("--flash", "prefer the flash model profile")
    .option("--deep", "prefer the high-effort reasoning profile")
    .option("--session <id>", "resume a specific session by id")
    .option("--lang <language>", "interface language (en or zh)", "auto")
    .action(async (options: { deep?: boolean; flash?: boolean; lang?: string; session?: string }) => {
      const access = await prepareWorkspace({
        cwd: cwd(),
        homeDir: dependencies.homeDir,
        input: stdin,
        output: stdout
      });
      config = await ensureApiKeyConfigured({
        config: loadConfig({ cwd: access.effectiveCwd, homeDir: dependencies.homeDir }),
        cwd: access.effectiveCwd,
        homeDir: dependencies.homeDir,
        input: stdin,
        output: stdout,
        setConfigValue: executeSetConfigValue
      });
      const accessDependencies = withWorkspaceAccessDependencies(access, config, dependencies);

      const profile = options.deep ? "deep" : options.flash ? "flash" : "default";
      const lang = options.lang === "zh" ? "zh" : options.lang === "en" ? "en" : undefined;
      await executeStartRepl({
        cwd: access.effectiveCwd,
        profile,
        sessionId: options.session,
        lang,
        workspaceMode: access.mode,
        requestedCwd: access.requestedCwd
      }, {
        ...accessDependencies,
        applyPreparedExecution: createWorkspaceAwareApplyFunction({
          access,
          applyPreparedExecutionImpl: executeApply,
          confirmPreparedExecutionImpl: dependencies.confirmPreparedExecution ?? confirmPreparedExecution,
          force: false,
          inspectRepositoryImpl: dependencies.inspectRepository,
          createAiCommitImpl: dependencies.createAiCommit,
          recordOperationImpl: dependencies.recordOperation,
          stdin,
          stdout
        }),
        stdin,
        stdout,
        stderr
      });
    });

  program
    .argument("[instruction]", "natural-language coding instruction")
    .option("--dry-run", "build the request and exit before making changes")
    .option("--force", "apply changes without interactive confirmation")
    .option("--flash", "prefer the flash model profile")
    .option("--deep", "prefer the high-effort reasoning profile")
    .option("--plan", "generate a multi-step plan first, then confirm and execute step by step")
    .action(async (instruction: string | undefined, options: { deep?: boolean; dryRun?: boolean; flash?: boolean; force?: boolean; plan?: boolean }) => {
      if (!instruction) {
        program.outputHelp();
        return;
      }

      const executionOptions = {
        instruction,
        cwd: cwd(),
        dryRun: Boolean(options.dryRun),
        planMode: Boolean(options.plan),
        profile: options.deep ? "deep" : options.flash ? "flash" : "default"
      } as const;

      if (options.plan) {
        const access = await prepareWorkspace({
          cwd: cwd(),
          homeDir: dependencies.homeDir,
          input: stdin,
          output: stdout
        });
        config = await ensureApiKeyConfigured({
          config: loadConfig({ cwd: access.effectiveCwd, homeDir: dependencies.homeDir }),
          cwd: access.effectiveCwd,
          homeDir: dependencies.homeDir,
          input: stdin,
          output: stdout,
          setConfigValue: executeSetConfigValue
        });
        const accessDependencies = withWorkspaceAccessDependencies(access, config, dependencies);

        const planResult = await runPlanExecution({ ...executionOptions, cwd: access.effectiveCwd }, {
          applyPreparedExecution: createWorkspaceAwareApplyFunction({
            access,
            applyPreparedExecutionImpl: executeApply,
            confirmPreparedExecutionImpl: dependencies.confirmPreparedExecution ?? confirmPreparedExecution,
            force: Boolean(options.force),
            inspectRepositoryImpl: dependencies.inspectRepository,
            createAiCommitImpl: dependencies.createAiCommit,
            recordOperationImpl: dependencies.recordOperation,
            stdin,
            stdout
          }),
          confirmPlanStep: dependencies.confirmPlanStep ?? confirmPlanStep,
          emitStepEvent: dependencies.emitStepEvent,
          generatePlan: executeGeneratePlan,
          prepareExecution: executePrepare,
          stdin,
          stdout,
          applyFileChanges: dependencies.applyFileChanges,
          createAiCommit: dependencies.createAiCommit,
          createClient: dependencies.createClient,
          commandApproval:
            dependencies.commandApproval ??
            createCommandApprovalHandler({
              allowPersistentApproval: config.toolPermissions?.command?.persistApprovals ?? false,
              cwd: cwd(),
              input: stdin,
              output: stdout,
              confirmCommandExecution: dependencies.confirmCommandExecution ?? confirmCommandExecution,
              getStore: () => approvalStore,
              setStore: (nextStore) => {
                approvalStore = nextStore;
              }
            }),
          inspectRepository: dependencies.inspectRepository,
          parseResponse: dependencies.parseResponse,
          recordOperation: dependencies.recordOperation,
          commandRunner: accessDependencies.commandRunner
        });
        stdout.write(`${planResult.message}\n`);
        return;
      }

      const result = options.dryRun
        ? await (async () => {
            const access = await prepareWorkspace({
              cwd: cwd(),
              homeDir: dependencies.homeDir,
              input: stdin,
              output: stdout
            });
            return executeRunEngine({ ...executionOptions, cwd: access.effectiveCwd }, withWorkspaceAccessDependencies(access, loadConfig({ cwd: access.effectiveCwd, homeDir: dependencies.homeDir }), dependencies));
          })()
        : await (async () => {
            const access = await prepareWorkspace({
              cwd: cwd(),
              homeDir: dependencies.homeDir,
              input: stdin,
              output: stdout
            });
            config = await ensureApiKeyConfigured({
              config: loadConfig({ cwd: access.effectiveCwd, homeDir: dependencies.homeDir }),
              cwd: access.effectiveCwd,
              homeDir: dependencies.homeDir,
              input: stdin,
              output: stdout,
              setConfigValue: executeSetConfigValue
            });
            const accessDependencies = withWorkspaceAccessDependencies(access, config, dependencies);

            return runConfirmedExecution({ ...executionOptions, cwd: access.effectiveCwd }, {
              applyPreparedExecution: createWorkspaceAwareApplyFunction({
                access,
                applyPreparedExecutionImpl: executeApply,
                confirmPreparedExecutionImpl: dependencies.confirmPreparedExecution ?? confirmPreparedExecution,
                force: Boolean(options.force),
                inspectRepositoryImpl: dependencies.inspectRepository,
                createAiCommitImpl: dependencies.createAiCommit,
                recordOperationImpl: dependencies.recordOperation,
                stdin,
                stdout
              }),
              confirmPreparedExecution: dependencies.confirmPreparedExecution ?? confirmPreparedExecution,
              force: Boolean(options.force),
              prepareExecution: executePrepare,
              stdin,
              stdout,
              applyFileChanges: dependencies.applyFileChanges,
              createAiCommit: dependencies.createAiCommit,
              createClient: dependencies.createClient,
              commandApproval:
                dependencies.commandApproval ??
                createCommandApprovalHandler({
                  allowPersistentApproval: config.toolPermissions?.command?.persistApprovals ?? false,
                  cwd: cwd(),
                  input: stdin,
                  output: stdout,
                  confirmCommandExecution: dependencies.confirmCommandExecution ?? confirmCommandExecution,
                  getStore: () => approvalStore,
                  setStore: (nextStore) => {
                    approvalStore = nextStore;
                  }
                }),
              inspectRepository: dependencies.inspectRepository,
              parseResponse: dependencies.parseResponse,
              recordOperation: dependencies.recordOperation,
              commandRunner: accessDependencies.commandRunner
            });
          })();

      stdout.write(`${result.message}\n`);
    });

  program
    .command("undo")
    .description("undo the most recent successful AI operation")
    .action(async () => {
      const result = await executeUndo(cwd());

      stdout.write(`Undo complete: kind=${result.kind} reference=${result.reference}\n`);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error.";

    stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

interface EnsureApiKeyConfiguredOptions {
  config: ReturnType<typeof loadConfig>;
  createInterfaceFn?: typeof createInterface;
  cwd: string;
  homeDir?: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  setConfigValue: typeof setConfigValue;
}

export async function ensureApiKeyConfigured(
  options: EnsureApiKeyConfiguredOptions
): Promise<ReturnType<typeof loadConfig>> {
  if (options.config.apiKey) {
    return options.config;
  }

  if (!isInteractiveInput(options.input) || !isInteractiveOutput(options.output)) {
    throw new Error(
      "DeepSeek API key is not configured. Run `pnpm cli config set api_key YOUR_DEEPSEEK_API_KEY` first."
    );
  }

  const readline = (options.createInterfaceFn ?? createInterface)({
    input: options.input,
    output: options.output
  });

  try {
    while (true) {
      const answer = (await readline.question("DeepSeek API key is not configured. Configure it now? [Y]es [N]o: ")).trim().toLowerCase();

      if (answer === "n" || answer === "no") {
        throw new Error(
          "DeepSeek API key is required. Run `pnpm cli config set api_key YOUR_DEEPSEEK_API_KEY` first."
        );
      }

      if (answer === "y" || answer === "yes" || answer.length === 0) {
        const apiKey = (await readline.question("Enter DeepSeek API key (will be saved to global config): ")).trim();

        if (apiKey.length === 0) {
          options.output.write("API key cannot be empty.\n");
          continue;
        }

        const result = options.setConfigValue({
          cwd: options.cwd,
          homeDir: options.homeDir,
          key: "api_key",
          target: "global",
          value: apiKey
        });

        options.output.write(`Saved ${result.key} to ${result.configPath}\n`);

        return loadConfig({
          cwd: options.cwd,
          homeDir: options.homeDir
        });
      }
    }
  } finally {
    readline.close();
  }
}

function isInteractiveInput(stream: NodeJS.ReadableStream): boolean {
  return Boolean((stream as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
}

function isInteractiveOutput(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
}

function withWorkspaceAccessDependencies(
  access: WorkspaceAccessInfo,
  config: ReturnType<typeof loadConfig>,
  dependencies: CliDependencies
): CliDependencies {
  if (access.mode !== "sandbox") {
    return dependencies;
  }

  return {
    ...dependencies,
    commandRunner:
      dependencies.commandRunner ??
      createDockerSandboxCommandRunner(access.effectiveCwd, {
        ...getDefaultWorkspaceSandboxConfig(),
        ...(config.toolPermissions?.command?.sandbox ?? {})
      })
  };
}

function createWorkspaceAwareApplyFunction(options: {
  access: WorkspaceAccessInfo;
  applyPreparedExecutionImpl: typeof applyPreparedExecution;
  confirmPreparedExecutionImpl: typeof confirmPreparedExecution;
  confirmLandingPreparedExecutionImpl?: typeof confirmLandingPreparedExecution;
  force: boolean;
  inspectRepositoryImpl?: typeof inspectRepository;
  createAiCommitImpl?: typeof createAiCommit;
  recordOperationImpl?: typeof recordOperation;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}): typeof applyPreparedExecution {
  if (options.access.mode !== "sandbox") {
    return options.applyPreparedExecutionImpl;
  }

  return async (cwd, prepared, dependencies) => {
    const sandboxResult = await options.applyPreparedExecutionImpl(cwd, prepared, dependencies);
    const landingChanges = collectWorkspaceSnapshotChanges(options.access.requestedCwd, options.access.effectiveCwd);

    if (landingChanges.length === 0) {
      return {
        message: `${sandboxResult.message} landing=none`
      };
    }

    if (!options.force) {
      const reviewPrepared = createLandingPreparedExecution(prepared, landingChanges);
      const confirmed = await (options.confirmLandingPreparedExecutionImpl ?? confirmLandingPreparedExecution)(reviewPrepared, {
        input: options.stdin,
        output: options.stdout
      });

      if (!confirmed) {
        return {
          message: "Sandbox execution completed, but landing to the real workspace was cancelled."
        };
      }

      landingChanges.splice(0, landingChanges.length, ...filterLandingChanges(landingChanges, reviewPrepared.parsedResponse.files.map((file) => file.path)));
    }

    applyWorkspaceSnapshotChanges(options.access.requestedCwd, landingChanges);
    const realRepositoryState = await (options.inspectRepositoryImpl ?? inspectRepository)(options.access.requestedCwd);
    const summary = prepared.parsedResponse.summary || "Land sandbox changes";

    if (realRepositoryState.isRepository) {
      if (realRepositoryState.isDirty) {
        (options.recordOperationImpl ?? recordOperation)(
          options.access.requestedCwd,
          realRepositoryState,
          landingChanges.map((change) => ({
            path: change.path,
            beforeContent: change.beforeContent,
            afterContent: change.afterContent
          })),
          summary
        );
      } else {
        await (options.createAiCommitImpl ?? createAiCommit)(
          options.access.requestedCwd,
          landingChanges.map((change) => change.path),
          summary
        );
      }
    }

    return {
      message: `${sandboxResult.message} landedFiles=${landingChanges.length} landing=real-workspace`
    };
  };
}

function createLandingPreparedExecution(
  prepared: PreparedExecution,
  landingChanges: WorkspaceSnapshotChange[]
): PreparedExecution {
  return {
    ...prepared,
    parsedResponse: {
      files: snapshotChangesToParsedFileChanges(landingChanges),
      summary: prepared.parsedResponse.summary || "Review sandbox changes before landing"
    },
    toolMutations: []
  };
}

function filterLandingChanges(
  changes: WorkspaceSnapshotChange[],
  selectedPaths: string[]
): WorkspaceSnapshotChange[] {
  const allowed = new Set(selectedPaths);
  return changes.filter((change) => allowed.has(change.path));
}

interface ConfirmedExecutionDependencies extends RunEngineDependencies {
  applyPreparedExecution: typeof applyPreparedExecution;
  confirmPreparedExecution: typeof confirmPreparedExecution;
  force: boolean;
  prepareExecution: typeof prepareExecution;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

async function runConfirmedExecution(
  options: Parameters<typeof runEngine>[0],
  dependencies: ConfirmedExecutionDependencies
) {
  const prepared = await dependencies.prepareExecution(options, {
    applyFileChanges: dependencies.applyFileChanges,
    createAiCommit: dependencies.createAiCommit,
    createClient: dependencies.createClient,
    commandApproval: dependencies.commandApproval,
    inspectRepository: dependencies.inspectRepository,
    parseResponse: dependencies.parseResponse,
    recordOperation: dependencies.recordOperation
  });

  if (!dependencies.force) {
    ensureInteractiveConfirmationAvailable(dependencies.stdin, dependencies.stdout);

    const confirmed = await dependencies.confirmPreparedExecution(prepared, {
      input: dependencies.stdin,
      output: dependencies.stdout
    });

    if (!confirmed) {
      return {
        message: "Cancelled: no changes were applied."
      };
    }
  }

  return dependencies.applyPreparedExecution(options.cwd, prepared, {
    applyFileChanges: dependencies.applyFileChanges,
    createAiCommit: dependencies.createAiCommit,
    createClient: dependencies.createClient,
    commandApproval: dependencies.commandApproval,
    inspectRepository: dependencies.inspectRepository,
    parseResponse: dependencies.parseResponse,
    recordOperation: dependencies.recordOperation
  });
}

interface PlanExecutionDependencies extends RunEngineDependencies {
  applyPreparedExecution: typeof applyPreparedExecution;
  confirmPlanStep: typeof confirmPlanStep;
  emitStepEvent?: (event: { type: string; stepIndex: number; totalSteps: number; payload?: Record<string, unknown> }) => void;
  generatePlan: typeof generatePlan;
  prepareExecution: typeof prepareExecution;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

async function runPlanExecution(
  options: Parameters<typeof generatePlan>[0],
  dependencies: PlanExecutionDependencies
): Promise<{ message: string }> {
  dependencies.stdout.write("Generating plan...\n");

  const planResult = await dependencies.generatePlan(options, {
    applyFileChanges: dependencies.applyFileChanges,
    createAiCommit: dependencies.createAiCommit,
    createClient: dependencies.createClient,
    commandApproval: dependencies.commandApproval,
    inspectRepository: dependencies.inspectRepository,
    parseResponse: dependencies.parseResponse,
    recordOperation: dependencies.recordOperation,
    searchWeb: dependencies.searchWeb,
    abortSignal: dependencies.abortSignal
  });

  const plan = planResult.plan;

  dependencies.stdout.write(formatPlan(plan));
  dependencies.stdout.write("\n");

  const confirmed = await confirmPlan(plan, {
    input: dependencies.stdin,
    output: dependencies.stdout
  });

  if (!confirmed) {
    return { message: "Plan cancelled. No changes were applied." };
  }

  dependencies.stdout.write("\nExecuting plan step by step...\n");

  const stepResults = await executePlanSteps(plan, options, {
    applyFileChanges: dependencies.applyFileChanges,
    createAiCommit: dependencies.createAiCommit,
    createClient: dependencies.createClient,
    commandApproval: dependencies.commandApproval,
    inspectRepository: dependencies.inspectRepository,
    parseResponse: dependencies.parseResponse,
    recordOperation: dependencies.recordOperation,
    searchWeb: dependencies.searchWeb,
    abortSignal: dependencies.abortSignal,
    emitStepEvent: dependencies.emitStepEvent,
    confirmStep: (stepIndex, totalSteps, prepared) =>
      dependencies.confirmPlanStep(stepIndex, totalSteps, prepared, {
        input: dependencies.stdin,
        output: dependencies.stdout
      })
  });

  return { message: formatPlanResults(stepResults) };
}

async function confirmPlan(
  plan: { overview: string; steps: Array<{ index: number; description: string; files: string[]; estimatedChanges: string }>; notes: string },
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    while (true) {
      const answer = (await readline.question("Proceed with plan? [A]ccept [R]eject: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "r" || answer === "reject" || answer === "n" || answer === "no") {
        return false;
      }
    }
  } finally {
    readline.close();
  }
}

export async function confirmPlanStep(
  stepIndex: number,
  totalSteps: number,
  prepared: PreparedExecution,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`\n--- Step ${stepIndex}/${totalSteps} ---\n`);
    streams.output.write(`${formatPreparedExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Confirm apply? [A]ccept [S]kip [R]eview [N]o (stop plan): ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "s" || answer === "skip") {
        return false;
      }

      if (answer === "n" || answer === "no") {
        throw new Error("Plan execution stopped by user.");
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply") {
          return true;
        }

        if (reviewResult === "skip") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export function formatPlan(plan: { overview: string; steps: Array<{ index: number; description: string; files: string[]; estimatedChanges: string }>; notes: string }): string {
  const lines = [
    `Plan: ${plan.overview}`,
    ""
  ];

  for (const step of plan.steps) {
    lines.push(`  ${step.index}. ${step.description} (${step.estimatedChanges})`);
    lines.push(`     Files: ${step.files.join(", ") || "(none specified)"}`);
  }

  if (plan.notes) {
    lines.push("");
    lines.push(`Notes: ${plan.notes}`);
  }

  return lines.join("\n");
}

export function formatPlanResults(results: PlanStepResult[]): string {
  const completed = results.filter((r) => r.status === "completed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const lines = [
    `Plan execution complete: ${completed} completed, ${skipped} skipped, ${failed} failed`
  ];

  for (const result of results) {
    const icon = result.status === "completed" ? "✓" : result.status === "skipped" ? "⊘" : "✗";
    lines.push(`  ${icon} Step ${result.stepIndex}: ${result.summary}`);
  }

  return lines.join("\n");
}

export async function confirmPreparedExecution(
  prepared: PreparedExecution,
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`${formatPreparedExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Confirm apply? [A]ccept [R]eview [N]o: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no" || answer === "reject") {
        return false;
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply" || reviewResult === "skip") {
          return true;
        }

        if (reviewResult === "cancel") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export async function confirmLandingPreparedExecution(
  prepared: PreparedExecution,
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`${formatLandingExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Land sandbox changes to the real workspace? [A]ccept [R]eview [N]o: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no" || answer === "reject") {
        return false;
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply" || reviewResult === "skip") {
          return true;
        }

        if (reviewResult === "cancel") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export function formatPreparedExecutionSummary(prepared: PreparedExecution): string {
  const lines = [
    `Planned changes: ${prepared.parsedResponse.files.length} file(s)`,
    `Summary: ${prepared.parsedResponse.summary}`,
    "Files:"
  ];

  for (const file of prepared.parsedResponse.files) {
    const stats = countDiffLines(file.diff);
    lines.push(`- [${file.action}] ${file.path} (+${stats.additions} -${stats.deletions})`);
  }

  return lines.join("\n");
}

export function formatLandingExecutionSummary(prepared: PreparedExecution): string {
  const lines = [
    "=== Sandbox Landing Review ===",
    "These are the actual file changes that will be written back from the sandbox copy into the real workspace.",
    `Landing changes: ${prepared.parsedResponse.files.length} file(s)`,
    `Summary: ${prepared.parsedResponse.summary}`,
    "Files:"
  ];

  for (const file of prepared.parsedResponse.files) {
    const stats = countDiffLines(file.diff);
    lines.push(`- [${file.action}] ${file.path} (+${stats.additions} -${stats.deletions})`);
  }

  return lines.join("\n");
}

export function formatPreparedExecutionDiffs(prepared: PreparedExecution): string {
  const sections: string[] = [];

  for (const file of prepared.parsedResponse.files) {
    sections.push(`--- ${file.action.toUpperCase()} ${file.path} ---`);
    sections.push(file.diff);
    sections.push(`--- END ${file.path} ---`);
  }

  return sections.join("\n");
}

export async function reviewPreparedExecutionFiles(
  prepared: PreparedExecution,
  readline: ReturnType<typeof createInterface>,
  output: NodeJS.WritableStream
): Promise<"apply" | "skip" | "cancel"> {
  const originalFiles = [...prepared.parsedResponse.files];
  const selectedFiles: PreparedExecution["parsedResponse"]["files"] = [];
  let applyAllRemaining = false;

  for (const file of originalFiles) {
    if (applyAllRemaining) {
      selectedFiles.push(file);
      continue;
    }

    output.write(`--- ${file.action.toUpperCase()} ${file.path} ---\n`);
    output.write(`${file.diff}\n`);
    output.write(`--- END ${file.path} ---\n`);

    while (true) {
      const answer = (await readline.question("Apply this file? [Y]es [S]kip [A]ll remaining [Q]uit: ")).trim().toLowerCase();

      if (answer === "y" || answer === "yes") {
        selectedFiles.push(file);
        break;
      }

      if (answer === "s" || answer === "skip" || answer === "n" || answer === "no") {
        break;
      }

      if (answer === "a" || answer === "all" || answer === "always") {
        selectedFiles.push(file);
        applyAllRemaining = true;
        break;
      }

      if (answer === "q" || answer === "quit" || answer === "c" || answer === "cancel" || answer === "r" || answer === "reject") {
        return "cancel";
      }
    }
  }

  prepared.parsedResponse.files = selectedFiles;
  output.write(`Selected ${selectedFiles.length} of ${originalFiles.length} file(s) for apply.\n`);

  return selectedFiles.length > 0 ? "apply" : "skip";
}

export async function confirmCommandExecution(
  request: CommandApprovalRequest,
  streams: {
    allowPersistentApproval?: boolean;
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<"approve_once" | "approve_and_remember" | "deny"> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`Tool wants to run a command.\n`);
    streams.output.write(`Working directory: ${request.cwd}\n`);
    streams.output.write(`Command: ${request.command}\n`);
    streams.output.write(`Risk: ${request.risk}\n`);

    while (true) {
      const prompt =
        request.risk === "low"
          ? streams.allowPersistentApproval
            ? "Allow low-risk command? [Y]es once [A]lways [N]o: "
            : "Allow low-risk command? [Y]es [N]o: "
          : request.risk === "medium"
            ? "Allow medium-risk command once? [Y]es [N]o: "
            : 'High-risk command. Type "allow" to continue or [N]o: ';
      const answer = (await readline.question(prompt)).trim().toLowerCase();

      if (request.risk === "high") {
        if (answer === "allow") {
          return "approve_once";
        }

        if (answer === "n" || answer === "no") {
          return "deny";
        }

        continue;
      }

      if (request.risk === "low" && streams.allowPersistentApproval && (answer === "a" || answer === "always")) {
        return "approve_and_remember";
      }

      if (answer === "y" || answer === "yes") {
        return "approve_once";
      }

      if (answer === "n" || answer === "no") {
        return "deny";
      }
    }
  } finally {
    readline.close();
  }
}

function ensureInteractiveConfirmationAvailable(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): void {
  if (!("isTTY" in input) || !input.isTTY || !("isTTY" in output) || !output.isTTY) {
    throw new Error("Interactive confirmation requires a TTY. Re-run with --force to skip confirmation.");
  }
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function parsePortOption(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function createCommandApprovalHandler(options: {
  allowPersistentApproval: boolean;
  confirmCommandExecution: typeof confirmCommandExecution;
  cwd: string;
  getStore: () => CommandApprovalStore;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  setStore: (store: CommandApprovalStore) => void;
}) {
  return async (request: CommandApprovalRequest): Promise<boolean> => {
    ensureInteractiveConfirmationAvailable(options.input, options.output);

    if (options.allowPersistentApproval && isCommandPersistentlyApproved(options.getStore(), request)) {
      return true;
    }

    const decision = await options.confirmCommandExecution(request, {
      allowPersistentApproval: options.allowPersistentApproval && request.allowPersistentApproval !== false,
      input: options.input,
      output: options.output
    });

    if (decision === "deny") {
      return false;
    }

    if (decision === "approve_and_remember" && options.allowPersistentApproval) {
      options.setStore(rememberApprovedCommand(options.cwd, options.getStore(), request));
    }

    return true;
  };
}

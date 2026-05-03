import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import {
  confirmCommandExecution,
  confirmLandingPreparedExecution,
  confirmPlan,
  confirmPlanStep,
  confirmPreparedExecution,
  ensureInteractiveConfirmationAvailable,
  formatLandingExecutionSummary,
  formatPlan,
  formatPlanResults,
  formatPreparedExecutionDiffs,
  formatPreparedExecutionSummary,
  reviewPreparedExecutionFiles
} from "./cli-confirmation.js";
import {
  isCommandPersistentlyApproved,
  loadCommandApprovalStore,
  rememberApprovedCommand,
  type CommandApprovalStore
} from "./command-approval-store.js";
import { loadConfig, setConfigValue } from "./config.js";
import { applyPreparedExecution, executePlanSteps, generatePlan, prepareExecution, runEngine, type ExecutionProfile, type PreparedExecution, type RunEngineDependencies, type PlanStepResult } from "./engine.js";
import type { Language } from "./i18n.js";
import { detectEngineeringIntent } from "./intent.js";
import {
  createAiCommit,
  initializeRepository,
  inspectRepository,
  recordOperation,
  undoLastAiChange
} from "./project/git-manager.js";
import {
  resolveReplModelProfile,
  resolveReplProfileSelection,
  type ReplModelFamily,
  type ReplProfileSelection,
  type ReplReasoningEffect
} from "./model-profile.js";
import { applyBootstrapGuidance } from "./project-bootstrap.js";
import { startRepl } from "./repl.js";
import { startService } from "./server.js";
import { createDockerSandboxCommandRunner, resolveCommandPermissions, type CommandApprovalRequest } from "./tools.js";
import { formatVerificationSummary, verifyWrittenChanges } from "./verification.js";
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
  detectEngineeringIntent?: typeof detectEngineeringIntent;
  emitStepEvent?: (event: { type: string; stepIndex: number; totalSteps: number; payload?: Record<string, unknown> }) => void;
  generatePlan?: typeof generatePlan;
  homeDir?: string;
  prepareExecution?: typeof prepareExecution;
  initializeRepository?: typeof initializeRepository;
  runEngine?: typeof runEngine;
  setConfigValue?: typeof setConfigValue;
  startRepl?: typeof startRepl;
  startService?: typeof startService;
  prepareWorkspaceAccess?: typeof prepareWorkspaceAccess;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  undoLastAiChange?: typeof undoLastAiChange;
  verifyWrittenChanges?: typeof verifyWrittenChanges;
}

export {
  confirmCommandExecution,
  confirmLandingPreparedExecution,
  confirmPlanStep,
  confirmPreparedExecution,
  formatLandingExecutionSummary,
  formatPlan,
  formatPlanResults,
  formatPreparedExecutionDiffs,
  formatPreparedExecutionSummary,
  reviewPreparedExecutionFiles
} from "./cli-confirmation.js";

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<void> {
  const executeRunEngine = dependencies.runEngine ?? runEngine;
  const executeGeneratePlan = dependencies.generatePlan ?? generatePlan;
  const executePrepare = dependencies.prepareExecution ?? prepareExecution;
  const executeApply = dependencies.applyPreparedExecution ?? applyPreparedExecution;
  const executeUndo = dependencies.undoLastAiChange ?? undoLastAiChange;
  const executeInitializeRepository = dependencies.initializeRepository ?? initializeRepository;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const prepareWorkspace = dependencies.prepareWorkspaceAccess ?? prepareWorkspaceAccess;
  let config = loadConfig({ cwd: cwd(), homeDir: dependencies.homeDir });
  const executeSetConfigValue = dependencies.setConfigValue ?? setConfigValue;
  const executeStartRepl = dependencies.startRepl ?? startRepl;
  const executeStartService = dependencies.startService ?? startService;
  const executeDetectEngineeringIntent = dependencies.detectEngineeringIntent ?? detectEngineeringIntent;
  const executeVerifyWrittenChanges = dependencies.verifyWrittenChanges ?? verifyWrittenChanges;
  let approvalStore = loadCommandApprovalStore(cwd());
  const program = new Command();
  program.enablePositionalOptions();

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

  const runChatRepl = async (cliOptions: CliProfileOptions & { lang?: string; session?: string }, command: Command) => {
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

    const chatOptions = mergeCommandOptions(cliOptions, command);
    const profile = resolveCliProfile(chatOptions);
    const lang = chatOptions.lang === "zh" ? "zh" : chatOptions.lang === "en" ? "en" : undefined;
    await executeStartRepl({
      cwd: access.effectiveCwd,
      profile: profile.legacyProfile,
      profileSelection: profile.selection,
      sessionId: chatOptions.session,
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
  };

  program
    .command("chat")
    .description("start an interactive REPL session")
    .option("--model <family>", "model family (flash or pro)")
    .option("--effect <level>", "reasoning strength (low, medium, high, xhigh)")
    .option("--flash", "legacy alias for --model flash --effect high")
    .option("--deep", "legacy alias for --model pro --effect xhigh")
    .option("--session <id>", "resume a specific session by id")
    .option("--lang <language>", "interface language (en or zh)", "auto")
    .action(async (options: CliProfileOptions & { lang?: string; session?: string }, command: Command) => {
      await runChatRepl(options, command);
    });

  program
    .argument("[instruction]", "natural-language coding instruction")
    .option("--dry-run", "build the request and exit before making changes")
    .option("--force", "apply changes without interactive confirmation")
    .option("--init", "initialize a Git repository before applying changes")
    .option("--model <family>", "model family (flash or pro)")
    .option("--effect <level>", "reasoning strength (low, medium, high, xhigh)")
    .option("--flash", "legacy alias for --model flash --effect high")
    .option("--deep", "legacy alias for --model pro --effect xhigh")
    .option("--lang <language>", "interface language (en or zh)", "auto")
    .option("--session <id>", "resume a specific session by id")
    .option("--plan", "generate a multi-step plan first, then confirm and execute step by step")
    .action(async (instruction: string | undefined, options: CliProfileOptions & { dryRun?: boolean; force?: boolean; init?: boolean; plan?: boolean; lang?: string; session?: string }) => {
      if (!instruction) {
        await runChatRepl(options, new Command());
        return;
      }

      const profile = resolveCliProfile(options);
      const requestedCwd = cwd();
      const intentDecision =
        options.dryRun
          ? undefined
          : await executeDetectEngineeringIntent(
              {
                cwd: requestedCwd,
                instruction,
                profileSettings: profile.profileSettings
              },
              {
                createClient: dependencies.createClient
              }
            );
      const initialization = options.dryRun
        ? { declined: false, initialized: false }
        : await maybeInitializeRepositoryForInstruction({
            cwd: requestedCwd,
            enabled: Boolean(options.init),
            initializeRepository: executeInitializeRepository,
            input: stdin,
            inspectRepository: dependencies.inspectRepository ?? inspectRepository,
            output: stdout,
            requestWriteAccess: Boolean(intentDecision?.requiresWriteAccess)
          });

      if (initialization.declined && intentDecision?.requiresWriteAccess) {
        stdout.write("Cancelled: Git repository initialization is required before DeepVibe can apply write requests here.\n");
        return;
      }

      const bootstrapGuidance = applyBootstrapGuidance({
        cwd: requestedCwd,
        instruction,
        repositoryJustInitialized: initialization.initialized
      });

      if (bootstrapGuidance.notice) {
        stdout.write(`${bootstrapGuidance.notice}\n`);
      }

      const effectiveInstruction = bootstrapGuidance.instruction;
      const usePlanExecution =
        Boolean(options.plan) ||
        (!options.dryRun && !options.force && Boolean(intentDecision?.requiresWriteAccess));

      if (usePlanExecution && !options.plan) {
        stdout.write("Auto-enabled plan mode for this write request.\n");
      }

      const executionOptions = {
        instruction: effectiveInstruction,
        cwd: requestedCwd,
        dryRun: Boolean(options.dryRun),
        planMode: usePlanExecution,
        profile: profile.legacyProfile,
        profileSettings: profile.profileSettings
      } as const;

      if (usePlanExecution) {
        ensureInteractiveConfirmationAvailable(stdin, stdout);
        const access = await prepareWorkspace({
          cwd: requestedCwd,
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
          commandPermissions: resolveCommandPermissions(config.toolPermissions?.command),
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
          commandRunner: accessDependencies.commandRunner,
          verifyWrittenChanges: executeVerifyWrittenChanges
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
              cwd: requestedCwd,
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
              commandPermissions: resolveCommandPermissions(config.toolPermissions?.command),
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
              commandRunner: accessDependencies.commandRunner,
              verifyWrittenChanges: executeVerifyWrittenChanges
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
  commandPermissions?: ReturnType<typeof resolveCommandPermissions>;
  force: boolean;
  prepareExecution: typeof prepareExecution;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  verifyWrittenChanges?: typeof verifyWrittenChanges;
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

  const applyResult = await dependencies.applyPreparedExecution(options.cwd, prepared, {
    applyFileChanges: dependencies.applyFileChanges,
    createAiCommit: dependencies.createAiCommit,
    createClient: dependencies.createClient,
    commandApproval: dependencies.commandApproval,
    inspectRepository: dependencies.inspectRepository,
    parseResponse: dependencies.parseResponse,
    recordOperation: dependencies.recordOperation
  });

  const hasWrites = prepared.parsedResponse.files.length > 0 || prepared.toolMutations.length > 0;

  if (!hasWrites || !dependencies.verifyWrittenChanges) {
    return applyResult;
  }

  dependencies.stdout.write("Running verification...\n");

  try {
    const verification = await dependencies.verifyWrittenChanges({
      abortSignal: dependencies.abortSignal,
      commandApproval: dependencies.commandApproval,
      commandPermissions: dependencies.commandPermissions,
      commandRunner: dependencies.commandRunner,
      cwd: options.cwd
    });

    return {
      message: `${applyResult.message}\n${formatVerificationSummary(verification)}`
    };
  } catch (error) {
    return {
      message: `${applyResult.message}\nVerification failed: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
}

interface PlanExecutionDependencies extends RunEngineDependencies {
  applyPreparedExecution: typeof applyPreparedExecution;
  commandPermissions?: ReturnType<typeof resolveCommandPermissions>;
  confirmPlanStep: typeof confirmPlanStep;
  emitStepEvent?: (event: { type: string; stepIndex: number; totalSteps: number; payload?: Record<string, unknown> }) => void;
  generatePlan: typeof generatePlan;
  prepareExecution: typeof prepareExecution;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  verifyWrittenChanges?: typeof verifyWrittenChanges;
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
  const completedSteps = stepResults.filter((result) => result.status === "completed").length;
  let message = formatPlanResults(stepResults);

  if (completedSteps > 0 && dependencies.verifyWrittenChanges) {
    dependencies.stdout.write("Running verification...\n");

    try {
      const verification = await dependencies.verifyWrittenChanges({
        abortSignal: dependencies.abortSignal,
        commandApproval: dependencies.commandApproval,
        commandPermissions: dependencies.commandPermissions,
        commandRunner: dependencies.commandRunner,
        cwd: options.cwd
      });
      message = `${message}\n${formatVerificationSummary(verification)}`;
    } catch (error) {
      message = `${message}\nVerification failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  return { message };
}

function parsePortOption(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

interface CliProfileOptions {
  deep?: boolean;
  effect?: string;
  flash?: boolean;
  lang?: string;
  model?: string;
  session?: string;
}

function mergeCommandOptions<T extends CliProfileOptions>(options: T, command: Command): T {
  return {
    ...(command.parent?.opts() as CliProfileOptions | undefined),
    ...command.opts(),
    ...options
  } as T;
}

function resolveCliProfile(options: CliProfileOptions): {
  legacyProfile: ExecutionProfile;
  profileSettings: ReturnType<typeof resolveReplModelProfile>;
  selection: ReplProfileSelection;
} {
  const deep = readCliOption<boolean>(options, "deep");
  const flash = readCliOption<boolean>(options, "flash");
  const model = readCliOption<string>(options, "model");
  const effect = readCliOption<string>(options, "effect");
  const legacyProfile: ExecutionProfile = deep ? "deep" : flash ? "flash" : "default";
  const selection = {
    ...resolveReplProfileSelection(legacyProfile)
  };

  if (model !== undefined) {
    selection.model = parseModelFamily(model);
  }

  if (effect !== undefined) {
    selection.effect = parseReasoningEffect(effect);
  }

  return {
    legacyProfile,
    profileSettings: resolveReplModelProfile(selection),
    selection
  };
}

function readCliOption<T>(options: CliProfileOptions, key: keyof CliProfileOptions): T | undefined {
  const direct = options[key] as T | undefined;

  if (direct !== undefined) {
    return direct;
  }

  const opts = (options as CliProfileOptions & { opts?: () => CliProfileOptions }).opts?.();
  return opts?.[key] as T | undefined;
}

function parseModelFamily(value: string): ReplModelFamily {
  if (value === "flash") {
    return "deepseek-v4-flash";
  }

  if (value === "pro") {
    return "deepseek-v4-pro";
  }

  throw new Error(`Unsupported model family "${value}". Expected flash or pro.`);
}

function parseReasoningEffect(value: string): ReplReasoningEffect {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  throw new Error(`Unsupported reasoning effect "${value}". Expected low, medium, high, or xhigh.`);
}

async function maybeInitializeRepositoryForInstruction(options: {
  cwd: string;
  enabled: boolean;
  initializeRepository: typeof initializeRepository;
  input: NodeJS.ReadableStream;
  inspectRepository: typeof inspectRepository;
  output: NodeJS.WritableStream;
  requestWriteAccess: boolean;
}): Promise<{ declined: boolean; initialized: boolean }> {
  const repositoryState = await options.inspectRepository(options.cwd);

  if (repositoryState.isRepository) {
    return { declined: false, initialized: false };
  }

  if (options.enabled) {
    await options.initializeRepository(options.cwd);
    options.output.write("Git repository initialized.\n");
    return { declined: false, initialized: true };
  }

  if (!options.requestWriteAccess || !isInteractiveInput(options.input) || !isInteractiveOutput(options.output)) {
    return { declined: false, initialized: false };
  }

  const readline = createInterface({
    input: options.input,
    output: options.output
  });

  try {
    const answer = (
      await readline.question(
        "This directory is not a Git repository. Initialize one now so I can create and edit project files? [Y]es [N]o: "
      )
    ).trim().toLowerCase();

    if (!(answer === "y" || answer === "yes" || answer.length === 0)) {
      return { declined: true, initialized: false };
    }

    await options.initializeRepository(options.cwd);
    options.output.write("Git repository initialized.\n");
    return { declined: false, initialized: true };
  } finally {
    readline.close();
  }
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

import {
  appendContextTurn,
  buildSessionHistorySummary,
  loadContextStore
} from "./context-store.js";
import { loadConfig, loadProjectPrompt, requireApiKey } from "./config.js";
import { buildContext, compressHistoryMessages } from "./context/builder.js";
import type { BuildContextResult } from "./context/builder.js";
import { PLAN_SYSTEM_PROMPT, REPL_SYSTEM_PROMPT } from "./context/prompts.js";
import { REPL_CHAT_ONLY_SYSTEM_PROMPT } from "./context/repl-chat-only-prompt.js";
import { estimateLooseMessageTokens, type ContextMessage } from "./context/token-counter.js";
import {
  DeepSeekClient,
  type ChatMessage,
  type CreateCompletionOptions,
  type DeepSeekCompletionResult,
  type DeepSeekUsage,
  type StreamingCallbacks
} from "./llm/deepseek-client.js";
import { parseResponse, parsePlan, type ParsedModelResponse, type ParsedPlan } from "./llm/response-parser.js";
import { applyFileChanges, type AppliedFileChange } from "./patcher.js";
import {
  createAiCommit,
  inspectRepository,
  recordOperation,
  type RecordedCommit,
  type RecordedOperation,
  type RepositoryState
} from "./project/git-manager.js";
import { scanProject, type ScanProjectResult } from "./project/scanner.js";
import {
  hasWebSearchTrigger,
  searchWeb,
  stripWebSearchTrigger,
  type SearchWebOptions,
  type WebSearchResult
} from "./search.js";
import { resolveModelProfile, type ModelProfileSettings } from "./model-profile.js";
import { loadPluginTools } from "./plugins.js";
import {
  type CommandApprovalHandler,
  type CommandRunner,
  createDefaultTools,
  createToolMutationState,
  executeToolCalls,
  listToolMutations,
  type LocalTool,
  rollbackToolMutations,
  resolveConfiguredCommandRunner,
  resolveCommandPermissions,
  type ToolExecutionContext,
  type ToolMutationState
} from "./tools.js";

export type ExecutionProfile = "default" | "flash" | "deep";

export interface RunEngineOptions {
  cwd: string;
  dryRun: boolean;
  instruction: string;
  planMode?: boolean;
  profile: ExecutionProfile;
  profileSettings?: ModelProfileSettings;
}

export interface EngineResult {
  message: string;
}

export interface PreparedExecution {
  configProjectPath?: string;
  context: BuildContextResult;
  hasApiKey: boolean;
  instruction: string;
  parsedResponse: ParsedModelResponse;
  profile: ModelProfileSettings;
  repositoryState: RepositoryState;
  scanResult: ScanProjectResult;
  searchResults: WebSearchResult[];
  toolMutations: AppliedFileChange[];
  toolCallsUsed: boolean;
}

export interface RunEngineDependencies {
  applyFileChanges?: typeof applyFileChanges;
  buildContext?: typeof buildContext;
  createAiCommit?: typeof createAiCommit;
  createClient?: (apiKey: string) => {
    createCompletion: (
      messages: Parameters<DeepSeekClient["createCompletion"]>[0],
      options: CreateCompletionOptions
    ) => Promise<DeepSeekCompletionResult>;
    createStreamingCompletion?: (
      messages: ChatMessage[],
      options: CreateCompletionOptions,
      callbacks: StreamingCallbacks
    ) => Promise<DeepSeekCompletionResult>;
  };
  inspectRepository?: typeof inspectRepository;
  parseResponse?: typeof parseResponse;
  recordOperation?: typeof recordOperation;
  scanProject?: typeof scanProject;
  searchWeb?: typeof searchWeb;
  createTools?: (context: ToolExecutionContext) => LocalTool[];
  executeToolCalls?: typeof executeToolCalls;
  loadPluginTools?: typeof loadPluginTools;
  commandApproval?: CommandApprovalHandler;
  commandRunner?: CommandRunner;
  abortSignal?: AbortSignal;
  emitEvent?: (event: EngineEvent) => void;
  executionMode?: "cli" | "service";
  repairRetryLimit?: number;
}

export interface EngineEvent {
  payload?: Record<string, unknown>;
  type: string;
}

export interface ReplTurnCallbacks {
  onContent?: (chunk: string) => void;
  onReasoningContent?: (chunk: string) => void;
}

export interface ReplTurnOptions {
  conversationMessages: ChatMessage[];
  cwd: string;
  instruction: string;
  profileSettings: ModelProfileSettings;
}

export interface ReplTurnResult {
  context: BuildContextResult;
  conversationMessages: ChatMessage[];
  parsedResponse: ParsedModelResponse;
  repositoryState: RepositoryState;
  scanResult: ScanProjectResult;
  searchResults: WebSearchResult[];
  toolCallsUsed: boolean;
  toolMutations: AppliedFileChange[];
  usage: DeepSeekUsage | null;
}

export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "EngineError";
  }
}

export async function runEngine(
  options: RunEngineOptions,
  dependencies: RunEngineDependencies = {}
): Promise<EngineResult> {
  const config = loadConfig({ cwd: options.cwd });
  ensureNotAborted(dependencies.abortSignal);
  const hasApiKey = Boolean(config.apiKey);
  const inspectRepo = dependencies.inspectRepository ?? inspectRepository;
  const repositoryState = await inspectRepo(options.cwd);
  dependencies.emitEvent?.({
    type: "scan.started",
    payload: {
      cwd: options.cwd
    }
  });
  const normalizedInstruction = stripWebSearchTrigger(options.instruction);
  const executeSearchWeb = dependencies.searchWeb ?? searchWeb;
  const searchOptions = buildSearchOptions(config);
  const searchResults =
    hasWebSearchTrigger(options.instruction)
      ? await executeSearchWeb({
          ...searchOptions,
          abortSignal: dependencies.abortSignal,
          query: normalizedInstruction
        })
      : [];
  const historySummary = buildSessionHistorySummary(loadContextStore(options.cwd));

  const executeScanProject = dependencies.scanProject ?? scanProject;
  const executeBuildContext = dependencies.buildContext ?? buildContext;
  const profile = resolveRunProfile(options);
  const projectPrompt = loadProjectPrompt(options.cwd);
  const scanResult = await executeScanProject({
    rootDir: options.cwd,
    instruction: normalizedInstruction,
    ignorePatterns: config.ignore,
    maxCandidates: profile.defaultScanCandidates
  });
  const context = executeBuildContext({
    rootDir: options.cwd,
    instruction: normalizedInstruction,
    candidates: scanResult.candidates,
    explicitPaths: scanResult.explicitPaths,
    historySummary,
    projectPrompt,
    searchResults,
    maxFiles: profile.maxContextFiles,
    maxWindowTokens: profile.contextLengthTokens,
    reservedResponseTokens: profile.reservedResponseTokens
  });
  dependencies.emitEvent?.({
    type: "scan.completed",
    payload: {
      scannedFiles: scanResult.scannedFiles,
      candidates: scanResult.candidates.length
    }
  });
  dependencies.emitEvent?.({
    type: "context.built",
    payload: {
      contextTokens: context.tokenEstimate,
      maxPromptTokens: context.maxPromptTokens
    }
  });
  const actionLabel = options.dryRun ? "Dry run ready" : "Scaffold ready";

  if (options.dryRun) {
    appendContextTurn({
      rootDir: options.cwd,
      instruction: normalizedInstruction,
      files: scanResult.candidates,
      summary: "Dry run completed without model execution.",
      result: {
        ok: true,
        kind: "dry-run",
        appliedFiles: 0,
        toolCallsUsed: false
      },
      search:
        searchResults.length > 0
          ? {
              query: normalizedInstruction,
              results: searchResults.slice(0, 3).map((result) => ({
                title: result.title,
                url: result.url
              }))
            }
          : undefined
    });

    return {
      message: `${actionLabel}: instruction="${normalizedInstruction}" profile=${profile.model}/${profile.reasoningEffort} apiKeyConfigured=${hasApiKey ? "yes" : "no"} scannedFiles=${scanResult.scannedFiles} candidates=${scanResult.candidates.length} searchResults=${searchResults.length} contextTokens=${context.tokenEstimate}/${context.maxPromptTokens} projectConfig=${config.projectConfigPath ?? "none"}`
    };
  }

  const prepared = await prepareExecution(options, dependencies, {
    configProjectPath: config.projectConfigPath,
    context,
    hasApiKey,
    instruction: normalizedInstruction,
    profile,
    repositoryState,
    scanResult,
    searchResults
  });

  return applyPreparedExecution(options.cwd, prepared, dependencies);
}

export async function prepareExecution(
  options: RunEngineOptions,
  dependencies: RunEngineDependencies = {},
  initialState?: {
    configProjectPath?: string;
    context: BuildContextResult;
    hasApiKey: boolean;
    instruction: string;
    profile: ModelProfileSettings;
    repositoryState: RepositoryState;
    scanResult: ScanProjectResult;
    searchResults: WebSearchResult[];
  }
): Promise<PreparedExecution> {
  ensureNotAborted(dependencies.abortSignal);
  const config = loadConfig({ cwd: options.cwd });
  const hasApiKey = initialState?.hasApiKey ?? Boolean(config?.apiKey);
  const instruction = initialState?.instruction ?? stripWebSearchTrigger(options.instruction);
  const repositoryState =
    initialState?.repositoryState ??
    (await (dependencies.inspectRepository ?? inspectRepository)(options.cwd));
  const executeSearchWeb = dependencies.searchWeb ?? searchWeb;
  const searchOptions = buildSearchOptions(config);
  const profile = initialState?.profile ?? resolveRunProfile(options);
  const searchResults =
    initialState?.searchResults ??
    (hasWebSearchTrigger(options.instruction)
      ? await executeSearchWeb({
          ...searchOptions,
          abortSignal: dependencies.abortSignal,
          query: instruction
        })
      : []);
  const historySummary = initialState?.context ? undefined : buildSessionHistorySummary(loadContextStore(options.cwd));
  const executeScanProject = dependencies.scanProject ?? scanProject;
  const executeBuildContext = dependencies.buildContext ?? buildContext;
  const scanResult =
    initialState?.scanResult ??
    (await executeScanProject({
      rootDir: options.cwd,
      instruction,
      ignorePatterns: config?.ignore,
      maxCandidates: profile.defaultScanCandidates
    }));
  const context =
    initialState?.context ??
    executeBuildContext({
      rootDir: options.cwd,
      instruction,
      candidates: scanResult.candidates,
      explicitPaths: scanResult.explicitPaths,
      historySummary,
      projectPrompt: loadProjectPrompt(options.cwd),
      searchResults,
      maxFiles: profile.maxContextFiles,
      maxWindowTokens: profile.contextLengthTokens,
      reservedResponseTokens: profile.reservedResponseTokens
    });
  const mutationState = createToolMutationState();
  const toolContext: ToolExecutionContext = {
    approvedCommands: new Set<string>(),
    abortSignal: dependencies.abortSignal,
    commandApproval: dependencies.commandApproval,
    commandPermissions: resolveCommandPermissions(config.toolPermissions?.command),
    commandRunner: resolveConfiguredCommandRunner(options.cwd, config.toolPermissions?.command, dependencies.commandRunner),
    executionMode: dependencies.executionMode ?? "cli",
    instruction: options.instruction,
    mutations: mutationState,
    repositoryState: {
      isDirty: repositoryState.isDirty
    },
    rootDir: options.cwd,
    searchWeb: (options) => executeSearchWeb(options)
  };
  const builtInTools = (dependencies.createTools ?? createDefaultTools)(toolContext);
  const pluginTools = await (dependencies.loadPluginTools ?? loadPluginTools)(options.cwd, toolContext);
  const tools = [
    ...builtInTools,
    ...pluginTools.flatMap((plugin) => plugin.tools)
  ];

  requireGitRepository(repositoryState);
  const apiKey = requireApiKey(config);
  const client =
    dependencies.createClient?.(apiKey) ??
    new DeepSeekClient({
      apiKey
    });
  try {
    const executeToolCallBatch = dependencies.executeToolCalls ?? executeToolCalls;
    const conversationMessages: ChatMessage[] = [...context.messages];
    let toolCallsUsed = false;
    let completion: DeepSeekCompletionResult | null = null;
    let usage: DeepSeekUsage | null = null;

    for (let round = 0; round < 5; round += 1) {
      const totalTokens = conversationMessages.reduce(
        (sum, msg) => sum + estimateLooseMessageTokens(msg),
        0
      );

      if (totalTokens > context.maxPromptTokens) {
        const compressed = compressHistoryMessages(conversationMessages, context.maxPromptTokens);
        conversationMessages.length = 0;
        conversationMessages.push(...compressed);
      }

      ensureNotAborted(dependencies.abortSignal);
      dependencies.emitEvent?.({
        type: "model.requested",
        payload: {
          round
        }
      });
      completion = await client.createCompletion(conversationMessages, {
        abortSignal: dependencies.abortSignal,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        responseFormat: "json_object",
        stream: false,
        thinking: "enabled",
        tools: tools.map((tool) => tool.definition)
      });
      usage = addUsage(usage, completion.usage);
      const completionToolCalls = completion.toolCalls ?? [];

      if (completionToolCalls.length === 0) {
        dependencies.emitEvent?.({
          type: "model.completed",
          payload: {
            round,
            toolCalls: 0
          }
        });
        break;
      }

      toolCallsUsed = true;
      dependencies.emitEvent?.({
        type: "tool_calls.requested",
        payload: {
          round,
          count: completionToolCalls.length
        }
      });
      conversationMessages.push({
        role: "assistant",
        content: completion.content,
        reasoning_content: completion.reasoningContent || undefined,
        tool_calls: completionToolCalls
      });

      const toolResults = await executeToolCallBatch(completionToolCalls, tools, toolContext);
      dependencies.emitEvent?.({
        type: "tool_calls.completed",
        payload: {
          round,
          count: toolResults.length
        }
      });

      for (const toolResult of toolResults) {
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolResult.tool_call_id,
          content: toolResult.content
        });
      }
    }

    if (!completion) {
      throw new EngineError("MODEL_EMPTY", "Model did not return a completion.");
    }

    const parseModelResponse = dependencies.parseResponse ?? parseResponse;
    const parsed = await parseWithRepairRetry({
      abortSignal: dependencies.abortSignal,
      client,
      completion,
      conversationMessages,
      emitEvent: dependencies.emitEvent,
      parseModelResponse,
      profile,
      repairRetryLimit: dependencies.repairRetryLimit ?? 1,
      tools
    });

    return {
      configProjectPath: initialState?.configProjectPath ?? config?.projectConfigPath,
      context,
      hasApiKey,
      instruction,
      parsedResponse: parsed,
      profile,
      repositoryState,
      scanResult,
      searchResults,
      toolMutations: listToolMutations(mutationState),
      toolCallsUsed
    };
  } catch (error) {
    rollbackToolMutations(mutationState, options.cwd);
    throw error;
  }
}

export async function applyPreparedExecution(
  cwd: string,
  prepared: PreparedExecution,
  dependencies: RunEngineDependencies = {}
): Promise<EngineResult> {
  const applyChanges = dependencies.applyFileChanges ?? applyFileChanges;
  const writeOperationRecord = dependencies.recordOperation ?? recordOperation;
  const commitChanges = dependencies.createAiCommit ?? createAiCommit;
  const hasDiffWrites = prepared.parsedResponse.files.length > 0;
  const hasToolWrites = prepared.toolMutations.length > 0;

  if (hasDiffWrites && hasToolWrites) {
    throw new EngineError(
      "MIXED_WRITE_CHANNELS",
      "Final model response included diff writes even though tool calls already modified files."
    );
  }

  if (!hasDiffWrites && !hasToolWrites) {
    const summary = "No changes were applied.";

    dependencies.emitEvent?.({
      type: "apply.skipped",
      payload: {
        reason: "no_selected_files"
      }
    });

    return {
      message: `Scaffold ready: instruction="${prepared.instruction}" profile=${prepared.profile.model}/${prepared.profile.reasoningEffort} apiKeyConfigured=${prepared.hasApiKey ? "yes" : "no"} scannedFiles=${prepared.scanResult.scannedFiles} candidates=${prepared.scanResult.candidates.length} searchResults=${prepared.searchResults.length} toolCallsUsed=${prepared.toolCallsUsed ? "yes" : "no"} contextTokens=${prepared.context.tokenEstimate}/${prepared.context.maxPromptTokens} appliedFiles=0 change=none summary="${summary}" projectConfig=${prepared.configProjectPath ?? "none"}`
    };
  }

  const applied = hasToolWrites
    ? prepared.toolMutations
    : await applyChanges(cwd, prepared.parsedResponse.files);
  dependencies.emitEvent?.({
    type: "apply.completed",
    payload: {
      appliedFiles: applied.length,
      via: hasToolWrites ? "tools" : "diff"
    }
  });
  const summary = prepared.parsedResponse.summary || summarizeAppliedFiles(applied);
  const changeLabel = prepared.repositoryState.isDirty ? "operation" : "commit";
  let changeReference: RecordedOperation | RecordedCommit;

  if (prepared.repositoryState.isDirty) {
    changeReference = writeOperationRecord(
      cwd,
      prepared.repositoryState,
      applied.map((change) => ({
        path: change.path,
        beforeContent: change.beforeContent,
        afterContent: change.afterContent
      })),
      summary
    );
  } else {
    changeReference = await commitChanges(
      cwd,
      applied.map((change) => change.path),
      summary
    );
  }

  appendContextTurn({
    rootDir: cwd,
    instruction: prepared.instruction,
    files: [...new Set(applied.map((change) => change.path))],
    summary,
    result: {
      ok: true,
      kind: prepared.repositoryState.isDirty ? "operation" : "commit",
      reference: formatChangeReference(changeReference),
      appliedFiles: applied.length,
      toolCallsUsed: prepared.toolCallsUsed
    },
    search:
      prepared.searchResults.length > 0
        ? {
            query: prepared.instruction,
            results: prepared.searchResults.slice(0, 3).map((result) => ({
              title: result.title,
              url: result.url
            }))
          }
        : undefined,
    tools: prepared.toolCallsUsed
      ? {
          names: prepared.toolMutations.length > 0 ? ["tool_calls", "write_tool"] : ["tool_calls"]
        }
      : undefined
  });

  return {
    message: `Scaffold ready: instruction="${prepared.instruction}" profile=${prepared.profile.model}/${prepared.profile.reasoningEffort} apiKeyConfigured=${prepared.hasApiKey ? "yes" : "no"} scannedFiles=${prepared.scanResult.scannedFiles} candidates=${prepared.scanResult.candidates.length} searchResults=${prepared.searchResults.length} toolCallsUsed=${prepared.toolCallsUsed ? "yes" : "no"} contextTokens=${prepared.context.tokenEstimate}/${prepared.context.maxPromptTokens} appliedFiles=${applied.length} ${changeLabel}=${formatChangeReference(changeReference)} summary="${summary}" projectConfig=${prepared.configProjectPath ?? "none"}`
  };
}

export async function executeReplTurn(
  options: ReplTurnOptions,
  dependencies: RunEngineDependencies = {},
  callbacks: ReplTurnCallbacks = {}
): Promise<ReplTurnResult> {
  ensureNotAborted(dependencies.abortSignal);
  const config = loadConfig({ cwd: options.cwd });
  const hasApiKey = Boolean(config.apiKey);
  const profile = options.profileSettings;
  const instruction = stripWebSearchTrigger(options.instruction);
  const inspectRepo = dependencies.inspectRepository ?? inspectRepository;
  const repositoryState = await inspectRepo(options.cwd);
  const executeSearchWeb = dependencies.searchWeb ?? searchWeb;
  const searchOptions = buildSearchOptions(config);
  const searchResults = hasWebSearchTrigger(options.instruction)
    ? await executeSearchWeb({
        ...searchOptions,
        abortSignal: dependencies.abortSignal,
        query: instruction
      })
    : [];
  const historySummary = buildSessionHistorySummary(loadContextStore(options.cwd));
  const mutationState = createToolMutationState();
  const isChatOnlyMode = !repositoryState.isRepository;
  const toolContext: ToolExecutionContext = {
    approvedCommands: new Set<string>(),
    abortSignal: dependencies.abortSignal,
    commandApproval: dependencies.commandApproval,
    commandPermissions: resolveCommandPermissions(config.toolPermissions?.command),
    commandRunner: resolveConfiguredCommandRunner(options.cwd, config.toolPermissions?.command, dependencies.commandRunner),
    executionMode: dependencies.executionMode ?? "cli",
    instruction: options.instruction,
    mutations: mutationState,
    repositoryState: {
      isDirty: repositoryState.isDirty
    },
    rootDir: options.cwd,
    searchWeb: (searchOpts) => executeSearchWeb(searchOpts)
  };
  const executeScanProject = dependencies.scanProject ?? scanProject;
  const executeBuildContext = dependencies.buildContext ?? buildContext;
  const projectPrompt = loadProjectPrompt(options.cwd);
  const scanResult = isChatOnlyMode
    ? {
        candidates: [],
        explicitPaths: [],
        scannedFiles: 0
      }
    : await executeScanProject({
        rootDir: options.cwd,
        instruction,
        ignorePatterns: config.ignore,
        maxCandidates: profile.defaultScanCandidates
      });
  const context = isChatOnlyMode
    ? buildStandaloneReplChatContext({
        historySummary,
        instruction,
        maxWindowTokens: profile.contextLengthTokens,
        reservedResponseTokens: profile.reservedResponseTokens,
        searchResults
      })
    : executeBuildContext({
        rootDir: options.cwd,
        instruction,
        candidates: scanResult.candidates,
        explicitPaths: scanResult.explicitPaths,
        historySummary,
        projectPrompt,
        searchResults,
        systemPrompt: REPL_SYSTEM_PROMPT,
        maxFiles: profile.maxContextFiles,
        maxWindowTokens: profile.contextLengthTokens,
        reservedResponseTokens: profile.reservedResponseTokens
      });
  const tools = isChatOnlyMode
    ? []
    : await buildReplTools(options.cwd, dependencies, toolContext);

  const apiKey = requireApiKey(config);
  const defaultClient = new DeepSeekClient({ apiKey });
  const client = dependencies.createClient?.(apiKey) ?? defaultClient;
  const streamFn = client.createStreamingCompletion
    ? client.createStreamingCompletion.bind(client)
    : defaultClient.createStreamingCompletion.bind(defaultClient);

  try {
    const conversationMessages: ChatMessage[] = [...options.conversationMessages];

    if (conversationMessages.length === 0) {
      conversationMessages.push(...context.messages);
    } else {
      const taskMessages = context.messages.filter((msg) => msg.role === "user");
      const taskMessage = taskMessages[taskMessages.length - 1];

      if (taskMessage) {
        conversationMessages.push(taskMessage);
      }
    }

    const executeToolCallBatch = dependencies.executeToolCalls ?? executeToolCalls;
    let toolCallsUsed = false;
    let completion: DeepSeekCompletionResult | null = null;
    let usage: DeepSeekUsage | null = null;

    for (let round = 0; round < 5; round += 1) {
      const totalTokens = conversationMessages.reduce(
        (sum, msg) => sum + estimateLooseMessageTokens(msg),
        0
      );

      if (totalTokens > context.maxPromptTokens) {
        const compressed = compressHistoryMessages(conversationMessages, context.maxPromptTokens);
        conversationMessages.length = 0;
        conversationMessages.push(...compressed);
      }

      ensureNotAborted(dependencies.abortSignal);
      dependencies.emitEvent?.({
        type: "model.requested",
        payload: {
          round
        }
      });

      completion = await streamFn(
        conversationMessages,
        {
          abortSignal: dependencies.abortSignal,
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          responseFormat: "text",
          thinking: "enabled",
          tools: tools.map((tool) => tool.definition)
        },
        callbacks
      );
      usage = addUsage(usage, completion.usage);

      const completionToolCalls = completion.toolCalls ?? [];

      if (completionToolCalls.length === 0) {
        dependencies.emitEvent?.({
          type: "model.completed",
          payload: {
            round,
            toolCalls: 0
          }
        });
        break;
      }

      toolCallsUsed = true;
      dependencies.emitEvent?.({
        type: "tool_calls.requested",
        payload: {
          round,
          count: completionToolCalls.length
        }
      });
      conversationMessages.push({
        role: "assistant",
        content: completion.content,
        reasoning_content: completion.reasoningContent || undefined,
        tool_calls: completionToolCalls
      });

      const toolResults = await executeToolCallBatch(completionToolCalls, tools, toolContext);
      dependencies.emitEvent?.({
        type: "tool_calls.completed",
        payload: {
          round,
          count: toolResults.length
        }
      });

      for (const toolResult of toolResults) {
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolResult.tool_call_id,
          content: toolResult.content
        });
      }
    }

    if (!completion) {
      throw new EngineError("MODEL_EMPTY", "Model did not return a completion.");
    }

    conversationMessages.push({
      role: "assistant",
      content: completion.content,
      reasoning_content: completion.reasoningContent || undefined
    });

    const parseModelResponse = dependencies.parseResponse ?? parseResponse;
    const parseOutcome = parseModelResponse(completion);
    let parsedResponse: ParsedModelResponse = parseOutcome.ok
      ? parseOutcome.value
      : {
          files: [],
          summary: completion.content || "No response content."
        };

    if (isChatOnlyMode && parsedResponse.files.length > 0) {
      parsedResponse = {
        files: [],
        summary:
          parsedResponse.summary ||
          "Chat-only mode: file changes are unavailable outside a Git repository."
      };
    }

    return {
      context,
      conversationMessages,
      parsedResponse,
      repositoryState,
      scanResult,
      searchResults,
      toolCallsUsed,
      toolMutations: listToolMutations(mutationState),
      usage
    };
  } catch (error) {
    rollbackToolMutations(mutationState, options.cwd);
    throw error;
  }
}

async function buildReplTools(
  rootDir: string,
  dependencies: RunEngineDependencies,
  toolContext: ToolExecutionContext
): Promise<LocalTool[]> {
  const builtInTools = (dependencies.createTools ?? createDefaultTools)(toolContext);
  const pluginTools = await (dependencies.loadPluginTools ?? loadPluginTools)(rootDir, toolContext);

  return [
    ...builtInTools,
    ...pluginTools.flatMap((plugin) => plugin.tools)
  ];
}

function buildStandaloneReplChatContext(options: {
  historySummary?: string;
  instruction: string;
  maxWindowTokens: number;
  reservedResponseTokens: number;
  searchResults: WebSearchResult[];
}): BuildContextResult {
  const maxPromptTokens = options.maxWindowTokens - options.reservedResponseTokens;
  const userParts = [
    options.historySummary ? `Recent conversation summary:\n${options.historySummary}` : null,
    options.searchResults.length > 0
      ? [
          "Web search results:",
          ...options.searchResults.map((result, index) => `${index + 1}. ${result.title} - ${result.url}\n${result.snippet}`)
        ].join("\n")
      : null,
    `User message:\n${options.instruction}`
  ].filter(Boolean);

  const messages: ContextMessage[] = [
    {
      role: "system",
      content: REPL_CHAT_ONLY_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: userParts.join("\n\n")
    }
  ];

  const tokenEstimate = messages.reduce((sum, message) => sum + estimateLooseMessageTokens(message), 0);

  return {
    messages,
    files: [],
    projectMetadata: "Chat-only mode (no Git repository detected).",
    tokenEstimate,
    maxPromptTokens,
    truncated: false
  };
}

export interface PlanResult {
  plan: ParsedPlan;
}

export async function generatePlan(
  options: RunEngineOptions,
  dependencies: RunEngineDependencies = {}
): Promise<PlanResult> {
  ensureNotAborted(dependencies.abortSignal);
  const config = loadConfig({ cwd: options.cwd });
  const hasApiKey = Boolean(config.apiKey);
  const executeSearchWeb = dependencies.searchWeb ?? searchWeb;
  const instruction = stripWebSearchTrigger(options.instruction);
  const searchOptions = buildSearchOptions(config);
  const searchResults = hasWebSearchTrigger(options.instruction)
    ? await executeSearchWeb({
        ...searchOptions,
        abortSignal: dependencies.abortSignal,
        query: instruction
      })
    : [];
  const historySummary = buildSessionHistorySummary(loadContextStore(options.cwd));
  const executeScanProject = dependencies.scanProject ?? scanProject;
  const executeBuildContext = dependencies.buildContext ?? buildContext;
  const profile = resolveRunProfile(options);
  const scanResult = await executeScanProject({
    rootDir: options.cwd,
    instruction,
    ignorePatterns: config.ignore,
    maxCandidates: profile.defaultScanCandidates
  });
  const projectPrompt = loadProjectPrompt(options.cwd);
  const context = executeBuildContext({
    rootDir: options.cwd,
    instruction,
    candidates: scanResult.candidates,
    explicitPaths: scanResult.explicitPaths,
    historySummary,
    searchResults,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    maxFiles: profile.maxContextFiles,
    maxWindowTokens: profile.contextLengthTokens,
    reservedResponseTokens: profile.reservedResponseTokens,
    projectPrompt
  });
  dependencies.emitEvent?.({
    type: "context.built",
    payload: {
      contextTokens: context.tokenEstimate,
      maxPromptTokens: context.maxPromptTokens
    }
  });

  const inspectRepo = dependencies.inspectRepository ?? inspectRepository;
  const repositoryState = await inspectRepo(options.cwd);
  requireGitRepository(repositoryState);
  const apiKey = requireApiKey(config);
  const client = dependencies.createClient?.(apiKey) ?? new DeepSeekClient({ apiKey });

  ensureNotAborted(dependencies.abortSignal);
  const completion = await client.createCompletion(context.messages, {
    abortSignal: dependencies.abortSignal,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    responseFormat: "json_object",
    stream: false,
    thinking: "enabled",
    toolChoice: "none"
  });
  dependencies.emitEvent?.({ type: "model.completed", payload: { round: 0, toolCalls: 0 } });

  const parseModelPlan = parsePlan;
  const parsed = parseModelPlan(completion);

  if (!parsed.ok) {
    throw new EngineError(parsed.error.code, parsed.error.message);
  }

  return { plan: parsed.value };
}

export async function executePlanSteps(
  plan: ParsedPlan,
  options: RunEngineOptions,
  dependencies: RunEngineDependencies & {
    confirmStep?: (stepIndex: number, totalSteps: number, prepared: PreparedExecution) => Promise<boolean>;
    emitStepEvent?: (event: { type: string; stepIndex: number; totalSteps: number; payload?: Record<string, unknown> }) => void;
    rollbackOnFailure?: boolean;
  } = {}
): Promise<PlanStepResult[]> {
  const results: PlanStepResult[] = [];
  const completedSteps: PreparedExecution[] = [];
  const totalSteps = plan.steps.length;

  for (const step of plan.steps) {
    ensureNotAborted(dependencies.abortSignal);
    dependencies.emitStepEvent?.({
      type: "step.started",
      stepIndex: step.index,
      totalSteps,
      payload: { description: step.description }
    });

    const fileRefs = step.files.map((f) => `@${f}`).join(" ");
    const stepInstruction = `[Step ${step.index}/${totalSteps}] ${step.description}\n${fileRefs}`;
    const stepOptions: RunEngineOptions = {
      cwd: options.cwd,
      dryRun: false,
      instruction: stepInstruction,
      profile: options.profile,
      profileSettings: options.profileSettings
    };

    try {
      const prepared = await prepareExecution(stepOptions, dependencies);

      if (dependencies.confirmStep) {
        const confirmed = await dependencies.confirmStep(step.index, totalSteps, prepared);
        if (!confirmed) {
          results.push({
            stepIndex: step.index,
            status: "skipped",
            summary: "Skipped by user"
          });
          continue;
        }
      }

      const engineResult = await applyPreparedExecution(options.cwd, prepared, dependencies);
      completedSteps.push(prepared);
      results.push({
        stepIndex: step.index,
        status: "completed",
        summary: engineResult.message
      });
      dependencies.emitStepEvent?.({
        type: "step.completed",
        stepIndex: step.index,
        totalSteps,
        payload: { summary: engineResult.message }
      });
    } catch (error) {
      results.push({
        stepIndex: step.index,
        status: "failed",
        summary: error instanceof Error ? error.message : "Unknown error"
      });
      dependencies.emitStepEvent?.({
        type: "step.failed",
        stepIndex: step.index,
        totalSteps,
        payload: { error: error instanceof Error ? error.message : "Unknown error" }
      });

      if (dependencies.rollbackOnFailure && completedSteps.length > 0) {
        await rollbackCompletedSteps(options.cwd, completedSteps, dependencies);
      }

      break;
    }
  }

  return results;
}

async function rollbackCompletedSteps(
  cwd: string,
  completedSteps: PreparedExecution[],
  dependencies: RunEngineDependencies
): Promise<void> {
  const applyChanges = dependencies.applyFileChanges ?? applyFileChanges;

  for (const step of [...completedSteps].reverse()) {
    try {
      const reverseFiles = step.parsedResponse.files
        .filter((file) => file.action !== "modify")
        .map((file) => ({
          ...file,
          action: file.action === "create" ? "delete" as const : "create" as const,
          diff: ""
        }));

      if (reverseFiles.length > 0) {
        await applyChanges(cwd, reverseFiles);
      }
    } catch {
      // Rollback is best-effort; continue trying other steps
    }
  }
}

export interface PlanStepResult {
  stepIndex: number;
  status: "completed" | "skipped" | "failed";
  summary: string;
}

async function parseWithRepairRetry(options: {
  abortSignal?: AbortSignal;
  client: { createCompletion: (messages: ChatMessage[], options: CreateCompletionOptions) => Promise<DeepSeekCompletionResult> };
  completion: DeepSeekCompletionResult;
  conversationMessages: ChatMessage[];
  emitEvent?: (event: EngineEvent) => void;
  parseModelResponse: typeof parseResponse;
  profile: PreparedExecution["profile"];
  repairRetryLimit: number;
  tools: LocalTool[];
}): Promise<ParsedModelResponse> {
  let completion = options.completion;
  let parsed = options.parseModelResponse(completion);

  for (let attempt = 0; !parsed.ok && parsed.error.canRetry && attempt < options.repairRetryLimit; attempt += 1) {
    ensureNotAborted(options.abortSignal);
    options.emitEvent?.({
      type: "repair.retry",
      payload: {
        attempt: attempt + 1,
        code: parsed.error.code
      }
    });
    const repairMessages = [
      ...options.conversationMessages,
      {
        role: "assistant" as const,
        content: completion.content
      },
      {
        role: "user" as const,
        content: buildRepairPrompt(parsed.error.code, parsed.error.message)
      }
    ];

    completion = await options.client.createCompletion(repairMessages, {
      abortSignal: options.abortSignal,
      model: options.profile.model,
      reasoningEffort: options.profile.reasoningEffort,
      responseFormat: "json_object",
      stream: false,
      thinking: "enabled",
      tools: options.tools.map((tool) => tool.definition),
      toolChoice: "none"
    });
    parsed = options.parseModelResponse(completion);
  }

  if (!parsed.ok) {
    throw new EngineError(parsed.error.code, parsed.error.message);
  }

  return parsed.value;
}

function buildRepairPrompt(code: string, message: string): string {
  return [
    "Your previous response could not be applied.",
    `Failure code: ${code}`,
    `Reason: ${message}`,
    "Return only a valid JSON object matching the required schema.",
    "Do not call tools in this repair response.",
    'The JSON must have the shape: {"files":[{"path":"relative/path","action":"modify|create|delete","diff":"unified diff"}],"summary":"..."}'
  ].join("\n");
}

function requireGitRepository(repositoryState: RepositoryState): void {
  if (!repositoryState.isRepository) {
    throw new EngineError(
      "GIT_REQUIRED",
      "DeepVibe requires a Git repository for non-dry-run execution. Run `git init`, pass `--init`, or use `deepvibe chat` for the interactive setup flow."
    );
  }
}

function resolveRunProfile(options: Pick<RunEngineOptions, "profile" | "profileSettings">): ModelProfileSettings {
  return options.profileSettings ?? resolveModelProfile(options.profile);
}

function summarizeAppliedFiles(applied: AppliedFileChange[]): string {
  if (applied.length === 0) {
    return "No file changes applied";
  }

  return `Applied ${applied.length} file change${applied.length === 1 ? "" : "s"}`;
}

function formatChangeReference(changeReference: RecordedOperation | RecordedCommit): string {
  if ("operationId" in changeReference) {
    return changeReference.operationId;
  }

  return changeReference.commitHash;
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EngineError("CANCELED", "Execution was canceled.");
  }
}

function buildSearchOptions(config: { searchProvider?: string; tavilyApiKey?: string; bingApiKey?: string }): Pick<SearchWebOptions, "provider" | "searchApiKey"> {
  const provider = config.searchProvider ?? "duckduckgo";
  const searchApiKey = provider === "tavily" ? config.tavilyApiKey : provider === "bing" ? config.bingApiKey : undefined;

  return { provider: provider as SearchWebOptions["provider"], searchApiKey };
}

export function addUsage(current: DeepSeekUsage | null, next: DeepSeekUsage | null): DeepSeekUsage | null {
  if (!current && !next) {
    return null;
  }

  return {
    completion_tokens: sumUsageField(current?.completion_tokens, next?.completion_tokens),
    prompt_cache_hit_tokens: sumUsageField(current?.prompt_cache_hit_tokens, next?.prompt_cache_hit_tokens),
    prompt_cache_miss_tokens: sumUsageField(current?.prompt_cache_miss_tokens, next?.prompt_cache_miss_tokens),
    prompt_tokens: sumUsageField(current?.prompt_tokens, next?.prompt_tokens),
    reasoning_tokens: sumUsageField(current?.reasoning_tokens, next?.reasoning_tokens),
    total_tokens: sumUsageField(current?.total_tokens, next?.total_tokens)
  };
}

export function sumUsageField(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}


import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";

import { createStreamingChatBubbleWriter, renderChatBubble } from "./chat-bubble.js";
import {
  appendContextTurn,
  loadChatHistory,
  loadContextStore,
  listSessions,
  switchSession,
  updateChatHistory
} from "./context-store.js";
import {
  addUsage,
  applyPreparedExecution,
  executeReplTurn,
  type ExecutionProfile,
  type PreparedExecution,
  type ReplTurnCallbacks,
  type ReplTurnResult,
  type RunEngineDependencies
} from "./engine.js";
import { detectLanguage, t, type Language } from "./i18n.js";
import type { ChatMessage, DeepSeekUsage } from "./llm/deepseek-client.js";
import {
  resolveReplModelProfile,
  resolveReplProfileSelection,
  type ReplProfileSelection
} from "./model-profile.js";
import {
  coalescePastedInputLine,
  consumeMultilineCaptureLine,
  createManualMultilineCapture,
  tryStartFenceMultilineCapture,
  type MultilineCapture,
  type PasteCaptureState
} from "./multiline.js";
import { inspectPluginDiscovery } from "./plugins.js";
import { initializeRepository, inspectRepository } from "./project/git-manager.js";
import { confirmReplExecution } from "./review.js";
import { completeReplInput, handleSlashCommand } from "./slash-command.js";
import {
  clearInteractiveViewport,
  clearTransientLine,
  createPersistentStatusArea,
  createThinkingStatus,
  formatPluginDiscoveryStatus,
  renderPanelMessage,
  renderStatusPanel,
  renderWelcomeBanner,
  type PersistentStatusArea
} from "./status.js";
import {
  createSessionUsageSnapshot,
  estimateUsageCost,
  formatUsageSummaryLine,
  type SessionUsageSnapshot
} from "./usage.js";

export { confirmReplExecution } from "./review.js";
export { completeReplInput } from "./slash-command.js";

function formatError(error: unknown, lang: Language): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code: string }).code;
    const errorKey = `error.${code}`;
    const translated = t(errorKey, lang);

    if (translated !== errorKey) {
      return translated;
    }
  }

  return error instanceof Error ? error.message : "Unknown error.";
}

export interface ReplDependencies extends RunEngineDependencies {
  applyPreparedExecution?: typeof applyPreparedExecution;
  confirmReplExecution?: typeof confirmReplExecution;
  executeReplTurn?: typeof executeReplTurn;
  initializeRepository?: typeof initializeRepository;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export async function startRepl(
  options: {
    cwd: string;
    profile: ExecutionProfile;
    sessionId?: string;
    lang?: Language;
    profileSelection?: ReplProfileSelection;
    workspaceMode?: "sandbox" | "full";
    requestedCwd?: string;
  },
  dependencies: ReplDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const executeTurn = dependencies.executeReplTurn ?? executeReplTurn;
  const executeApply = dependencies.applyPreparedExecution ?? applyPreparedExecution;
  const confirmExec = dependencies.confirmReplExecution ?? confirmReplExecution;
  const executeInitializeRepository = dependencies.initializeRepository ?? initializeRepository;
  const lang = options.lang ?? detectLanguage();
  let currentSelection = options.profileSelection ?? resolveReplProfileSelection(options.profile);
  const pluginDiscovery = inspectPluginDiscovery(options.cwd);

  const renderCurrentStatusPanel = () => {
    const workspaceStatus = resolveWorkspaceStatus({
      cwd: options.cwd,
      requestedCwd: options.requestedCwd,
      workspaceMode: options.workspaceMode
    });

    return renderStatusPanel({
      hint: t("repl.hint", lang),
      lang,
      mode: t(repositoryState.isRepository ? "repl.mode.project" : "repl.mode.chat_only", lang),
      profile: formatExecutionProfileStatus(currentSelection),
      sessionId: store.currentSessionId,
      plugins: formatPluginDiscoveryStatus(pluginDiscovery),
      workspace: workspaceStatus?.mode,
      workspacePath: workspaceStatus?.path,
      welcome: t("repl.welcome", lang).trim()
    });
  };

  let store = loadContextStore(options.cwd);

  if (options.sessionId) {
    const switched = switchSession(options.cwd, options.sessionId);
    if (switched) {
      store = switched;
    } else {
      stderr.write(t("session.not_found", lang, { id: options.sessionId }) + "\n");
    }
  }

  let chatHistory: ChatMessage[] = loadChatHistory(store);
  let lastReasoningTrace = "";
  let lastTurnUsage: DeepSeekUsage | null = null;
  let lastTurnUsageProfile: ReplProfileSelection = { ...currentSelection };
  let currentTurnController: AbortController | null = null;
  const sessionUsageById = new Map<string, SessionUsageSnapshot>();
  let multilineCapture: MultilineCapture | null = null;
  let repositoryState: { isRepository: boolean; isDirty: boolean } = { isRepository: false, isDirty: false };
  const ensureSessionUsage = (sessionId: string) => {
    if (!sessionUsageById.has(sessionId)) {
      sessionUsageById.set(sessionId, createSessionUsageSnapshot());
    }

    return sessionUsageById.get(sessionId)!;
  };
  ensureSessionUsage(store.currentSessionId);

  try {
    repositoryState = await (dependencies.inspectRepository ?? inspectRepository)(options.cwd);
  } catch {
    // Non-git directory: inspectRepository may throw; REPL works in chat-only mode
  }

  const readline = createInterface({
    completer: (line) =>
      completeReplInput(line, {
        sessionIds: listSessions(store).map((session) => session.id)
      }),
    input: stdin,
    output: stdout,
    prompt: t("repl.prompt", lang)
  });
  const persistentStatusArea = createPersistentStatusArea(stdout, {
    renderStatusPanel: renderCurrentStatusPanel,
    renderWelcomeBanner: () => renderWelcomeBanner(lang)
  });
  const syncPrompt = () => {
    readline.setPrompt(multilineCapture ? t("repl.prompt.multiline", lang) : t("repl.prompt", lang));
  };

  let isClosed = false;
  let exitReason = "eof";

  readline.on("close", () => {
    isClosed = true;
  });

  readline.on("SIGINT", () => {
    if (currentTurnController && !currentTurnController.signal.aborted) {
      currentTurnController.abort();
      exitReason = "interrupt_turn";
      return;
    }
    exitReason = "interrupt";
    stdout.write("\n");
    readline.close();
  });

  try {
    if (persistentStatusArea) {
      persistentStatusArea.initialize();
    } else {
      stdout.write(renderWelcomeBanner(lang));
      stdout.write(renderCurrentStatusPanel());
    }

    syncPrompt();
    if (!isClosed) readline.prompt();

    const pasteCaptureState: PasteCaptureState = { lineBuffer: null };

    for await (const line of readline) {
      let rawInput = line;

      const pastedInput = await coalescePastedInputLine(rawInput, {
        multilineActive: Boolean(multilineCapture),
        readline,
        state: pasteCaptureState,
        stdin
      });

      if (pastedInput.pending) {
        syncPrompt();
        if (!isClosed) readline.prompt();
        continue;
      }

      rawInput = pastedInput.rawInput;

      if (multilineCapture) {
        const completion = consumeMultilineCaptureLine(multilineCapture, rawInput);

        if (completion.status === "pending") {
          syncPrompt();
          if (!isClosed) readline.prompt();
          continue;
        }

        multilineCapture = null;
        syncPrompt();

        if (completion.status === "canceled") {
          stdout.write(t("cmd.multiline.canceled", lang) + "\n");
          if (!isClosed) readline.prompt();
          continue;
        }

        rawInput = completion.value ?? "";
      } else {
        const autoCapture = tryStartFenceMultilineCapture(rawInput);

        if (autoCapture) {
          multilineCapture = autoCapture;
          syncPrompt();
          stdout.write(t("cmd.multiline.started_fence", lang) + "\n");
          if (!isClosed) readline.prompt();
          continue;
        }
      }

      const input = rawInput.trim();

      if (input.length === 0) {
        if (!isClosed) readline.prompt();
        continue;
      }

      if (input.startsWith("/")) {
        const handled = await handleSlashCommand(input, {
          cwd: options.cwd,
          input: stdin,
          lang,
          persistentStatusArea,
          readline,
          refreshStatusPanel: () => {
            persistentStatusArea?.refresh();
          },
          stderr,
          stdout,
          getStore: () => store,
          setStore: (next) => {
            store = next;
            ensureSessionUsage(next.currentSessionId);
          },
          getChatHistory: () => chatHistory,
          setChatHistory: (next) => {
            chatHistory = next;
          },
          getLastReasoningTrace: () => lastReasoningTrace,
          getProfile: () => currentSelection,
          setProfile: (next) => {
            currentSelection = next;
          },
          getSessionUsage: () => ensureSessionUsage(store.currentSessionId),
          getLastTurnUsage: () => lastTurnUsage,
          getLastTurnUsageProfile: () => lastTurnUsageProfile,
          startMultilineCapture: () => {
            multilineCapture = createManualMultilineCapture();
            syncPrompt();
          },
          renderStatusPanel: renderCurrentStatusPanel,
          renderWelcomeBanner: () => renderWelcomeBanner(lang)
        });

        if (handled === "quit") {
          exitReason = "quit";
          readline.close();
          break;
        }

        syncPrompt();
        if (!isClosed) readline.prompt();
        continue;
      }

      if (!repositoryState.isRepository && looksLikeEngineeringIntent(input)) {
        stdout.write(renderChatBubble(t("repl.panel.user", lang), input));
        const initialized = await maybeInitializeRepository({
          cwd: options.cwd,
          inspectRepository: dependencies.inspectRepository ?? inspectRepository,
          initializeRepository: executeInitializeRepository,
          lang,
          output: stdout,
          readline
        });

        if (initialized) {
          repositoryState = initialized;
          persistentStatusArea?.refresh();
        }
      } else {
        stdout.write(renderChatBubble(t("repl.panel.user", lang), input));
      }

      const thinkingStatus = createThinkingStatus(stdout, lang);
      const assistantBubble = createStreamingChatBubbleWriter(stdout, t("repl.panel.assistant", lang));

      try {
        let reasoningAnnounced = false;
        let streamedContent = "";
        let streamedReasoning = "";

        thinkingStatus.start();
        stdout.write(`${t("repl.preflight", lang)}\n`);

        currentTurnController = new AbortController();

        const callbacks: ReplTurnCallbacks = {
          onContent: (chunk) => {
            streamedContent += chunk;
            thinkingStatus.stop({ clearLine: true });
            assistantBubble.write(chunk);
          },
          onReasoningContent: (chunk) => {
            streamedReasoning += chunk;

            if (!reasoningAnnounced) {
              thinkingStatus.start();
              reasoningAnnounced = true;
            }
          }
        };

        stdout.write("\n");
        const result = await executeTurn(
          {
            conversationMessages: chatHistory,
            cwd: options.cwd,
            instruction: input,
            profileSettings: resolveReplModelProfile(currentSelection)
          },
          {
            ...dependencies,
            abortSignal: currentTurnController.signal,
            emitEvent: (event) => {
              if (event.type === "tool_calls.requested") {
                const count = event.payload?.count as number | undefined;
                if (count) {
                  thinkingStatus.stop({ clearLine: true });
                }
              }
              if (event.type === "tool_calls.completed") {
                thinkingStatus.start();
              }
              if (event.type === "model.requested") {
                thinkingStatus.start();
              }
              dependencies.emitEvent?.(event);
            }
          },
          callbacks
        );

        thinkingStatus.stop({ clearLine: true });

        if (currentTurnController.signal.aborted) {
          assistantBubble.end();
          stdout.write(`${t("repl.interrupted", lang)}\n`);
          currentTurnController = null;
          syncPrompt();
          if (!isClosed) readline.prompt();
          continue;
        }

        if (streamedContent.trim().length === 0 && result.parsedResponse.files.length === 0 && result.parsedResponse.summary.trim().length > 0) {
          assistantBubble.write(result.parsedResponse.summary);
        }
        assistantBubble.end();

        stdout.write("\n");
        lastReasoningTrace = streamedReasoning.trim();
        lastTurnUsage = result.usage;
        lastTurnUsageProfile = { ...currentSelection };

        if (lastReasoningTrace.length > 0) {
          stdout.write(`${t("repl.thoughts.hidden", lang)}\n`);
        }

        if (result.usage) {
          const sessionUsage = ensureSessionUsage(store.currentSessionId);
          sessionUsage.turnCount += 1;
          sessionUsage.usage = addUsage(sessionUsage.usage, result.usage);
          sessionUsage.estimatedCostUsd += estimateUsageCost(currentSelection.model, result.usage);
          stdout.write(`${formatUsageSummaryLine(currentSelection, result.usage)}\n`);
        }

        chatHistory = result.conversationMessages;

        const hasChanges = result.parsedResponse.files.length > 0 || result.toolMutations.length > 0;

        if (hasChanges) {
          const confirmed = await confirmExec(result, {
            input: stdin,
            output: stdout,
            lang
          }, readline);

          if (confirmed) {
            const prepared = buildPreparedFromReplResult(result, input, resolveReplModelProfile(currentSelection));
            await executeApply(options.cwd, prepared, dependencies);
            stdout.write(t("confirm.accepted", lang) + "\n");
          } else {
            stdout.write(t("confirm.rejected", lang) + "\n");
          }
        }

        const previousSessionId = store.currentSessionId;
        const persistedStore = appendContextTurn({
          rootDir: options.cwd,
          instruction: input,
          files: result.toolMutations.map((m) => m.path),
          summary: result.parsedResponse.summary,
          result: {
            ok: true,
            kind: hasChanges ? "operation" : "dry-run",
            appliedFiles: result.toolMutations.length,
            toolCallsUsed: result.toolCallsUsed
          }
        });

        if (persistedStore.currentSessionId !== previousSessionId && sessionUsageById.has(previousSessionId)) {
          sessionUsageById.set(
            persistedStore.currentSessionId,
            sessionUsageById.get(previousSessionId)!
          );
        }

        store = persistedStore;
        updateChatHistory(options.cwd, store.currentSessionId, chatHistory);
        store = loadContextStore(options.cwd);
        currentTurnController = null;
      } catch (error) {
        const wasInterrupted = currentTurnController?.signal.aborted === true;
        currentTurnController = null;
        // Ensure the transient thinking line does not linger on screen.
        clearTransientLine(stdout);

        if (wasInterrupted) {
          assistantBubble.end();
          stdout.write(`${t("repl.interrupted", lang)}\n`);
        } else {
          stderr.write(renderPanelMessage(t("repl.panel.error", lang), `${t("error.prefix", lang)} ${formatError(error, lang)}`));
        }
      }

      syncPrompt();
      if (!isClosed) readline.prompt();
    }
  } finally {
    if (persistentStatusArea) {
      persistentStatusArea.dispose({ clearViewport: exitReason === "interrupt" });
    } else if (exitReason === "interrupt") {
      clearInteractiveViewport(stdout);
    }
    readline.close();
  }

  if (exitReason === "interrupt") {
    stdout.write(t("repl.interrupted", lang) + "\n");
  } else if (exitReason === "quit") {
    stdout.write(t("repl.goodbye", lang) + "\n");
  }
}

async function maybeInitializeRepository(options: {
  cwd: string;
  inspectRepository: typeof inspectRepository;
  initializeRepository: typeof initializeRepository;
  lang: Language;
  output: NodeJS.WritableStream;
  readline: Interface;
}): Promise<{ isDirty: boolean; isRepository: boolean } | null> {
  const answer = (await options.readline.question(t("repl.repo_init.prompt", options.lang))).trim().toLowerCase();

  if (answer === "n" || answer === "no") {
    options.output.write(renderPanelMessage(t("repl.panel.workspace", options.lang), t("repl.repo_init.declined", options.lang)));
    return null;
  }

  if (!(answer === "y" || answer === "yes" || answer.length === 0)) {
    options.output.write(renderPanelMessage(t("repl.panel.workspace", options.lang), t("repl.repo_init.declined", options.lang)));
    return null;
  }

  try {
    const repositoryState = await options.initializeRepository(options.cwd);
    options.output.write(renderPanelMessage(t("repl.panel.workspace", options.lang), t("repl.repo_init.done", options.lang)));
    return repositoryState;
  } catch (error) {
    options.output.write(
      renderPanelMessage(
        t("repl.panel.workspace", options.lang),
        t("repl.repo_init.failed", options.lang, { message: formatError(error, options.lang) })
      )
    );
    return await options.inspectRepository(options.cwd);
  }
}

function looksLikeEngineeringIntent(input: string): boolean {
  const normalized = input.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  const patterns = [
    /\b(implement|build|create|scaffold|generate|write|edit|modify|refactor|fix|patch|add|remove|rename)\b/u,
    /\b(api|endpoint|project|app|feature|module|component|test|tests|bug|code|file|files|repository|repo)\b/u,
    /(瀹炵幇|缂栧啓|淇敼|閲嶆瀯|淇|鍒涘缓|鏂板缓|鎼缓|鐢熸垚|娣诲姞|鍒犻櫎|閲嶅懡鍚峾鎺ュ彛|椤圭洰|鍔熻兘|妯″潡|缁勪欢|娴嬭瘯|浠ｇ爜|鏂囦欢|浠撳簱)/u
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function formatExecutionProfileStatus(selection: ReplProfileSelection): string {
  const resolved = resolveReplModelProfile(selection);
  return `${formatModelFamily(selection.model)}/${selection.effect} -> ${resolved.model}/${resolved.reasoningEffort}`;
}

function formatModelFamily(model: ReplProfileSelection["model"]): "flash" | "pro" {
  return model === "deepseek-v4-flash" ? "flash" : "pro";
}

function resolveWorkspaceStatus(options: {
  cwd: string;
  requestedCwd?: string;
  workspaceMode?: "sandbox" | "full";
}): { mode: "sandbox" | "full"; path: string } | undefined {
  if (!options.workspaceMode) {
    return undefined;
  }

  return {
    mode: options.workspaceMode,
    path: path.resolve(options.requestedCwd ?? options.cwd)
  };
}

function buildPreparedFromReplResult(
  result: ReplTurnResult,
  instruction: string,
  profile: PreparedExecution["profile"]
): PreparedExecution {
  return {
    context: result.context,
    hasApiKey: true,
    instruction,
    parsedResponse: result.parsedResponse,
    profile,
    repositoryState: result.repositoryState,
    scanResult: result.scanResult,
    searchResults: result.searchResults,
    toolMutations: result.toolMutations,
    toolCallsUsed: result.toolCallsUsed
  };
}

import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

import { createStreamingChatBubbleWriter, renderChatBubble } from "./chat-bubble.js";
import {
  appendContextTurn,
  loadChatHistory,
  loadContextStore,
  loadDisplayHistory,
  listSessions,
  switchSession,
  updateChatHistory,
  updateDisplayHistory
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
import { detectEngineeringIntent } from "./intent.js";
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
import { applyBootstrapGuidance } from "./project-bootstrap.js";
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

function writeChat(
  persistentStatusArea: PersistentStatusArea | null,
  stdout: NodeJS.WritableStream,
  text: string
): void {
  if (persistentStatusArea) {
    persistentStatusArea.writeChatRaw(text);
  } else {
    stdout.write(text);
  }
}

function createChatPanelWriter(
  persistentStatusArea: PersistentStatusArea,
  fallback: NodeJS.WritableStream
): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
      persistentStatusArea.writeChatRaw(typeof chunk === "string" ? chunk : chunk.toString());
      callback();
    }
  });
}

export interface ReplDependencies extends RunEngineDependencies {
  applyPreparedExecution?: typeof applyPreparedExecution;
  confirmReplExecution?: typeof confirmReplExecution;
  detectEngineeringIntent?: typeof detectEngineeringIntent;
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
  const executeDetectEngineeringIntent = dependencies.detectEngineeringIntent ?? detectEngineeringIntent;
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
  let displayHistory: ChatMessage[] = loadDisplayHistory(store);
  let lastReasoningTrace = "";
  let lastTurnUsage: DeepSeekUsage | null = null;
  let lastTurnUsageProfile: ReplProfileSelection = { ...currentSelection };
  let currentTurnController: AbortController | null = null;
  const sessionUsageById = new Map<string, SessionUsageSnapshot>();
  let multilineCapture: MultilineCapture | null = null;
  let repositoryState: { isRepository: boolean; isDirty: boolean } = { isRepository: false, isDirty: false };
  let repoInitPromptInstruction: string | null = null;
  const gitCwd = options.requestedCwd ?? options.cwd;
  const ensureSessionUsage = (sessionId: string) => {
    if (!sessionUsageById.has(sessionId)) {
      sessionUsageById.set(sessionId, createSessionUsageSnapshot());
    }

    return sessionUsageById.get(sessionId)!;
  };
  ensureSessionUsage(store.currentSessionId);

  try {
    repositoryState = await (dependencies.inspectRepository ?? inspectRepository)(gitCwd);
  } catch {
    // Non-git directory: inspectRepository may throw; REPL works in chat-only mode
  }

  const isStdinTTY = (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true;

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
    renderWelcomeBanner: () => renderWelcomeBanner(lang, stdout),
    renderInputPanel: (_contentWidth: number) => ""
  }, lang);
  const syncPrompt = () => {
    readline.setPrompt(multilineCapture ? t("repl.prompt.multiline", lang) : t("repl.prompt", lang));
  };

  let isClosed = false;
  let exitReason = "eof";

  const onResize = () => {
    persistentStatusArea?.handleResize();
  };

  if (persistentStatusArea) {
    process.stdout.on("resize", onResize);
  }

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
    if (!repositoryState.isRepository && isStdinTTY) {
      try {
        const answer = (await readline.question(t("repl.repo_init.startup_prompt", lang))).trim().toLowerCase();
        if (answer === "y" || answer === "yes" || answer.length === 0) {
          await executeInitializeRepository(gitCwd);
          repositoryState = await (dependencies.inspectRepository ?? inspectRepository)(gitCwd);
          stdout.write(renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.done", lang)));
        } else {
          stdout.write(renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.declined", lang)));
        }
      } catch (error) {
        stdout.write(renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.failed", lang, { message: formatError(error, lang) })));
      }
    }

    if (persistentStatusArea) {
      persistentStatusArea.initialize();
    } else {
      stdout.write(renderWelcomeBanner(lang, stdout));
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
          writeChat(persistentStatusArea, stdout, t("cmd.multiline.canceled", lang) + "\n");
          if (!isClosed) readline.prompt();
          continue;
        }

        rawInput = completion.value ?? "";
      } else {
        const autoCapture = tryStartFenceMultilineCapture(rawInput);

        if (autoCapture) {
          multilineCapture = autoCapture;
          syncPrompt();
          writeChat(persistentStatusArea, stdout, t("cmd.multiline.started_fence", lang) + "\n");
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
          getDisplayHistory: () => displayHistory,
          setDisplayHistory: (next) => {
            displayHistory = next;
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
          renderWelcomeBanner: () => renderWelcomeBanner(lang, stdout)
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

      let effectiveInput = input;
      let repositoryJustInitialized = false;
      let repoInitJustAnswered = false;
      let displayUserMessage: string | null = null;

      if (repoInitPromptInstruction) {
        const storedInstruction = repoInitPromptInstruction;
        repoInitPromptInstruction = null;
        repoInitJustAnswered = true;
        const answer = input.trim().toLowerCase();

        if (answer === "n" || answer === "no") {
          writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.declined", lang)));
          effectiveInput = storedInstruction;
        } else if (answer === "y" || answer === "yes" || answer.length === 0) {
          try {
            await executeInitializeRepository(gitCwd);
            repositoryState = await (dependencies.inspectRepository ?? inspectRepository)(gitCwd);
            repositoryJustInitialized = true;
            persistentStatusArea?.refresh();
            writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.done", lang)));
          } catch (error) {
            writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.failed", lang, { message: formatError(error, lang) })));
            repositoryState = await (dependencies.inspectRepository ?? inspectRepository)(gitCwd);
          }
          effectiveInput = storedInstruction;
        } else {
          writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.declined", lang)));
          effectiveInput = storedInstruction;
        }
      }

      if (!repositoryState.isRepository) {
        if (!repoInitJustAnswered) {
        const intentDecision = await executeDetectEngineeringIntent(
          {
            conversationMessages: chatHistory,
            cwd: options.cwd,
            instruction: effectiveInput,
            profileSettings: resolveReplModelProfile(currentSelection)
          },
          {
            createClient: dependencies.createClient
          }
        );

        if (intentDecision.requiresWriteAccess) {
          writeChat(persistentStatusArea, stdout, renderChatBubble(t("repl.panel.user", lang), effectiveInput, persistentStatusArea?.getContentWidth()));
          displayUserMessage = effectiveInput;
          writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), t("repl.repo_init.prompt", lang)));
          repoInitPromptInstruction = effectiveInput;
          syncPrompt();
          if (!isClosed) readline.prompt();
          continue;
        } else {
          writeChat(persistentStatusArea, stdout, renderChatBubble(t("repl.panel.user", lang), effectiveInput, persistentStatusArea?.getContentWidth()));
          displayUserMessage = effectiveInput;
        }
        }
      } else {
        writeChat(persistentStatusArea, stdout, renderChatBubble(t("repl.panel.user", lang), input, persistentStatusArea?.getContentWidth()));
        displayUserMessage = input;
      }

      if (displayUserMessage) {
        displayHistory = [...displayHistory, { role: "user", content: displayUserMessage }];
      }

      const bootstrapGuidance = applyBootstrapGuidance({
        cwd: options.cwd,
        instruction: input,
        repositoryJustInitialized
      });

      if (bootstrapGuidance.notice) {
        writeChat(persistentStatusArea, stdout, renderPanelMessage(t("repl.panel.workspace", lang), bootstrapGuidance.notice));
      }

      effectiveInput = bootstrapGuidance.instruction;

      const thinkingStatus = createThinkingStatus(stdout, lang);
      const assistantBubble = createStreamingChatBubbleWriter(stdout, t("repl.panel.assistant", lang), persistentStatusArea?.getContentWidth());

      try {
        let reasoningAnnounced = false;
        let streamedContent = "";
        let streamedReasoning = "";
        let visibleAssistantMessage = "";

        thinkingStatus.start();
        writeChat(persistentStatusArea, stdout, `${t("repl.preflight", lang)}\n`);

        currentTurnController = new AbortController();

        const callbacks: ReplTurnCallbacks = {
          onContent: (chunk) => {
            streamedContent += chunk;
            visibleAssistantMessage += chunk;
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

        writeChat(persistentStatusArea, stdout, "\n");
        const result = await executeTurn(
          {
            conversationMessages: chatHistory,
            cwd: options.cwd,
            instruction: effectiveInput,
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
          writeChat(persistentStatusArea, stdout, `${t("repl.interrupted", lang)}\n`);
          currentTurnController = null;
          syncPrompt();
          if (!isClosed) readline.prompt();
          continue;
        }

        if (streamedContent.trim().length === 0 && result.parsedResponse.files.length === 0 && result.parsedResponse.summary.trim().length > 0) {
          assistantBubble.write(result.parsedResponse.summary);
          visibleAssistantMessage = result.parsedResponse.summary;
        }
        assistantBubble.end();

        writeChat(persistentStatusArea, stdout, "\n");
        lastReasoningTrace = streamedReasoning.trim();
        lastTurnUsage = result.usage;
        lastTurnUsageProfile = { ...currentSelection };

        if (lastReasoningTrace.length > 0) {
          writeChat(persistentStatusArea, stdout, `${t("repl.thoughts.hidden", lang)}\n`);
        }

        if (result.usage) {
          const sessionUsage = ensureSessionUsage(store.currentSessionId);
          sessionUsage.turnCount += 1;
          sessionUsage.usage = addUsage(sessionUsage.usage, result.usage);
          sessionUsage.estimatedCostUsd += estimateUsageCost(currentSelection.model, result.usage);
          writeChat(persistentStatusArea, stdout, `${formatUsageSummaryLine(currentSelection, result.usage)}\n`);
        }

        chatHistory = result.conversationMessages;
        if (visibleAssistantMessage.trim().length > 0) {
          displayHistory = [...displayHistory, { role: "assistant", content: visibleAssistantMessage }];
        }

        const hasChanges = result.parsedResponse.files.length > 0 || result.toolMutations.length > 0;

        if (hasChanges) {
          const confirmOutput = persistentStatusArea
            ? createChatPanelWriter(persistentStatusArea, stdout)
            : stdout;
          const confirmed = await confirmExec(result, {
            input: stdin,
            output: confirmOutput,
            lang
          }, readline);

          if (confirmed) {
            const prepared = buildPreparedFromReplResult(result, effectiveInput, resolveReplModelProfile(currentSelection));
            await executeApply(options.cwd, prepared, dependencies);
            writeChat(persistentStatusArea, stdout, t("confirm.accepted", lang) + "\n");
          } else {
            writeChat(persistentStatusArea, stdout, t("confirm.rejected", lang) + "\n");
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
        updateDisplayHistory(options.cwd, store.currentSessionId, displayHistory);
        store = loadContextStore(options.cwd);
        currentTurnController = null;
      } catch (error) {
        const wasInterrupted = currentTurnController?.signal.aborted === true;
        currentTurnController = null;
        thinkingStatus.stop();
        clearTransientLine(stdout);

        if (wasInterrupted) {
          assistantBubble.end();
          writeChat(persistentStatusArea, stdout, `${t("repl.interrupted", lang)}\n`);
        } else {
          const errorMsg = renderPanelMessage(t("repl.panel.error", lang), `${t("error.prefix", lang)} ${formatError(error, lang)}`);
          writeChat(persistentStatusArea, stderr, errorMsg);
        }
      }

      syncPrompt();
      if (!isClosed) readline.prompt();
    }
  } finally {
    process.stdout.off("resize", onResize);

    const shouldClearViewport = exitReason === "interrupt" || exitReason === "quit";

    if (persistentStatusArea) {
      persistentStatusArea.dispose({ clearViewport: shouldClearViewport });
    } else if (shouldClearViewport) {
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

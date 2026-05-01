import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";

import {
  appendContextTurn,
  loadChatHistory,
  loadContextStore,
  listSessions,
  startNewSession,
  switchSession,
  updateChatHistory
} from "./context-store.js";
import {
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
import type { ParsedFileChange } from "./llm/response-parser.js";
import {
  resolveReplModelProfile,
  resolveReplProfileSelection,
  type ReplProfileSelection,
  type ReplReasoningEffect
} from "./model-profile.js";
import { inspectPluginDiscovery } from "./plugins.js";
import { initializeRepository, inspectRepository } from "./project/git-manager.js";

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
  let currentSelection = resolveReplProfileSelection(options.profile);
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

    let pastedLineBuffer: string[] | null = null;

    for await (const line of readline) {
      let rawInput = line;

      if (
        (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY &&
        !multilineCapture &&
        (pastedLineBuffer || !rawInput.trimStart().startsWith("/"))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));

        const lineObjectStreamSymbol = Object.getOwnPropertySymbols(readline).find(
          (symbol) => String(symbol) === "Symbol(line object stream)"
        );
        const lineObjectStream = lineObjectStreamSymbol
          ? (readline as Interface & Record<PropertyKey, unknown>)[lineObjectStreamSymbol]
          : undefined;
        const watermarkDataSymbol =
          lineObjectStream && typeof lineObjectStream === "object"
            ? Object.getOwnPropertySymbols(lineObjectStream).find(
                (symbol) => String(symbol) === "Symbol(nodejs.watermarkData)"
              )
            : undefined;
        const watermarkData =
          watermarkDataSymbol && lineObjectStream && typeof lineObjectStream === "object"
            ? (lineObjectStream as Record<PropertyKey, unknown>)[watermarkDataSymbol]
            : undefined;
        const queuedLineCount =
          watermarkData &&
          typeof watermarkData === "object" &&
          "size" in watermarkData &&
          typeof watermarkData.size === "number"
            ? watermarkData.size
            : 0;
        const queuedByteCount = (stdin as NodeJS.ReadableStream & { readableLength?: number }).readableLength ?? 0;
        const hasQueuedInput = queuedLineCount + queuedByteCount > 0;

        if (pastedLineBuffer) {
          pastedLineBuffer.push(rawInput);

          if (hasQueuedInput) {
            syncPrompt();
            if (!isClosed) readline.prompt();
            continue;
          }

          rawInput = pastedLineBuffer.join("\n");
          pastedLineBuffer = null;
        } else if (hasQueuedInput) {
          pastedLineBuffer = [rawInput];
          syncPrompt();
          if (!isClosed) readline.prompt();
          continue;
        }
      }

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
        const toolNames: string[] = [];
        const toolProgressPrefix = "  ";

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
            profile: options.profile,
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
    /(实现|编写|修改|重构|修复|创建|新建|搭建|生成|添加|删除|重命名|接口|项目|功能|模块|组件|测试|代码|文件|仓库)/u
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

interface SlashCommandContext {
  cwd: string;
  input: NodeJS.ReadableStream;
  lang: Language;
  persistentStatusArea: PersistentStatusArea | null;
  readline: Interface;
  refreshStatusPanel: () => void;
  renderStatusPanel: () => string;
  renderWelcomeBanner: () => string;
  stderr: NodeJS.WritableStream;
  stdout: NodeJS.WritableStream;
  getStore: () => ReturnType<typeof loadContextStore>;
  setStore: (store: ReturnType<typeof loadContextStore>) => void;
  getChatHistory: () => ChatMessage[];
  setChatHistory: (history: ChatMessage[]) => void;
  getLastReasoningTrace: () => string;
  getLastTurnUsage: () => DeepSeekUsage | null;
  getLastTurnUsageProfile: () => ReplProfileSelection;
  getProfile: () => ReplProfileSelection;
  getSessionUsage: () => SessionUsageSnapshot;
  setProfile: (profile: ReplProfileSelection) => void;
  startMultilineCapture: () => void;
}

async function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext
): Promise<"quit" | void> {
  const [command, ...args] = input.split(/\s+/u);

  switch (command) {
    case "/quit":
    case "/exit":
      return "quit";

    case "/help":
      ctx.stdout.write(renderPanelText(t("repl.panel.commands", ctx.lang), [
        t("cmd.help.title", ctx.lang),
        t("cmd.help.new", ctx.lang),
        t("cmd.help.history", ctx.lang),
        t("cmd.help.sessions", ctx.lang),
        t("cmd.help.switch", ctx.lang),
        t("cmd.help.effect", ctx.lang),
        t("cmd.help.model", ctx.lang),
        t("cmd.help.cost", ctx.lang),
        t("cmd.help.multiline", ctx.lang),
        t("cmd.help.thoughts", ctx.lang),
        t("cmd.help.clear", ctx.lang),
        t("cmd.help.help", ctx.lang),
        t("cmd.help.quit", ctx.lang)
      ]));
      return;

    case "/new": {
      const nextStore = startNewSession(ctx.cwd);
      ctx.setStore(nextStore);
      ctx.setChatHistory([]);
      ctx.refreshStatusPanel();
      ctx.stdout.write(t("cmd.new.started", ctx.lang) + "\n");
      return;
    }

    case "/history": {
      const history = ctx.getChatHistory();

      if (history.length === 0) {
        ctx.stdout.write(t("cmd.history.empty", ctx.lang) + "\n");
        return;
      }

      for (const msg of history) {
        if (msg.role === "user") {
          const content = typeof msg.content === "string" ? msg.content : "";
          const preview = content.length > 120 ? `${content.slice(0, 120)}...` : content;
          ctx.stdout.write(`  user: ${preview}\n`);
        } else if (msg.role === "assistant") {
          const content = typeof msg.content === "string" ? msg.content : "";
          const preview = content.length > 120 ? `${content.slice(0, 120)}...` : content;
          ctx.stdout.write(`  assistant: ${preview}\n`);
        }
      }
      return;
    }

    case "/sessions": {
      const sessions = listSessions(ctx.getStore());

      if (sessions.length === 0) {
        ctx.stdout.write(t("cmd.sessions.empty", ctx.lang) + "\n");
        return;
      }

      for (const session of sessions) {
        const active = session.id === ctx.getStore().currentSessionId ? ` (${t("cmd.sessions.active", ctx.lang)})` : "";
        ctx.stdout.write(`  ${session.id}${active} - ${session.turnCount} ${t("cmd.sessions.turns", ctx.lang)}, ${t("cmd.sessions.last", ctx.lang)} ${session.updatedAt}\n`);
      }
      return;
    }

    case "/switch": {
      const sessionId = args[0];

      if (!sessionId) {
        ctx.stdout.write(t("cmd.switch.usage", ctx.lang) + "\n");
        return;
      }

      const nextStore = switchSession(ctx.cwd, sessionId);

      if (!nextStore) {
        ctx.stdout.write(`${t("cmd.switch.not_found", ctx.lang)} ${sessionId}\n`);
        return;
      }

      ctx.setStore(nextStore);
      ctx.setChatHistory(loadChatHistory(nextStore));
      ctx.refreshStatusPanel();
      ctx.stdout.write(`${t("cmd.switch.done", ctx.lang)} ${sessionId}\n`);
      return;
    }

    case "/effect": {
      const requestedProfile = parseExecutionProfile(args[0]);

      if (args[0] && !requestedProfile) {
        ctx.stdout.write(t("cmd.effect.invalid", ctx.lang, { value: args[0] }) + "\n");
        ctx.stdout.write(t("cmd.effect.usage", ctx.lang) + "\n");
        return;
      }

      const currentSelection = ctx.getProfile();
      const nextSelection = {
        ...currentSelection,
        effect: requestedProfile ?? getNextExecutionProfile(currentSelection.effect)
      };
      ctx.setProfile(nextSelection);
      ctx.refreshStatusPanel();

      const profile = resolveReplModelProfile(nextSelection);
      ctx.stdout.write(
        t("cmd.effect.changed", ctx.lang, {
          profile: nextSelection.effect,
          model: profile.model,
          reasoning: profile.reasoningEffort
        }) + "\n"
      );
      return;
    }

    case "/model": {
      const requestedModel = parseExecutionModel(args[0]);

      if (args[0] && !requestedModel) {
        ctx.stdout.write(t("cmd.model.invalid", ctx.lang, { value: args[0] }) + "\n");
        ctx.stdout.write(t("cmd.model.usage", ctx.lang) + "\n");
        return;
      }

      const nextModel = requestedModel ?? getNextExecutionModel(ctx.getProfile());
      const nextProfile = setExecutionModel(ctx.getProfile(), nextModel);
      ctx.setProfile(nextProfile);
      ctx.refreshStatusPanel();

      const profile = resolveReplModelProfile(nextProfile);
      ctx.stdout.write(
        t("cmd.model.changed", ctx.lang, {
          model: nextModel,
          profile: nextProfile.effect,
          reasoning: profile.reasoningEffort
        }) + "\n"
      );
      return;
    }

    case "/cost": {
      const sessionUsage = ctx.getSessionUsage();
      const latest = ctx.getLastTurnUsage();
      const latestProfile = ctx.getLastTurnUsageProfile();

      if (!sessionUsage.usage) {
        ctx.stdout.write(t("cmd.cost.empty", ctx.lang) + "\n");
        return;
      }

      ctx.stdout.write(
        renderPanelText(t("cmd.cost.title", ctx.lang), [
          `${t("repl.status.session", ctx.lang)}: ${ctx.getStore().currentSessionId}`,
          `${t("cmd.cost.turns", ctx.lang)}: ${sessionUsage.turnCount}`,
          ...formatUsageDetails(ctx.getProfile(), sessionUsage.usage, t("cmd.cost.session_total", ctx.lang), sessionUsage.estimatedCostUsd),
          ...(latest ? formatUsageDetails(latestProfile, latest, t("cmd.cost.last_turn", ctx.lang)) : [])
        ])
      );
      return;
    }

    case "/multiline":
      ctx.startMultilineCapture();
      ctx.stdout.write(t("cmd.multiline.started", ctx.lang) + "\n");
      return;

    case "/thoughts": {
      const trace = ctx.getLastReasoningTrace();

      if (trace.trim().length === 0) {
        ctx.stdout.write(`${t("repl.thoughts.empty", ctx.lang)}\n`);
        return;
      }

      ctx.persistentStatusArea?.suspend();
      try {
        await openThoughtTraceViewer(trace, ctx.lang, ctx.input, ctx.stdout, ctx.readline);
      } finally {
        ctx.persistentStatusArea?.resume();
      }
      return;
    }

    case "/clear":
      if (ctx.persistentStatusArea) {
        ctx.persistentStatusArea.clearBody();
        return;
      }

      if ((ctx.stdout as unknown as { isTTY?: boolean }).isTTY) {
        ctx.stdout.write("\x1B[2J\x1B[H");
        ctx.stdout.write(ctx.renderWelcomeBanner());
        ctx.stdout.write(ctx.renderStatusPanel());
      }
      return;

    default:
      ctx.stdout.write(t("cmd.unknown", ctx.lang, { command }) + "\n");
  }
}

export async function confirmReplExecution(
  result: ReplTurnResult,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; lang?: Language },
  existingReadline?: Interface
): Promise<boolean> {
  const lang = streams.lang ?? detectLanguage();
  const readline = existingReadline ?? createInterface({
    input: streams.input,
    output: streams.output
  });
  const shouldClose = !existingReadline;

  try {
    streams.output.write(renderPanelHeader(t("repl.panel.changes", lang)));
    streams.output.write(`${t("confirm.summary", lang)} ${result.parsedResponse.summary}\n`);

    if (result.parsedResponse.files.length > 0) {
      streams.output.write(t("confirm.files", lang) + "\n");

      for (const file of result.parsedResponse.files) {
        streams.output.write(`  [${file.action}] ${file.path}\n`);
      }
    }

    if (result.toolMutations.length > 0) {
      streams.output.write(t("confirm.tool_changes", lang) + "\n");

      for (const mutation of result.toolMutations) {
        streams.output.write(`  ${mutation.path}\n`);
      }
    }

    while (true) {
      const answer = (await readline.question(t("confirm.prompt", lang))).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no" || answer === "reject") {
        return false;
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewReplResultFiles(result, readline, streams.output, lang);

        if (reviewResult === "apply" || reviewResult === "skip") {
          return true;
        }

        if (reviewResult === "cancel") {
          return false;
        }

        continue;
      }

      streams.output.write(t("confirm.bad_choice", lang) + "\n");
    }
  } finally {
    if (shouldClose) {
      readline.close();
    }
  }
}

async function reviewReplResultFiles(
  result: ReplTurnResult,
  readline: Interface,
  output: NodeJS.WritableStream,
  lang: Language
): Promise<"apply" | "skip" | "cancel"> {
  const originalFiles = [...result.parsedResponse.files];
  const selectedFiles: typeof originalFiles = [];
  let applyAllRemaining = false;

  for (const file of originalFiles) {
    if (applyAllRemaining) {
      selectedFiles.push(file);
      continue;
    }

    output.write(`--- ${file.action.toUpperCase()} ${file.path} ---\n`);
    output.write(`${formatReviewDiff(file.diff, output)}\n`);
    output.write(`--- END ${file.path} ---\n`);

    while (true) {
      const answer = (await readline.question(t("review.file_prompt", lang))).trim().toLowerCase();

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

      if (answer === "q" || answer === "quit" || answer === "c" || answer === "cancel") {
        return "cancel";
      }
    }
  }

  result.parsedResponse.files = selectedFiles;
  output.write(t("review.selected", lang, { selected: selectedFiles.length, total: originalFiles.length }) + "\n");

  return selectedFiles.length > 0 ? "apply" : "skip";
}

async function openThoughtTraceViewer(
  trace: string,
  lang: Language,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  readline: Interface
): Promise<void> {
  const useAltScreen = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (useAltScreen) {
    output.write("\x1B[?1049h\x1B[2J\x1B[H");
  }

  output.write(`${t("repl.thoughts.title", lang)}\n`);
  output.write(`${"=".repeat(48)}\n\n`);
  output.write(`${trace}\n\n`);
  await waitForThoughtViewerExit(input, output, readline, lang);

  if (useAltScreen) {
    output.write("\x1B[?1049l");
  }
}

async function waitForThoughtViewerExit(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  readline: Interface,
  lang: Language
): Promise<void> {
  const rawInput = input as NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };

  if (rawInput.isTTY && typeof rawInput.setRawMode === "function") {
    emitKeypressEvents(input);
    rawInput.setRawMode(true);
    output.write(`${t("repl.thoughts.return", lang)} `);

    try {
      await new Promise<void>((resolve) => {
        const onKeypress = (_str: string, key: { name?: string; sequence?: string }) => {
          const isReturn = key.name === "return" || key.name === "enter";
          const isQuit = key.name === "q" || key.sequence?.toLowerCase() === "q";
          const isEscape = key.name === "escape" || key.sequence === "\u001b";

          if (!isReturn && !isQuit && !isEscape) {
            return;
          }

          input.off("keypress", onKeypress);
          output.write("\n");
          resolve();
        };

        input.on("keypress", onKeypress);
      });
    } finally {
      rawInput.setRawMode(false);
    }

    return;
  }

  await readline.question(`${t("repl.thoughts.return", lang)} `);
}

function createThinkingStatus(output: NodeJS.WritableStream, lang: Language) {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  const frames = [
    `${t("repl.thinking", lang)}   `,
    `${t("repl.thinking", lang)}.  `,
    `${t("repl.thinking", lang)}.. `,
    `${t("repl.thinking", lang)}...`
  ];
  let intervalId: NodeJS.Timeout | null = null;
  let frameIndex = 0;
  let started = false;
  let renderedWidth = 0;

  return {
    start() {
      if (started) {
        return;
      }

      started = true;

      if (!isInteractive) {
        output.write(`${frames[0]}\n`);
        renderedWidth = frames[0].length;
        return;
      }

      const render = () => {
        const frame = frames[frameIndex % frames.length];
        renderedWidth = Math.max(renderedWidth, frame.length);
        output.write(`\r${frame}`);
        frameIndex += 1;
      };

      render();
      intervalId = setInterval(render, 120);
    },
    stop(options?: { clearLine?: boolean }) {
      if (!started) {
        return;
      }

      started = false;

      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      if (options?.clearLine) {
        clearTransientLine(output, renderedWidth);
      }
    }
  };
}

function clearTransientLine(output: NodeJS.WritableStream, width?: number) {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (!isInteractive) {
    return;
  }

  const lineWidth = Math.max(width ?? 0, 24);
  output.write(`\r${" ".repeat(lineWidth)}\r`);
}

function clearInteractiveViewport(output: NodeJS.WritableStream) {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (!isInteractive) {
    return;
  }

  output.write("\x1B[r");
  output.write("\x1B[2J\x1B[H");
}

function renderStatusPanel(options: {
  hint: string;
  lang: Language;
  mode: string;
  profile: string;
  plugins?: string;
  sessionId: string;
  workspace?: string;
  workspacePath?: string;
  welcome: string;
}): string {
  const lines = [
    `${t("repl.status.ready", options.lang)}: ${options.welcome}`,
    `${t("repl.status.mode", options.lang)}: ${options.mode}`,
    `${t("repl.status.profile", options.lang)}: ${options.profile}`,
    `${t("repl.status.session", options.lang)}: ${options.sessionId}`,
    ...(options.plugins ? [`${t("repl.status.plugins", options.lang)}: ${options.plugins}`] : []),
    ...(options.workspace ? [`${t("repl.status.workspace", options.lang)}: ${options.workspace}`] : []),
    ...(options.workspacePath ? [`${t("repl.status.workspace_path", options.lang)}: ${options.workspacePath}`] : []),
    `${t("repl.status.hint", options.lang)}: ${options.hint}`
  ];

  return renderPanelText(t("repl.status.title", options.lang), lines);
}

function renderPanelHeader(title: string): string {
  return `+-- ${title} ${"-".repeat(Math.max(1, 58 - title.length))}+\n`;
}

function renderPanelText(title: string, lines: string[]): string {
  return `${renderPanelHeader(title)}${lines.join("\n")}\n`;
}

function renderPanelMessage(title: string, message: string): string {
  return renderPanelText(title, [message]);
}

interface PersistentStatusArea {
  clearBody: () => void;
  dispose: (options?: { clearViewport?: boolean }) => void;
  initialize: () => void;
  refresh: () => void;
  resume: () => void;
  suspend: () => void;
}

function createPersistentStatusArea(
  output: NodeJS.WritableStream,
  renderers: {
    renderStatusPanel: () => string;
    renderWelcomeBanner: () => string;
  }
): PersistentStatusArea | null {
  const interactiveOutput = output as NodeJS.WritableStream & { isTTY?: boolean; rows?: number };

  if (interactiveOutput.isTTY !== true) {
    return null;
  }

  let active = false;
  let lastStatusHeight = 0;

  const getTerminalRows = () => Math.max(interactiveOutput.rows ?? 24, 8);
  const getScrollTopRow = () => Math.min(lastStatusHeight + 1, getTerminalRows());

  const renderStatusLines = () => {
    const lines = splitRenderableLines(renderers.renderStatusPanel());
    const clearRows = Math.max(lastStatusHeight, lines.length);

    for (let index = 0; index < clearRows; index += 1) {
      output.write(`\x1B[${index + 1};1H\x1B[2K`);

      if (index < lines.length) {
        output.write(lines[index]);
      }
    }

    lastStatusHeight = lines.length;
  };

  const applyScrollRegion = () => {
    output.write(`\x1B[${getScrollTopRow()};${getTerminalRows()}r`);
  };

  const moveCursorToBody = (clearToEnd = false) => {
    output.write(`\x1B[${getScrollTopRow()};1H`);

    if (clearToEnd) {
      output.write("\x1B[J");
    }
  };

  return {
    initialize() {
      active = true;
      output.write("\x1B[2J\x1B[H");
      renderStatusLines();
      applyScrollRegion();
      moveCursorToBody(true);
      output.write(renderers.renderWelcomeBanner());
    },
    refresh() {
      if (!active) {
        return;
      }

      output.write("\x1B7");
      renderStatusLines();
      applyScrollRegion();
      output.write("\x1B8");
    },
    clearBody() {
      if (!active) {
        return;
      }

      output.write("\x1B[2J\x1B[H");
      renderStatusLines();
      applyScrollRegion();
      moveCursorToBody(true);
    },
    suspend() {
      if (!active) {
        return;
      }

      output.write("\x1B[r");
    },
    resume() {
      if (!active) {
        return;
      }

      output.write("\x1B7");
      renderStatusLines();
      applyScrollRegion();
      output.write("\x1B8");
    },
    dispose(options?: { clearViewport?: boolean }) {
      if (!active) {
        return;
      }

      output.write("\x1B[r");

      if (options?.clearViewport) {
        output.write("\x1B[2J\x1B[H");
      }

      active = false;
    }
  };
}

function splitRenderableLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;

  return trimmed.length > 0 ? trimmed.split("\n") : [""];
}

interface SessionUsageSnapshot {
  estimatedCostUsd: number;
  turnCount: number;
  usage: DeepSeekUsage | null;
}

interface MultilineCapture {
  delimiter?: string;
  kind: "fence" | "manual";
  lines: string[];
}

function createSessionUsageSnapshot(): SessionUsageSnapshot {
  return {
    estimatedCostUsd: 0,
    turnCount: 0,
    usage: null
  };
}

function addUsage(current: DeepSeekUsage | null, next: DeepSeekUsage | null): DeepSeekUsage | null {
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

function sumUsageField(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}

function formatPluginDiscoveryStatus(info: { enabledCount: number; errorCount: number }): string {
  if (info.errorCount > 0) {
    return `${info.enabledCount} enabled, ${info.errorCount} error${info.errorCount === 1 ? "" : "s"}`;
  }

  return `${info.enabledCount} enabled`;
}

function formatUsageSummaryLine(selection: ReplProfileSelection, usage: DeepSeekUsage): string {
  const estimatedCost = estimateUsageCost(selection.model, usage);
  return `[Usage] prompt=${formatTokenCount(getPromptUsageTokens(usage))} completion=${formatTokenCount(getCompletionUsageTokens(usage))} total=${formatTokenCount(usage.total_tokens)} est=${formatUsd(estimatedCost)}`;
}

function formatUsageDetails(
  selection: ReplProfileSelection,
  usage: DeepSeekUsage,
  label: string,
  estimatedCostOverride?: number
): string[] {
  const estimatedCost = estimatedCostOverride ?? estimateUsageCost(selection.model, usage);
  const promptTokens = getPromptUsageTokens(usage);
  const completionTokens = getCompletionUsageTokens(usage);

  return [
    `${label}: prompt=${formatTokenCount(promptTokens)}, completion=${formatTokenCount(completionTokens)}, total=${formatTokenCount(usage.total_tokens)}, est=${formatUsd(estimatedCost)}`,
    `${label} cache: hit=${formatTokenCount(usage.prompt_cache_hit_tokens)}, miss=${formatTokenCount(usage.prompt_cache_miss_tokens)}, reasoning=${formatTokenCount(usage.reasoning_tokens)}`
  ];
}

function getPromptUsageTokens(usage: DeepSeekUsage): number | undefined {
  return usage.prompt_tokens ?? sumUsageField(usage.prompt_cache_hit_tokens, usage.prompt_cache_miss_tokens);
}

function getCompletionUsageTokens(usage: DeepSeekUsage): number | undefined {
  if (usage.completion_tokens !== undefined) {
    return usage.completion_tokens;
  }

  if (usage.total_tokens !== undefined) {
    return Math.max(usage.total_tokens - (getPromptUsageTokens(usage) ?? 0), 0);
  }

  return undefined;
}

function estimateUsageCost(model: "deepseek-v4-pro" | "deepseek-v4-flash", usage: DeepSeekUsage): number {
  const pricing =
    model === "deepseek-v4-flash"
      ? {
          promptCacheHitPerMillion: 0.0028,
          promptCacheMissPerMillion: 0.14,
          completionPerMillion: 0.28
        }
      : {
          promptCacheHitPerMillion: 0.003625,
          promptCacheMissPerMillion: 0.435,
          completionPerMillion: 0.87
        };
  const promptCacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const promptCacheMissTokens =
    usage.prompt_cache_miss_tokens ??
    Math.max((usage.prompt_tokens ?? 0) - promptCacheHitTokens, 0);
  const completionTokens = getCompletionUsageTokens(usage) ?? 0;

  return (
    (promptCacheHitTokens / 1_000_000) * pricing.promptCacheHitPerMillion +
    (promptCacheMissTokens / 1_000_000) * pricing.promptCacheMissPerMillion +
    (completionTokens / 1_000_000) * pricing.completionPerMillion
  );
}

function formatTokenCount(value?: number): string {
  return value === undefined ? "-" : value.toLocaleString("en-US");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function createManualMultilineCapture(): MultilineCapture {
  return {
    kind: "manual",
    lines: []
  };
}

function tryStartFenceMultilineCapture(rawLine: string): MultilineCapture | null {
  const trimmed = rawLine.trim();

  if (!trimmed.startsWith("```")) {
    return null;
  }

  if (trimmed.indexOf("```", 3) !== -1) {
    return null;
  }

  return {
    kind: "fence",
    delimiter: "```",
    lines: [rawLine]
  };
}

function consumeMultilineCaptureLine(
  capture: MultilineCapture,
  rawLine: string
): { status: "canceled" | "complete" | "pending"; value?: string } {
  const trimmed = rawLine.trim();

  if (trimmed === ".cancel") {
    return { status: "canceled" };
  }

  if (capture.kind === "manual") {
    if (trimmed.length === 0) {
      return {
        status: "complete",
        value: capture.lines.join("\n")
      };
    }

    capture.lines.push(rawLine);
    return { status: "pending" };
  }

  capture.lines.push(rawLine);

  if (capture.delimiter && trimmed.startsWith(capture.delimiter) && capture.lines.length > 1) {
    return {
      status: "complete",
      value: capture.lines.join("\n")
    };
  }

  return { status: "pending" };
}

export function completeReplInput(line: string, options: { sessionIds: string[] }): [string[], string] {
  const commands = [
    "/new",
    "/history",
    "/sessions",
    "/switch",
    "/effect",
    "/model",
    "/cost",
    "/multiline",
    "/thoughts",
    "/clear",
    "/help",
    "/quit",
    "/exit"
  ];
  const trimmedStart = line.trimStart();

  if (!trimmedStart.startsWith("/")) {
    return [[], line];
  }

  if (trimmedStart.startsWith("/switch ")) {
    const current = trimmedStart.slice("/switch ".length);
    return [options.sessionIds.filter((id) => id.startsWith(current)), current];
  }

  if (trimmedStart.startsWith("/effect ")) {
    const current = trimmedStart.slice("/effect ".length);
    return [["low", "medium", "high", "xhigh"].filter((value) => value.startsWith(current)), current];
  }

  if (trimmedStart.startsWith("/model ")) {
    const current = trimmedStart.slice("/model ".length);
    return [["flash", "pro"].filter((value) => value.startsWith(current)), current];
  }

  return [commands.filter((command) => command.startsWith(trimmedStart)), trimmedStart];
}

function formatReviewDiff(diff: string, output: NodeJS.WritableStream): string {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (!isInteractive) {
    return diff;
  }

  return diff
    .split(/\r?\n/u)
    .map((line) => {
      if (line.startsWith("@@")) {
        return `\x1B[35m${line}\x1B[0m`;
      }

      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        return `\x1B[36m${line}\x1B[0m`;
      }

      if (line.startsWith("+")) {
        return `\x1B[32m${line}\x1B[0m`;
      }

      if (line.startsWith("-")) {
        return `\x1B[31m${line}\x1B[0m`;
      }

      return line;
    })
    .join("\n");
}

function parseExecutionProfile(value?: string): ReplReasoningEffect | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  return undefined;
}

function getNextExecutionProfile(effect: ReplReasoningEffect): ReplReasoningEffect {
  if (effect === "low") {
    return "medium";
  }

  if (effect === "medium") {
    return "high";
  }

  if (effect === "high") {
    return "xhigh";
  }

  return "low";
}

function parseExecutionModel(value?: string): "flash" | "pro" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "flash" || value === "pro") {
    return value;
  }

  return undefined;
}

function getCurrentExecutionModel(selection: ReplProfileSelection): "flash" | "pro" {
  return selection.model === "deepseek-v4-flash" ? "flash" : "pro";
}

function getNextExecutionModel(selection: ReplProfileSelection): "flash" | "pro" {
  return getCurrentExecutionModel(selection) === "flash" ? "pro" : "flash";
}

function setExecutionModel(selection: ReplProfileSelection, model: "flash" | "pro"): ReplProfileSelection {
  return {
    ...selection,
    model: model === "flash" ? "deepseek-v4-flash" : "deepseek-v4-pro"
  };
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

function renderChatBubble(title: string, message: string): string {
  const normalized = message.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [""];
  const body = lines.map((line) => `│ ${line}`).join("\n");

  return `╭─ ${title}\n${body}\n╰─\n`;
}

function createStreamingChatBubbleWriter(output: NodeJS.WritableStream, title: string) {
  let started = false;
  let lineStart = true;

  return {
    write(chunk: string) {
      if (!started) {
        output.write(`╭─ ${title}\n`);
        started = true;
      }

      const normalized = chunk.replace(/\r\n/g, "\n");

      for (const character of normalized) {
        if (lineStart) {
          output.write("│ ");
          lineStart = false;
        }

        output.write(character);

        if (character === "\n") {
          lineStart = true;
        }
      }
    },
    end() {
      if (!started) {
        return;
      }

      if (!lineStart) {
        output.write("\n");
      }

      output.write("╰─\n");
    }
  };
}

function renderWelcomeBanner(lang: Language): string {
  const title = t("repl.ready", lang);
  const blue = "\x1B[34m";
  const reset = "\x1B[0m";

  const art = [
    "      ⢀⣀⣀⢀⣀⣠⣤⡀  ⢠⣄",
    "  ⢀⣠⣶⣿⣿⣿⣿⣿⣿⣿⣯⡀  ⣿⣿⣷⣄⣀⣤⣤⣾⠆",
    " ⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣀⠘⣿⣿⣿⣿⣿⣿⡟",
    " ⣿⣿⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣬⣿⣿⡟⠛⠉",
    " ⣿⣿    ⠉⠻⣿⣿⣿⣿⣿⡏⢻⣿⣿⣿⣿⡇",
    " ⣿⣿⣆     ⠈⠻⣿⣿⣿⣷⣶⣿⣿⣿⡟",
    " ⠸⣿⣿⣦⡀  ⣀⣀ ⠙⢿⣿⣿⣿⣿⣿⡟",
    "  ⠘⢿⣿⣿⣦⣄⣹⣿⣿⣦⣈⠻⣿⣿⣿⣿⣤⡀",
    "    ⠉⠻⢿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠛⠛⠛⠁"
  ];

  const lines = art.map((line) => `  ${blue}${line}${reset}`);

  return [
    ...lines,
    "",
    `  ${title}`,
    ""
  ].join("\n");
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

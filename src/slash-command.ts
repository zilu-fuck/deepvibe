import { emitKeypressEvents } from "node:readline";
import type { Interface } from "node:readline/promises";

import {
  loadChatHistory,
  loadContextStore,
  listSessions,
  startNewSession,
  switchSession
} from "./context-store.js";
import { t, type Language } from "./i18n.js";
import type { ChatMessage, DeepSeekUsage } from "./llm/deepseek-client.js";
import {
  resolveReplModelProfile,
  type ReplProfileSelection,
  type ReplReasoningEffect
} from "./model-profile.js";
import type { PersistentStatusArea } from "./status.js";
import { renderPanelText } from "./status.js";
import { formatUsageDetails, type SessionUsageSnapshot } from "./usage.js";

export interface SlashCommandContext {
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

export async function handleSlashCommand(
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

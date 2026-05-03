import { emitKeypressEvents } from "node:readline";
import type { Interface } from "node:readline/promises";

import {
  loadChatHistory,
  loadDisplayHistory,
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
import { ANSI, visibleWidth, wrapLine } from "./tui-layout.js";
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
  getDisplayHistory: () => ChatMessage[];
  setDisplayHistory: (history: ChatMessage[]) => void;
  getLastReasoningTrace: () => string;
  getLastTurnUsage: () => DeepSeekUsage | null;
  getLastTurnUsageProfile: () => ReplProfileSelection;
  getProfile: () => ReplProfileSelection;
  getSessionUsage: () => SessionUsageSnapshot;
  setProfile: (profile: ReplProfileSelection) => void;
  startMultilineCapture: () => void;
}

function writeChat(ctx: SlashCommandContext, text: string): void {
  if (ctx.persistentStatusArea) {
    ctx.persistentStatusArea.writeChatRaw(text);
  } else {
    ctx.stdout.write(text);
  }
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
      writeChat(ctx, renderPanelText(t("repl.panel.commands", ctx.lang), [
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
      ctx.setDisplayHistory([]);
      ctx.refreshStatusPanel();
      writeChat(ctx, t("cmd.new.started", ctx.lang) + "\n");
      return;
    }

    case "/history": {
      const history = ctx.getDisplayHistory();

      if (history.length === 0) {
        writeChat(ctx, t("cmd.history.empty", ctx.lang) + "\n");
        return;
      }

      ctx.persistentStatusArea?.suspend();
      try {
        await openScrollableTextViewer({
          title: t("repl.history.title", ctx.lang),
          body: formatConversationHistory(history, ctx.lang),
          returnPrompt: t("repl.thoughts.return", ctx.lang),
          lang: ctx.lang,
          input: ctx.input,
          output: ctx.stdout,
          readline: ctx.readline
        });
      } finally {
        ctx.persistentStatusArea?.resume();
      }
      return;
    }

    case "/sessions": {
      const sessions = listSessions(ctx.getStore());

      if (sessions.length === 0) {
        writeChat(ctx, t("cmd.sessions.empty", ctx.lang) + "\n");
        return;
      }

      for (const session of sessions) {
        const active = session.id === ctx.getStore().currentSessionId ? ` (${t("cmd.sessions.active", ctx.lang)})` : "";
        writeChat(ctx, `  ${session.id}${active} - ${session.turnCount} ${t("cmd.sessions.turns", ctx.lang)}, ${t("cmd.sessions.last", ctx.lang)} ${session.updatedAt}\n`);
      }
      return;
    }

    case "/switch": {
      const sessionId = args[0];

      if (!sessionId) {
        writeChat(ctx, t("cmd.switch.usage", ctx.lang) + "\n");
        return;
      }

      const nextStore = switchSession(ctx.cwd, sessionId);

      if (!nextStore) {
        writeChat(ctx, `${t("cmd.switch.not_found", ctx.lang)} ${sessionId}\n`);
        return;
      }

      ctx.setStore(nextStore);
      ctx.setChatHistory(loadChatHistory(nextStore));
      ctx.setDisplayHistory(loadDisplayHistory(nextStore));
      ctx.refreshStatusPanel();
      writeChat(ctx, `${t("cmd.switch.done", ctx.lang)} ${sessionId}\n`);
      return;
    }

    case "/effect": {
      const requestedProfile = parseExecutionProfile(args[0]);

      if (args[0] && !requestedProfile) {
        writeChat(ctx, t("cmd.effect.invalid", ctx.lang, { value: args[0] }) + "\n");
        writeChat(ctx, t("cmd.effect.usage", ctx.lang) + "\n");
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
      writeChat(ctx,
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
        writeChat(ctx, t("cmd.model.invalid", ctx.lang, { value: args[0] }) + "\n");
        writeChat(ctx, t("cmd.model.usage", ctx.lang) + "\n");
        return;
      }

      const nextModel = requestedModel ?? getNextExecutionModel(ctx.getProfile());
      const nextProfile = setExecutionModel(ctx.getProfile(), nextModel);
      ctx.setProfile(nextProfile);
      ctx.refreshStatusPanel();

      const profile = resolveReplModelProfile(nextProfile);
      writeChat(ctx,
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
        writeChat(ctx, t("cmd.cost.empty", ctx.lang) + "\n");
        return;
      }

      writeChat(ctx,
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
      writeChat(ctx, t("cmd.multiline.started", ctx.lang) + "\n");
      return;

    case "/thoughts": {
      const trace = ctx.getLastReasoningTrace();

      if (trace.trim().length === 0) {
        writeChat(ctx, `${t("repl.thoughts.empty", ctx.lang)}\n`);
        return;
      }

      ctx.persistentStatusArea?.suspend();
      try {
        await openScrollableTextViewer({
          title: t("repl.thoughts.title", ctx.lang),
          body: trace,
          returnPrompt: t("repl.thoughts.return", ctx.lang),
          lang: ctx.lang,
          input: ctx.input,
          output: ctx.stdout,
          readline: ctx.readline
        });
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
      writeChat(ctx, t("cmd.unknown", ctx.lang, { command }) + "\n");
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

function formatConversationHistory(history: ChatMessage[], lang: Language): string {
  const sections: string[] = [];
  let visibleEntryCount = 0;

  for (const msg of history) {
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }

    visibleEntryCount += 1;
    const title = msg.role === "user" ? t("repl.panel.user", lang) : t("repl.panel.assistant", lang);
    const heading = `${title} ${visibleEntryCount}`;
    const content = (typeof msg.content === "string" ? msg.content : "") || "";

    sections.push(heading);
    sections.push("-".repeat(Math.max(12, visibleWidth(heading))));
    sections.push(content);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

async function openScrollableTextViewer(options: {
  title: string;
  body: string;
  returnPrompt: string;
  lang: Language;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  readline: Interface;
}): Promise<void> {
  const ttyOutput = options.output as NodeJS.WritableStream & {
    columns?: number;
    isTTY?: boolean;
    off?: (eventName: string, listener: (...args: never[]) => void) => void;
    on?: (eventName: string, listener: (...args: never[]) => void) => void;
    rows?: number;
  };
  const useAltScreen = ttyOutput.isTTY === true;
  const rawInput = options.input as NodeJS.ReadableStream & {
    addListener?: (eventName: string, listener: (...args: never[]) => void) => void;
    off?: (eventName: string, listener: (...args: never[]) => void) => void;
    listeners?: (eventName: string) => Array<(...args: never[]) => void>;
    on?: (eventName: string, listener: (...args: never[]) => void) => void;
    removeListener?: (eventName: string, listener: (...args: never[]) => void) => void;
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  let mouseTrackingEnabled = false;

  if (useAltScreen) {
    options.output.write("\x1B[?1049h");
  }

  try {
    if (rawInput.isTTY && typeof rawInput.setRawMode === "function") {
      const logicalLines = options.body.replace(/\r\n/g, "\n").split("\n");
      let scrollTop = 0;
      let wrappedWidth = getViewerContentWidth(Math.max(ttyOutput.columns ?? 80, 20));
      let wrappedLines = wrapViewerLines(logicalLines, wrappedWidth);
      let pendingMouseSequence = "";
      const suspendedKeypressListeners = [...(rawInput.listeners?.("keypress") ?? [])] as Array<(...args: never[]) => void>;

      emitKeypressEvents(options.input);
      for (const listener of suspendedKeypressListeners) {
        rawInput.removeListener?.("keypress", listener);
      }
      mouseTrackingEnabled = true;
      options.output.write("\x1B[?1000h\x1B[?1006h");
      rawInput.setRawMode(true);

      const render = () => {
        const termCols = Math.max(ttyOutput.columns ?? 80, 20);
        const termRows = Math.max(ttyOutput.rows ?? 24, 8);
        const contentHeight = Math.max(termRows - 3, 1);
        const contentWidth = getViewerContentWidth(termCols);
        if (contentWidth !== wrappedWidth) {
          wrappedWidth = contentWidth;
          wrappedLines = wrapViewerLines(logicalLines, wrappedWidth);
        }
        const maxScrollTop = Math.max(0, wrappedLines.length - contentHeight);
        scrollTop = Math.min(scrollTop, maxScrollTop);

        const visibleEnd = Math.min(scrollTop + contentHeight, wrappedLines.length);
        const position = `${scrollTop + 1}-${visibleEnd}/${wrappedLines.length}`;
        const controls = fitViewerLine(`${position} | ${t("repl.viewer.controls", options.lang)}`, termCols);
        const scrollbar = renderViewerScrollbar({
          contentHeight,
          currentScrollTop: scrollTop,
          totalLines: wrappedLines.length
        });

        options.output.write(ANSI.clearScreen);
        options.output.write(`${options.title}\n`);
        options.output.write(`${controls}\n`);
        options.output.write(`${"=".repeat(Math.max(16, Math.min(termCols, 48)))}\n`);

        for (let index = scrollTop; index < visibleEnd; index += 1) {
          const scrollbarChar = scrollbar[index - scrollTop] ?? " ";
          options.output.write(`${renderViewerContentLine(wrappedLines[index] ?? "", contentWidth, scrollbarChar)}\n`);
        }
      };

      const onResize = () => {
        render();
      };

      if (useAltScreen && typeof ttyOutput.on === "function") {
        ttyOutput.on("resize", onResize);
      }

      try {
        render();
        await new Promise<void>((resolve) => {
          const onData = (chunk: Buffer | string) => {
            const next = consumeViewerMouseInput(`${pendingMouseSequence}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`);
            pendingMouseSequence = next.remainder;

            if (!next.scroll) {
              return;
            }

            const contentHeight = Math.max((ttyOutput.rows ?? 24) - 3, 1);
            const maxScrollTop = Math.max(0, wrappedLines.length - contentHeight);
            scrollTop = next.scroll.direction === "up"
              ? Math.max(0, scrollTop - next.scroll.lines)
              : Math.min(maxScrollTop, scrollTop + next.scroll.lines);
            render();
          };

          const onKeypress = (_str: string, key: { name?: string; sequence?: string }) => {
            const sequence = key.sequence?.toLowerCase();
            const isReturn = key.name === "return" || key.name === "enter";
            const isQuit = key.name === "q" || sequence === "q";
            const isEscape = key.name === "escape" || key.sequence === "\u001b";

            if (isReturn || isQuit || isEscape) {
              options.input.off("keypress", onKeypress);
              rawInput.off?.("data", onData);
              resolve();
              return;
            }

            const nextScrollTop = getNextViewerScrollTop({
              contentHeight: Math.max((ttyOutput.rows ?? 24) - 3, 1),
              currentScrollTop: scrollTop,
              key,
              totalLines: wrappedLines.length
            });

            if (nextScrollTop === null || nextScrollTop === scrollTop) {
              return;
            }

            scrollTop = nextScrollTop;
            render();
          };

          options.input.on("keypress", onKeypress);
          rawInput.on?.("data", onData);
        });
      } finally {
        if (useAltScreen && typeof ttyOutput.off === "function") {
          ttyOutput.off("resize", onResize);
        }
        rawInput.setRawMode(false);
        for (const listener of suspendedKeypressListeners) {
          rawInput.addListener?.("keypress", listener);
        }
      }

      return;
    }

    if (useAltScreen) {
      options.output.write(ANSI.clearScreen);
    }

    options.output.write(`${options.title}\n`);
    options.output.write(`${"=".repeat(48)}\n\n`);
    options.output.write(`${options.body}\n\n`);
    options.output.write(`${options.returnPrompt}\n`);
  } finally {
    if (mouseTrackingEnabled) {
      options.output.write("\x1B[?1000l\x1B[?1006l");
    }

    if (useAltScreen) {
      options.output.write("\x1B[?1049l");
    }
  }
}

function consumeViewerMouseInput(value: string): {
  remainder: string;
  scroll: { direction: "up" | "down"; lines: number } | null;
} {
  let remainder = "";
  let scroll: { direction: "up" | "down"; lines: number } | null = null;
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf("\x1B[<", cursor);

    if (start === -1) {
      const trailingEscape = findTrailingMousePrefix(value.slice(cursor));
      remainder = trailingEscape ?? "";
      break;
    }

    const candidate = value.slice(start);
    const match = candidate.match(/^\x1B\[<(\d+);(\d+);(\d+)([mM])/u);

    if (match) {
      const parsed = parseMouseScrollReport(Number(match[1]));
      if (parsed) {
        scroll = parsed;
      }
      cursor = start + match[0].length;
      continue;
    }

    if (isIncompleteMouseSequence(candidate)) {
      remainder = candidate;
      break;
    }

    cursor = start + 1;
  }

  return { remainder, scroll };
}

function parseMouseScrollReport(button: number): { direction: "up" | "down"; lines: number } | null {
  const lines = 3;

  if (button === 64) {
    return { direction: "up", lines };
  }

  if (button === 65) {
    return { direction: "down", lines };
  }

  return null;
}

function isIncompleteMouseSequence(value: string): boolean {
  return /^\x1B\[<[\d;]*$/u.test(value) || value === "\x1B" || value === "\x1B[";
}

function findTrailingMousePrefix(value: string): string | null {
  for (const prefix of ["\x1B[<", "\x1B[", "\x1B"]) {
    const index = value.lastIndexOf(prefix);
    if (index !== -1 && isIncompleteMouseSequence(value.slice(index))) {
      return value.slice(index);
    }
  }

  return null;
}

function wrapViewerLines(lines: string[], width: number): string[] {
  const wrappedLines: string[] = [];

  for (const line of lines) {
    const wrapped = wrapLine(line, width);
    wrappedLines.push(...(wrapped.length > 0 ? wrapped : [""]));
  }

  return wrappedLines.length > 0 ? wrappedLines : [""];
}

function getViewerContentWidth(termCols: number): number {
  return Math.max(termCols - 1, 10);
}

function renderViewerContentLine(text: string, width: number, scrollbarChar: string): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(padding)}${scrollbarChar}`;
}

function renderViewerScrollbar(options: {
  contentHeight: number;
  currentScrollTop: number;
  totalLines: number;
}): string[] {
  if (options.totalLines <= options.contentHeight) {
    return Array.from({ length: options.contentHeight }, () => " ");
  }

  const track = Array.from({ length: options.contentHeight }, () => ".");
  const maxScrollTop = Math.max(0, options.totalLines - options.contentHeight);
  const thumbSize = Math.max(1, Math.round((options.contentHeight / options.totalLines) * options.contentHeight));
  const thumbTravel = Math.max(0, options.contentHeight - thumbSize);
  const thumbStart = maxScrollTop === 0
    ? 0
    : Math.round((options.currentScrollTop / maxScrollTop) * thumbTravel);

  for (let index = thumbStart; index < thumbStart + thumbSize; index += 1) {
    track[index] = "#";
  }

  return track;
}

function fitViewerLine(text: string, width: number): string {
  const wrapped = wrapLine(text, width);
  return wrapped[0] ?? "";
}

function getNextViewerScrollTop(options: {
  contentHeight: number;
  currentScrollTop: number;
  key: { name?: string; sequence?: string };
  totalLines: number;
}): number | null {
  const maxScrollTop = Math.max(0, options.totalLines - options.contentHeight);
  const pageSize = Math.max(options.contentHeight - 1, 1);
  const sequence = options.key.sequence?.toLowerCase();

  if (options.key.name === "up" || options.key.name === "k" || sequence === "k") {
    return Math.max(0, options.currentScrollTop - 1);
  }

  if (options.key.name === "down" || options.key.name === "j" || sequence === "j") {
    return Math.min(maxScrollTop, options.currentScrollTop + 1);
  }

  if (options.key.name === "pageup") {
    return Math.max(0, options.currentScrollTop - pageSize);
  }

  if (options.key.name === "pagedown" || options.key.name === "space" || sequence === " ") {
    return Math.min(maxScrollTop, options.currentScrollTop + pageSize);
  }

  if (options.key.name === "home") {
    return 0;
  }

  if (options.key.name === "end") {
    return maxScrollTop;
  }

  return null;
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


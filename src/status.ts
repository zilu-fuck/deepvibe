import { execFileSync } from "node:child_process";

import { t, type Language } from "./i18n.js";
import {
  ANSI,
  computeLayout,
  renderBoxBottom,
  renderBoxLine,
  renderBoxTop,
  visibleWidth,
  wrapLine,
  type TuiLayout
} from "./tui-layout.js";

export interface PersistentStatusArea {
  clearBody: () => void;
  dispose: (options?: { clearViewport?: boolean }) => void;
  initialize: () => void;
  refresh: () => void;
  resume: () => void;
  suspend: () => void;
  writeChatLine: (text: string) => void;
  writeChatRaw: (text: string) => void;
  redrawInputPanel: () => void;
  getLayout: () => TuiLayout;
  getContentWidth: () => number;
  handleResize: () => void;
}

export function createThinkingStatus(output: NodeJS.WritableStream, lang: Language) {
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

export function clearTransientLine(output: NodeJS.WritableStream, width?: number) {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (!isInteractive) {
    return;
  }

  const lineWidth = Math.max(width ?? 0, 24);
  output.write(`\r${" ".repeat(lineWidth)}\r`);
}

export function clearInteractiveViewport(output: NodeJS.WritableStream) {
  const isInteractive = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;

  if (!isInteractive) {
    return;
  }

  output.write(ANSI.clearScrollRegion);
  output.write(ANSI.clearScreen);
}

export function renderStatusPanel(options: {
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

  return lines.join("\n");
}

export function renderTuiStatusBox(
  title: string,
  contentLines: string[],
  width: number
): string {
  let result = renderBoxTop(title, width);

  for (const line of contentLines) {
    result += renderBoxLine(line, width);
  }

  result += renderBoxBottom(width);
  return result;
}

export function renderPanelHeader(title: string): string {
  return `┌─ ${title} ${"─".repeat(Math.max(1, 55 - title.length))}┐\n`;
}

export function renderPanelText(title: string, lines: string[]): string {
  return `${renderPanelHeader(title)}${lines.map((line) => `│ ${line}`).join("\n")}\n└${"─".repeat(58)}┘\n`;
}

export function renderPanelMessage(title: string, message: string): string {
  return renderPanelText(title, [message]);
}

export function createPersistentStatusArea(
  output: NodeJS.WritableStream,
  renderers: {
    renderStatusPanel: () => string;
    renderWelcomeBanner: () => string;
    renderInputPanel?: (contentWidth: number) => string;
  },
  lang: Language = "en"
): PersistentStatusArea | null {
  const interactiveOutput = output as NodeJS.WritableStream & { isTTY?: boolean; rows?: number; columns?: number };

  if (interactiveOutput.isTTY !== true) {
    return null;
  }

  let active = false;
  let layout: TuiLayout | null = null;
  let chatBuffer = renderers.renderWelcomeBanner();

  const getTermRows = () => Math.max(interactiveOutput.rows ?? 24, 12);
  const getTermCols = () => Math.max(interactiveOutput.columns ?? 80, 40);

  const getStatusContentLines = (): string[] => {
    const raw = renderers.renderStatusPanel();
    return splitRenderableLines(raw);
  };

  const computeCurrentLayout = (): TuiLayout => {
    const statusLines = getStatusContentLines();
    return computeLayout(getTermRows(), getTermCols(), statusLines.length);
  };

  const renderStatusBoxContent = (currentLayout: TuiLayout) => {
    const statusLines = getStatusContentLines();
    const title = t("repl.status.title", lang);
    const boxStr = renderTuiStatusBox(title, statusLines, currentLayout.contentWidth + 4);
    const lines = splitRenderableLines(boxStr);

    for (let i = 0; i < lines.length; i++) {
      output.write(ANSI.cursorTo(i + 1, 1));
      output.write(ANSI.clearLine);
      output.write(lines[i]!);
    }
  };

  const renderChatBoxBorders = (currentLayout: TuiLayout) => {
    const chatTitle = t("tui.chat.title", lang);
    const width = currentLayout.contentWidth + 4;

    output.write(ANSI.cursorTo(currentLayout.chatBox.topBorderRow, 1));
    output.write(ANSI.clearLine);
    output.write(renderBoxTop(chatTitle, width).trimEnd());

    output.write(ANSI.cursorTo(currentLayout.chatBox.bottomBorderRow, 1));
    output.write(ANSI.clearLine);
    output.write(renderBoxBottom(width).trimEnd());
  };

  const renderInputBoxContent = (currentLayout: TuiLayout) => {
    const inputTitle = t("tui.input.title", lang);
    const width = currentLayout.contentWidth + 4;
    const promptText = renderers.renderInputPanel
      ? renderers.renderInputPanel(currentLayout.contentWidth)
      : "";

    output.write(ANSI.cursorTo(currentLayout.inputBox.topBorderRow, 1));
    output.write(ANSI.clearLine);
    output.write(renderBoxTop(inputTitle, width).trimEnd());

    output.write(ANSI.cursorTo(currentLayout.inputBox.contentStartRow, 1));
    output.write(ANSI.clearLine);
    output.write(renderBoxLine(promptText, width).trimEnd());

    output.write(ANSI.cursorTo(currentLayout.inputBox.bottomBorderRow, 1));
    output.write(ANSI.clearLine);
    output.write(renderBoxBottom(width).trimEnd());
  };

  const applyScrollRegion = (currentLayout: TuiLayout) => {
    output.write(ANSI.scrollRegion(currentLayout.chatScrollTop, currentLayout.chatScrollBottom));
  };

  const moveCursorToChatBottom = (currentLayout: TuiLayout) => {
    output.write(ANSI.cursorTo(currentLayout.chatScrollBottom, 1));
  };

  const replayChatBuffer = () => {
    if (chatBuffer.length === 0) {
      return;
    }

    output.write(chatBuffer);
  };

  const renderAll = () => {
    layout = computeCurrentLayout();
    output.write(ANSI.clearScreen);
    renderStatusBoxContent(layout);
    renderChatBoxBorders(layout);
    renderInputBoxContent(layout);
    applyScrollRegion(layout);
    moveCursorToChatBottom(layout);
    replayChatBuffer();
  };

  return {
    initialize() {
      active = true;
      renderAll();
    },
    refresh() {
      if (!active || !layout) {
        return;
      }

      output.write(ANSI.saveCursor);
      renderStatusBoxContent(layout);
      renderInputBoxContent(layout);
      applyScrollRegion(layout);
      output.write(ANSI.restoreCursor);
    },
    clearBody() {
      if (!active || !layout) {
        return;
      }

      chatBuffer = "";

      output.write(ANSI.saveCursor);
      renderStatusBoxContent(layout);
      renderChatBoxBorders(layout);

      for (let row = layout.chatBox.contentStartRow; row <= layout.chatBox.contentEndRow; row++) {
        output.write(ANSI.cursorTo(row, 1));
        output.write(ANSI.clearLine);
      }

      renderInputBoxContent(layout);
      applyScrollRegion(layout);
      moveCursorToChatBottom(layout);
      output.write(ANSI.restoreCursor);
    },
    suspend() {
      if (!active) {
        return;
      }

      output.write(ANSI.clearScrollRegion);
    },
    resume() {
      if (!active || !layout) {
        return;
      }

      output.write(ANSI.saveCursor);
      renderAll();
      output.write(ANSI.restoreCursor);
    },
    writeChatLine(text: string) {
      if (!layout) {
        output.write(text + "\n");
        return;
      }

      const wrapped = wrapLine(text, layout.contentWidth);

      for (const line of wrapped) {
        output.write(line + "\n");
      }
    },
    writeChatRaw(text: string) {
      chatBuffer += text;
      output.write(text);
    },
    redrawInputPanel() {
      if (!active || !layout) {
        return;
      }

      output.write(ANSI.saveCursor);
      renderInputBoxContent(layout);
      applyScrollRegion(layout);
      output.write(ANSI.restoreCursor);
    },
    getLayout() {
      return layout ?? computeCurrentLayout();
    },
    getContentWidth() {
      return layout?.contentWidth ?? computeCurrentLayout().contentWidth;
    },
    handleResize() {
      if (!active) {
        return;
      }

      renderAll();
    },
    dispose(options?: { clearViewport?: boolean }) {
      if (!active) {
        return;
      }

      output.write(ANSI.clearScrollRegion);

      if (options?.clearViewport) {
        output.write(ANSI.clearScreen);
      }

      active = false;
    }
  };
}

export function formatPluginDiscoveryStatus(info: { enabledCount: number; errorCount: number }): string {
  if (info.errorCount > 0) {
    return `${info.enabledCount} enabled, ${info.errorCount} error${info.errorCount === 1 ? "" : "s"}`;
  }

  return `${info.enabledCount} enabled`;
}

const ASCII_BANNER_ART = [
  "  _________________________________________________ ",
  " /                                                 \\",
  "|                   DeepVibe                        |",
  "|               CLI coding workflow                 |",
  " \\_________________________________________________/"
];

const UNICODE_BANNER_ART = [
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

let cachedWindowsUtf8CodePage: boolean | null = null;

export function resetWelcomeBannerEncodingCacheForTest(): void {
  cachedWindowsUtf8CodePage = null;
}

export function renderWelcomeBanner(
  lang: Language,
  output: NodeJS.WritableStream = process.stdout
): string {
  const title = t("repl.ready", lang);
  const blue = "\x1B[34m";
  const reset = "\x1B[0m";
  const art = shouldUseUnicodeBanner(output) ? UNICODE_BANNER_ART : ASCII_BANNER_ART;

  const lines = art.map((line) => `  ${blue}${line}${reset}`);

  return [
    ...lines,
    "",
    `  ${title}`,
    ""
  ].join("\n");
}

function shouldUseUnicodeBanner(output: NodeJS.WritableStream): boolean {
  const mode = (process.env.DEEPVIBE_BANNER ?? "").trim().toLowerCase();

  if (mode === "ascii") {
    return false;
  }

  if (mode === "unicode" || mode === "utf8") {
    return true;
  }

  const ttyOutput = output as NodeJS.WritableStream & { isTTY?: boolean };

  if (ttyOutput.isTTY !== true) {
    return false;
  }

  const locale = [
    process.env.LANG ?? "",
    process.env.LC_ALL ?? "",
    process.env.LC_CTYPE ?? "",
    process.env.LC_MESSAGES ?? ""
  ].join(" ");

  if (/utf-?8/i.test(locale)) {
    return true;
  }

  return true;
}

function isWindowsUtf8CodePage(): boolean {
  if (cachedWindowsUtf8CodePage !== null) {
    return cachedWindowsUtf8CodePage;
  }

  try {
    const output = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "chcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    cachedWindowsUtf8CodePage = /\b65001\b/.test(output);
  } catch {
    cachedWindowsUtf8CodePage = false;
  }

  return cachedWindowsUtf8CodePage;
}

function splitRenderableLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;

  return trimmed.length > 0 ? trimmed.split("\n") : [""];
}

import { t, type Language } from "./i18n.js";

export interface PersistentStatusArea {
  clearBody: () => void;
  dispose: (options?: { clearViewport?: boolean }) => void;
  initialize: () => void;
  refresh: () => void;
  resume: () => void;
  suspend: () => void;
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

  output.write("\x1B[r");
  output.write("\x1B[2J\x1B[H");
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

  return renderPanelText(t("repl.status.title", options.lang), lines);
}

export function renderPanelHeader(title: string): string {
  return `+-- ${title} ${"-".repeat(Math.max(1, 58 - title.length))}+\n`;
}

export function renderPanelText(title: string, lines: string[]): string {
  return `${renderPanelHeader(title)}${lines.join("\n")}\n`;
}

export function renderPanelMessage(title: string, message: string): string {
  return renderPanelText(title, [message]);
}

export function createPersistentStatusArea(
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

export function formatPluginDiscoveryStatus(info: { enabledCount: number; errorCount: number }): string {
  if (info.errorCount > 0) {
    return `${info.enabledCount} enabled, ${info.errorCount} error${info.errorCount === 1 ? "" : "s"}`;
  }

  return `${info.enabledCount} enabled`;
}

export function renderWelcomeBanner(lang: Language): string {
  const title = t("repl.ready", lang);
  const blue = "\x1B[34m";
  const reset = "\x1B[0m";

  const art = [
    "      猗€猓€猓€猗€猓€猓犫￥狻€  猗犫",
    "  猗€猓犫６猓库？猓库？猓库？猓库／狻€  猓库？猓封猓€猓も￥猓锯爢",
    " 猗犫？猓库？猓库？猓库？猓库？猓库？猓库＆猓€鉅樷？猓库？猓库？猓库",
    " 猓库？鉅库牽鉅库？猓库？猓库？猓库？猓库？猓库＇猓？猓库鉅涒爥",
    " 猓库？    鉅夆牷猓库？猓库？猓库猗烩？猓库？猓库",
    " 猓库？猓?    鉅堚牷猓库？猓库７猓垛？猓库？狻?",
    " 鉅糕？猓库＆狻€  猓€猓€ 鉅欌⒖猓库？猓库？猓库",
    "  鉅樷⒖猓库？猓︹猓光？猓库＆猓堚牷猓库？猓库？猓も",
    "    鉅夆牷猗库？猓库？猓库？猓库】鉅熲牄鉅涒牄鉅涒爜"
  ];

  const lines = art.map((line) => `  ${blue}${line}${reset}`);

  return [
    ...lines,
    "",
    `  ${title}`,
    ""
  ].join("\n");
}

function splitRenderableLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;

  return trimmed.length > 0 ? trimmed.split("\n") : [""];
}

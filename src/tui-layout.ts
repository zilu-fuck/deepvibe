export interface Region {
  topBorderRow: number;
  contentStartRow: number;
  contentEndRow: number;
  bottomBorderRow: number;
}

export interface TuiLayout {
  statusBox: Region;
  chatBox: Region;
  inputBox: Region;
  chatScrollTop: number;
  chatScrollBottom: number;
  contentWidth: number;
}

export const ANSI = {
  cursorTo: (row: number, col: number) => `\x1B[${row};${col}H`,
  scrollRegion: (top: number, bottom: number) => `\x1B[${top};${bottom}r`,
  clearScrollRegion: "\x1B[r",
  clearLine: "\x1B[2K",
  clearToEnd: "\x1B[J",
  saveCursor: "\x1B7",
  restoreCursor: "\x1B8",
  clearScreen: "\x1B[2J\x1B[H"
} as const;

const MIN_CHAT_HEIGHT = 5;
const INPUT_PANEL_ROWS = 3;

export function computeLayout(termRows: number, termCols: number, statusLineCount: number): TuiLayout {
  const contentWidth = Math.max(termCols - 4, 10);
  const statusHeight = statusLineCount + 2;
  const inputTopRow = Math.max(termRows - INPUT_PANEL_ROWS + 1, statusHeight + MIN_CHAT_HEIGHT + 2);
  const chatTopRow = statusHeight + 1;
  const chatBottomRow = inputTopRow - 1;

  return {
    statusBox: {
      topBorderRow: 1,
      contentStartRow: 2,
      contentEndRow: 1 + statusLineCount,
      bottomBorderRow: statusHeight
    },
    chatBox: {
      topBorderRow: chatTopRow,
      contentStartRow: chatTopRow + 1,
      contentEndRow: chatBottomRow - 1,
      bottomBorderRow: chatBottomRow
    },
    inputBox: {
      topBorderRow: inputTopRow,
      contentStartRow: inputTopRow + 1,
      contentEndRow: inputTopRow + 1,
      bottomBorderRow: inputTopRow + 2
    },
    chatScrollTop: chatTopRow + 1,
    chatScrollBottom: chatBottomRow - 1,
    contentWidth
  };
}

export function renderBoxTop(title: string, width: number): string {
  const titleSegment = ` ${title} `;
  const titleVisibleWidth = visibleWidth(titleSegment);
  const dashCount = Math.max(1, width - 3 - titleVisibleWidth);
  return `┌─${titleSegment}${"─".repeat(dashCount)}┐\n`;
}

export function renderBoxBottom(width: number): string {
  return `└${"─".repeat(width - 2)}┘\n`;
}

export function renderBoxLine(text: string, width: number): string {
  const innerWidth = width - 4;
  const padded = padToVisibleWidth(text, innerWidth);
  return `│ ${padded} │\n`;
}

export function visibleWidth(str: string): number {
  let width = 0;
  let i = 0;

  while (i < str.length) {
    if (str.charCodeAt(i) === 0x1B && str[i + 1] === "[") {
      i += 2;

      while (i < str.length && str.charCodeAt(i) !== 0x6D) {
        i++;
      }

      i++;
      continue;
    }

    const code = str.codePointAt(i)!;
    width += isWideChar(code) ? 2 : 1;
    i += code > 0xFFFF ? 2 : 1;
  }

  return width;
}

export function wrapLine(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [text];
  }

  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;
  let i = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1B && text[i + 1] === "[") {
      let escape = "\x1B[";
      i += 2;

      while (i < text.length && text.charCodeAt(i) !== 0x6D) {
        escape += text[i];
        i++;
      }

      if (i < text.length) {
        escape += text[i];
        i++;
      }

      currentLine += escape;
      continue;
    }

    const code = text.codePointAt(i)!;
    const charWidth = isWideChar(code) ? 2 : 1;
    const char = code > 0xFFFF ? String.fromCodePoint(code) : text[i];

    if (currentWidth + charWidth > maxWidth && currentWidth > 0) {
      lines.push(currentLine);
      currentLine = "";
      currentWidth = 0;
    }

    currentLine += char;
    currentWidth += charWidth;
    i += code > 0xFFFF ? 2 : 1;
  }

  lines.push(currentLine);
  return lines;
}

function padToVisibleWidth(text: string, targetWidth: number): string {
  const currentWidth = visibleWidth(text);

  if (currentWidth >= targetWidth) {
    return truncateToVisibleWidth(text, targetWidth);
  }

  return text + " ".repeat(targetWidth - currentWidth);
}

function truncateToVisibleWidth(text: string, maxWidth: number): string {
  let width = 0;
  let i = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1B && text[i + 1] === "[") {
      i += 2;

      while (i < text.length && text.charCodeAt(i) !== 0x6D) {
        i++;
      }

      i++;
      continue;
    }

    const code = text.codePointAt(i)!;
    const charWidth = isWideChar(code) ? 2 : 1;

    if (width + charWidth > maxWidth) {
      break;
    }

    width += charWidth;
    i += code > 0xFFFF ? 2 : 1;
  }

  return text.slice(0, i);
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x2E80 && code <= 0x9FFF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE4F) ||
    (code >= 0x20000 && code <= 0x2A6DF) ||
    (code >= 0x2F800 && code <= 0x2FA1F)
  );
}

import { visibleWidth, wrapLine } from "./tui-layout.js";

export function renderChatBubble(title: string, message: string, maxWidth?: number): string {
  const normalized = message.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [""];

  if (maxWidth !== undefined) {
    const innerWidth = maxWidth - 2;
    const wrappedTitle = wrapLine(title, innerWidth);
    const titleLine = wrappedTitle[0] ?? title;
    const wrappedLines: string[] = [];

    for (const line of lines) {
      wrappedLines.push(...wrapLine(line, innerWidth));
    }

    const titleStr = `╭─ ${titleLine}`;
    const body = wrappedLines.map((line) => `│ ${line}`).join("\n");

    return `${titleStr}\n${body}\n╰─\n`;
  }

  const body = lines.map((line) => `│ ${line}`).join("\n");

  return `╭─ ${title}\n${body}\n╰─\n`;
}

export function createStreamingChatBubbleWriter(output: NodeJS.WritableStream, title: string, maxWidth?: number) {
  let started = false;
  let lineStart = true;
  let currentLineWidth = 0;
  const innerWidth = maxWidth !== undefined ? maxWidth - 2 : undefined;

  const writePrefix = () => {
    output.write("│ ");
    lineStart = false;
    currentLineWidth = 0;
  };

  return {
    write(chunk: string) {
      if (!started) {
        const titleLine = innerWidth !== undefined ? wrapLine(title, innerWidth)[0] ?? title : title;
        output.write(`╭─ ${titleLine}\n`);
        started = true;
      }

      const normalized = chunk.replace(/\r\n/g, "\n");

      for (const character of normalized) {
        if (lineStart) {
          writePrefix();
        }

        if (character === "\n") {
          output.write(character);
          lineStart = true;
          continue;
        }

        if (innerWidth !== undefined) {
          const charWidth = visibleWidth(character);

          if (currentLineWidth + charWidth > innerWidth) {
            output.write("\n");
            writePrefix();
          }

          currentLineWidth += charWidth;
        }

        output.write(character);
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

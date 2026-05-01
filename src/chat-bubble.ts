export function renderChatBubble(title: string, message: string): string {
  const normalized = message.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [""];
  const body = lines.map((line) => `│ ${line}`).join("\n");

  return `╭─ ${title}\n${body}\n╰─\n`;
}

export function createStreamingChatBubbleWriter(output: NodeJS.WritableStream, title: string) {
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

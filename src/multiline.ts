import type { Interface } from "node:readline/promises";

export interface MultilineCapture {
  delimiter?: string;
  kind: "fence" | "manual";
  lines: string[];
}

export interface PasteCaptureState {
  lineBuffer: string[] | null;
}

export async function coalescePastedInputLine(
  rawInput: string,
  options: {
    multilineActive: boolean;
    readline: Interface;
    state: PasteCaptureState;
    stdin: NodeJS.ReadableStream;
  }
): Promise<{ pending: boolean; rawInput: string }> {
  if (
    !(options.stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY ||
    options.multilineActive ||
    (!options.state.lineBuffer && rawInput.trimStart().startsWith("/"))
  ) {
    return { pending: false, rawInput };
  }

  await new Promise((resolve) => setTimeout(resolve, 30));

  const hasQueuedInput = hasQueuedReadlineOrStdinInput(options.readline, options.stdin);

  if (options.state.lineBuffer) {
    options.state.lineBuffer.push(rawInput);

    if (hasQueuedInput) {
      return { pending: true, rawInput };
    }

    const combinedInput = options.state.lineBuffer.join("\n");
    options.state.lineBuffer = null;
    return { pending: false, rawInput: combinedInput };
  }

  if (hasQueuedInput) {
    options.state.lineBuffer = [rawInput];
    return { pending: true, rawInput };
  }

  return { pending: false, rawInput };
}

export function createManualMultilineCapture(): MultilineCapture {
  return {
    kind: "manual",
    lines: []
  };
}

export function tryStartFenceMultilineCapture(rawLine: string): MultilineCapture | null {
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

export function consumeMultilineCaptureLine(
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

function hasQueuedReadlineOrStdinInput(readline: Interface, stdin: NodeJS.ReadableStream): boolean {
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

  return queuedLineCount + queuedByteCount > 0;
}

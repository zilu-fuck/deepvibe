import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { startRepl } from "../src/repl.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("REPL interrupt cleanup", () => {
  it("closes the streaming bubble when Ctrl+C interrupts a turn", async () => {
    const rootDir = createWorkspace();
    const stdin = createInputStream();
    const stdout = createWritableStream();
    const stderr = createWritableStream();

    const run = startRepl(
      { cwd: rootDir, profile: "default", lang: "en" },
      {
        stdin,
        stdout,
        stderr,
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        }),
        executeReplTurn: async (_options, dependencies, callbacks) => {
          callbacks?.onContent?.("partial");

          await new Promise<void>((resolve) => {
            dependencies?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });

          return {
            context: {
              messages: [],
              files: [],
              projectMetadata: "",
              tokenEstimate: 0,
              maxPromptTokens: 1,
              truncated: false
            },
            conversationMessages: [],
            parsedResponse: {
              files: [],
              summary: ""
            },
            repositoryState: {
              isRepository: true,
              isDirty: false,
              currentHead: "abc123"
            },
            scanResult: {
              candidates: [],
              explicitPaths: [],
              scannedFiles: 0
            },
            searchResults: [],
            toolCallsUsed: false,
            toolMutations: [],
            usage: null
          };
        }
      }
    );

    setTimeout(() => stdin.write("hello\n"), 50);
    setTimeout(() => stdin.write(Buffer.from([3])), 200);
    setTimeout(() => stdin.end("/quit\n"), 400);

    await run;

    const output = stdout.readAsString();
    expect(output).toContain("partial\n╰─\n\nSession interrupted. Type /quit to exit.");
    expect(stderr.readAsString()).toBe("");
  });

  it("clears the interactive viewport before the final Ctrl+C exit message", async () => {
    const rootDir = createWorkspace();
    const stdin = createInputStream();
    const stdout = createWritableStream();

    const run = startRepl(
      { cwd: rootDir, profile: "default", lang: "en" },
      {
        stdin,
        stdout,
        inspectRepository: async () => ({
          isRepository: true,
          isDirty: false,
          currentHead: "abc123"
        })
      }
    );

    setTimeout(() => stdin.end(Buffer.from([3])), 10);

    await run;

    const output = stdout.readAsString();
    expect(output).toContain("\x1B[r\x1B[2J\x1B[H");
    expect(output.match(/\x1B\[2J\x1B\[H/g)?.length).toBe(2);
    expect(output).toContain("Session interrupted. Type /quit to exit.");
  });
});

function createWorkspace(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-repl-interrupt-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function createInputStream() {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

function createWritableStream() {
  let buffer = "";

  const stream = new PassThrough() as PassThrough & NodeJS.WritableStream & {
    isTTY?: boolean;
    rows?: number;
    columns?: number;
    readAsString: () => string;
  };

  stream.isTTY = true;
  stream.rows = 24;
  stream.columns = 80;
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
  });
  stream.readAsString = () => buffer;

  return stream;
}

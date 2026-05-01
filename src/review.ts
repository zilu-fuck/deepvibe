import { createInterface, type Interface } from "node:readline/promises";

import { detectLanguage, t, type Language } from "./i18n.js";
import type { ReplTurnResult } from "./engine.js";
import { renderPanelHeader } from "./status.js";

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

export async function reviewReplResultFiles(
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

export function formatReviewDiff(diff: string, output: NodeJS.WritableStream): string {
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

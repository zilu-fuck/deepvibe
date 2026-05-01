import { createInterface } from "node:readline/promises";

import type { PreparedExecution, PlanStepResult } from "./engine.js";
import type { CommandApprovalRequest } from "./tools.js";

export async function confirmPlan(
  plan: { overview: string; steps: Array<{ index: number; description: string; files: string[]; estimatedChanges: string }>; notes: string },
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    while (true) {
      const answer = (await readline.question("Proceed with plan? [A]ccept [R]eject: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "r" || answer === "reject" || answer === "n" || answer === "no") {
        return false;
      }
    }
  } finally {
    readline.close();
  }
}

export async function confirmPlanStep(
  stepIndex: number,
  totalSteps: number,
  prepared: PreparedExecution,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`\n--- Step ${stepIndex}/${totalSteps} ---\n`);
    streams.output.write(`${formatPreparedExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Confirm apply? [A]ccept [S]kip [R]eview [N]o (stop plan): ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "s" || answer === "skip") {
        return false;
      }

      if (answer === "n" || answer === "no") {
        throw new Error("Plan execution stopped by user.");
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply") {
          return true;
        }

        if (reviewResult === "skip") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export function formatPlan(plan: { overview: string; steps: Array<{ index: number; description: string; files: string[]; estimatedChanges: string }>; notes: string }): string {
  const lines = [
    `Plan: ${plan.overview}`,
    ""
  ];

  for (const step of plan.steps) {
    lines.push(`  ${step.index}. ${step.description} (${step.estimatedChanges})`);
    lines.push(`     Files: ${step.files.join(", ") || "(none specified)"}`);
  }

  if (plan.notes) {
    lines.push("");
    lines.push(`Notes: ${plan.notes}`);
  }

  return lines.join("\n");
}

export function formatPlanResults(results: PlanStepResult[]): string {
  const completed = results.filter((r) => r.status === "completed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const lines = [
    `Plan execution complete: ${completed} completed, ${skipped} skipped, ${failed} failed`
  ];

  for (const result of results) {
    const icon = result.status === "completed" ? "done" : result.status === "skipped" ? "skip" : "fail";
    lines.push(`  ${icon} Step ${result.stepIndex}: ${result.summary}`);
  }

  return lines.join("\n");
}

export async function confirmPreparedExecution(
  prepared: PreparedExecution,
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`${formatPreparedExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Confirm apply? [A]ccept [R]eview [N]o: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no" || answer === "reject") {
        return false;
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply" || reviewResult === "skip") {
          return true;
        }

        if (reviewResult === "cancel") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export async function confirmLandingPreparedExecution(
  prepared: PreparedExecution,
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`${formatLandingExecutionSummary(prepared)}\n`);

    while (true) {
      const answer = (await readline.question("Land sandbox changes to the real workspace? [A]ccept [R]eview [N]o: ")).trim().toLowerCase();

      if (answer === "a" || answer === "accept" || answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no" || answer === "reject") {
        return false;
      }

      if (answer === "r" || answer === "review") {
        const reviewResult = await reviewPreparedExecutionFiles(prepared, readline, streams.output);

        if (reviewResult === "apply" || reviewResult === "skip") {
          return true;
        }

        if (reviewResult === "cancel") {
          return false;
        }
      }
    }
  } finally {
    readline.close();
  }
}

export function formatPreparedExecutionSummary(prepared: PreparedExecution): string {
  const lines = [
    `Planned changes: ${prepared.parsedResponse.files.length} file(s)`,
    `Summary: ${prepared.parsedResponse.summary}`,
    "Files:"
  ];

  for (const file of prepared.parsedResponse.files) {
    const stats = countDiffLines(file.diff);
    lines.push(`- [${file.action}] ${file.path} (+${stats.additions} -${stats.deletions})`);
  }

  return lines.join("\n");
}

export function formatLandingExecutionSummary(prepared: PreparedExecution): string {
  const lines = [
    "=== Sandbox Landing Review ===",
    "These are the actual file changes that will be written back from the sandbox copy into the real workspace.",
    `Landing changes: ${prepared.parsedResponse.files.length} file(s)`,
    `Summary: ${prepared.parsedResponse.summary}`,
    "Files:"
  ];

  for (const file of prepared.parsedResponse.files) {
    const stats = countDiffLines(file.diff);
    lines.push(`- [${file.action}] ${file.path} (+${stats.additions} -${stats.deletions})`);
  }

  return lines.join("\n");
}

export function formatPreparedExecutionDiffs(prepared: PreparedExecution): string {
  const sections: string[] = [];

  for (const file of prepared.parsedResponse.files) {
    sections.push(`--- ${file.action.toUpperCase()} ${file.path} ---`);
    sections.push(file.diff);
    sections.push(`--- END ${file.path} ---`);
  }

  return sections.join("\n");
}

export async function reviewPreparedExecutionFiles(
  prepared: PreparedExecution,
  readline: ReturnType<typeof createInterface>,
  output: NodeJS.WritableStream
): Promise<"apply" | "skip" | "cancel"> {
  const originalFiles = [...prepared.parsedResponse.files];
  const selectedFiles: PreparedExecution["parsedResponse"]["files"] = [];
  let applyAllRemaining = false;

  for (const file of originalFiles) {
    if (applyAllRemaining) {
      selectedFiles.push(file);
      continue;
    }

    output.write(`--- ${file.action.toUpperCase()} ${file.path} ---\n`);
    output.write(`${file.diff}\n`);
    output.write(`--- END ${file.path} ---\n`);

    while (true) {
      const answer = (await readline.question("Apply this file? [Y]es [S]kip [A]ll remaining [Q]uit: ")).trim().toLowerCase();

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

      if (answer === "q" || answer === "quit" || answer === "c" || answer === "cancel" || answer === "r" || answer === "reject") {
        return "cancel";
      }
    }
  }

  prepared.parsedResponse.files = selectedFiles;
  output.write(`Selected ${selectedFiles.length} of ${originalFiles.length} file(s) for apply.\n`);

  return selectedFiles.length > 0 ? "apply" : "skip";
}

export async function confirmCommandExecution(
  request: CommandApprovalRequest,
  streams: {
    allowPersistentApproval?: boolean;
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }
): Promise<"approve_once" | "approve_and_remember" | "deny"> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });

  try {
    streams.output.write(`Tool wants to run a command.\n`);
    streams.output.write(`Working directory: ${request.cwd}\n`);
    streams.output.write(`Command: ${request.command}\n`);
    streams.output.write(`Risk: ${request.risk}\n`);

    while (true) {
      const prompt =
        request.risk === "low"
          ? streams.allowPersistentApproval
            ? "Allow low-risk command? [Y]es once [A]lways [N]o: "
            : "Allow low-risk command? [Y]es [N]o: "
          : request.risk === "medium"
            ? "Allow medium-risk command once? [Y]es [N]o: "
            : 'High-risk command. Type "allow" to continue or [N]o: ';
      const answer = (await readline.question(prompt)).trim().toLowerCase();

      if (request.risk === "high") {
        if (answer === "allow") {
          return "approve_once";
        }

        if (answer === "n" || answer === "no") {
          return "deny";
        }

        continue;
      }

      if (request.risk === "low" && streams.allowPersistentApproval && (answer === "a" || answer === "always")) {
        return "approve_and_remember";
      }

      if (answer === "y" || answer === "yes") {
        return "approve_once";
      }

      if (answer === "n" || answer === "no") {
        return "deny";
      }
    }
  } finally {
    readline.close();
  }
}

export function ensureInteractiveConfirmationAvailable(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): void {
  if (!("isTTY" in input) || !input.isTTY || !("isTTY" in output) || !output.isTTY) {
    throw new Error("Interactive confirmation requires a TTY. Re-run with --force to skip confirmation.");
  }
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

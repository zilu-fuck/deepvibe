import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { composeSystemPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { ContextMessage, estimateLooseMessageTokens, estimateMessageTokens, estimateMessagesTokens, estimateTextTokens } from "./token-counter.js";
import type { WebSearchResult } from "../search.js";
import { buildContextSearchSection } from "../search.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEFAULT_RESPONSE_RESERVE_TOKENS = 64_000;
const DEFAULT_MAX_FILES = 12;
export interface BuildContextOptions {
  rootDir: string;
  historySummary?: string;
  instruction: string;
  candidates: string[];
  explicitPaths?: string[];
  maxWindowTokens?: number;
  maxFiles?: number;
  projectPrompt?: string;
  reservedResponseTokens?: number;
  searchResults?: WebSearchResult[];
  systemPrompt?: string;
  topLevelEntryLimit?: number;
}

export interface ContextFile {
  path: string;
  content: string;
  mode: "full" | "compact" | "outline" | "truncated";
  tokenEstimate: number;
}

export interface BuildContextResult {
  messages: ContextMessage[];
  files: ContextFile[];
  projectMetadata: string;
  tokenEstimate: number;
  maxPromptTokens: number;
  truncated: boolean;
}

interface FileDraft {
  path: string;
  explicit: boolean;
  rawText: string;
}

export function buildContext(options: BuildContextOptions): BuildContextResult {
  const rootDir = path.resolve(options.rootDir);
  const explicitPaths = new Set((options.explicitPaths ?? []).map(normalizeRelativePath));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const uniqueCandidates = dedupe(
    options.candidates.map(normalizeRelativePath).slice(0, maxFiles)
  );
  const fileDrafts = uniqueCandidates
    .map((filePath) => loadFileDraft(rootDir, filePath, explicitPaths.has(filePath)))
    .filter((draft): draft is FileDraft => draft !== null);
  let projectMetadata = buildProjectMetadata(rootDir, options.topLevelEntryLimit ?? 12);
  const maxPromptTokens =
    (options.maxWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS) -
    (options.reservedResponseTokens ?? DEFAULT_RESPONSE_RESERVE_TOKENS);

  const systemMessage: ContextMessage = {
    role: "system",
    content: composeSystemPrompt(options.systemPrompt ?? SYSTEM_PROMPT, options.projectPrompt)
  };
  let metadataMessage: ContextMessage = {
    role: "user",
    content: projectMetadata
  };
  let baseTokens = estimateMessagesTokens([systemMessage, metadataMessage]);

  if (baseTokens > maxPromptTokens) {
    projectMetadata = buildMinimalProjectMetadata(rootDir);
    metadataMessage = {
      role: "user",
      content: projectMetadata
    };
    baseTokens = estimateMessagesTokens([systemMessage, metadataMessage]);
  }

  const emptyTaskTokens = estimateMessageTokens({
    role: "user",
    content: buildTaskMessage(options.instruction, [], options.searchResults ?? [], options.historySummary)
  });
  const availableFileTokens = Math.max(0, maxPromptTokens - baseTokens - emptyTaskTokens);
  let files = renderFiles(fileDrafts, "full");

  if (availableFileTokens === 0) {
    files = [];
  } else if (estimateRenderedFilesTokens(files, options.instruction, options.searchResults ?? []) > availableFileTokens) {
    files = renderFiles(fileDrafts, "compact");
  }

  if (estimateRenderedFilesTokens(files, options.instruction, options.searchResults ?? []) > availableFileTokens) {
    files = renderFiles(fileDrafts, "outline");
  }

  if (estimateRenderedFilesTokens(files, options.instruction, options.searchResults ?? []) > availableFileTokens) {
    files = dropNonExplicitFiles(files, explicitPaths);
  }

  if (estimateRenderedFilesTokens(files, options.instruction, options.searchResults ?? []) > availableFileTokens) {
    files = truncateFilesToBudget(files, availableFileTokens, options.instruction);
  }

  if (estimateRenderedFilesTokens(files, options.instruction, options.searchResults ?? []) > availableFileTokens) {
    files = forceFitFilesToBudget(
      files,
      explicitPaths,
      availableFileTokens,
      options.instruction,
      options.searchResults ?? []
    );
  }

  const taskMessage: ContextMessage = {
    role: "user",
    content: buildTaskMessage(options.instruction, files, options.searchResults ?? [], options.historySummary)
  };
  const messages = [systemMessage, metadataMessage, taskMessage];
  const tokenEstimate = estimateMessagesTokens(messages);

  return {
    messages,
    files,
    projectMetadata,
    tokenEstimate,
    maxPromptTokens,
    truncated: files.some((file) => file.mode !== "full")
  };
}

function loadFileDraft(rootDir: string, filePath: string, explicit: boolean): FileDraft | null {
  const absolutePath = path.join(rootDir, filePath);

  if (!existsSync(absolutePath)) {
    return null;
  }

  return {
    path: filePath,
    explicit,
    rawText: readFileSync(absolutePath, "utf8")
  };
}

function buildProjectMetadata(rootDir: string, topLevelEntryLimit: number): string {
  const entries = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => ![".git", "node_modules", "dist", "build"].includes(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, topLevelEntryLimit)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);

  return [
    "项目元信息：",
    `- 根目录: ${path.basename(rootDir)}`,
    "- 顶层结构：",
    ...entries.map((entry) => `  - ${entry}`)
  ].join("\n");
}

function buildMinimalProjectMetadata(rootDir: string): string {
  return ["项目元信息：", `- 根目录: ${path.basename(rootDir)}`].join("\n");
}

function renderFiles(fileDrafts: FileDraft[], mode: ContextFile["mode"]): ContextFile[] {
  return fileDrafts.map((draft) => {
    const content =
      mode === "full"
        ? draft.rawText
        : mode === "compact"
          ? compactText(draft.rawText)
          : mode === "outline"
            ? outlineText(draft.rawText)
            : draft.rawText;

    return {
      path: draft.path,
      content,
      mode,
      tokenEstimate: estimateTextTokens(content)
    };
  });
}

function compactText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        return false;
      }

      return !(
        trimmed.startsWith("//") ||
        trimmed === "/*" ||
        trimmed === "*/" ||
        trimmed.startsWith("*")
      );
    })
    .join("\n");
}

function outlineText(text: string): string {
  const lines = compactText(text).split(/\r?\n/u);
  const structural = lines.filter((line) => {
    const trimmed = line.trim();

    return (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("function ") ||
      trimmed.startsWith("interface ") ||
      trimmed.startsWith("type ") ||
      trimmed.startsWith("enum ") ||
      trimmed.startsWith("const ") ||
      trimmed.startsWith("let ") ||
      trimmed.startsWith("var ") ||
      trimmed.startsWith("async ") ||
      trimmed.includes("=>") ||
      trimmed.endsWith("{")
    );
  });

  const selectedLines = structural.length > 0 ? structural : lines.slice(0, 20);

  return selectedLines.join("\n");
}

function dropNonExplicitFiles(files: ContextFile[], explicitPaths: Set<string>): ContextFile[] {
  const kept: ContextFile[] = [];

  for (const file of files) {
    if (explicitPaths.has(file.path)) {
      kept.push(file);
    }
  }

  if (kept.length > 0) {
    return kept;
  }

  return files.slice(0, 1);
}

function truncateFilesToBudget(
  files: ContextFile[],
  availableFileTokens: number,
  instruction: string
): ContextFile[] {
  if (files.length === 0) {
    return files;
  }

  const instructionTokens = estimateTextTokens(instruction);
  const perFileBudget = Math.floor(Math.max(availableFileTokens - instructionTokens, 0) / files.length);

  return files.map((file) => {
    if (file.tokenEstimate <= perFileBudget) {
      return file;
    }

    return truncateFile(file, perFileBudget);
  });
}

function forceFitFilesToBudget(
  files: ContextFile[],
  explicitPaths: Set<string>,
  availableFileTokens: number,
  instruction: string,
  searchResults: WebSearchResult[]
): ContextFile[] {
  let fitted = [...files];
  let maxIterations = fitted.length * 2 + 5;

  while (fitted.length > 0 && estimateRenderedFilesTokens(fitted, instruction, searchResults) > availableFileTokens) {
    if (maxIterations-- <= 0) {
      break;
    }

    const overflow = estimateRenderedFilesTokens(fitted, instruction, searchResults) - availableFileTokens;
    const dropIndex = findLastNonExplicitIndex(fitted, explicitPaths);

    if (dropIndex >= 0 && fitted.length > 1) {
      fitted = fitted.filter((_, index) => index !== dropIndex);
      continue;
    }

    const largestIndex = findLargestFileIndex(fitted);
    const targetTokens = Math.max(8, fitted[largestIndex].tokenEstimate - overflow - 8);
    const nextFile = truncateFile(fitted[largestIndex], targetTokens);

    if (nextFile.tokenEstimate >= fitted[largestIndex].tokenEstimate) {
      break;
    }

    fitted = fitted.map((file, index) => (index === largestIndex ? nextFile : file));
  }

  return fitted;
}

function findLargestFileIndex(files: ContextFile[]): number {
  let largestIndex = 0;

  for (let index = 1; index < files.length; index += 1) {
    if (files[index].tokenEstimate > files[largestIndex].tokenEstimate) {
      largestIndex = index;
    }
  }

  return largestIndex;
}

function findLastNonExplicitIndex(files: ContextFile[], explicitPaths: Set<string>): number {
  for (let index = files.length - 1; index >= 0; index -= 1) {
    if (!explicitPaths.has(files[index].path)) {
      return index;
    }
  }

  return -1;
}

function truncateFile(file: ContextFile, targetTokens: number): ContextFile {
  if (targetTokens <= 16) {
    const content = "[omitted by context builder due to prompt budget]";

    return {
      path: file.path,
      content,
      mode: "truncated",
      tokenEstimate: estimateTextTokens(content)
    };
  }

  const targetChars = Math.max(32, targetTokens * 4);
  const head = file.content.slice(0, Math.floor(targetChars * 0.6));
  const tail = file.content.slice(-Math.floor(targetChars * 0.3));
  const content = `${head}\n... [truncated by context builder] ...\n${tail}`;

  return {
    path: file.path,
    content,
    mode: "truncated",
    tokenEstimate: estimateTextTokens(content)
  };
}

function estimateRenderedFilesTokens(
  files: ContextFile[],
  instruction: string,
  searchResults: WebSearchResult[]
): number {
  return estimateMessageTokens({
    role: "user",
    content: buildTaskMessage(instruction, files, searchResults, undefined)
  });
}

function buildTaskMessage(
  instruction: string,
  files: ContextFile[],
  searchResults: WebSearchResult[],
  historySummary: string | undefined
): string {
  const sections = [
    "当前任务：",
    instruction,
    "",
    "相关文件："
  ];

  if (historySummary) {
    sections.push(historySummary);
    sections.push("");
  }

  for (const file of files) {
    sections.push(`--- FILE: ${file.path} [mode=${file.mode}] ---`);
    sections.push(file.content);
    sections.push(`--- END FILE: ${file.path} ---`);
    sections.push("");
  }

  if (searchResults.length > 0) {
    sections.push(buildContextSearchSection(searchResults));
  }

  return sections.join("\n");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

export function compressHistoryMessages<T extends { content?: string | null; role: string }>(
  messages: T[],
  maxPromptTokens: number,
  keepRecentRounds: number = 3
): T[] {
  const fixedCount = Math.min(2, messages.length);
  const fixed = messages.slice(0, fixedCount);
  const history = messages.slice(fixedCount);

  if (history.length === 0) {
    return messages;
  }

  const fixedTokens = fixed.reduce((sum, msg) => sum + estimateLooseMessageTokens(msg), 0);

  if (fixedTokens >= maxPromptTokens) {
    return fixed;
  }

  const rounds: T[][] = [];
  let currentRound: T[] = [];

  for (const msg of history) {
    if (msg.role === "assistant" && currentRound.length > 0) {
      rounds.push(currentRound);
      currentRound = [];
    }

    currentRound.push(msg);
  }

  if (currentRound.length > 0) {
    rounds.push(currentRound);
  }

  if (rounds.length <= keepRecentRounds) {
    return messages;
  }

  const droppedCount = rounds.length - keepRecentRounds;
  const keptRounds = rounds.slice(-keepRecentRounds);
  const summaryMessage = {
    role: "user" as T["role"],
    content: `（此前省略 ${droppedCount} 轮工具调用对话）`
  } as T;
  const compressed = [...fixed, summaryMessage, ...keptRounds.flat()];
  const compressedTokens = compressed.reduce(
    (sum, msg) => sum + estimateLooseMessageTokens(msg),
    0
  );

  if (compressedTokens <= maxPromptTokens) {
    return compressed;
  }

  const budget = maxPromptTokens - fixedTokens - estimateLooseMessageTokens(summaryMessage);
  const perRoundBudget = Math.floor(budget / keptRounds.length);

  const trimmedRounds = keptRounds.map((round) => {
    const roundTokens = round.reduce((sum, msg) => sum + estimateLooseMessageTokens(msg), 0);

    if (roundTokens <= perRoundBudget) {
      return round;
    }

    return round.map((msg) => {
      const content = msg.content ?? "";

      if (content.length <= 100) {
        return msg;
      }

      const targetChars = Math.floor(perRoundBudget * 4 * 0.6);
      const truncated = content.slice(0, targetChars) + "\n... [truncated]";

      return { ...msg, content: truncated } as T;
    });
  });

  return [...fixed, summaryMessage, ...trimmedRounds.flat()];
}

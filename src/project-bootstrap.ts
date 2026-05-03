import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface BootstrapGuidanceResult {
  applied: boolean;
  instruction: string;
  notice?: string;
}

const PROJECT_BOOTSTRAP_PATTERNS = [
  /\b(create|start|bootstrap|initialize|scaffold|build|set up)\b.{0,24}\b(project|app|cli|library|package|repo|repository|service)\b/u,
  /\b(new project|new app|new cli|starter|boilerplate)\b/u,
  /(?:\u521B\u5EFA|\u65B0\u5EFA|\u642D\u5EFA|\u521D\u59CB\u5316|\u811A\u624B\u67B6|\u542F\u52A8)\S*(?:\u9879\u76EE|\u5E94\u7528|\u670D\u52A1|\u4ED3\u5E93|\u811A\u624B\u67B6|\u5DE5\u7A0B)/u
];

export function applyBootstrapGuidance(options: {
  cwd: string;
  instruction: string;
  repositoryJustInitialized: boolean;
}): BootstrapGuidanceResult {
  if (!options.repositoryJustInitialized) {
    return {
      applied: false,
      instruction: options.instruction
    };
  }

  if (!looksLikeProjectBootstrapRequest(options.instruction)) {
    return {
      applied: false,
      instruction: options.instruction
    };
  }

  if (!isWorkspaceNearlyEmpty(options.cwd)) {
    return {
      applied: false,
      instruction: options.instruction
    };
  }

  return {
    applied: true,
    instruction: [
      options.instruction,
      "",
      "Additional execution guidance:",
      "- The repository was just initialized and the workspace is effectively empty.",
      "- Start with the smallest viable project scaffold needed for the request before deeper implementation.",
      "- Prefer a minimal starter set such as README, ignore files, package metadata, source entrypoint, and one basic verification target only when they fit the requested stack.",
      "- Do not add optional infrastructure the user did not ask for."
    ].join("\n"),
    notice: "Initialized an empty repository. DeepVibe will start with a minimal project scaffold before deeper implementation."
  };
}

export function looksLikeProjectBootstrapRequest(instruction: string): boolean {
  const normalized = instruction.trim().toLowerCase();
  return PROJECT_BOOTSTRAP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isWorkspaceNearlyEmpty(rootDir: string): boolean {
  if (!existsSync(rootDir)) {
    return true;
  }

  const visibleEntries = readdirSync(rootDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => ![".git", ".deepvibe"].includes(name));

  if (visibleEntries.length === 0) {
    return true;
  }

  if (visibleEntries.length > 2) {
    return false;
  }

  return visibleEntries.every((name) => {
    const extension = path.extname(name).toLowerCase();
    return extension === ".md" || extension === ".txt";
  });
}

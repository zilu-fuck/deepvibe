import { describe, expect, it } from "vitest";

import {
  composeSystemPrompt,
  PLAN_SYSTEM_PROMPT,
  REPL_SYSTEM_PROMPT,
  SYSTEM_PROMPT
} from "../src/context/prompts.js";
import { REPL_CHAT_ONLY_SYSTEM_PROMPT } from "../src/context/repl-chat-only-prompt.js";

describe("prompt persona", () => {
  it("defines the main coding prompt as DeepVibe CLI rather than a generic engineer", () => {
    expect(SYSTEM_PROMPT).toContain("You are DeepVibe CLI");
    expect(SYSTEM_PROMPT).toContain("not just");
    expect(SYSTEM_PROMPT).toContain("terminal-native AI coding agent");
  });

  it("defines the plan prompt as a DeepVibe CLI planning layer", () => {
    expect(PLAN_SYSTEM_PROMPT).toContain("You are DeepVibe CLI in plan mode");
    expect(PLAN_SYSTEM_PROMPT).toContain("planning layer");
  });

  it("defines the REPL project prompt as DeepVibe CLI in project mode", () => {
    expect(REPL_SYSTEM_PROMPT).toContain("You are DeepVibe CLI in project mode");
    expect(REPL_SYSTEM_PROMPT).toContain("Git-backed project workspace");
  });

  it("defines the chat-only prompt as DeepVibe CLI with explicit mode limits", () => {
    expect(REPL_CHAT_ONLY_SYSTEM_PROMPT).toContain("You are DeepVibe CLI in chat-only mode");
    expect(REPL_CHAT_ONLY_SYSTEM_PROMPT).toContain("not a generic assistant");
    expect(REPL_CHAT_ONLY_SYSTEM_PROMPT).toContain("not a Git repository");
    expect(REPL_CHAT_ONLY_SYSTEM_PROMPT).toContain("Do not emit JSON file-change payloads");
  });

  it("appends project-specific guidance with a product-oriented section header", () => {
    const composed = composeSystemPrompt("base", "local rules");

    expect(composed).toContain("## Project-Specific Guidance");
    expect(composed).toContain("local rules");
  });
});

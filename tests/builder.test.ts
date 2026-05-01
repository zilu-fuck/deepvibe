import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../src/context/builder.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("buildContext", () => {
  it("keeps messages in a stable system -> metadata -> task order", () => {
    const rootDir = createWorkspace({
      "src/api/request.ts": "export const request = true;\n",
      "README.md": "# demo\n"
    });

    const result = buildContext({
      rootDir,
      instruction: "inspect request handling",
      candidates: ["src/api/request.ts"]
    });

    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(result.messages[1]?.content).toContain("项目元信息");
    expect(result.messages[2]?.content).toContain("--- FILE: src/api/request.ts [mode=full] ---");
    expect(result.tokenEstimate).toBeLessThanOrEqual(result.maxPromptTokens);
  });

  it("compacts or truncates files when the prompt budget is small", () => {
    const rootDir = createWorkspace({
      "src/huge.ts": [
        "// comment",
        "",
        "const alpha = 1;",
        "const beta = 2;",
        "const gamma = 3;",
        "const delta = 4;",
        "const epsilon = 5;",
        "const zeta = 6;",
        "const eta = 7;",
        "const theta = 8;",
        "const iota = 9;",
        "const kappa = 10;"
      ].join("\n").repeat(25)
    });

    const result = buildContext({
      rootDir,
      instruction: "inspect huge file",
      candidates: ["src/huge.ts"],
      maxWindowTokens: 460,
      reservedResponseTokens: 20
    });

    expect(result.files[0]?.mode).not.toBe("full");
    expect(result.tokenEstimate).toBeLessThanOrEqual(result.maxPromptTokens);
  });

  it("preserves explicit paths and drops non-explicit files first", () => {
    const rootDir = createWorkspace({
      "src/explicit.ts": "export const explicit = true;\n".repeat(40),
      "src/secondary.ts": "export const secondary = true;\n".repeat(40),
      "src/tertiary.ts": "export const tertiary = true;\n".repeat(40)
    });

    const result = buildContext({
      rootDir,
      instruction: "check @src/explicit.ts",
      candidates: ["src/explicit.ts", "src/secondary.ts", "src/tertiary.ts"],
      explicitPaths: ["src/explicit.ts"],
      maxWindowTokens: 180,
      reservedResponseTokens: 20
    });

    expect(result.files.some((file) => file.path === "src/explicit.ts")).toBe(true);
    expect(result.files.every((file) => file.path === "src/explicit.ts")).toBe(true);
  });

  it("includes web search results in the task message", () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const api = true;\n"
    });

    const result = buildContext({
      rootDir,
      instruction: "check api docs",
      candidates: ["src/api.ts"],
      searchResults: [
        {
          title: "API Docs",
          url: "https://example.com/api",
          snippet: "Latest API docs."
        }
      ]
    });

    expect(result.messages[2]?.content).toContain("联网搜索结果");
    expect(result.messages[2]?.content).toContain("https://example.com/api");
  });

  it("includes persistent history summary in the task message", () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const api = true;\n"
    });

    const result = buildContext({
      rootDir,
      instruction: "update api",
      candidates: ["src/api.ts"],
      historySummary: "最近会话摘要：\n- 指令: summarize project | 摘要: inspected files"
    });

    expect(result.messages[2]?.content).toContain("最近会话摘要");
    expect(result.messages[2]?.content).toContain("inspected files");
  });

  it("appends a project-level prompt to the system message", () => {
    const rootDir = createWorkspace({
      "src/api.ts": "export const api = true;\n"
    });

    const result = buildContext({
      rootDir,
      instruction: "update api",
      candidates: ["src/api.ts"],
      projectPrompt: "请优先遵循项目中的错误处理约定。"
    });

    expect(result.messages[0]?.content).toContain("Project-Specific Guidance");
    expect(result.messages[0]?.content).toContain("请优先遵循项目中的错误处理约定。");
  });
});

function createWorkspace(files: Record<string, string>): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "deepvibe-builder-"));
  tempDirs.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return rootDir;
}

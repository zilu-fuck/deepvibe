import { describe, expect, it } from "vitest";

import { parseResponse, parsePlan } from "../src/llm/response-parser.js";

function makeCompletionResult(content: string, finishReason = "stop", toolCalls: Array<{ function: { arguments: string; name: string }; id: string; type: "function" }> = []) {
  return {
    id: "test",
    content,
    reasoningContent: "",
    finishReason,
    toolCalls,
    usage: null
  };
}

describe("parseResponse", () => {
  it("parses a valid structured response", () => {
    const result = parseResponse(makeCompletionResult(JSON.stringify({
      files: [
        {
          path: "src/api.ts",
          action: "modify",
          diff: "@@ -1 +1 @@"
        }
      ],
      summary: "Updated API handling"
    })));

    expect(result).toEqual({
      ok: true,
      value: {
        files: [
          {
            path: "src/api.ts",
            action: "modify",
            diff: "@@ -1 +1 @@"
          }
        ],
        summary: "Updated API handling"
      }
    });
  });

  it("classifies empty content as retryable", () => {
    const result = parseResponse(makeCompletionResult("   "));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("EMPTY_CONTENT");
    expect(result.ok ? null : result.error.canRetry).toBe(true);
  });

  it("classifies truncated output before schema parsing", () => {
    const result = parseResponse(makeCompletionResult("{\"files\":", "length"));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("TRUNCATED");
  });

  it("classifies invalid JSON as retryable", () => {
    const result = parseResponse(makeCompletionResult("{not json}"));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_JSON");
  });

  it("classifies schema violations separately from JSON syntax errors", () => {
    const result = parseResponse(makeCompletionResult(JSON.stringify({
      files: [
        {
          path: "src/api.ts",
          action: "rewrite",
          diff: "@@ -1 +1 @@"
        }
      ],
      summary: "Updated API handling"
    })));

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_SCHEMA");
  });
});

describe("parsePlan", () => {
  it("parses a valid plan", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "Add JWT authentication",
      steps: [
        {
          index: 1,
          description: "Create user model",
          files: ["src/models/user.ts"],
          estimatedChanges: "~40 lines"
        },
        {
          index: 2,
          description: "Add auth middleware",
          files: ["src/middleware/auth.ts"],
          estimatedChanges: "~30 lines"
        }
      ],
      notes: "Requires bcrypt and jsonwebtoken"
    })));

    expect(result).toEqual({
      ok: true,
      value: {
        overview: "Add JWT authentication",
        steps: [
          {
            index: 1,
            description: "Create user model",
            files: ["src/models/user.ts"],
            estimatedChanges: "~40 lines"
          },
          {
            index: 2,
            description: "Add auth middleware",
            files: ["src/middleware/auth.ts"],
            estimatedChanges: "~30 lines"
          }
        ],
        notes: "Requires bcrypt and jsonwebtoken"
      }
    });
  });

  it("parses a plan with empty notes", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "Simple task",
      steps: [
        {
          index: 1,
          description: "Do one thing",
          files: ["src/thing.ts"],
          estimatedChanges: "~10 lines"
        }
      ]
    })));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.notes : "").toBe("");
  });

  it("rejects empty content", () => {
    const result = parsePlan(makeCompletionResult("  "));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("EMPTY_CONTENT");
  });

  it("rejects truncated content", () => {
    const result = parsePlan(makeCompletionResult('{"overview":', "length"));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("TRUNCATED");
  });

  it("rejects invalid JSON", () => {
    const result = parsePlan(makeCompletionResult("{bad json"));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_JSON");
  });

  it("rejects plan with missing overview", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      steps: [{ index: 1, description: "test", files: [], estimatedChanges: "0" }]
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });

  it("rejects plan with empty steps", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "test",
      steps: []
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });

  it("rejects plan with invalid step index", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "test",
      steps: [{ index: 0, description: "test", files: [], estimatedChanges: "0" }]
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });

  it("rejects plan with step missing description", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "test",
      steps: [{ index: 1, description: "", files: [], estimatedChanges: "0" }]
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });

  it("rejects plan with non-array files", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "test",
      steps: [{ index: 1, description: "test", files: "not-array", estimatedChanges: "0" }]
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });

  it("rejects plan with non-string notes", () => {
    const result = parsePlan(makeCompletionResult(JSON.stringify({
      overview: "test",
      steps: [{ index: 1, description: "test", files: [], estimatedChanges: "0" }],
      notes: 123
    })));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_PLAN_SCHEMA");
  });
});

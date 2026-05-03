import { describe, expect, it } from "vitest";

import {
  ANSI,
  computeLayout,
  renderBoxBottom,
  renderBoxLine,
  renderBoxTop,
  visibleWidth,
  wrapLine
} from "../src/tui-layout.js";

describe("computeLayout", () => {
  it("allocates rows for a standard 80x24 terminal", () => {
    const layout = computeLayout(24, 80, 7);

    expect(layout.statusBox.topBorderRow).toBe(1);
    expect(layout.statusBox.bottomBorderRow).toBe(9);
    expect(layout.chatBox.topBorderRow).toBe(10);
    expect(layout.inputBox.bottomBorderRow).toBe(24);
    expect(layout.contentWidth).toBe(76);
  });

  it("allocates rows for a 120x40 terminal", () => {
    const layout = computeLayout(40, 120, 7);

    expect(layout.statusBox.topBorderRow).toBe(1);
    expect(layout.statusBox.bottomBorderRow).toBe(9);
    expect(layout.chatBox.topBorderRow).toBe(10);
    expect(layout.inputBox.topBorderRow).toBe(38);
    expect(layout.contentWidth).toBe(116);
  });

  it("enforces minimum chat height of 5 rows", () => {
    const layout = computeLayout(16, 80, 3);

    expect(layout.chatBox.contentEndRow - layout.chatBox.contentStartRow + 1).toBeGreaterThanOrEqual(5);
  });

  it("sets chatScrollTop and chatScrollBottom inside the chat content area", () => {
    const layout = computeLayout(24, 80, 7);

    expect(layout.chatScrollTop).toBe(layout.chatBox.contentStartRow);
    expect(layout.chatScrollBottom).toBe(layout.chatBox.contentEndRow);
  });

  it("does not overlap status and chat boxes", () => {
    const layout = computeLayout(24, 80, 7);

    expect(layout.chatBox.topBorderRow).toBeGreaterThan(layout.statusBox.bottomBorderRow);
  });

  it("does not overlap chat and input boxes", () => {
    const layout = computeLayout(24, 80, 7);

    expect(layout.inputBox.topBorderRow).toBeGreaterThan(layout.chatBox.bottomBorderRow);
  });
});

describe("renderBoxTop", () => {
  it("renders a box top with title", () => {
    const result = renderBoxTop("Status", 20);

    expect(result).toContain("┌─");
    expect(result).toContain("Status");
    expect(result).toContain("┐");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("pads with dashes to fill the width", () => {
    const result = renderBoxTop("Hi", 10);
    const line = result.split("\n")[0]!;

    expect(line.length).toBe(10);
    expect(line.startsWith("┌─")).toBe(true);
    expect(line.endsWith("┐")).toBe(true);
  });
});

describe("renderBoxBottom", () => {
  it("renders a box bottom with the given width", () => {
    const result = renderBoxBottom(20);

    expect(result).toContain("└");
    expect(result).toContain("┘");
    const line = result.split("\n")[0]!;
    expect(line.length).toBe(20);
  });
});

describe("renderBoxLine", () => {
  it("pads text to fit the inner width", () => {
    const result = renderBoxLine("hello", 20);

    expect(result).toContain("│ hello");
    expect(result).toContain("│");
    const line = result.split("\n")[0]!;
    expect(line.length).toBe(20);
  });

  it("truncates text that exceeds the inner width", () => {
    const longText = "a".repeat(50);
    const result = renderBoxLine(longText, 20);

    const line = result.split("\n")[0]!;
    expect(line.length).toBe(20);
  });
});

describe("visibleWidth", () => {
  it("returns 0 for an empty string", () => {
    expect(visibleWidth("")).toBe(0);
  });

  it("returns the correct width for ASCII text", () => {
    expect(visibleWidth("hello")).toBe(5);
  });

  it("strips ANSI escape sequences", () => {
    expect(visibleWidth("\x1B[31mhello\x1B[0m")).toBe(5);
  });

  it("counts CJK characters as double-width", () => {
    expect(visibleWidth("你好")).toBe(4);
  });

  it("handles mixed ASCII and CJK", () => {
    expect(visibleWidth("hi你好")).toBe(6);
  });

  it("handles nested ANSI and CJK", () => {
    expect(visibleWidth("\x1B[31m你好\x1B[0m")).toBe(4);
  });
});

describe("wrapLine", () => {
  it("returns a single line when text fits", () => {
    expect(wrapLine("hello", 10)).toEqual(["hello"]);
  });

  it("wraps long text into multiple lines", () => {
    const result = wrapLine("hello world foo bar", 10);

    expect(result.length).toBeGreaterThan(1);
    for (const line of result) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it("preserves ANSI escape sequences across wrapped lines", () => {
    const result = wrapLine("\x1B[31mhello world\x1B[0m", 8);

    expect(result.length).toBeGreaterThan(1);
  });

  it("handles empty input", () => {
    expect(wrapLine("", 10)).toEqual([""]);
  });

  it("handles zero maxWidth", () => {
    expect(wrapLine("hello", 0)).toEqual(["hello"]);
  });

  it("counts CJK characters correctly when wrapping", () => {
    const result = wrapLine("你好世界", 4);

    expect(result).toEqual(["你好", "世界"]);
  });
});

describe("ANSI helpers", () => {
  it("generates cursor positioning escape", () => {
    expect(ANSI.cursorTo(5, 10)).toBe("\x1B[5;10H");
  });

  it("generates scroll region escape", () => {
    expect(ANSI.scrollRegion(3, 20)).toBe("\x1B[3;20r");
  });

  it("generates clear scroll region escape", () => {
    expect(ANSI.clearScrollRegion).toBe("\x1B[r");
  });
});

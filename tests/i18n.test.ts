import { describe, expect, it } from "vitest";

import { detectLanguage, t, type Language } from "../src/i18n.js";

describe("i18n", () => {
  it("returns English for unknown locales", () => {
    const originalLANG = process.env.LANG;
    const originalLC_ALL = process.env.LC_ALL;
    const originalLC_MESSAGES = process.env.LC_MESSAGES;

    try {
      delete process.env.LANG;
      delete process.env.LC_ALL;
      delete process.env.LC_MESSAGES;

      expect(detectLanguage()).toBe("en");
    } finally {
      if (originalLANG) process.env.LANG = originalLANG;
      if (originalLC_ALL) process.env.LC_ALL = originalLC_ALL;
      if (originalLC_MESSAGES) process.env.LC_MESSAGES = originalLC_MESSAGES;
    }
  });

  it("detects Chinese from LANG=zh_CN", () => {
    const originalLANG = process.env.LANG;

    try {
      process.env.LANG = "zh_CN.UTF-8";
      expect(detectLanguage()).toBe("zh");
    } finally {
      if (originalLANG) process.env.LANG = originalLANG;
    }
  });

  it("detects Chinese from LANG=zh_TW", () => {
    const originalLANG = process.env.LANG;

    try {
      process.env.LANG = "zh_TW.UTF-8";
      expect(detectLanguage()).toBe("zh");
    } finally {
      if (originalLANG) process.env.LANG = originalLANG;
    }
  });

  it("detects Chinese from LC_ALL=zh_CN", () => {
    const originalLANG = process.env.LANG;
    const originalLC_ALL = process.env.LC_ALL;

    try {
      delete process.env.LANG;
      process.env.LC_ALL = "zh_CN.UTF-8";
      expect(detectLanguage()).toBe("zh");
    } finally {
      if (originalLANG) process.env.LANG = originalLANG;
      if (originalLC_ALL) process.env.LC_ALL = originalLC_ALL;
    }
  });

  it("fallback to English for fr_FR", () => {
    const originalLANG = process.env.LANG;

    try {
      process.env.LANG = "fr_FR.UTF-8";
      expect(detectLanguage()).toBe("en");
    } finally {
      if (originalLANG) process.env.LANG = originalLANG;
    }
  });
});

describe("t", () => {
  const allKeys = [
    "repl.welcome",
    "repl.prompt",
    "cmd.help.title",
    "cmd.help.new",
    "cmd.help.history",
    "cmd.help.sessions",
    "cmd.help.switch",
    "cmd.help.clear",
    "cmd.help.help",
    "cmd.help.quit",
    "cmd.new.started",
    "cmd.history.empty",
    "cmd.sessions.empty",
    "cmd.sessions.active",
    "cmd.sessions.turns",
    "cmd.sessions.last",
    "cmd.switch.usage",
    "cmd.switch.not_found",
    "cmd.switch.done",
    "cmd.unknown",
    "confirm.summary",
    "confirm.files",
    "confirm.tool_changes",
    "confirm.prompt",
    "confirm.accepted",
    "confirm.rejected",
    "confirm.bad_choice",
    "review.file_prompt",
    "review.selected",
    "error.prefix",
    "session.not_found"
  ];

  it("returns English text for all keys", () => {
    for (const key of allKeys) {
      const text = t(key, "en");
      expect(text).toBeTruthy();
      expect(typeof text).toBe("string");
    }
  });

  it("returns Chinese text for all keys", () => {
    for (const key of allKeys) {
      const text = t(key, "zh");
      expect(text).toBeTruthy();
      expect(typeof text).toBe("string");
    }
  });

  it("returns English as fallback for unknown language", () => {
    expect(t("repl.welcome", "fr" as Language)).toBe(t("repl.welcome", "en"));
  });

  it("returns key itself for missing key", () => {
    expect(t("nonexistent.key", "en")).toBe("nonexistent.key");
    expect(t("nonexistent.key", "zh")).toBe("nonexistent.key");
  });

  it("interpolates parameters", () => {
    expect(t("cmd.unknown", "en", { command: "/foo" })).toContain("/foo");
    expect(t("cmd.unknown", "zh", { command: "/foo" })).toContain("/foo");
  });

  it("interpolates numeric parameters", () => {
    expect(t("review.selected", "en", { selected: 3, total: 5 })).toContain("3");
    expect(t("review.selected", "en", { selected: 3, total: 5 })).toContain("5");
    expect(t("review.selected", "zh", { selected: 3, total: 5 })).toContain("5");
    expect(t("review.selected", "zh", { selected: 3, total: 5 })).toContain("3");
  });

  it("interpolates session.not_found with id", () => {
    expect(t("session.not_found", "en", { id: "abc123" })).toContain("abc123");
    expect(t("session.not_found", "zh", { id: "abc123" })).toContain("abc123");
  });

  it("Chinese and English are different for display strings", () => {
    expect(t("cmd.help.title", "en")).not.toBe(t("cmd.help.title", "zh"));
    expect(t("confirm.prompt", "en")).not.toBe(t("confirm.prompt", "zh"));
    expect(t("repl.welcome", "en")).not.toBe(t("repl.welcome", "zh"));
  });
});

describe("i18n coverage", () => {
  it("every used key exists in both English and Chinese dictionaries", () => {
    const usedKeys = [
      "repl.welcome", "repl.prompt",
      "cmd.help.title", "cmd.help.new", "cmd.help.history", "cmd.help.sessions",
      "cmd.help.switch", "cmd.help.clear", "cmd.help.help", "cmd.help.quit",
      "cmd.new.started", "cmd.history.empty", "cmd.sessions.empty",
      "cmd.sessions.active", "cmd.sessions.turns", "cmd.sessions.last",
      "cmd.switch.usage", "cmd.switch.not_found", "cmd.switch.done", "cmd.unknown",
      "confirm.summary", "confirm.files", "confirm.tool_changes", "confirm.prompt",
      "confirm.accepted", "confirm.rejected", "confirm.bad_choice",
      "review.file_prompt", "review.selected",
      "error.prefix", "session.not_found"
    ];

    for (const key of usedKeys) {
      expect(t(key, "en")).not.toBe(key); // must exist in English dict
      expect(t(key, "zh")).not.toBe(key); // must exist in Chinese dict
    }
  });
});

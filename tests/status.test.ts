import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPersistentStatusArea,
  renderWelcomeBanner,
  resetWelcomeBannerEncodingCacheForTest
} from "../src/status.js";

const originalBannerMode = process.env.DEEPVIBE_BANNER;
const originalLANG = process.env.LANG;
const originalLC_ALL = process.env.LC_ALL;
const originalLC_CTYPE = process.env.LC_CTYPE;
const originalLC_MESSAGES = process.env.LC_MESSAGES;

afterEach(() => {
  resetWelcomeBannerEncodingCacheForTest();

  if (originalBannerMode === undefined) {
    delete process.env.DEEPVIBE_BANNER;
  } else {
    process.env.DEEPVIBE_BANNER = originalBannerMode;
  }

  if (originalLANG === undefined) {
    delete process.env.LANG;
  } else {
    process.env.LANG = originalLANG;
  }

  if (originalLC_ALL === undefined) {
    delete process.env.LC_ALL;
  } else {
    process.env.LC_ALL = originalLC_ALL;
  }

  if (originalLC_CTYPE === undefined) {
    delete process.env.LC_CTYPE;
  } else {
    process.env.LC_CTYPE = originalLC_CTYPE;
  }

  if (originalLC_MESSAGES === undefined) {
    delete process.env.LC_MESSAGES;
  } else {
    process.env.LC_MESSAGES = originalLC_MESSAGES;
  }
});

describe("renderWelcomeBanner", () => {
  it("falls back to ASCII when forced", () => {
    process.env.DEEPVIBE_BANNER = "ascii";

    const banner = renderWelcomeBanner("en", createOutput(true));

    expect(banner).toContain("CLI coding workflow");
    expect(banner).not.toContain("⢀⣀⣀");
  });

  it("uses the Unicode banner when forced", () => {
    process.env.DEEPVIBE_BANNER = "unicode";

    const banner = renderWelcomeBanner("en", createOutput(true));

    expect(banner).toContain("⢀⣀⣀");
    expect(banner).not.toContain("CLI coding workflow");
  });

  it("falls back to ASCII for non-TTY output", () => {
    delete process.env.DEEPVIBE_BANNER;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    delete process.env.LC_MESSAGES;

    const banner = renderWelcomeBanner("en", createOutput(false));

    expect(banner).toContain("CLI coding workflow");
    expect(banner).not.toContain("⢀⣀⣀");
  });
});

describe("createPersistentStatusArea", () => {
  it("replays chat content after resuming from a fullscreen viewer", () => {
    const output = createOutput(true) as PassThrough & NodeJS.WritableStream & {
      columns?: number;
      isTTY?: boolean;
      readAsString: () => string;
      rows?: number;
    };
    output.columns = 80;
    output.rows = 24;
    output.readAsString = () => output.read()?.toString("utf8") ?? "";

    const area = createPersistentStatusArea(output, {
      renderStatusPanel: () => "Ready: test",
      renderWelcomeBanner: () => "Welcome\n",
      renderInputPanel: () => ""
    });

    expect(area).not.toBeNull();
    area!.initialize();
    area!.writeChatRaw("hello world\n");
    area!.suspend();
    area!.resume();

    const rendered = output.readAsString();
    expect(rendered.match(/hello world/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

function createOutput(isTTY: boolean): NodeJS.WritableStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WritableStream & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream;
}

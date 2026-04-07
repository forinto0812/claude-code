import { describe, expect, test } from "bun:test";
import {
  isOutputLineTruncated,
  renderTruncatedContent,
  sanitizeCapturedTerminalOutput,
} from "../terminal";

describe("sanitizeCapturedTerminalOutput", () => {
  test("keeps only the latest carriage-return segment on a line", () => {
    expect(sanitizeCapturedTerminalOutput("old status\rfinal line")).toBe(
      "final line",
    );
  });

  test("normalizes CRLF while preserving line breaks", () => {
    expect(sanitizeCapturedTerminalOutput("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  test("removes OSC and non-SGR CSI control sequences", () => {
    const input =
      "prefix\u001B]0;title\u0007\u001B[2K\u001B[1Gvisible\u001B[31m red\u001B[0m";
    expect(sanitizeCapturedTerminalOutput(input)).toBe(
      "prefixvisible\u001B[31m red\u001B[0m",
    );
  });
});

describe("renderTruncatedContent", () => {
  test("does not leak overwritten status text into folded output", () => {
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "status: searching\rfinal error line",
    ].join("\n");

    const rendered = renderTruncatedContent(content, 80, true);

    expect(rendered).toContain("final error line");
    expect(rendered).not.toContain("status: searching");
  });
});

describe("isOutputLineTruncated", () => {
  test("uses sanitized content for carriage-return overwritten lines", () => {
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "progress\roverwritten line",
      "line 5",
    ].join("\n");

    expect(isOutputLineTruncated(content, 80)).toBe(true);
  });

  test("matches visual wrapping for a long single line", () => {
    expect(isOutputLineTruncated("x".repeat(160), 40)).toBe(true);
  });

  test("ignores trailing newline after sanitization", () => {
    expect(isOutputLineTruncated("a\nb\nc\n", 80)).toBe(false);
  });
});

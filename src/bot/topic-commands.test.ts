import { test, expect, describe } from "bun:test";
import { convertToTelegramHtml } from "./topic-commands.ts";

describe("convertToTelegramHtml", () => {
  test("converts *bold* to <b>bold</b>", () => {
    expect(convertToTelegramHtml("Current topic: *work*")).toBe(
      "Current topic: <b>work</b>",
    );
  });

  test("converts `code` to <code>code</code>", () => {
    expect(convertToTelegramHtml("Use `/topic name` to switch.")).toBe(
      "Use <code>/topic name</code> to switch.",
    );
  });

  test("escapes HTML entities before formatting", () => {
    expect(convertToTelegramHtml("*<script>*")).toBe(
      "<b>&lt;script&gt;</b>",
    );
  });

  test("escapes & < > in plain text", () => {
    expect(convertToTelegramHtml("a & b < c > d")).toBe(
      "a &amp; b &lt; c &gt; d",
    );
  });

  test("handles mixed bold and code", () => {
    expect(convertToTelegramHtml("*work* — 5 msgs, `/topic name`")).toBe(
      "<b>work</b> — 5 msgs, <code>/topic name</code>",
    );
  });

  test("handles multiple bold sections", () => {
    expect(convertToTelegramHtml("▶️ *work* — 5 msgs\n○ *play* — 0 msgs")).toBe(
      "▶️ <b>work</b> — 5 msgs\n○ <b>play</b> — 0 msgs",
    );
  });

  test("passes through text without formatting markers", () => {
    expect(convertToTelegramHtml("No formatting here")).toBe(
      "No formatting here",
    );
  });
});

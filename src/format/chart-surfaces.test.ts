import { describe, expect, test } from "bun:test";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatEmailHtml } from "./email-format.ts";

// Off the wiki reader a <Chart> is its table as written: every surface renders
// the page exactly as it renders the same page with the tags taken out. The
// chat sanitizer's half (no svg, the table kept) runs on the real bundle in
// e2e/wiki-chart.spec.ts, since it needs a DOM.

const table = ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| 7 — rows | 2 | 3 (D7) | — |", "| 8 — cells | 2 | 1,5 | 2 |"];
const bare = ["Intro line.", "", ...table, "", "After the table.", ""].join("\n");
const charted = [
  "Intro line.",
  "",
  '<Chart kind="gate" caption="Gates" bar="Bar" pass="Pass" hold="Hold">',
  "",
  ...table,
  "",
  "</Chart>",
  "",
  "After the table.",
  "",
].join("\n");

describe("a <Chart> off the reader", () => {
  const surfaces: [string, (s: string) => string][] = [
    ["web chat", (s) => formatWebHtml(s)],
    ["telegram", formatTelegramHtml],
    ["slack", formatSlackMrkdwn],
    ["email", formatEmailHtml],
  ];
  for (const [name, fmt] of surfaces) {
    test(`${name} prints the table rows as written`, () => {
      const out = fmt(charted);
      expect(out).toContain("3 (D7)");
      expect(out).not.toContain("<svg");
      expect(out).not.toContain("numbers");
      // The block's own lines (tag and blank lines around it) aside, the same render.
      expect(out.replace(/\s+/g, " ")).toBe(fmt(bare).replace(/\s+/g, " "));
    });
  }
});

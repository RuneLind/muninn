import { describe, expect, test } from "bun:test";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { PEEK_STRIP_SELECTOR } from "../dashboard/views/components/wiki-ref-links.ts";
import { readCaseBoardView } from "./component-spec.ts";

import { READER_ONLY_ATTR } from "./reader-lens.ts";
import type { PageFileResult } from "./query-block.ts";

// Invented cases only: a lending library.

const YAML = [
  "- {id: LIB-101, status: hold, kort: Waits for a Renewal}",
  "- {id: LIB-102, status: ok, note: 'Returned · **back on the shelf**'}",
  "- {id: LIB-103, status: hold}",
  "- {id: LIB-104, status: lost}",
  "- {id: LIB-105, status: none}",
  "",
].join("\n");

const files = (text = YAML) => new Map<string, PageFileResult>([["cases.yaml", { ok: true, text }]]);
const reader = (md: string, text?: string) => renderWikiHtml(md, () => undefined, { views: true, files: files(text) });
const dotsOf = (html: string) => [...html.matchAll(/<button type="button" class="cb-dot cb-dot-(\w+)"[^>]*aria-label="([^"]*)"[^>]*data-cb-say="([^"]*)"/g)].map((m) => [m[1], m[2], m[3]]);
const DOTS = '<CaseBoard src="cases.yaml" view="dots" />';

describe("view=", () => {
  test.each([
    ["dots", "dots", false],
    ["rows", "rows", false],
    [undefined, "rows", false],
    ["Dots", "rows", true],
    ["squares", "rows", true],
  ])("%s reads as %s", (raw, value, fellBack) => {
    const r = readCaseBoardView(raw);
    expect(r.value).toBe(value as "rows" | "dots");
    expect(r.fellBack === true).toBe(fellBack);
  });

  test("lint names a view it does not read", () => {
    const findings = checkPageText({ relPath: "plans/c.mdx" }, '<CaseBoard src="cases.yaml" view="Dots" />\n', []).filter((f) => f.check === "component-value");
    expect(findings.map((f) => [f.line, f.message])).toEqual([[1, 'CaseBoard view="Dots" renders as rows, not dots']]);
  });
});

describe("the squares", () => {
  const html = reader(DOTS);

  test("one per case, grouped by status in the board's order, before the rows", () => {
    expect(dotsOf(html)).toEqual([
      ["hold", "LIB-101: hold", "LIB-101 — hold: Waits for a Renewal"],
      ["hold", "LIB-103: hold", "LIB-103 — hold"],
      ["none", "LIB-105: none", "LIB-105 — none"],
      ["ok", "LIB-102: ok", "LIB-102 — ok: back on the shelf"],
      ["unknown", "LIB-104: unknown", "LIB-104 — unknown"],
    ]);
    expect(html.indexOf('class="cb-dots"')).toBeLessThan(html.indexOf('class="cb-group"'));
    expect(html.match(/class="cb-row"/g)?.length).toBe(5);
  });

  test("buttons in a named group, one tab stop, a polite live line, reader-only", () => {
    expect(html).toContain(`<div class="cb-dots" ${READER_ONLY_ATTR} role="group" aria-label="Cases by status">`);
    expect([...html.matchAll(/class="cb-dot [^"]*" tabindex="(-?\d)" aria-pressed="false"/g)].map((m) => m[1])).toEqual(["0", "-1", "-1", "-1", "-1"]);
    expect(html).toContain('<p class="cb-dots-say" aria-live="polite"></p>');
  });

  test("each square and each group label carries its status glyph, not colour alone", () => {
    expect([...html.matchAll(/class="cb-dot [^>]*><span aria-hidden="true">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(["‖", "‖", "–", "✓", "?"]);
    expect(html).toContain('<span class="cb-dots-label"><span aria-hidden="true">‖ </span>hold · 2</span>');
  });

  test("labels= names the statuses in the squares as in the pills", () => {
    const named = reader('<CaseBoard src="cases.yaml" view="dots" labels="hold:held back" />');
    expect(dotsOf(named)[0]).toEqual(["hold", "LIB-101: held back", "LIB-101 — held back: Waits for a Renewal"]);
  });

  test("a kort is escaped text", () => {
    const html = reader(DOTS, '- {id: LIB-1, status: wait, kort: "a < b & \\"c\\""}\n');
    expect(dotsOf(html)).toEqual([["wait", "LIB-1: wait", 'LIB-1 — wait: a &lt; b &amp; &quot;c&quot;']]);
  });

  test("a peek strips the squares", () => {
    expect(PEEK_STRIP_SELECTOR.split(", ")).toContain(".cb-dots");
  });
});

describe("edge cases", () => {
  test("an empty board, a missing src and a broken file draw no squares", () => {
    expect(reader(DOTS, "[]\n")).not.toContain("cb-dots");
    expect(reader('<CaseBoard view="dots" />')).not.toContain("cb-dots");
    expect(reader(DOTS, "- id: a\n  status: [\n")).not.toContain("cb-dots");
  });

  test("duplicate ids are two squares", () => {
    expect(dotsOf(reader(DOTS, "- {id: LIB-1, status: ok}\n- {id: LIB-1, status: hold}\n")).map((d) => d[1])).toEqual(["LIB-1: hold", "LIB-1: ok"]);
  });

  test("two boards each draw their own; only the one asking for dots", () => {
    const html = reader([DOTS, "", '<CaseBoard src="cases.yaml" />', "", DOTS].join("\n"));
    expect(html.match(/class="cb-dots"/g)?.length).toBe(2);
  });

  test("inside a Fold, and a fenced fake draws nothing", () => {
    expect(reader(`<Fold title="Cases">\n\n${DOTS}\n\n</Fold>\n`)).toContain('class="cb-dots"');
    expect(reader("```\n" + DOTS + "\n```\n")).not.toContain('class="cb-dots"');
  });
});

describe("off the reader a dots board is its rows", () => {
  const rows = '<CaseBoard src="cases.yaml" />';
  const surfaces: [string, (s: string) => string][] = [
    ["web chat", (s) => formatWebHtml(s, { files: files() })],
    ["web with views and no renderer", (s) => formatWebHtml(s, { views: true, files: files() })],
    ["the reader without views", (s) => renderWikiHtml(s, () => undefined, { files: files() })],
    ["telegram", formatTelegramHtml],
    ["slack", formatSlackMrkdwn],
    ["email", formatEmailHtml],
  ];
  for (const [name, fmt] of surfaces) {
    test(`${name} is byte for byte the rows`, () => {
      expect(fmt(DOTS)).toBe(fmt(rows));
    });
  }
});

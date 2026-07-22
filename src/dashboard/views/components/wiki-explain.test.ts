import { test, expect } from "bun:test";
import {
  buildExplainUrl,
  explainLabel,
  factcheckLabel,
  buildFactcheckUrl,
  applyToolLogEvent,
  toolLogRowLabel,
  type ToolLogRow,
  EXPLAIN_LABEL_CHARS,
  EXPLAIN_SEL_MAX,
} from "./wiki-explain.ts";

test("explainLabel wraps a short selection in quotes, no ellipsis", () => {
  expect(explainLabel("coverage gate")).toBe('Explain: "coverage gate"');
});

test("explainLabel collapses internal whitespace/newlines", () => {
  expect(explainLabel("  the   coverage\n gate ")).toBe('Explain: "the coverage gate"');
});

test("explainLabel truncates past the label cap and appends an ellipsis", () => {
  const long = "x".repeat(EXPLAIN_LABEL_CHARS + 40);
  const label = explainLabel(long);
  expect(label).toBe('Explain: "' + "x".repeat(EXPLAIN_LABEL_CHARS) + '…"');
});

test("buildExplainUrl includes sel + page, omits empty optional params", () => {
  const url = buildExplainUrl({ sel: "hello world", page: "concepts/foo" });
  expect(url).toBe(
    "/api/wiki/explain?sel=hello%20world&page=concepts%2Ffoo",
  );
});

test("buildExplainUrl appends wiki/ctx/history when present", () => {
  const url = buildExplainUrl({
    sel: "a b",
    page: "p",
    wiki: "mimir",
    ctx: "Some Heading",
    history: '[{"q":"x"}]',
  });
  expect(url).toContain("sel=a%20b");
  expect(url).toContain("&page=p");
  expect(url).toContain("&wiki=mimir");
  expect(url).toContain("&ctx=Some%20Heading");
  expect(url).toContain("&history=%5B%7B%22q%22%3A%22x%22%7D%5D");
});

test("buildExplainUrl caps sel at EXPLAIN_SEL_MAX before encoding", () => {
  const sel = "y".repeat(EXPLAIN_SEL_MAX + 500);
  const url = buildExplainUrl({ sel, page: "p" });
  const encoded = url.slice("/api/wiki/explain?sel=".length, url.indexOf("&page="));
  expect(decodeURIComponent(encoded).length).toBe(EXPLAIN_SEL_MAX);
});

test("buildExplainUrl never bisects a surrogate pair at the cap boundary", () => {
  // An emoji straddling the UTF-16 cap must not leave a lone surrogate
  // (encodeURIComponent throws on one).
  const sel = "y".repeat(EXPLAIN_SEL_MAX - 1) + "😀" + "z".repeat(200);
  const url = buildExplainUrl({ sel, page: "p" });
  const encoded = url.slice("/api/wiki/explain?sel=".length, url.indexOf("&page="));
  const decoded = decodeURIComponent(encoded);
  expect(decoded.startsWith("y".repeat(EXPLAIN_SEL_MAX - 1))).toBe(true);
  expect(decoded).not.toContain("�");
});

test("factcheckLabel quotes a selection; falls back to the page title with no sel", () => {
  expect(factcheckLabel("Eiffel Tower completed 1889")).toBe('Fact check: "Eiffel Tower completed 1889"');
  expect(factcheckLabel("", "My Page")).toBe("Fact check: My Page");
  expect(factcheckLabel("")).toBe("Fact check: this article");
});

test("factcheckLabel truncates past the label cap", () => {
  const long = "x".repeat(EXPLAIN_LABEL_CHARS + 40);
  expect(factcheckLabel(long)).toBe('Fact check: "' + "x".repeat(EXPLAIN_LABEL_CHARS) + '…"');
});

test("buildFactcheckUrl sel mode includes page/mode/sel/ctx, article mode omits sel", () => {
  const sel = buildFactcheckUrl({ mode: "sel", page: "concepts/foo", sel: "a b", wiki: "mimir", ctx: "H" });
  expect(sel).toContain("page=concepts%2Ffoo");
  expect(sel).toContain("&mode=sel");
  expect(sel).toContain("&sel=a%20b");
  expect(sel).toContain("&ctx=H");
  expect(sel).toContain("&wiki=mimir");

  const article = buildFactcheckUrl({ mode: "article", page: "p", wiki: "mimir" });
  expect(article).toContain("&mode=article");
  expect(article).not.toContain("sel=");
  expect(article).not.toContain("ctx=");
  expect(article).toContain("&wiki=mimir");
});

test("buildFactcheckUrl caps sel at EXPLAIN_SEL_MAX (sel mode)", () => {
  const sel = "y".repeat(EXPLAIN_SEL_MAX + 300);
  const url = buildFactcheckUrl({ mode: "sel", page: "p", sel });
  const enc = url.slice(url.indexOf("&sel=") + "&sel=".length);
  expect(decodeURIComponent(enc).length).toBe(EXPLAIN_SEL_MAX);
});

test("applyToolLogEvent appends a row on start with label/detail", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, {
    state: "start", name: "WebFetch", claimIndex: 2, label: "Reading", detail: "example.com",
  });
  expect(rows).toEqual([
    { claimIndex: 2, name: "WebFetch", label: "Reading", detail: "example.com", done: false },
  ]);
});

test("applyToolLogEvent falls back to name when label is absent", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, { state: "start", name: "WebSearch", claimIndex: 1 });
  expect(rows[0]!.label).toBe("WebSearch");
  expect(rows[0]!.detail).toBeUndefined();
});

test("applyToolLogEvent marks the matching open row done on end", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, { state: "start", name: "WebFetch", claimIndex: 1, label: "Reading", detail: "a.com" });
  applyToolLogEvent(rows, { state: "end", name: "WebFetch", claimIndex: 1 });
  expect(rows[0]!.done).toBe(true);
});

test("applyToolLogEvent pairs end to the row of the same claim (concurrent interleave)", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, { state: "start", name: "WebFetch", claimIndex: 1, label: "Reading", detail: "a.com" });
  applyToolLogEvent(rows, { state: "start", name: "WebFetch", claimIndex: 2, label: "Reading", detail: "b.com" });
  applyToolLogEvent(rows, { state: "end", name: "WebFetch", claimIndex: 2 });
  expect(rows[0]!.done).toBe(false); // claim 1 still open
  expect(rows[1]!.done).toBe(true); // claim 2 closed
});

test("applyToolLogEvent marks only the FIRST open row of a claim when a tool repeats", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, { state: "start", name: "WebFetch", claimIndex: 1, label: "Reading", detail: "a.com" });
  applyToolLogEvent(rows, { state: "start", name: "WebFetch", claimIndex: 1, label: "Reading", detail: "b.com" });
  applyToolLogEvent(rows, { state: "end", name: "WebFetch", claimIndex: 1 });
  expect(rows[0]!.done).toBe(true);
  expect(rows[1]!.done).toBe(false);
});

test("applyToolLogEvent end with no open match is a no-op", () => {
  const rows: ToolLogRow[] = [];
  applyToolLogEvent(rows, { state: "end", name: "WebFetch", claimIndex: 9 });
  expect(rows).toEqual([]);
});

test("toolLogRowLabel joins label + detail, or bare label when no detail", () => {
  expect(toolLogRowLabel({ claimIndex: 1, name: "WebFetch", label: "Reading", detail: "example.com", done: false }))
    .toBe("Reading: example.com");
  expect(toolLogRowLabel({ claimIndex: 1, name: "WebSearch", label: "Searching the web", done: false }))
    .toBe("Searching the web");
});

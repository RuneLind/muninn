import { test, expect } from "bun:test";
import {
  buildExplainUrl,
  explainLabel,
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

/**
 * Acceptance for the paste-subset post-pass.
 *
 * Every positive case here is a construct PR 0 measured as NOT converting when
 * pasted into a live MELOSYS create screen, and the negative cases are the ones
 * that converted — including the two the probe FALSIFIED, which is why nesting
 * depth is asserted as un-flagged rather than left unmentioned.
 */

import { test, expect, describe } from "bun:test";
import { checkJiraMarkdown } from "./markdown-check.ts";

const kinds = (md: string) => checkJiraMarkdown(md).map((f) => f.kind);

describe("flags what the Jira paste does not convert", () => {
  test("raw HTML", () => {
    // One row per LINE per kind — an open/close pair is one thing to fix.
    const flags = checkJiraMarkdown("Se <div class=\"x\">her</div> for detaljer.");
    expect(flags.map((f) => f.kind)).toEqual(["html"]);
    expect(flags[0]!.line).toBe(1);
  });

  test("Jira wiki markup — block macros and h1.–h6. headings", () => {
    expect(kinds("{code}\nfoo\n{code}")).toEqual(["wiki-markup", "wiki-markup"]);
    expect(kinds("h2. Overskrift")).toEqual(["wiki-markup"]);
    expect(kinds("{panel:title=Foo}")).toEqual(["wiki-markup"]);
  });

  test("task-list checkboxes — the construct that renders as a literal `[ ]`", () => {
    expect(kinds("- [ ] Første krav\n- [x] Andre krav")).toEqual(["task-list", "task-list"]);
    expect(checkJiraMarkdown("- [ ] Krav")[0]!.line).toBe(1);
  });

  test("emoji shortcodes", () => {
    expect(kinds("Obs :warning: dette er viktig")).toEqual(["emoji-shortcode"]);
  });

  test("reports the 1-based line number", () => {
    const md = "# Tittel\n\nTekst\n\n- [ ] Krav";
    expect(checkJiraMarkdown(md)[0]!.line).toBe(5);
  });
});

describe("does NOT flag what converts", () => {
  test("three-level nesting — PR 0 falsified the two-level assumption", () => {
    // Had this shipped on the documented assumption it would have carried a
    // linter rule against working syntax.
    const md = "- ett\n  - to\n    - tre\n      - fire";
    expect(checkJiraMarkdown(md)).toEqual([]);
  });

  test("the whole measured subset", () => {
    const md = [
      "# H1", "## H2", "#### H4",
      "**fet** og *kursiv* og ~~strek~~ og `kode`",
      "```kotlin",
      "val x = 1",
      "```",
      "- punkt",
      "1. nummerert",
      "[tekst](https://example.test)",
      "| a | b |", "|---|---|", "| 1 | 2 |",
      "> sitat",
      "---",
    ].join("\n");
    expect(checkJiraMarkdown(md)).toEqual([]);
  });

  test("ignores everything inside a fenced code block", () => {
    // A `<div>` in an ```html block is the point of the block.
    const md = ["```html", '<div class="x">- [ ] :warning: h2. {code}</div>', "```"].join("\n");
    expect(checkJiraMarkdown(md)).toEqual([]);
  });

  test("a generic type and an inequality are prose, not HTML", () => {
    expect(checkJiraMarkdown("Feltet er en List<String> og a < b < c.")).toEqual([]);
  });

  test("a ratio, a timestamp and a URL are not emoji shortcodes", () => {
    expect(checkJiraMarkdown("Forholdet 3:2:1 kl. 09:00:00, se https://example.test:8080/x")).toEqual([]);
  });

  test("`no. 2` is not an h-heading", () => {
    expect(checkJiraMarkdown("Se punkt h2 og no. 2 i listen.")).toEqual([]);
  });
});

// ── False positives and false negatives the first cut shipped ────────────────

describe("the scan is neither noisy nor blind", () => {
  test("INLINE CODE is masked — a tag the reader deliberately quoted is not raw HTML", () => {
    expect(kinds("Bruk `<div>` som eksempel.")).toEqual([]);
    expect(kinds("Skriv `h2.` i stedet for `## `.")).toEqual([]);
    // The same tag OUTSIDE the code span is still flagged.
    expect(kinds("Bruk `<div>` men ikke <span>her</span>.")).toEqual(["html"]);
  });

  test("HTML matching is case-insensitive — `<DIV>` mangles exactly like `<div>`", () => {
    expect(kinds("Se <DIV>her</DIV> for detaljer.")).toEqual(["html"]);
    expect(kinds("<BR/>")).toEqual(["html"]);
  });

  test("a markdown link whose text is `[x]` is NOT a task list", () => {
    expect(kinds("- [x](https://jira.adeo.no/browse/MELOSYS-1) er fikset")).toEqual([]);
    expect(kinds("- [ ] Krav")).toEqual(["task-list"]);
    // A checkbox followed by end-of-line still counts.
    expect(kinds("- [x]")).toEqual(["task-list"]);
  });

  test("one flag per LINE per KIND — four tags on a line is one row to read, not four", () => {
    const flags = checkJiraMarkdown("<div><span>a</span></div>");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe("html");
    // Two DIFFERENT kinds on one line still report separately.
    expect(kinds("<div>x</div> {code}")).toEqual(["html", "wiki-markup"]);
    // And the same kind on two lines is two rows.
    expect(checkJiraMarkdown("<div>a</div>\n<div>b</div>").map((f) => f.line)).toEqual([1, 2]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  answerStamp,
  exportHeading,
  exportStamp,
  formatAnswerExport,
  formatOrphanExport,
  quoteBody,
  restampAnswerExport,
  type ExportAnswer,
} from "./answer-export.ts";

// 2026-10-07 19:32 UTC = 21:32 in Oslo (CEST); 2026-01-15 08:05 UTC = 09:05 (CET).
const SUMMER = Date.UTC(2026, 9, 7, 19, 32);
const WINTER = Date.UTC(2026, 0, 15, 8, 5);

const a = (over: Partial<ExportAnswer> = {}): ExportAnswer => ({
  questionId: "O3",
  authorName: "Yvonne Jacobs",
  asked: true,
  createdAt: SUMMER,
  choice: "B",
  body: "The page's language.",
  version: 2,
  redacted: false,
  ...over,
});

describe("stamps are Oslo time, whatever the process zone", () => {
  test("summer and winter offsets", () => {
    expect(exportStamp(SUMMER)).toBe("2026-10-07 21:32");
    expect(answerStamp(SUMMER)).toBe("07.10.2026 21:32");
    expect(exportStamp(WINTER)).toBe("2026-01-15 09:05");
    expect(answerStamp(WINTER)).toBe("15.01.2026 09:05");
  });

  test("midnight renders 00, never 24", () => {
    expect(answerStamp(Date.UTC(2026, 9, 7, 22, 0))).toBe("08.10.2026 00:00");
  });
});

describe("the heading", () => {
  test("asked, a choice, a version", () => {
    expect(exportHeading(a())).toBe("### O3 — Yvonne Jacobs (asked), 07.10.2026 21:32, chose B, version 2");
  });
  test("not asked; no choice ⇒ no `chose`", () => {
    expect(exportHeading(a({ asked: false, choice: null }))).toBe("### O3 — Yvonne Jacobs (not asked), 07.10.2026 21:32, version 2");
  });
  test("asked null ⇒ no label", () => {
    expect(exportHeading(a({ asked: null }))).toBe("### O3 — Yvonne Jacobs, 07.10.2026 21:32, chose B, version 2");
  });
  test("the fixed not-sure value reads as words", () => {
    expect(exportHeading(a({ choice: "not-sure" }))).toContain(", chose not sure yet, ");
  });
  test("redacted replaces the choice", () => {
    expect(exportHeading(a({ redacted: true }))).toBe("### O3 — Yvonne Jacobs (asked), 07.10.2026 21:32, redacted, version 2");
  });
  test("a name or choice with a newline stays on one line", () => {
    expect(exportHeading(a({ authorName: "Ola\nNordmann", choice: "A\nB" }))).toBe(
      "### O3 — Ola Nordmann (asked), 07.10.2026 21:32, chose A B, version 2",
    );
  });
});

describe("the body is quoted word for word", () => {
  test("every line prefixed, an empty line a bare `>`, markup untouched", () => {
    expect(quoteBody("**Ja** — `kode`\n\n- æøå <b>x</b>\n  indent")).toEqual([
      "> **Ja** — `kode`",
      ">",
      "> - æøå <b>x</b>",
      ">   indent",
    ]);
  });
  test("an empty body quotes nothing", () => {
    expect(quoteBody("")).toEqual([]);
  });
});

describe("the block", () => {
  test("byte-exact: header, answers separated by a blank line, orphan trailer", () => {
    const block = formatAnswerExport({
      wiki: "mimir",
      relPath: "plans/spørsmål.mdx",
      exportedAt: WINTER,
      orphanCount: 1,
      answers: [
        a(),
        a({ questionId: "O4", authorName: "Kari Nordmann", asked: false, choice: null, body: "Første linje.\n\nTredje — «sitat».", version: 1 }),
        a({ questionId: "O5", asked: null, redacted: true, choice: null, body: "", version: 3 }),
      ],
    });
    expect(block).toBe(
      [
        "<!-- answers · mimir · plans/spørsmål.mdx · exported 2026-01-15 09:05 -->",
        "### O3 — Yvonne Jacobs (asked), 07.10.2026 21:32, chose B, version 2",
        "> The page's language.",
        "",
        "### O4 — Kari Nordmann (not asked), 07.10.2026 21:32, version 1",
        "> Første linje.",
        ">",
        "> Tredje — «sitat».",
        "",
        "### O5 — Yvonne Jacobs, 07.10.2026 21:32, redacted, version 3",
        "",
        "<!-- orphaned answers in mimir: 1 -->",
        "",
      ].join("\n"),
    );
  });

  test("no answers ⇒ empty string", () => {
    expect(formatAnswerExport({ wiki: "w", relPath: "p.md", exportedAt: SUMMER, orphanCount: 3, answers: [] })).toBe("");
  });

  test("a `-->` in the path cannot close the header comment", () => {
    const block = formatAnswerExport({ wiki: "w", relPath: "a-->b.md", exportedAt: SUMMER, orphanCount: 0, answers: [a()] });
    expect(block.split("\n")[0]).toBe("<!-- answers · w · a-- >b.md · exported 2026-10-07 21:32 -->");
  });
});

describe("answer export fix round 1: line breaks", () => {
  test("CRLF and a lone CR break lines like LF, and no \\r is left in the block", () => {
    expect(quoteBody("Ett.\r\n\r\nTo.\rTre.")).toEqual(["> Ett.", ">", "> To.", "> Tre."]);
    const block = formatAnswerExport({
      wiki: "w",
      relPath: "p.mdx",
      exportedAt: SUMMER,
      answers: [a({ body: "Linje én.\r\nLinje to." })],
      orphanCount: 0,
    });
    expect(block).not.toContain("\r");
    expect(block).toContain("> Linje én.\n> Linje to.\n");
  });
});

describe("answer export fix round 2: the orphan block", () => {
  test("byte-exact: one header for the wiki, each heading names its page and why, no trailer", () => {
    const block = formatOrphanExport({
      wiki: "mimir",
      exportedAt: WINTER,
      answers: [
        { ...a({ asked: null }), relPath: "plans/gammel.mdx", reason: "page_gone" },
        { ...a({ questionId: "O9", asked: null, choice: null, body: "Linje én.\r\nLinje to.", version: 1 }), relPath: "plans/ny\nside.mdx", reason: "question_gone" },
      ],
    });
    expect(block).toBe(
      [
        "<!-- orphaned answers · mimir · exported 2026-01-15 09:05 -->",
        "### O3 — Yvonne Jacobs, 07.10.2026 21:32, chose B, version 2 · plans/gammel.mdx, page gone",
        "> The page's language.",
        "",
        "### O9 — Yvonne Jacobs, 07.10.2026 21:32, version 1 · plans/ny side.mdx, question gone",
        "> Linje én.",
        "> Linje to.",
        "",
      ].join("\n"),
    );
  });

  test("no orphans ⇒ empty string; a `-->` in the wiki name cannot close the header", () => {
    expect(formatOrphanExport({ wiki: "w", exportedAt: SUMMER, answers: [] })).toBe("");
    const block = formatOrphanExport({ wiki: "a-->b", exportedAt: SUMMER, answers: [{ ...a(), relPath: "p.md", reason: "page_gone" }] });
    expect(block.split("\n")[0]).toBe("<!-- orphaned answers · a-- >b · exported 2026-10-07 21:32 -->");
  });

  test("the click restamps the orphan header like the page header", () => {
    const block = "<!-- orphaned answers · mimir · exported 2026-01-15 09:05 -->\n### O3 — x · p.md, page gone\n> y\n";
    const out = restampAnswerExport(block, SUMMER);
    expect(out.split("\n")[0]).toBe("<!-- orphaned answers · mimir · exported 2026-10-07 21:32 -->");
    expect(out.split("\n").slice(1)).toEqual(block.split("\n").slice(1));
  });
});

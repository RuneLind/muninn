import { describe, expect, test } from "bun:test";
import { renderWikiHtml } from "./render.ts";
import { formatWebHtml } from "../web/web-format.ts";

// D20/D49: where the reader's render stamps `data-item-date`, and from what.
// The parser's own cases are in `src/format/item-dates.test.ts`.

const none = () => undefined;

/** The `data-item-date` on the element whose opening tag starts with `open`. */
function stampOn(html: string, open: string): string | null {
  const at = html.indexOf(open);
  if (at < 0) throw new Error(`no ${open} in the render`);
  const tag = html.slice(at, html.indexOf(">", at) + 1);
  return /data-item-date="([^"]+)"/.exec(tag)?.[1] ?? null;
}

const page = (statusDate: string, body: string) =>
  ["---", "title: T", "type: plan", `status_date: ${statusDate}`, "---", "", body, ""].join("\n");

describe("item-date stamps on the reader path", () => {
  const html = renderWikiHtml(
    page(
      "2026-10-07",
      [
        "<DecisionLog>",
        "",
        "- **D1** — Vedtatt for alle saker. Fag, 01.10 (runde 1).",
        "  - Bekreftet på nytt 08.10.",
        "- **D2** — Se [[notatet|møtet 09.10]] for grunnlaget.",
        "- **D3** — Lukket 06.10, avgjøres tidligst 2099-01-01.",
        "- Et punkt uten id, avklart 05.10.",
        "",
        "</DecisionLog>",
        "",
        '<Query id="Q-1" question="Hvor mange?" answer="Tre" run="2026-10-09" />',
        "",
        '<Query id="Q-2" question="Hvor mange senere?" answer="Fire" run="2099-01-01" />',
        "",
        "<NextMoves>",
        "",
        '<Lane kind="waiting" who="fag" since="2026-10-04">',
        "",
        "- Spørsmål til fag",
        "",
        "</Lane>",
        "",
        "</NextMoves>",
      ].join("\n"),
    ),
    none,
    { today: "2026-10-11" },
  );

  test("a DecisionLog item's .dl-text, dated by a nested line's later date", () => {
    expect(stampOn(html, '<li class="dl-item dl-decision" id="d1"')).toBeNull();
    expect(stampOn(html.slice(html.indexOf('id="d1"')), '<span class="dl-text"')).toBe("2026-10-08");
  });

  test("a wikilink label's date counts", () => {
    expect(stampOn(html.slice(html.indexOf('id="d2"')), '<span class="dl-text"')).toBe("2026-10-09");
  });

  test("a date after the render day is skipped (D49)", () => {
    expect(stampOn(html.slice(html.indexOf('id="d3"')), '<span class="dl-text"')).toBe("2026-10-06");
  });

  test("an item with no id carries it on its <li>", () => {
    expect(stampOn(html, '<li class="dl-item dl-noid')).toBe("2026-10-05");
  });

  test("a Query on its .query-head, none for a run= after the render day", () => {
    expect(stampOn(html.slice(html.indexOf('id="q-1"')), '<div class="query-head"')).toBe("2026-10-09");
    expect(stampOn(html.slice(html.indexOf('id="q-2"')), '<div class="query-head"')).toBeNull();
  });

  test("a compact lane on its <details>", () => {
    expect(stampOn(html, '<details class="nm-lane')).toBe("2026-10-04");
  });
});

describe("the reference day", () => {
  const log = ["<DecisionLog>", "", "- **D1** — Vedtatt. Fag, 01.09 (runde 1).", "", "</DecisionLog>"].join("\n");

  test("a status_date with a trailing YAML comment is still the reference", () => {
    // Read against 2026-03-01, 01.09 is 2025-09-01 (181 days back, against
    // 184 forward); read against the render day 2026-10-11 it is 2026-09-01.
    const html = renderWikiHtml(page("2026-03-01 # lagging", log), none, { today: "2026-10-11" });
    expect(stampOn(html, '<span class="dl-text"')).toBe("2025-09-01");
  });
});

describe("chat", () => {
  test("formatWebHtml off the reader stamps nothing, even when given the days", () => {
    const html = formatWebHtml(
      [
        "<DecisionLog>",
        "",
        "- **D1** — Vedtatt. Fag, 01.10 (runde 1).",
        "- Uten id, 02.10.",
        "",
        "</DecisionLog>",
        "",
        '<Query id="Q-1" question="Hvor mange?" answer="Tre" run="2026-10-09" />',
      ].join("\n"),
      { itemDates: { ref: "2026-10-07", today: "2026-10-11" } },
    );
    expect(html).toContain("dl-item");
    expect(html).not.toContain("data-item-date");
  });
});

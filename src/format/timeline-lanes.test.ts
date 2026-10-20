import { describe, expect, test } from "bun:test";
import { renderWikiHtml } from "../wiki/render.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { OVERVIEW_HIDDEN } from "../dashboard/views/components/wiki-lens.ts";
import { PEEK_SKIP } from "../dashboard/views/components/wiki-ref-links.ts";
import { LANE_MIN_ITEMS, LANES_MIN, lanesDraw, pageTimelineLanes } from "./timeline-lanes.ts";

// Invented content only: a lending library.

const TODAY = "2026-10-01";
const DAYS = { ref: TODAY, today: TODAY };

const status = ["<StatusRows>", "", "- **Library:** open", "", "</StatusRows>", ""];
const log = (...items: string[]) => ["<DecisionLog>", "", ...items.map((i) => `- ${i}`), "", "</DecisionLog>", ""];
const timeline = (...items: string[]) => ["<Timeline>", "", ...items.map((i) => `- ${i}`), "", "</Timeline>", ""];
const query = (id: string, run: string) => [`<Query id="${id}" question="How many holds?" run="${run}" />`, ""];
const page = (...parts: string[][]) => parts.flat().join("\n");
const reader = (md: string, today = TODAY) => renderWikiHtml(md, () => undefined, { views: true, today });
const lanesOf = (html: string) => html.match(/<section class="dc-view tl-lanes"[\s\S]*?<\/section>/)?.[0] ?? "";
const marks = (html: string) =>
  [...lanesOf(html).matchAll(/<div class="tll-lane tll-(\w+)"[\s\S]*?<\/ol><\/div>/g)].map((m) => [
    m[1],
    [...m[0].matchAll(/inset-inline-start:([\d.]+)%" title="([^"]*)"/g)].map((x) => `${x[1]} ${x[2]}`),
  ]);

const FULL = page(
  status,
  log("**D1** — Hold a book for a week. 01.09.2026", "**D2** — Renewal twice. 2026-09-15", "**D3** — Undated rule."),
  query("Q-1", "2026-09-10"),
  timeline("**2026-09-01** — Opened", "**2026-09-15** — Renewal rule", "Undated note"),
);

describe("one lane per source, one axis", () => {
  test("each source's dated items, same-day items sharing a mark, positioned on one axis", () => {
    expect(marks(reader(FULL))).toEqual([
      ["decisions", ["0 2026-09-01: D1", "100 2026-09-15: D2"]],
      ["queries", ["64.3 2026-09-10: Q-1"]],
      ["timeline", ["0 2026-09-01: Opened", "100 2026-09-15: Renewal rule"]],
    ]);
  });

  test("a lane's day is the day the reader stamps on that item", () => {
    const html = reader(FULL);
    const stamped = [...html.matchAll(/data-item-date="([\d-]+)"/g)].map((m) => m[1]).sort();
    const laned = [...lanesOf(html).matchAll(/title="([\d-]+):/g)].map((m) => m[1]);
    // Every log and query stamp is in its lane; the Timeline adds its own two.
    expect(stamped).toEqual(["2026-09-01", "2026-09-10", "2026-09-15"]);
    for (const d of stamped) expect(laned).toContain(d);
  });

  test("overlapping days across lanes sit at one x; within a lane they share a mark", () => {
    const md = page(status, log("**D1** — A. 2026-09-01", "**D2** — B. 2026-09-01", "**D3** — C. 2026-09-11"), timeline("**2026-09-01** — X", "**2026-09-11** — Y"));
    expect(marks(reader(md))).toEqual([
      ["decisions", ["0 2026-09-01: D1, D2", "100 2026-09-11: D3"]],
      ["timeline", ["0 2026-09-01: X", "100 2026-09-11: Y"]],
    ]);
    expect(lanesOf(reader(md))).toContain('<span class="tll-n" aria-hidden="true">2</span>');
  });

  test("every item on one day draws at the middle", () => {
    const md = page(status, log("**D1** — A. 2026-09-01", "**D2** — B. 2026-09-01"), query("Q-1", "2026-09-01"), query("Q-2", "2026-09-01"));
    expect(marks(reader(md))).toEqual([
      ["decisions", ["50 2026-09-01: D1, D2"]],
      ["queries", ["50 2026-09-01: Q-1, Q-2"]],
    ]);
  });

  test("two DecisionLogs are one lane; a block inside a Fold counts; a fenced fake does not", () => {
    const md = page(
      status,
      log("**D1** — A. 2026-09-01"),
      ["<Fold title=\"More\">", "", ...log("**D2** — B. 2026-09-05"), "</Fold>", ""],
      ["```", ...log("**D9** — Fake. 2026-09-09"), "```", ""],
      timeline("**2026-09-02** — X", "**2026-09-03** — Y"),
    );
    expect(marks(reader(md)).map(([k, m]) => [k, (m as string[]).map((x) => x.split(" ").slice(1).join(" "))])).toEqual([
      ["decisions", ["2026-09-01: D1", "2026-09-05: D2"]],
      ["timeline", ["2026-09-02: X", "2026-09-03: Y"]],
    ]);
  });
});

describe("the threshold", () => {
  test(`draws at ${LANES_MIN} lanes of ${LANE_MIN_ITEMS} dated items, not one item fewer`, () => {
    expect([LANES_MIN, LANE_MIN_ITEMS]).toEqual([2, 2]);
    const two = page(status, log("**D1** — A. 2026-09-01", "**D2** — B. 2026-09-02"), timeline("**2026-09-03** — X", "**2026-09-04** — Y"));
    const short = page(status, log("**D1** — A. 2026-09-01", "**D2** — B. 2026-09-02"), timeline("**2026-09-03** — X", "Undated"));
    const one = page(status, log("**D1** — A. 2026-09-01", "**D2** — B. 2026-09-02", "**D3** — C. 2026-09-03"));
    expect(lanesOf(reader(two))).not.toBe("");
    expect(lanesOf(reader(short))).toBe("");
    expect(lanesOf(reader(one))).toBe("");
  });

  test("once it draws, a lane with one dated item is drawn too", () => {
    expect(marks(reader(FULL)).map(([k]) => k)).toEqual(["decisions", "queries", "timeline"]);
  });

  test("lanesDraw over the parsed lanes", () => {
    const lanes = pageTimelineLanes(parseBlocks(FULL), DAYS);
    expect(lanes.map((l) => [l.kind, l.items.length])).toEqual([["decisions", 2], ["queries", 1], ["timeline", 2]]);
    expect(lanesDraw(lanes)).toBe(true);
    expect(lanesDraw(lanes.slice(1))).toBe(false);
  });
});

describe("dates", () => {
  test("Norwegian and ISO dates, yearless by the page's status_date, a time after a date", () => {
    const md = [
      "---",
      "status_date: 2026-09-20",
      "---",
      "",
      page(status, log("**D1** — A. 07.09", "**D2** — B. 08.09.2026"), timeline("**2026-09-09 14:05** — X", "**10.09** — Y")),
    ].join("\n");
    expect(marks(reader(md)).map(([k, m]) => [k, (m as string[]).map((x) => x.split(" ")[1])])).toEqual([
      ["decisions", ["2026-09-07:", "2026-09-08:"]],
      ["timeline", ["2026-09-09:", "2026-09-10:"]],
    ]);
  });

  test("a log date after the render day is skipped, a planned Timeline step is kept", () => {
    const md = page(status, log("**D1** — A. 2026-09-01", "**D2** — Due 2026-12-01.", "**D3** — C. 2026-09-02"), timeline("**2026-09-01** — X", "**2026-12-01** — Planned"));
    expect(marks(reader(md))).toEqual([
      ["decisions", ["0 2026-09-01: D1", "1.1 2026-09-02: D3"]],
      ["timeline", ["0 2026-09-01: X", "100 2026-12-01: Planned"]],
    ]);
  });

  test("a `no` wiki labels in Norwegian and writes days day first", () => {
    const html = renderWikiHtml(FULL, () => undefined, { views: true, today: TODAY, language: "no" } as Parameters<typeof renderWikiHtml>[2]);
    const lanes = lanesOf(html);
    expect(lanes).toContain('aria-label="Datoer på siden"');
    expect(lanes).toContain('aria-label="Beslutninger: 2 datert"');
    expect(lanes).toContain('title="01.09.2026: D1"');
    expect(lanes).toContain('<div class="tll-axis" aria-hidden="true"><span>01.09.2026</span><span>15.09.2026</span></div>');
  });
});

describe("placement and surfaces", () => {
  test("in the view slot after the StatusRows, a named figure of named groups, reader-only", () => {
    const html = reader(FULL);
    const lanes = lanesOf(html);
    expect(lanes.startsWith('<section class="dc-view tl-lanes" data-reader-only role="figure" aria-label="Dates on this page">')).toBe(true);
    expect([...lanes.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Decisions: 2 dated", "Queries: 1 dated", "Timeline: 2 dated"]);
    expect(html.indexOf("status-rows")).toBeLessThan(html.indexOf("tl-lanes"));
    expect(html.indexOf("tl-lanes")).toBeLessThan(html.indexOf("decision-log"));
  });

  test("after the decision chain view, in the same slot", () => {
    const next = ["<NextMoves>", "", '<Lane kind="you">', "", "1. Shelve the returns.", "", "</Lane>", "", "</NextMoves>", ""];
    const html = reader(
      page(
        next,
        log(
          "**S1** — Which shelf? Closed 2026-09-02 (D1).",
          "**S2** — How long a Hold? Closed 2026-09-04 (D2).",
          "**S3** — How many Renewals? Closed 2026-09-06 (D3).",
          "**D1** — The front shelf.",
          "**D2** — One week.",
          "**D3** — Two.",
        ),
        timeline("**2026-09-01** — Opened", "**2026-09-20** — Renewal rule"),
      ),
    );
    expect(html.indexOf("dc-chain")).toBeGreaterThan(html.indexOf("Shelve the returns."));
    expect(html.indexOf("tl-lanes")).toBeGreaterThan(html.indexOf("dc-chain"));
    expect(html.indexOf("decision-log")).toBeGreaterThan(html.indexOf("tl-lanes"));
  });

  test("no view slot, no lanes; views off, no lanes", () => {
    expect(lanesOf(reader(FULL.replace(page(status), "")))).toBe("");
    expect(renderWikiHtml(FULL, () => undefined, { today: TODAY })).not.toContain("tl-lanes");
  });

  test("Overview and All show the lanes; a peek skips them", () => {
    expect(OVERVIEW_HIDDEN.some((sel) => /tl-lanes|tll-|dc-view/.test(sel))).toBe(false);
    expect(PEEK_SKIP).toContain(".dc-view");
  });

  test("chat, Telegram, Slack and email never see a lane", () => {
    for (const out of [formatWebHtml(FULL), formatWebHtml(FULL, { views: true }), formatTelegramHtml(FULL), formatSlackMrkdwn(FULL), formatEmailHtml(FULL)]) {
      expect(out).not.toContain("tll-");
    }
  });
});

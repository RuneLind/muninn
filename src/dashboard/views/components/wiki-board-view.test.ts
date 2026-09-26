/**
 * The issue board's pure half: flag derivation, each filter, the URL state,
 * and the markup rules that matter (no `$0` for an unpriced key, "not tracked",
 * no cost total). Synthetic keys (`DEMO`).
 */

import { describe, expect, test } from "bun:test";
import {
  boardGraphUrl,
  boardKpisHtml,
  boardNotes,
  boardRows,
  boardTableHtml,
  filterBoardRows,
  issueFlags,
  keylessTableHtml,
  parseBoardFilter,
  searchWithBoardFilter,
  type BoardRow,
} from "./wiki-board-view.ts";
import { readDisplayParams } from "./wiki-filter.ts";
import type { GraphIssueNode, GraphPageNode } from "../../../wiki/graph-types.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 20);

const node = (key: string, over: Partial<GraphIssueNode> = {}): GraphIssueNode => ({
  id: `issue:jira:${key}`,
  lane: "issue",
  hop: 0,
  tracker: "jira",
  key,
  label: "Jira",
  url: `https://example.invalid/browse/${key}`,
  pageCount: 1,
  planPages: [],
  stampedCount: 1,
  lastActivityMs: NOW - DAY,
  prRefs: [],
  ...over,
});
const plan = [{ relPath: "plans/p.md", title: "Plan" }];

describe("issueFlags", () => {
  test("no plan, unknown key and 0 stamped, each on its own condition", () => {
    expect(issueFlags(node("DEMO-101", { planPages: plan, known: true }), true)).toEqual([]);
    expect(issueFlags(node("DEMO-102", { known: true }), true)).toEqual(["no plan"]);
    expect(issueFlags(node("DEMO-103", { planPages: plan, known: false }), true)).toEqual(["unknown key"]);
    expect(issueFlags(node("DEMO-104", { planPages: plan, stampedCount: 0 }), true)).toEqual(["0 stamped"]);
  });
  test("unknown key only when the lookup answered", () => {
    expect(issueFlags(node("DEMO-103", { planPages: plan, known: false }), false)).toEqual([]);
  });
});

describe("boardRows", () => {
  test("newest activity first, then key; flags read the payload's lookup state", () => {
    const rows = boardRows({
      nodes: [node("DEMO-102", { lastActivityMs: NOW - 5 * DAY }), node("DEMO-101", { lastActivityMs: NOW - 5 * DAY }), node("DEMO-150", { lastActivityMs: NOW, known: false })],
      issueLookup: { available: true },
    });
    expect(rows.map((r) => r.node.key)).toEqual(["DEMO-150", "DEMO-101", "DEMO-102"]);
    expect(rows[0]!.flags).toContain("unknown key");
  });
});

describe("filterBoardRows", () => {
  const rows: BoardRow[] = boardRows({
    nodes: [
      node("DEMO-101", { category: "active", planPages: plan, title: "Grunnfeilen", lastActivityMs: NOW - 2 * DAY }),
      node("DEMO-102", { category: "todo", lastActivityMs: NOW - 30 * DAY }),
      node("DEMO-103", { category: "done", planPages: plan, lastActivityMs: NOW - 3 * DAY }),
      node("DEMO-104", { category: "done", lastActivityMs: NOW - 40 * DAY }),
      // No category: the lookup did not answer. Open, since nothing says done.
      node("DEMO-105", { planPages: plan, lastActivityMs: NOW - 60 * DAY }),
    ],
    issueLookup: { available: true },
  });
  const keys = (show: Parameters<typeof filterBoardRows>[1]["show"], q = "") =>
    filterBoardRows(rows, { show, q }, NOW).map((r) => r.node.key).sort();

  test("all", () => expect(keys("all")).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-105"]));
  test("open: every category but done", () => expect(keys("open")).toEqual(["DEMO-101", "DEMO-102", "DEMO-105"]));
  test("open without a plan", () => expect(keys("noplan")).toEqual(["DEMO-102"]));
  test("active in 14 days", () => expect(keys("active")).toEqual(["DEMO-101", "DEMO-103"]));
  test("flagged: any flag", () => expect(keys("flagged")).toEqual(["DEMO-102", "DEMO-104"]));
  test("text matches key or title, case-insensitively, and composes with show", () => {
    expect(keys("all", "grunnfeil")).toEqual(["DEMO-101"]);
    expect(keys("all", "demo-10")).toHaveLength(5);
    expect(keys("open", "103")).toEqual([]);
  });
});

describe("URL state", () => {
  test("parse and write round-trip; the default leaves no param", () => {
    expect(parseBoardFilter("?wiki=w&show=noplan&q=feil")).toEqual({ show: "noplan", q: "feil" });
    expect(parseBoardFilter("?wiki=w&show=bogus")).toEqual({ show: "all", q: "" });
    expect(searchWithBoardFilter("?wiki=w&show=open", { show: "all", q: "" })).toBe("?wiki=w");
    expect(searchWithBoardFilter("?wiki=w", { show: "active", q: " x " })).toBe("?wiki=w&show=active&q=x");
  });
  test("a row's graph link is PR 4's deep link, read back as graph mode rooted at the key", () => {
    const href = boardGraphUrl("demo wiki", "jira", "DEMO-101");
    expect(href).toBe("/wiki?wiki=demo%20wiki&display=graph&issue=jira%3ADEMO-101");
    expect(readDisplayParams(href.slice(href.indexOf("?")))).toEqual({ graph: true, issue: "jira:DEMO-101" });
  });
});

describe("markup", () => {
  test("a priced key shows its sessions and cost; unpriced and not-tracked keys never read $0", () => {
    const html = boardTableHtml(
      boardRows({
        nodes: [
          node("DEMO-101", { keyLedger: { state: "priced", sessions: 3, totalCost: 4.5, costedSessions: 3, truncated: false, lastSeen: null } }),
          node("DEMO-102", { keyLedger: { state: "unpriced", reason: "unreachable" } }),
          node("DEMO-103", { keyLedger: { state: "not-tracked" } }),
          node("DEMO-104", { keyLedger: { state: "priced", sessions: 0, totalCost: 0, costedSessions: 0, truncated: false, lastSeen: null } }),
        ],
      }),
      "w",
    );
    expect(html).toContain(">$4.50<");
    expect(html).toContain(">not tracked<");
    expect(html).not.toContain("$0");
  });
  test("KPIs are counts, never a cost total", () => {
    const rows = boardRows({
      nodes: [node("DEMO-101", { keyLedger: { state: "priced", sessions: 2, totalCost: 7, costedSessions: 2, truncated: false, lastSeen: null } })],
    });
    const html = boardKpisHtml(rows, 3);
    expect(html).not.toContain("$");
    expect(html).toContain('data-kpi="keyless"><b>3</b>');
  });
  test("the keyless table lists each page with its PRs", () => {
    const page: GraphPageNode = {
      id: "page:loose.md",
      lane: "page",
      hop: 0,
      relPath: "loose.md",
      title: "Løs <side>",
      type: "note",
      pageTimeMs: NOW,
      prRefs: ["example-org/demo-repo#9"],
      plan: false,
    };
    const html = keylessTableHtml([page], "w");
    expect(html).toContain('data-keyless="loose.md"');
    expect(html).toContain("Løs &lt;side&gt;");
    expect(html).toContain("demo-repo#9");
    expect(keylessTableHtml([], "w")).toContain("Every page relates to a key");
  });
  test("notes say what degraded", () => {
    expect(boardNotes({ keysLedger: { configured: true, calls: 1, reachable: false, timedOut: false } })).toEqual([
      "Session ledger unavailable: sessions and cost are not shown.",
    ]);
    expect(boardNotes({ issueLookup: { available: false } })[0]).toContain("no key is flagged unknown");
    expect(boardNotes({ truncated: true, truncatedBy: ["nodes"] })[0]).toContain("first 1500 keys");
    expect(boardNotes({ issueLookup: { available: true }, keysLedger: { configured: true, calls: 1, reachable: true, timedOut: false } })).toEqual([]);
  });
});

describe("fix round 1", () => {
  /** Run `fn` with the process in `tz`, restoring the zone it had. */
  const inZone = <T>(tz: string, fn: () => T): T => {
    const prev = process.env.TZ;
    const was = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = prev ?? was;
    }
  };

  test("C4: a bare frontmatter day renders as that day west of UTC, in both tables", () => {
    const ms = Date.parse("2026-09-24");
    const html = inZone("America/New_York", () => ({
      row: boardTableHtml(boardRows({ nodes: [node("DEMO-101", { lastActivityMs: ms })] }), "w"),
      keyless: keylessTableHtml([{ id: "page:l.md", lane: "page", hop: 0, relPath: "l.md", title: "L", type: "note", pageTimeMs: ms, plan: false }], "w"),
    }));
    expect(html.row).toContain('data-last>2026-09-24<');
    expect(html.keyless).toContain(">2026-09-24<");
  });

  test("C5: active keeps a page dated exactly 14 calendar days back, at any time of day", () => {
    const evening = new Date(2026, 0, 20, 18).getTime();
    const rows = boardRows({
      nodes: [node("DEMO-101", { lastActivityMs: Date.parse("2026-01-06") }), node("DEMO-102", { lastActivityMs: Date.parse("2026-01-05") })],
    });
    expect(filterBoardRows(rows, { show: "active", q: "" }, evening).map((r) => r.node.key)).toEqual(["DEMO-101"]);
  });

  test("C6: a tie sorts by project, then by the key's number", () => {
    const at = NOW - DAY;
    const rows = boardRows({
      nodes: ["DEMO-100", "DEMO-10", "DEMO-9", "ABC-5"].map((k) => node(k, { lastActivityMs: at })),
    });
    expect(rows.map((r) => r.node.key)).toEqual(["ABC-5", "DEMO-9", "DEMO-10", "DEMO-100"]);
  });

  test("C7: one failed batch of several says how many keys went unpriced, not that the ledger is unavailable", () => {
    const priced = { state: "priced", sessions: 1, totalCost: 1, costedSessions: 1, truncated: false, lastSeen: null } as const;
    const nodes = [
      node("DEMO-101", { keyLedger: priced }),
      node("DEMO-102", { keyLedger: priced }),
      node("DEMO-103", { keyLedger: { state: "unpriced", reason: "unreachable" } }),
    ];
    const notes = boardNotes({ nodes, keysLedger: { configured: true, calls: 2, reachable: false, timedOut: false } });
    expect(notes).toEqual(["1 key could not be priced: the session ledger did not answer for it."]);
  });

  test("C8: a key the ledger returned no row for has its own reason, tooltip and note", () => {
    const nodes = [node("DEMO-101", { keyLedger: { state: "unpriced", reason: "no-row" } as never })];
    const html = boardTableHtml(boardRows({ nodes }), "w");
    expect(html).toContain('title="the session ledger returned no usable row for this key"');
    expect(boardNotes({ nodes, keysLedger: { configured: true, calls: 1, reachable: true, timedOut: false } })).toEqual([
      "1 key got no row from the session ledger: sessions and cost are not shown for it.",
    ]);
  });

  test("C9: a priced key whose cost arrived as null renders — and does not throw", () => {
    const keyLedger = { state: "priced", sessions: 2, totalCost: null, costedSessions: 2, truncated: false, lastSeen: null } as never;
    const html = boardTableHtml(boardRows({ nodes: [node("DEMO-101", { keyLedger })] }), "w");
    expect(html).toContain('data-cost="priced" title="2 sessions">—<');
  });

  test("C15: the default wiki's links carry no empty wiki param", () => {
    expect(boardGraphUrl("", "jira", "DEMO-101")).toBe("/wiki?display=graph&issue=jira%3ADEMO-101");
  });
});

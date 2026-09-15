/**
 * The provenance view's copy family, enumerated.
 *
 * The seven cost lines are a TABLE rather than seven spot checks because the
 * defect this module exists to prevent is two states collapsing into one
 * sentence — "claude-usage unreachable" on a host that was never pointed at one,
 * or on a page whose only problem is a damaged frontmatter line. A table makes
 * the states visible beside each other; a spot check per state does not.
 */

import { describe, expect, test } from "bun:test";
import {
  BARE_CHIP_COPY,
  chipView,
  clipTitle,
  costLine,
  jiraChipView,
  money,
  providerGlyph,
  provStripHtml,
  sessionsRailHtml,
  sessionsSectionVisible,
} from "./wiki-provenance-view.ts";
import type { ProvenancePayload, ProvenanceSessionChip } from "../../../wiki/provenance.ts";
import type { WikiFilters } from "./wiki-filter.ts";

function chip(over: Partial<ProvenanceSessionChip> = {}): ProvenanceSessionChip {
  return {
    ref: "claude-code:abc",
    provider: "claude-code",
    id: "abc",
    title: null,
    host: null,
    first: null,
    last: null,
    cost: null,
    messages: null,
    missing: false,
    unresolved: false,
    invalid: false,
    ...over,
  };
}

function payload(over: Partial<ProvenancePayload> = {}): ProvenancePayload {
  return {
    sessions: [],
    jira: [],
    prs: [],
    totalCost: 0,
    costedSessions: 0,
    ledger: { asked: false, reachable: false, partial: false, configured: false },
    ...over,
  };
}

const noFilters: WikiFilters = {
  q: "",
  domain: "",
  folder: "",
  type: "",
  tag: "",
  status: "",
  followups: "",
  project: "",
  jira: "",
};

describe("costLine", () => {
  // Every row is (name, payload, expected). `null` means "say nothing".
  const cases: Array<[string, ProvenancePayload, string | null]> = [
    [
      "jira-only page: nothing to say about money",
      payload({ jira: [{ key: "MELOSYS-1", url: "https://x/1" }] }),
      null,
    ],
    [
      "unconfigured host: not an outage",
      payload({
        sessions: [chip(), chip({ id: "def" })],
        ledger: { asked: false, reachable: false, partial: false, configured: false },
      }),
      "2 sessions wrote this page — no claude-usage on this host",
    ],
    [
      "configured but every id damaged: nobody asked, and nobody could",
      payload({
        sessions: [chip({ invalid: true })],
        ledger: { asked: false, reachable: false, partial: false, configured: true },
      }),
      "1 session ref — none could be looked up",
    ],
    [
      "asked and unreachable: the ledger really is down",
      payload({
        sessions: [chip(), chip({ id: "def" }), chip({ id: "ghi" })],
        ledger: { asked: true, reachable: false, partial: false, configured: true, baseUrl: "http://x" },
      }),
      "3 sessions wrote this page — claude-usage unreachable, cost unknown",
    ],
    [
      "priced and complete",
      payload({
        sessions: [chip({ cost: 1.2 }), chip({ id: "def", cost: 2 })],
        totalCost: 3.2,
        costedSessions: 2,
        ledger: { asked: true, reachable: true, partial: false, configured: true },
      }),
      "the 2 sessions that wrote this page cost $3.20 in total",
    ],
    [
      "priced, one chip the ledger does not hold",
      payload({
        sessions: [chip({ cost: 12.34 }), chip({ id: "def", missing: true })],
        totalCost: 12.34,
        costedSessions: 1,
        ledger: { asked: true, reachable: true, partial: false, configured: true },
      }),
      "the 2 sessions that wrote this page cost $12.34 in total over 1 of 2",
    ],
    [
      "partial: the total is over a subset, and says so",
      payload({
        sessions: [chip({ cost: 5 }), chip({ id: "def", unresolved: true })],
        totalCost: 5,
        costedSessions: 1,
        ledger: { asked: true, reachable: true, partial: true, configured: true },
      }),
      "the 2 sessions that wrote this page cost at least $5.00 — the ledger answered for 1 of 2",
    ],
    [
      "one session, singular everywhere",
      payload({
        sessions: [chip({ cost: 0.5 })],
        totalCost: 0.5,
        costedSessions: 1,
        ledger: { asked: true, reachable: true, partial: false, configured: true },
      }),
      "the 1 session that wrote this page cost $0.50 in total",
    ],
  ];

  for (const [name, p, expected] of cases) {
    test(name, () => {
      expect(costLine(p)).toBe(expected);
    });
  }

  test("an unconfigured host with NO sessions says nothing at all", () => {
    expect(costLine(payload())).toBeNull();
  });

  test("backfilled rides every state, including the degraded ones", () => {
    const base = {
      sessions: [chip({ cost: 1 })],
      totalCost: 1,
      costedSessions: 1,
      backfilled: "2026-10-14",
    };
    expect(
      costLine(payload({ ...base, ledger: { asked: true, reachable: true, partial: false, configured: true } })),
    ).toBe("the 1 session that wrote this page cost $1.00 in total · inferred from history 2026-10-14");
    expect(
      costLine(payload({ ...base, ledger: { asked: true, reachable: false, partial: false, configured: true } })),
    ).toBe(
      "1 session wrote this page — claude-usage unreachable, cost unknown · inferred from history 2026-10-14",
    );
    expect(
      costLine(payload({ ...base, ledger: { asked: false, reachable: false, partial: false, configured: false } })),
    ).toBe("1 session wrote this page — no claude-usage on this host · inferred from history 2026-10-14");
  });

  test("the unconfigured and the unreachable lines are never the same sentence", () => {
    const sessions = [chip()];
    const unconfigured = costLine(
      payload({ sessions, ledger: { asked: false, reachable: false, partial: false, configured: false } }),
    );
    const unreachable = costLine(
      payload({ sessions, ledger: { asked: true, reachable: false, partial: false, configured: true } }),
    );
    expect(unconfigured).not.toBe(unreachable);
    expect(unconfigured).not.toContain("unreachable");
  });
});

describe("chipView", () => {
  test("a priced chip carries money, a date, a host and a title", () => {
    const v = chipView(
      chip({
        provider: "claude-code",
        id: "5a2e",
        title: "Wiki provenance — PR 4a",
        host: "macmini",
        first: "2026-09-15",
        last: "2026-09-15",
        cost: 12.34,
      }),
    );
    expect(v).toMatchObject({
      glyph: "◆",
      providerLabel: "claude-code",
      dateLabel: "2026-09-15",
      dateTitle: "",
      host: "macmini",
      title: "Wiki provenance — PR 4a",
      costLabel: "$12.34",
      bareCopy: null,
      id: "5a2e",
      url: null,
    });
  });

  test("`last` becomes a hover only when it differs from `first`", () => {
    expect(chipView(chip({ first: "2026-09-01", last: "2026-09-03" })).dateTitle).toBe(
      "2026-09-01 → 2026-09-03",
    );
    expect(chipView(chip({ first: "2026-09-01", last: "2026-09-01" })).dateTitle).toBe("");
  });

  test("each bare reason gets its OWN copy, and never money", () => {
    for (const reason of ["invalid", "unresolved", "missing"] as const) {
      const v = chipView(chip({ [reason]: true, cost: 9 }));
      expect(v.bareCopy).toBe(BARE_CHIP_COPY[reason]);
      expect(v.costLabel).toBeNull();
    }
    // The three sentences are distinguishable, which is the whole contract.
    const copies = new Set(Object.values(BARE_CHIP_COPY));
    expect(copies.size).toBe(3);
  });

  test("precedence follows the server's `bareChipReason`, not a local guess", () => {
    // The payload says at most one flag is set; a client that re-derived the
    // order would disagree here rather than fail loudly.
    expect(chipView(chip({ invalid: true, unresolved: true, missing: true })).bareCopy).toBe(
      BARE_CHIP_COPY.invalid,
    );
    expect(chipView(chip({ unresolved: true, missing: true })).bareCopy).toBe(BARE_CHIP_COPY.unresolved);
  });

  test("a known-but-unpriced session shows `—`, not a missing-chip sentence", () => {
    const v = chipView(chip({ cost: null }));
    expect(v.costLabel).toBe("—");
    expect(v.bareCopy).toBeNull();
  });

  test("the drill-down url rides through only when the server built one", () => {
    expect(chipView(chip({ url: "https://usage.example.test/#/session/abc" })).url).toBe(
      "https://usage.example.test/#/session/abc",
    );
    expect(chipView(chip()).url).toBeNull();
  });

  test("a bare chip never carries a drill-down, even when the server built one", () => {
    for (const reason of ["invalid", "unresolved", "missing"] as const) {
      expect(chipView(chip({ [reason]: true, url: "https://usage.example.test/#/session/abc" })).url)
        .toBeNull();
    }
  });

  test("provider glyphs, including the neutral one", () => {
    expect(providerGlyph("claude-code")).toBe("◆");
    expect(providerGlyph("opencode")).toBe("◇");
    expect(providerGlyph("codex")).toBe("•");
    expect(providerGlyph(null)).toBe("•");
    expect(chipView(chip({ provider: null })).providerLabel).toBe("unknown provider");
  });

  test("titles clip for the row and keep the full string for the hover", () => {
    const long = "x".repeat(80);
    const v = chipView(chip({ title: long }));
    expect(v.title.length).toBe(60);
    expect(v.title.endsWith("…")).toBe(true);
    expect(v.titleFull).toBe(long);
    expect(clipTitle("short")).toBe("short");
  });
});

describe("jiraChipView", () => {
  test("`huginnKnown` marks the chip only when it is literally true", () => {
    expect(jiraChipView({ key: "MELOSYS-1", url: "https://x/1", huginnKnown: true }).known).toBe(true);
    expect(jiraChipView({ key: "MELOSYS-1", url: "https://x/1", huginnKnown: false }).known).toBe(false);
    // Absent means nobody asked — not "fabricated".
    expect(jiraChipView({ key: "MELOSYS-1", url: "https://x/1" }).known).toBe(false);
  });
});

describe("provStripHtml", () => {
  const priced = payload({
    sessions: [chip({ cost: 1 })],
    jira: [{ key: "MELOSYS-8045", url: "https://nav.atlassian.net/browse/MELOSYS-8045", huginnKnown: true }],
    prs: [{ ref: "navikt/melosys-api#1234", url: "https://github.com/navikt/melosys-api/pull/1234" }],
    totalCost: 1,
    costedSessions: 1,
    ledger: { asked: true, reachable: true, partial: false, configured: true },
  });

  test("renders the Jira link, the filter affordance and the cost line", () => {
    const html = provStripHtml(priced);
    expect(html).toContain(`href="https://nav.atlassian.net/browse/MELOSYS-8045"`);
    expect(html).toContain(`data-prov-jira="MELOSYS-8045"`);
    expect(html).toContain("wiki-prov-known");
    expect(html).toContain("cost $1.00 in total");
  });

  test("renders NOTHING for `prs` — the PR row ships with campaign 2", () => {
    expect(provStripHtml(priced)).not.toContain("1234");
    expect(provStripHtml(priced)).not.toContain("melosys-api");
  });

  test("a payload with no jira and no cost line renders no strip at all", () => {
    expect(provStripHtml(payload({ prs: [{ ref: "a/b#1", url: null }] }))).toBe("");
  });

  test("user-controlled values are escaped", () => {
    const html = provStripHtml(
      payload({ jira: [{ key: `A-1"><img src=x>`, url: `https://x/"><img src=x>` }] }),
    );
    expect(html).not.toContain("<img");
  });
});

describe("sessionsRailHtml", () => {
  test("a priced row carries glyph, date, host, title, money and the id", () => {
    const html = sessionsRailHtml([
      chip({
        id: "5a2ee3f0",
        provider: "claude-code",
        host: "macmini",
        title: "Wiki provenance — PR 4a",
        first: "2026-09-15",
        cost: 12.34,
        url: "https://usage.example.test/#/session/5a2ee3f0",
      }),
    ]);
    expect(html).toContain(`data-section="sessions"`);
    expect(html).toContain("◆");
    expect(html).toContain("2026-09-15");
    expect(html).toContain("macmini");
    expect(html).toContain("$12.34");
    expect(html).toContain("<code class=\"wiki-sess-id\">5a2ee3f0</code>");
    expect(html).toContain(`data-sess-copy="5a2ee3f0"`);
    expect(html).toContain(`href="https://usage.example.test/#/session/5a2ee3f0"`);
  });

  test("a bare row carries the id and its reason, and NO link", () => {
    const html = sessionsRailHtml([chip({ id: "ses_7f3a", missing: true })]);
    expect(html).toContain("wiki-sess-bare");
    expect(html).toContain(BARE_CHIP_COPY.missing);
    expect(html).toContain(`data-sess-copy="ses_7f3a"`);
    expect(html).not.toContain("wiki-sess-link");
    expect(html).not.toContain("$");
  });

  test("no sessions, no section", () => {
    expect(sessionsRailHtml([])).toBe("");
  });

  test("rows carry no `data-relpath` — the navigation delegate must not claim them", () => {
    const html = sessionsRailHtml([chip({ id: "a", title: "t", cost: 1 })]);
    expect(html).not.toContain("data-relpath");
    expect(html).not.toContain("wiki-list-item");
  });

  test("a ledger-supplied title is escaped", () => {
    const html = sessionsRailHtml([chip({ title: `<img src=x onerror=1>` })]);
    expect(html).not.toContain("<img");
  });
});

describe("sessionsSectionVisible", () => {
  test("needs sessions AND an empty query", () => {
    expect(sessionsSectionVisible(noFilters, [chip()])).toBe(true);
    expect(sessionsSectionVisible(noFilters, [])).toBe(false);
    expect(sessionsSectionVisible(noFilters, null)).toBe(false);
    expect(sessionsSectionVisible({ ...noFilters, q: "provenance" }, [chip()])).toBe(false);
    // A whitespace-only query is not a query — `railSectionsVisible`'s rule.
    expect(sessionsSectionVisible({ ...noFilters, q: "  " }, [chip()])).toBe(true);
  });

  test("a facet narrows the page list but does not hide the open page's sessions", () => {
    expect(sessionsSectionVisible({ ...noFilters, type: "plan", jira: "MELOSYS-1" }, [chip()])).toBe(true);
  });
});

describe("money", () => {
  test("always two decimals", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(5.3)).toBe("$5.30");
    expect(money(12.345)).toBe("$12.35");
  });
});

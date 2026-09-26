/**
 * The provenance view's copy family, enumerated.
 *
 * The eight cost lines are a TABLE rather than eight spot checks because the
 * defect this module exists to prevent is two states collapsing into one
 * sentence — "claude-usage unreachable" on a host that was never pointed at one,
 * or on a page whose only problem is a damaged frontmatter line. A table makes
 * the states visible beside each other; a spot check per state does not.
 */

import { describe, expect, test } from "bun:test";
import {
  BARE_CHIP_COPY,
  chainHtml,
  chipView,
  clipTitle,
  costLine,
  jiraChipView,
  money,
  providerGlyph,
  provStripHtml,
  railListHtml,
  stripChipViews,
} from "./wiki-provenance-view.ts";
import { LINKS_NOT_ASKED } from "../../../wiki/provenance.ts";
import type { ProvenancePayload, ProvenanceSessionChip } from "../../../wiki/provenance.ts";

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
    model: null,
    delegatedCost: null,
    missing: false,
    unresolved: false,
    invalid: false,
    ...over,
  };
}

function payload(over: Partial<ProvenancePayload> = {}): ProvenancePayload {
  return {
    sessions: [],
    ghosts: [],
    handoffs: [],
    stampable: false,
    links: LINKS_NOT_ASKED,
    jira: [],
    prs: [],
    merges: [],
    totalCost: 0,
    costedSessions: 0,
    ledger: { asked: false, reachable: false, partial: false, configured: false },
    mergesLedger: { asked: false, reachable: false, partial: false, truncated: false },
    ...over,
  };
}

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

  test("a reachable ledger that priced NOTHING says so — never `$0.00 over 0 of N`", () => {
    // The `m < n` line would render "cost $0.00 in total over 0 of 1": "we don't
    // know" spelled as "it was free", on the one figure that must not read that
    // way.
    const one = payload({
      sessions: [chip({ missing: true })],
      totalCost: 0,
      costedSessions: 0,
      ledger: { asked: true, reachable: true, partial: false, configured: true },
    });
    expect(costLine(one)).toBe("1 session wrote this page — the ledger holds none of them");
    expect(costLine(one)).not.toContain("$0.00");

    const many = payload({
      sessions: [chip({ missing: true }), chip({ id: "def", missing: true })],
      totalCost: 0,
      costedSessions: 0,
      ledger: { asked: true, reachable: true, partial: false, configured: true },
    });
    expect(costLine(many)).toBe("2 sessions wrote this page — the ledger holds none of them");
  });

  test("a PARTIAL run keeps its own line even at zero priced — a batch FAILED there", () => {
    // "the ledger holds none of them" is a claim about an answer; `partial` is
    // the state where one never came, so the two must not merge.
    expect(
      costLine(
        payload({
          sessions: [chip({ unresolved: true }), chip({ id: "def", unresolved: true })],
          totalCost: 0,
          costedSessions: 0,
          ledger: { asked: true, reachable: true, partial: true, configured: true },
        }),
      ),
    ).toBe(
      "the 2 sessions that wrote this page cost at least $0.00 — the ledger answered for 0 of 2",
    );
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
      host: "macmini",
      title: "Wiki provenance — PR 4a",
      costLabel: "$12.34",
      bareCopy: null,
      url: null,
    });
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

  test("an ABSENT `cost` is the same as null — it must not throw the whole rail down", () => {
    // The payload crosses the wire, and `JSON.parse` drops a key the server left
    // undefined. `cost === null` missed that and `money(undefined)` threw out of
    // the loop, so ONE malformed chip painted no Sessions section at all.
    //
    // What this pins is the OUTCOME, not the `== null` spelling: `fmtCost`
    // answers `—` for an absent value on its own, so the two spellings are
    // indistinguishable from here. The mutation it catches is reverting the
    // renderer to `money` (verified).
    const partial = { ...chip(), cost: undefined } as unknown as ProvenanceSessionChip;
    expect(() => chipView(partial)).not.toThrow();
    expect(chipView(partial).costLabel).toBe("—");
    // And through the renderer, which is where the blast radius was.
    expect(() => chainHtml(payload({ sessions: [partial] }))).not.toThrow();
    expect(chainHtml(payload({ sessions: [partial] }))).toContain("wiki-chain-row");
  });

  test("a SUB-CENT cost keeps its digits instead of flattening to $0.00", () => {
    // `costOfSessions` rounds only the SUM; a per-chip `cost` arrives raw, so a
    // two-decimal render turns a real $0.0043 session into the `$0.00` that
    // means "free" on every other surface (`fmtCost`'s own rule).
    expect(chipView(chip({ cost: 0.0043 })).costLabel).toBe("$0.0043");
    expect(chipView(chip({ cost: 0.003 })).costLabel).toBe("$0.0030");
    // A real zero still reads as a real zero, and cents still render as cents.
    expect(chipView(chip({ cost: 0 })).costLabel).toBe("$0.00");
    expect(chipView(chip({ cost: 1.5 })).costLabel).toBe("$1.50");
  });

  test("the only date the ledger returned is shown, whichever end of the range it is", () => {
    // Reading `first` alone dropped a chip's only date on the ground. The chain
    // dates a session by `first ?? last`, in an EXPLICIT zone, so the assertion
    // is not a fact about the machine that ran it.
    const only = (over: Partial<ProvenanceSessionChip>) =>
      chainHtml(payload({ sessions: [chip(over)] }), { timeZone: "UTC" });
    // DATE-ONLY inputs, so they render as dates: a `00:00` here was the hour
    // `Date.parse` invented, and west of UTC it also moved the day.
    expect(only({ first: null, last: "2026-09-03" })).toContain(">09-03<");
    expect(only({ first: "2026-09-01", last: null })).toContain(">09-01<");
    // Neither end: no element at all, rather than an empty one holding a gap.
    expect(only({})).not.toContain("wiki-chain-when");
  });

  test("`unresolved` on an UNCONFIGURED host does not blame a service that isn't there", () => {
    const unconfigured = { asked: false, reachable: false, partial: false, configured: false };
    const configured = { asked: true, reachable: true, partial: true, configured: true };
    expect(chipView(chip({ unresolved: true }), unconfigured).bareCopy).toBe(
      "not looked up — no claude-usage on this host",
    );
    // …and the configured copy is untouched, or the split buys nothing.
    expect(chipView(chip({ unresolved: true }), configured).bareCopy).toBe(
      BARE_CHIP_COPY.unresolved,
    );
    // No ledger at all ⇒ the default, never a claim about a host we know nothing of.
    expect(chipView(chip({ unresolved: true })).bareCopy).toBe(BARE_CHIP_COPY.unresolved);
    // The OTHER two reasons are facts about the id, not about the host.
    expect(chipView(chip({ invalid: true }), unconfigured).bareCopy).toBe(BARE_CHIP_COPY.invalid);
    expect(chipView(chip({ missing: true }), unconfigured).bareCopy).toBe(BARE_CHIP_COPY.missing);
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

  const known = { "MELOSYS-8045": 1 };

  test("renders the Jira link, the filter affordance and the cost line", () => {
    const html = provStripHtml(priced, known);
    expect(html).toContain(`href="https://nav.atlassian.net/browse/MELOSYS-8045"`);
    expect(html).toContain(`data-prov-jira="MELOSYS-8045"`);
    expect(html).toContain("wiki-prov-known");
    expect(html).toContain("cost $1.00 in total");
  });

  test("a key the facet map does not hold is TEXT — no filter, no browse link", () => {
    // The store keeps a malformed key on the page's own row while `jiraCounts`
    // shape-filters the facet map, so this key was rendered as a button whose
    // click set a filter `resolveJiraParam` drops: the chip row read
    // `NOT-A-KEY 0`, links built while it was live carried a dead param, and a
    // reload lost it silently.
    const mixed = payload({
      jira: [
        { key: "MELOSYS-9001", url: "https://nav.atlassian.net/browse/MELOSYS-9001" },
        { key: "NOT-A-KEY", url: "https://nav.atlassian.net/browse/NOT-A-KEY" },
      ],
    });
    const html = provStripHtml(mixed, { "MELOSYS-9001": 1 });
    // The good key keeps both controls…
    expect(html).toContain(`data-prov-jira="MELOSYS-9001"`);
    expect(html).toContain(`href="https://nav.atlassian.net/browse/MELOSYS-9001"`);
    // …and the malformed one gets neither, while still being SHOWN: it is on the
    // page, and hiding it would hide the frontmatter damage too.
    expect(html).toContain("NOT-A-KEY");
    expect(html).not.toContain(`data-prov-jira="NOT-A-KEY"`);
    expect(html).not.toContain("browse/NOT-A-KEY");
    expect(html).toContain("NOT-A-KEY is not a Jira key");
  });

  test("a well-SHAPED key the listing has not caught up with is not called malformed", () => {
    // Two causes, two sentences: a value that cannot BE a key is frontmatter the
    // reader can fix; a real key missing from a stale listing is not.
    const html = provStripHtml(
      payload({ jira: [{ key: "MELOSYS-9999", url: "https://nav.atlassian.net/browse/MELOSYS-9999" }] }),
      {},
    );
    expect(html).not.toContain(`data-prov-jira=`);
    // The apostrophe in "wiki's" is escaped into the attribute, so match around it.
    expect(html).toContain("Jira index — no filter and no link");
    expect(html).not.toContain("is not a Jira key");
  });

  test("with NO known map nothing is a control — a dead button is worse than text", () => {
    const html = provStripHtml(priced, null);
    expect(html).not.toContain(`data-prov-jira=`);
    expect(html).not.toContain("wiki-prov-jira-link");
    // The cost line is independent of the facet and still renders.
    expect(html).toContain("cost $1.00 in total");
  });

  test("renders NOTHING for `prs` — the PR row ships with campaign 2", () => {
    expect(provStripHtml(priced, known)).not.toContain("1234");
    expect(provStripHtml(priced, known)).not.toContain("melosys-api");
    expect(provStripHtml(priced, known)).not.toContain("github.com");
  });

  test("a payload with no jira and no cost line renders no strip at all", () => {
    expect(provStripHtml(payload({ prs: [{ ref: "a/b#1", url: null }] }), known)).toBe("");
  });

  test("user-controlled values are escaped", () => {
    const evil = `A-1"><img src=x>`;
    // Both branches: the key is a sink in the button AND in the inert `title=`.
    expect(
      provStripHtml(payload({ jira: [{ key: evil, url: `https://x/"><img src=x>` }] }), {
        [evil]: 1,
      }),
    ).not.toContain("<img");
    expect(
      provStripHtml(payload({ jira: [{ key: evil, url: `https://x/"><img src=x>` }] }), {}),
    ).not.toContain("<img");
  });
});

describe("railListHtml", () => {
  test("a facet matching nothing still says so", () => {
    // The rule #550's fix round established. The Sessions prefix that motivated
    // it is gone, but the composition stays: nothing above the rows may stand in
    // for the answer about the filter.
    expect(railListHtml("")).toContain("No pages match.");
  });

  test("real rows suppress the empty state", () => {
    expect(railListHtml("<div>row</div>")).toBe("<div>row</div>");
  });
});

describe("money", () => {
  test("always two decimals", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(5.3)).toBe("$5.30");
    expect(money(12.345)).toBe("$12.35");
  });
});

describe("the strip's chips on a wiki with a tracker", () => {
  const issue = (key: string, relations: string[], known?: boolean) => ({
    tracker: "jira",
    key,
    url: `https://example.invalid/browse/${key}`,
    field: "jira",
    relations: relations as never,
    pageCount: 1,
    planPages: [],
    ...(known === undefined ? {} : { known }),
  });

  test("`issues` supersede `jira`: every counting key, stamped solid and inferred dashed", () => {
    const p = payload({
      jira: [{ key: "DEMO-180", url: "https://example.invalid/browse/DEMO-180" }],
      issues: [issue("DEMO-180", ["stamped"], true), issue("DEMO-101", ["created", "link"]), issue("DEMO-190", ["link"]), issue("DEMO-122", ["mention"])],
    });
    expect(stripChipViews(p).map((c) => [c.key, !!c.inferred, c.known])).toEqual([
      ["DEMO-180", false, true],
      ["DEMO-101", true, false],
    ]);
    const html = provStripHtml(p, { "DEMO-180": 1, "DEMO-101": 1 });
    expect(html.match(/data-prov-jira="/g)).toHaveLength(2);
    expect(html).toContain("wiki-prov-jira inferred");
  });

  test("with no `issues` the strip draws `jira`, as before", () => {
    const p = payload({ jira: [{ key: "DEMO-180", url: "https://example.invalid/browse/DEMO-180" }] });
    expect(stripChipViews(p).map((c) => c.key)).toEqual(["DEMO-180"]);
    expect(provStripHtml(p, { "DEMO-180": 1 })).not.toContain("inferred");
  });
});

describe("the strip's chips on a wiki with a tracker, PR 3 fix round 1", () => {
  const issue = (tracker: string, key: string, relations: string[]) => ({
    tracker,
    key,
    url: `https://example.invalid/browse/${key}`,
    field: "jira",
    relations: relations as never,
    pageCount: 1,
    planPages: [],
  });

  test("C8: only the Jira tracker's rows become Jira chips", () => {
    const p = payload({ jira: [], issues: [issue("jira", "DEMO-101", ["title"]), issue("gitlab", "DEMO-7", ["title"])] });
    expect(stripChipViews(p).map((c) => c.key)).toEqual(["DEMO-101"]);
  });

  test("C9: a stamped value that is not key-shaped still draws its inert chip beside the counting keys", () => {
    const p = payload({
      jira: [
        { key: "DEMO-140", url: "https://example.invalid/browse/DEMO-140" },
        { key: "SEE THE EPIC", url: "https://example.invalid/browse/SEE%20THE%20EPIC" },
      ],
      issues: [issue("jira", "DEMO-140", ["stamped"]), issue("jira", "DEMO-142", ["tag"]), issue("jira", "DEMO-150", ["title"])],
    });
    expect(stripChipViews(p).map((c) => c.key)).toEqual(["DEMO-140", "DEMO-142", "DEMO-150", "SEE THE EPIC"]);
    const html = provStripHtml(p, { "DEMO-140": 1, "DEMO-150": 1 });
    expect(html).toContain('<span class="wiki-prov-jira wiki-prov-jira-inert"><span class="wiki-prov-jira-key"');
    expect(html).toContain("SEE THE EPIC");
  });
});

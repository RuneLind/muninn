/**
 * PR 3's half of the provenance VIEW: the gate verdict on a merge row, the model
 * and delegated-cost suffixes on a session row, the handoff line between two
 * sessions, the ghost row with its Stamp, the line's ghost hint and its ninth
 * state, and the footer lines the four new legs degrade to.
 *
 * Pure string building, like the rest of the module — `wiki-browser.ts` cannot
 * be loaded by `bun test`, so anything shaped there is provable only through
 * Playwright, and none of this is shaped there.
 */

import { describe, expect, test } from "bun:test";
import {
  chainEvents,
  chainHtml,
  costLine,
  gateVerdict,
  // Imported, not re-typed. The module exports these BECAUSE there must be one
  // spelling of each — an assertion that quotes the string instead is green
  // against a second spelling, which is the whole thing the export prevents.
  GATE_NOT_MATCHED_COPY,
  HANDOFFS_UNREAD_NOTE,
  LINKS_TIMED_OUT_NOTE,
  NO_GATE_LINE_COPY,
  PR_LINKS_UNREAD_NOTE,
  ghostHint,
  linksNotes,
  modelLabel,
  provLineHtml,
  PROV_PENDING_COPY,
  PROV_UNAVAILABLE_COPY,
  provPendingHtml,
  provStripHtml,
  provUnavailableHtml,
  STAMP_CONFIRM_LABEL,
  STAMP_LABEL,
} from "./wiki-provenance-view.ts";
import {
  LEDGER_NOT_ASKED,
  LINKS_NOT_ASKED,
  MERGES_NOT_ASKED,
  type ProvenanceLinksState,
  type ProvenanceMerge,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "../../../wiki/provenance.ts";

const UTC = { timeZone: "UTC" };

function chip(over: Partial<ProvenanceSessionChip> = {}): ProvenanceSessionChip {
  return {
    ref: "claude-code:abc",
    provider: "claude-code",
    id: "abc",
    title: "A session",
    host: "macpro",
    first: "2026-09-16T07:24:44.336Z",
    last: "2026-09-16T12:24:25.972Z",
    cost: 101.72,
    messages: 581,
    model: null,
    delegatedCost: null,
    missing: false,
    unresolved: false,
    invalid: false,
    ...over,
  };
}

function merge(over: Partial<ProvenanceMerge> = {}): ProvenanceMerge {
  return {
    sessionId: "abc",
    repo: "/src/muninn",
    prNumber: 553,
    url: "https://github.com/acme/widget/pull/553",
    subject: null,
    mergedAt: "2026-09-16T11:44:55.071Z",
    mergeOk: true,
    gate: null,
    preStandardization: false,
    ...over,
  };
}

function payload(over: Partial<ProvenancePayload> = {}): ProvenancePayload {
  return {
    sessions: [chip()],
    ghosts: [],
    handoffs: [],
    stampable: false,
    jira: [],
    prs: [],
    merges: [],
    totalCost: 101.72,
    costedSessions: 1,
    ledger: { asked: true, reachable: true, partial: false, configured: true },
    mergesLedger: { asked: true, reachable: true, partial: false, truncated: false },
    links: LINKS_NOT_ASKED,
    ...over,
  };
}

function links(over: Partial<ProvenanceLinksState> = {}): ProvenanceLinksState {
  return { ...LINKS_NOT_ASKED, ...over };
}

describe("modelLabel", () => {
  test("keeps the family and drops a trailing date stamp", () => {
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  test("a model with no date suffix is unchanged", () => {
    expect(modelLabel("claude-opus-5")).toBe("claude-opus-5");
  });

  test("a version that only LOOKS like a date is left alone", () => {
    // Eight digits is the rule; seven is a version, not a day.
    expect(modelLabel("model-1234567")).toBe("model-1234567");
  });
});

describe("gateVerdict", () => {
  test("a gated merge names the gates it carried, in the ledger's own order", () => {
    expect(
      gateVerdict(
        merge({
          gate: {
            matched: true,
            gated: true,
            gatedBy: "gate",
            gates: ["gate-split-check", "gate-review-floor"],
          },
        }),
        "2026-07-30",
      ),
    ).toBe("✓ review floor + split check");
  });

  test("a matched merge with no gate says so — never nothing", () => {
    expect(
      gateVerdict(merge({ gate: { matched: true, gated: false, gatedBy: null, gates: [] } }), "2026-07-30"),
    ).toBe(NO_GATE_LINE_COPY);
  });

  test("a row the join did not match reads as unmatched, not as ungated", () => {
    expect(gateVerdict(merge({ gate: { matched: false } }), "2026-07-30")).toBe(GATE_NOT_MATCHED_COPY);
  });

  test("a merge older than the standardized phrases names the date instead", () => {
    expect(
      gateVerdict(
        merge({
          preStandardization: true,
          gate: { matched: true, gated: false, gatedBy: null, gates: [] },
        }),
        "2026-07-30",
      ),
    ).toBe("no gate data before 2026-07-30");
  });

  test("...and says it without a date when the envelope carried none", () => {
    expect(
      gateVerdict(
        merge({
          preStandardization: true,
          gate: { matched: true, gated: false, gatedBy: null, gates: [] },
        }),
      ),
    ).toBe("no gate data before the gate phrases were standardized");
  });

  test("a gated PRE-standardization row keeps its ✓ — the date qualifies an absence", () => {
    expect(
      gateVerdict(
        merge({
          preStandardization: true,
          gate: { matched: true, gated: true, gatedBy: "gate", gates: ["gate-review-floor"] },
        }),
        "2026-07-30",
      ),
    ).toBe("✓ review floor");
  });

  test("a bare `gh pr merge` (gate null) renders NOTHING", () => {
    expect(gateVerdict(merge({ prNumber: null, gate: null }), "2026-07-30")).toBeNull();
  });

  test("gated through a shape that associated no gate kind still reads as gated", () => {
    expect(
      gateVerdict(
        merge({ gate: { matched: true, gated: true, gatedBy: "closing-single", gates: [] } }),
        "2026-07-30",
      ),
    ).toBe("✓ gated");
  });

  test("an unknown gate kind is named raw rather than dropped", () => {
    expect(
      gateVerdict(
        merge({ gate: { matched: true, gated: true, gatedBy: "gate", gates: ["gate-brand-new"] } }),
        "2026-07-30",
      ),
    ).toBe("✓ gate-brand-new");
  });
});

describe("the session row's model and delegated suffixes", () => {
  test("the model renders short after the host, with the raw id on the hover", () => {
    const html = chainHtml(
      payload({ sessions: [chip({ model: "claude-sonnet-4-5-20250929" })] }),
      UTC,
    );
    expect(html).toContain('title="claude-sonnet-4-5-20250929"');
    expect(html).toContain("· claude-sonnet-4-5</span>");
  });

  test("the delegated cost renders after the total", () => {
    const html = chainHtml(payload({ sessions: [chip({ delegatedCost: 28.75 })] }), UTC);
    expect(html).toContain("$28.75 delegated");
  });

  test("a session the ledger sent neither for renders neither", () => {
    const html = chainHtml(payload(), UTC);
    expect(html).not.toContain("wiki-chain-model");
    expect(html).not.toContain("delegated");
  });

  test("a delegated cost of ZERO is a fact and renders", () => {
    const html = chainHtml(payload({ sessions: [chip({ delegatedCost: 0 })] }), UTC);
    expect(html).toContain("$0.00 delegated");
  });
});

describe("the gate verdict on a merge row", () => {
  test("renders beside the coordinate", () => {
    const html = chainHtml(
      payload({
        merges: [
          merge({
            gate: { matched: true, gated: true, gatedBy: "gate", gates: ["gate-review-floor", "gate-split-check"] },
          }),
        ],
        rulesStandardizedDate: "2026-07-30",
      }),
      UTC,
    );
    // The ✓ is its own span: it is the one MARK on the row, and the words beside
    // it stay at the row's text colour because --status-success is under the
    // contrast floor in the light theme.
    expect(html).toContain('<span class="wiki-chain-gate-ok">✓</span> review floor + split check');
    expect(html).toContain("wiki-chain-gate");
  });

  test("a verdict that is NOT a ✓ carries no mark span at all", () => {
    const html = chainHtml(
      payload({
        merges: [merge({ gate: { matched: true, gated: false, gatedBy: null, gates: [] } })],
      }),
      UTC,
    );
    expect(html).toContain(`>${NO_GATE_LINE_COPY}</span>`);
    expect(html).not.toContain("wiki-chain-gate-ok");
  });

  test("a null gate leaves the row with no verdict element at all", () => {
    const html = chainHtml(payload({ merges: [merge({ prNumber: null, gate: null })] }), UTC);
    expect(html).not.toContain("wiki-chain-gate");
  });
});

describe("the handoff line", () => {
  const p = payload({
    sessions: [chip({ id: "a", ref: "claude-code:a", first: "2026-09-15T20:00:00.000Z", last: "2026-09-15T21:00:00.000Z" })],
    ghosts: [
      {
        ...chip({ id: "b", ref: "b", first: "2026-09-16T07:24:44.336Z", last: null, title: "The ghost" }),
        ghost: { via: "handoff", through: "a", stampRef: "claude-code:b" },
      },
    ],
    handoffs: [{ from: "a", to: "b", at: "2026-09-16T07:24:41.216Z", host: "macpro" }],
  });

  test("sits between the two sessions it joins", () => {
    const kinds = chainEvents(p).map((e) => e.kind);
    expect(kinds).toEqual(["session", "handoff", "session"]);
  });

  test("names both ends on the hover and the instant in the row", () => {
    const html = chainHtml(p, UTC);
    expect(html).toContain("wiki-chain-handoff");
    expect(html).toContain('title="a → b"');
    expect(html).toContain("handoff · 09-16 07:24");
  });

  test("a DATELESS handoff still renders, and sorts last like every undated event", () => {
    const dateless = payload({
      ...p,
      handoffs: [{ from: "a", to: "b", at: null, host: null }],
    });
    const kinds = chainEvents(dateless).map((e) => e.kind);
    expect(kinds).toEqual(["session", "session", "handoff"]);
    expect(chainHtml(dateless, UTC)).toContain("wiki-chain-handoff");
  });

  test("a ghost DATED from its facts slots in by the chain's own rule, not at the end", () => {
    const early = payload({
      sessions: [chip({ id: "z", ref: "claude-code:z", first: "2026-09-20T09:00:00.000Z", last: null })],
      ghosts: [
        {
          ...chip({ id: "g", ref: "g", first: "2026-09-10T09:00:00.000Z", last: null }),
          ghost: { via: "pr", through: "#553", stampRef: "claude-code:g" },
        },
      ],
    });
    expect(chainEvents(early).map((e) => (e.kind === "session" ? e.chip.id : e.kind))).toEqual([
      "g",
      "z",
    ]);
  });

  test("a ghost leg 5 could not price is DATELESS and sorts last", () => {
    const bare = payload({
      sessions: [chip({ id: "z", ref: "claude-code:z", first: "2026-09-20T09:00:00.000Z", last: null })],
      ghosts: [
        {
          ...chip({ id: "g", ref: "g", first: null, last: null, cost: null, title: null, unresolved: true }),
          ghost: { via: "pr", through: "#553", stampRef: null },
        },
      ],
    });
    expect(chainEvents(bare).map((e) => (e.kind === "session" ? e.chip.id : e.kind))).toEqual([
      "z",
      "g",
    ]);
  });
});

describe("the ghost row", () => {
  const handoffGhost = {
    ...chip({ id: "g", ref: "g", title: "The ghost", cost: 101.72 }),
    ghost: { via: "handoff" as const, through: "a", stampRef: "claude-code:g" },
  };
  const prGhost = {
    ...chip({ id: "g", ref: "g", title: "The ghost", cost: 101.72 }),
    ghost: { via: "pr" as const, through: "#553", stampRef: "claude-code:g" },
  };

  test("a handoff ghost says what the evidence is and asks for a confirmation", () => {
    const html = chainHtml(payload({ ghosts: [handoffGhost], stampable: true }), UTC);
    expect(html).toContain("wiki-chain-ghost");
    expect(html).toContain("ran this session&#39;s handoff — may not have touched this page");
    expect(html).toContain('data-prov-stamp="claude-code:g"');
    expect(html).toContain('data-prov-stamp-confirm="1"');
    expect(html).toContain(`>${STAMP_LABEL}<`);
  });

  test("a PR ghost names the PR and gets a one-click Stamp", () => {
    const html = chainHtml(payload({ ghosts: [prGhost], stampable: true }), UTC);
    expect(html).toContain("merged #553 — this page does not stamp it");
    expect(html).toContain('data-prov-stamp="claude-code:g"');
    expect(html).not.toContain("data-prov-stamp-confirm");
  });

  test("an unstampable instance renders the row and NO button", () => {
    const html = chainHtml(payload({ ghosts: [prGhost], stampable: false }), UTC);
    expect(html).toContain("wiki-chain-ghost");
    expect(html).not.toContain("data-prov-stamp");
  });

  test("a provider nothing stamps gets no button and says why", () => {
    const html = chainHtml(
      payload({
        stampable: true,
        ghosts: [
          {
            ...chip({ id: "g", ref: "g", provider: "copilot" }),
            ghost: { via: "pr", through: "#553", stampRef: null },
          },
        ],
      }),
      UTC,
    );
    expect(html).not.toContain("data-prov-stamp");
    expect(html).toContain("no Stamp — the ledger reports provider &quot;copilot&quot;");
  });

  test("the confirm label is one exported string, shared with the client", () => {
    expect(STAMP_CONFIRM_LABEL).toBe("Confirm: this session wrote the page");
  });
});

describe("the line's ghost hint", () => {
  test("names the PR a ghost came through and what it cost", () => {
    const p = payload({
      ghosts: [
        { ...chip({ id: "g", ref: "g", cost: 101.72 }), ghost: { via: "pr", through: "#553", stampRef: null } },
      ],
    });
    expect(ghostHint(p)).toBe("the ledger links 1 more session through #553 — $101.72");
    expect(provLineHtml(p, UTC)).toContain("the ledger links 1 more session through #553");
  });

  test("a handoff ghost says `through a handoff` rather than naming the session", () => {
    const p = payload({
      ghosts: [
        { ...chip({ id: "g", ref: "g", cost: 101.72 }), ghost: { via: "handoff", through: "a", stampRef: null } },
      ],
    });
    expect(ghostHint(p)).toBe("the ledger links 1 more session through a handoff — $101.72");
  });

  test("an UNPRICED ghost (leg 5 failed) is counted with no amount", () => {
    const p = payload({
      ghosts: [
        { ...chip({ id: "g", ref: "g", cost: null }), ghost: { via: "handoff", through: "a", stampRef: null } },
      ],
    });
    expect(ghostHint(p)).toBe("the ledger links 1 more session through a handoff");
  });

  test("no ghosts, no hint", () => {
    expect(ghostHint(payload())).toBeNull();
  });

  test("no STAMPED session, no hint either — the ninth costLine state says it instead", () => {
    const ghostOnly = payload({
      sessions: [],
      totalCost: 0,
      costedSessions: 0,
      ledger: LEDGER_NOT_ASKED,
      ghosts: [
        { ...chip({ id: "g", ref: "g", cost: 40 }), ghost: { via: "pr", through: "#553", stampRef: null } },
      ],
    });
    expect(ghostHint(ghostOnly)).toBeNull();
    // ...and the line therefore says it once, not twice.
    const html = provLineHtml(ghostOnly, UTC);
    expect([...html.matchAll(/the ledger links/g)]).toHaveLength(1);
  });
});

describe("costLine's ninth state — no stamped sessions, ghosts found", () => {
  const ghostOnly = (over: Partial<ProvenanceSessionChip> = {}) =>
    payload({
      sessions: [],
      totalCost: 0,
      costedSessions: 0,
      ledger: LEDGER_NOT_ASKED,
      mergesLedger: MERGES_NOT_ASKED,
      ghosts: [
        {
          ...chip({ id: "g", ref: "g", cost: 40, ...over }),
          ghost: { via: "pr", through: "#553", stampRef: "claude-code:g" },
        },
      ],
    });

  test("a `prs:`-only page gets a line of its own", () => {
    expect(costLine(ghostOnly())).toBe("the ledger links 1 session through #553 — $40.00");
  });

  test("...and the strip renders rather than returning empty", () => {
    expect(provStripHtml(ghostOnly(), null, UTC)).toContain("wiki-prov-line");
  });

  test("a page with neither sessions nor ghosts still has no line", () => {
    const empty = payload({
      sessions: [],
      ghosts: [],
      totalCost: 0,
      costedSessions: 0,
      ledger: LEDGER_NOT_ASKED,
      mergesLedger: MERGES_NOT_ASKED,
    });
    expect(costLine(empty)).toBeNull();
    expect(provStripHtml(empty, null, UTC)).toBe("");
  });
});

describe("the marks gain a third kind", () => {
  test("one ring per session, one dashed ring per ghost, one square per merge, in that order", () => {
    const html = provLineHtml(
      payload({
        sessions: [chip(), chip({ id: "b", ref: "claude-code:b" })],
        ghosts: [
          { ...chip({ id: "g", ref: "g" }), ghost: { via: "handoff", through: "abc", stampRef: null } },
        ],
        merges: [merge(), merge({ prNumber: 552 })],
      }),
      UTC,
    );
    const kinds = [...html.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["session", "session", "ghost", "merge", "merge"]);
  });

  test("the ghost kind keeps a reserved share of the cap", () => {
    const many = Array.from({ length: 250 }, (_, i) => chip({ id: `s${i}`, ref: `claude-code:s${i}` }));
    const html = provLineHtml(
      payload({
        sessions: many,
        ghosts: [
          { ...chip({ id: "g", ref: "g" }), ghost: { via: "handoff", through: "abc", stampRef: null } },
        ],
        merges: [merge()],
      }),
      UTC,
    );
    const kinds = [...html.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds.filter((k) => k === "ghost")).toHaveLength(1);
    expect(kinds.filter((k) => k === "merge")).toHaveLength(1);
  });
});

describe("linksNotes — one footer line per leg that has something to report", () => {
  test("a handoff leg that answered nothing", () => {
    expect(linksNotes(links({ handoffs: { asked: true, reachable: false } }))).toEqual([
      HANDOFFS_UNREAD_NOTE,
    ]);
  });

  test("a PR leg that answered nothing", () => {
    expect(linksNotes(links({ prs: { asked: true, reachable: false } }))).toEqual([
      PR_LINKS_UNREAD_NOTE,
    ]);
  });

  test("a page past the handoff-read cap says the lines are a subset", () => {
    expect(linksNotes(links({ handoffsCapped: true }))).toEqual([
      "handoff lines not shown: this page names more than 10 sessions",
    ]);
  });

  test("a page past the `prs:` cap says so", () => {
    expect(linksNotes(links({ prsCapped: true }))).toEqual([
      "PR links read for the first 10 entries only",
    ]);
  });

  test("the deadline firing mid-fan-out is its own line", () => {
    expect(linksNotes(links({ timedOut: true }))).toEqual([LINKS_TIMED_OUT_NOTE]);
  });

  test("a leg that was never asked says nothing", () => {
    expect(linksNotes(LINKS_NOT_ASKED)).toEqual([]);
  });

  test("the notes reach the chain's footer", () => {
    const html = chainHtml(
      payload({ links: links({ handoffs: { asked: true, reachable: false } }) }),
      UTC,
    );
    expect(html).toContain(HANDOFFS_UNREAD_NOTE);
  });
});

describe("the ghost hint counts its sources and states its denominator", () => {
  const ghost = (
    id: string,
    cost: number | null,
    via: "pr" | "handoff",
    through: string,
  ) => ({
    ...chip({ id, ref: id, cost }),
    ghost: { via, through, stampRef: null },
  });

  test("M < N says `over M of N` — the money is never presented as the whole", () => {
    // The measured line: `links 3 sessions through #553 — $15.00`, on a page
    // whose three ghosts came through two PRs and a handoff and of which the
    // ledger had priced two. Both halves were wrong.
    const p = payload({
      ghosts: [
        ghost("g1", 10, "pr", "#553"),
        ghost("g2", 5, "pr", "#554"),
        ghost("g3", null, "handoff", "a"),
      ],
    });
    expect(ghostHint(p)).toBe(
      "the ledger links 3 more sessions through 2 PRs and a handoff — $15.00 over 2 of 3",
    );
  });

  test("every ghost priced ⇒ no denominator clause", () => {
    const p = payload({ ghosts: [ghost("g1", 10, "pr", "#553"), ghost("g2", 5, "pr", "#553")] });
    // Two ghosts through the SAME PR is one distinct source, so it is named.
    expect(ghostHint(p)).toBe("the ledger links 2 more sessions through #553 — $15.00");
  });

  test("a handoff beside a single named PR is named too, never dropped", () => {
    const p = payload({ ghosts: [ghost("g1", 10, "pr", "#553"), ghost("g2", 5, "handoff", "a")] });
    expect(ghostHint(p)).toBe(
      "the ledger links 2 more sessions through #553 and a handoff — $15.00",
    );
  });

  test("two handoffs and no PR are counted", () => {
    const p = payload({
      ghosts: [ghost("g1", 10, "handoff", "a"), ghost("g2", 5, "handoff", "b")],
    });
    expect(ghostHint(p)).toBe("the ledger links 2 more sessions through 2 handoffs — $15.00");
  });

  test("nothing priced ⇒ no amount and no denominator", () => {
    const p = payload({
      ghosts: [ghost("g1", null, "pr", "#553"), ghost("g2", null, "handoff", "a")],
    });
    expect(ghostHint(p)).toBe("the ledger links 2 more sessions through #553 and a handoff");
  });

  test("the sum is rounded ONCE, by money's own toFixed", () => {
    const p = payload({ ghosts: [ghost("g1", 0.005, "pr", "#553"), ghost("g2", 0.005, "pr", "#553")] });
    expect(ghostHint(p)).toBe("the ledger links 2 more sessions through #553 — $0.01");
  });
});

describe("the ninth costLine state keeps the backfilled tail", () => {
  const ghostOnly = (over: Partial<ProvenancePayload> = {}) =>
    payload({
      sessions: [],
      totalCost: 0,
      costedSessions: 0,
      ledger: LEDGER_NOT_ASKED,
      mergesLedger: MERGES_NOT_ASKED,
      ghosts: [
        {
          ...chip({ id: "g", ref: "g", cost: 40 }),
          ghost: { via: "pr", through: "#553", stampRef: "claude-code:g" },
        },
      ],
      ...over,
    });

  test("`· inferred from history` rides this state like the other eight", () => {
    // It qualifies the LIST, and this is the state where the list is EMPTY —
    // which makes the marker the reason the page names no session of its own.
    expect(costLine(ghostOnly({ backfilled: "2026-09-01" }))).toBe(
      "the ledger links 1 session through #553 — $40.00 · inferred from history 2026-09-01",
    );
  });

  test("and is still absent when the page carries no marker", () => {
    expect(costLine(ghostOnly())).toBe("the ledger links 1 session through #553 — $40.00");
  });
});

describe("a ghost with no provider defers to the chip's own reason", () => {
  const unresolvedGhost = {
    ...chip({ id: "g", ref: "g", provider: "", title: null, cost: null, unresolved: true }),
    ghost: { via: "pr" as const, through: "#553", stampRef: null },
  };

  test("an UNRESOLVED chip says the lookup failed ONCE, not twice contradicting itself", () => {
    // Leg 5 never answered, so the row already carries `bareChipCopy`'s reason.
    // "the ledger named no provider for this session" beside it is a claim about
    // an answer nobody got.
    const html = chainHtml(payload({ ghosts: [unresolvedGhost], stampable: true }), UTC);
    expect(html).not.toContain("the ledger named no provider");
    expect(html).toContain("wiki-chain-bare");
  });

  test("a MISSING chip defers the same way", () => {
    const missing = {
      ...chip({ id: "g", ref: "g", provider: "", title: null, cost: null, missing: true }),
      ghost: { via: "pr" as const, through: "#553", stampRef: null },
    };
    const html = chainHtml(payload({ ghosts: [missing], stampable: true }), UTC);
    expect(html).not.toContain("the ledger named no provider");
  });

  test("a chip the ledger DID answer for, with no provider, still says so", () => {
    const answered = {
      ...chip({ id: "g", ref: "g", provider: "", title: "Known", cost: 1 }),
      ghost: { via: "pr" as const, through: "#553", stampRef: null },
    };
    const html = chainHtml(payload({ ghosts: [answered], stampable: true }), UTC);
    expect(html).toContain("no Stamp — the ledger named no provider for this session");
  });

  test("and a NAMED provider this pipeline does not stamp is unchanged", () => {
    const copilot = {
      ...chip({ id: "g", ref: "g", provider: "copilot", unresolved: true }),
      ghost: { via: "pr" as const, through: "#553", stampRef: null },
    };
    const html = chainHtml(payload({ ghosts: [copilot], stampable: true }), UTC);
    expect(html).toContain("no Stamp — the ledger reports provider &quot;copilot&quot;");
  });
});

describe("the Stamp button's message span", () => {
  const prGhost = {
    ...chip({ id: "g", ref: "g", title: "The ghost", cost: 101.72 }),
    ghost: { via: "pr" as const, through: "#553", stampRef: "claude-code:g" },
  };

  test("is rendered empty and hidden beside every Stamp", () => {
    // The client writes `textContent` into it. Without a span the reason went
    // into the button's LABEL, which renamed the control to a sentence and left
    // it renamed for the next click.
    const html = chainHtml(payload({ ghosts: [prGhost], stampable: true }), UTC);
    expect(html).toContain(
      '<span class="wiki-chain-stamp-msg" data-prov-stamp-msg hidden></span>',
    );
  });

  test("and is absent where there is no Stamp to explain", () => {
    const html = chainHtml(payload({ ghosts: [prGhost], stampable: false }), UTC);
    expect(html).not.toContain("data-prov-stamp-msg");
  });
});

describe("the placeholder strip a deferred page renders", () => {
  test("is a .wiki-prov-strip so the real block can replace it in place, and is busy", () => {
    const html = provPendingHtml();
    expect(html).toContain('class="wiki-prov-strip wiki-prov-pending"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("wiki-prov-spinner");
    expect(html).toContain(PROV_PENDING_COPY);
    // Not a control: the disclosure class carries a pointer cursor.
    expect(html).not.toContain("wiki-prov-line");
  });

  test("its failed state is still a .wiki-prov-strip, without the spinner", () => {
    const html = provUnavailableHtml();
    expect(html).toContain('class="wiki-prov-strip wiki-prov-unavailable"');
    expect(html).not.toContain("wiki-prov-spinner");
    expect(html).not.toContain("aria-busy");
    expect(html).toContain(PROV_UNAVAILABLE_COPY);
  });
});

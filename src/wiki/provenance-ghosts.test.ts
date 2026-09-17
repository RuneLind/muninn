/**
 * PR 3's pure layer: the ONE ledger-provider mapping, the Stamp ref built from
 * it, the handoff links `ranBy` yields, and ghost discovery over the two
 * sources.
 *
 * A ghost is a session the LEDGER links to the page that `sessions:` does not
 * name. The two sources are not interchangeable — a PR ghost merged a PR the
 * page names (real evidence, one-click Stamp), a handoff ghost only pasted a
 * stamped session's handoff prompt (which does not say it touched the page) —
 * so the link rides on the chip and the renderer reads it.
 */

import { describe, expect, test } from "bun:test";
import {
  enrichSessions,
  ghostCandidates,
  handoffLinks,
  mapLedgerProvider,
  stampRefFor,
  type ProvenanceHandoff,
  type ProvenanceMerge,
} from "./provenance.ts";

const merge = (over: Partial<ProvenanceMerge> = {}): ProvenanceMerge => ({
  sessionId: "ghost-1",
  repo: "/src/muninn",
  prNumber: 553,
  url: "https://github.com/acme/widget/pull/553",
  subject: null,
  mergedAt: "2026-09-16T11:44:55.071Z",
  mergeOk: true,
  gate: null,
  preStandardization: false,
  ...over,
});

describe("mapLedgerProvider", () => {
  test("`claude` is the ledger's spelling of the prefix the stamper writes", () => {
    expect(mapLedgerProvider("claude")).toBe("claude-code");
  });

  test("`opencode` maps to itself", () => {
    expect(mapLedgerProvider("opencode")).toBe("opencode");
  });

  test("an unknown provider is passed through, never invented away", () => {
    expect(mapLedgerProvider("copilot")).toBe("copilot");
  });

  test("absent is null", () => {
    expect(mapLedgerProvider(null)).toBeNull();
    expect(mapLedgerProvider(undefined)).toBeNull();
    expect(mapLedgerProvider("")).toBeNull();
  });
});

describe("stampRefFor", () => {
  test("builds `provider:id` for a provider this pipeline stamps", () => {
    expect(stampRefFor({ provider: "claude-code", id: "abc" })).toBe("claude-code:abc");
    expect(stampRefFor({ provider: "opencode", id: "ses_1" })).toBe("opencode:ses_1");
  });

  test("a provider nothing stamps gets NO ref — the row says why instead", () => {
    expect(stampRefFor({ provider: "copilot", id: "abc" })).toBeNull();
    expect(stampRefFor({ provider: null, id: "abc" })).toBeNull();
  });

  test("the RAW ledger spelling is not a ref — the mapping runs first", () => {
    // `claude` reaches a chip only through `enrichSessions`, which maps it.
    expect(stampRefFor({ provider: "claude", id: "abc" })).toBeNull();
  });
});

describe("enrichSessions applies the provider mapping once", () => {
  const ledger = {
    facts: new Map([["abc", { sessionId: "abc", provider: "claude", cost: 1 }]]),
  };

  test("a BARE ref takes the mapped provider, so its glyph agrees with a stamped one", () => {
    const [chip] = enrichSessions(["abc"], ledger);
    expect(chip!.provider).toBe("claude-code");
    expect(stampRefFor(chip!)).toBe("claude-code:abc");
  });

  test("a PREFIXED ref keeps the page's own spelling", () => {
    const [chip] = enrichSessions(["claude-code:abc"], ledger);
    expect(chip!.provider).toBe("claude-code");
    expect(chip!.ref).toBe("claude-code:abc");
  });

  test("model and delegated cost ride the chip, null when the ledger sent none", () => {
    const priced = new Map([
      ["abc", { sessionId: "abc", provider: "claude", cost: 1, model: "claude-opus-5", delegatedCost: 2.5 }],
    ]);
    const [withFacts] = enrichSessions(["abc"], { facts: priced });
    expect(withFacts!.model).toBe("claude-opus-5");
    expect(withFacts!.delegatedCost).toBe(2.5);
    const [without] = enrichSessions(["abc"], ledger);
    expect(without!.model).toBeNull();
    expect(without!.delegatedCost).toBeNull();
  });

  test("a chip the ledger holds nothing for still carries the whole key set", () => {
    const [bare] = enrichSessions(["zzz"], { facts: new Map() });
    expect(bare!.model).toBeNull();
    expect(bare!.delegatedCost).toBeNull();
  });
});

describe("handoffLinks", () => {
  test("one link per (stamped session → the session that ran its handoff), oldest first", () => {
    const links = handoffLinks(
      new Map([
        ["a", [{ sessionId: "b", at: "2026-09-16T07:24:41.216Z", host: "macpro" }]],
        ["x", [{ sessionId: "a", at: "2026-09-15T20:21:58.731Z", host: "macpro" }]],
      ]),
    );
    expect(links).toEqual([
      { from: "x", to: "a", at: "2026-09-15T20:21:58.731Z", host: "macpro" },
      { from: "a", to: "b", at: "2026-09-16T07:24:41.216Z", host: "macpro" },
    ] satisfies ProvenanceHandoff[]);
  });

  test("a session whose `ranBy` names itself is not a handoff to anywhere", () => {
    expect(handoffLinks(new Map([["a", [{ sessionId: "a", at: null, host: null }]]]))).toEqual([]);
  });

  test("an empty `ranBy` is the ordinary answer and yields nothing", () => {
    expect(handoffLinks(new Map([["a", []]]))).toEqual([]);
  });

  test("a dateless run sorts LAST, the chain's own rule", () => {
    const links = handoffLinks(
      new Map([
        ["a", [{ sessionId: "b", at: null, host: null }]],
        ["c", [{ sessionId: "d", at: "2026-09-16T07:24:41.216Z", host: "macpro" }]],
      ]),
    );
    expect(links.map((l) => l.to)).toEqual(["d", "b"]);
  });
});

describe("ghostCandidates", () => {
  test("a `ranBy` target the page does not stamp is a handoff ghost, named by the session it ran", () => {
    expect(
      ghostCandidates({
        stampedIds: ["a"],
        prMerges: [],
        handoffs: [{ from: "a", to: "ghost-1", at: "2026-09-16T07:24:41.216Z", host: "macpro" }],
      }),
    ).toEqual([{ id: "ghost-1", via: "handoff", through: "a" }]);
  });

  test("a stamped session is never a ghost of itself", () => {
    expect(
      ghostCandidates({
        stampedIds: ["a", "b"],
        prMerges: [],
        handoffs: [{ from: "a", to: "b", at: null, host: null }],
      }),
    ).toEqual([]);
  });

  test("a merging session the page does not stamp is a PR ghost, named by the PR", () => {
    expect(
      ghostCandidates({ stampedIds: ["a"], prMerges: [merge()], handoffs: [] }),
    ).toEqual([{ id: "ghost-1", via: "pr", through: "#553" }]);
  });

  test("a PR row with no number names the coordinate it cannot number", () => {
    expect(
      ghostCandidates({
        stampedIds: [],
        prMerges: [merge({ prNumber: null, url: null })],
        handoffs: [],
      }),
    ).toEqual([{ id: "ghost-1", via: "pr", through: "a merged PR" }]);
  });

  test("PR ghosts come FIRST — real evidence before a pasted prompt — and an id found both ways keeps the PR link", () => {
    const out = ghostCandidates({
      stampedIds: ["a"],
      prMerges: [merge({ sessionId: "g2" })],
      handoffs: [
        { from: "a", to: "g1", at: null, host: null },
        { from: "a", to: "g2", at: null, host: null },
      ],
    });
    expect(out).toEqual([
      { id: "g2", via: "pr", through: "#553" },
      { id: "g1", via: "handoff", through: "a" },
    ]);
  });

  test("one ghost per id, however many rows name it", () => {
    const out = ghostCandidates({
      stampedIds: [],
      prMerges: [merge(), merge({ prNumber: 77 })],
      handoffs: [],
    });
    expect(out).toEqual([{ id: "ghost-1", via: "pr", through: "#553" }]);
  });
});

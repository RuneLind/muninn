/**
 * Legs 3–6 of the page-open fan-out: the handoff reads, the `?prs=` lookup, and
 * the two calls that enrich whatever ghosts those two found.
 *
 * All four ride the ONE hoisted deadline `pageProvenance` owns, and every one of
 * them has a stated degrade that reaches the reader as a footer line. The rule
 * they all share: **the cost sentence never moves for any of them** — it is
 * about the sessions the page STAMPED, and a ghost is a link.
 */

import { describe, expect, mock, test } from "bun:test";
import { pageProvenance, type ProvenanceContext } from "./provenance-service.ts";
import { HANDOFF_READS_MAX, PR_READS_MAX } from "./provenance.ts";
import type { SessionLedgerDeps } from "./session-ledger.ts";
import type { WikiPageMeta } from "./store.ts";

const STAMPED = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const GHOST = "617e67b3-13d7-4407-a2fe-37ce79df9634";

const meta = (over: Partial<WikiPageMeta> = {}): WikiPageMeta =>
  ({
    name: "page",
    title: "Page",
    type: "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "plans/page.mdx",
    sessions: [`claude-code:${STAMPED}`],
    ...over,
  }) as WikiPageMeta;

function deps(over: Partial<SessionLedgerDeps> = {}): SessionLedgerDeps {
  return {
    urlConfigured: true,
    baseUrl: "http://ledger.test",
    fetchSessions: async (ids) => ({
      sessions: ids.map((id) => ({
        sessionId: id,
        provider: "claude",
        host: "macpro",
        title: `Session ${id}`,
        first: "2026-09-16T07:24:44.336Z",
        last: "2026-09-16T12:24:25.972Z",
        cost: id === GHOST ? 101.72 : 35.71,
        messages: 100,
        model: "claude-opus-5",
        delegatedCost: 28.75,
      })),
    }),
    fetchMerges: async () => ({ merges: [], rulesStandardizedDate: "2026-07-30" }),
    fetchHandoff: async () => ({ available: false, reason: "no-handoff" }),
    fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
    ...over,
  };
}

const ctx = (over: Partial<ProvenanceContext> = {}): ProvenanceContext => ({
  sessionLedger: deps(),
  knowledgeApiUrl: "http://huginn.test",
  publicUrl: null,
  loadJiraIndex: async () => null,
  stampable: () => false,
  ...over,
});

/** A `ranBy` answer naming one runner. */
const ranBy = (to: string, at = "2026-09-16T07:24:41.216Z") => ({
  available: true,
  handoff: "…",
  timestamp: "2026-09-16T07:12:48.318Z",
  ranBy: [{ sessionId: to, at, host: "macpro" }],
});

describe("leg 3 — handoffs", () => {
  test("a stamped session's `ranBy` becomes a handoff link and a ghost", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({ sessionLedger: deps({ fetchHandoff: async () => ranBy(GHOST) }) }),
    );
    expect(p!.handoffs).toEqual([
      { from: STAMPED, to: GHOST, at: "2026-09-16T07:24:41.216Z", host: "macpro" },
    ]);
    expect(p!.ghosts).toHaveLength(1);
    expect(p!.ghosts[0]!.id).toBe(GHOST);
    expect(p!.ghosts[0]!.ghost).toEqual({
      via: "handoff",
      through: STAMPED,
      stampRef: `claude-code:${GHOST}`,
    });
    expect(p!.links.handoffs).toEqual({ asked: true, reachable: true });
  });

  test("the ghost is NOT in the cost sentence's denominator", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({ sessionLedger: deps({ fetchHandoff: async () => ranBy(GHOST) }) }),
    );
    expect(p!.sessions).toHaveLength(1);
    expect(p!.costedSessions).toBe(1);
    expect(p!.totalCost).toBe(35.71);
  });

  test("one call PER stamped session — the route has no batch form", async () => {
    const fetchHandoff = mock(async () => ({ available: false, reason: "no-handoff" }));
    await pageProvenance(
      meta({ sessions: [`claude-code:${STAMPED}`, `claude-code:${GHOST}`] }),
      ctx({ sessionLedger: deps({ fetchHandoff }) }),
    );
    expect(fetchHandoff).toHaveBeenCalledTimes(2);
    expect((fetchHandoff.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual([
      STAMPED,
      GHOST,
    ]);
  });

  test("a leg that throws leaves no handoff lines, no handoff ghosts and a footer state", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({
        sessionLedger: deps({
          fetchHandoff: async () => {
            throw new Error("connection refused");
          },
        }),
      }),
    );
    expect(p!.handoffs).toEqual([]);
    expect(p!.ghosts).toEqual([]);
    expect(p!.links.handoffs).toEqual({ asked: true, reachable: false });
    // ...and the cost sentence is untouched.
    expect(p!.totalCost).toBe(35.71);
  });

  test("a page past the cap reads NO handoffs at all and says so", async () => {
    const many = Array.from({ length: HANDOFF_READS_MAX + 1 }, (_, i) =>
      `claude-code:0000000${i}-aaaa-bbbb-cccc-dddddddddddd`);
    const fetchHandoff = mock(async () => ranBy(GHOST));
    const p = await pageProvenance(
      meta({ sessions: many }),
      ctx({ sessionLedger: deps({ fetchHandoff }) }),
    );
    expect(fetchHandoff).toHaveBeenCalledTimes(0);
    expect(p!.links.handoffsCapped).toBe(true);
    expect(p!.links.handoffs.asked).toBe(false);
    expect(p!.handoffs).toEqual([]);
  });

  test("exactly the cap is still read", async () => {
    const many = Array.from({ length: HANDOFF_READS_MAX }, (_, i) =>
      `claude-code:0000000${i}-aaaa-bbbb-cccc-dddddddddddd`);
    const fetchHandoff = mock(async () => ({ available: false, reason: "no-handoff" }));
    const p = await pageProvenance(
      meta({ sessions: many }),
      ctx({ sessionLedger: deps({ fetchHandoff }) }),
    );
    expect(fetchHandoff).toHaveBeenCalledTimes(HANDOFF_READS_MAX);
    expect(p!.links.handoffsCapped).toBe(false);
  });

  test("discovery is ONE hop — a ghost's own handoff is never read", async () => {
    const asked: string[] = [];
    const p = await pageProvenance(
      meta(),
      ctx({
        sessionLedger: deps({
          fetchHandoff: async (id) => {
            asked.push(id);
            return ranBy(id === STAMPED ? GHOST : "deeper-ghost");
          },
        }),
      }),
    );
    expect(asked).toEqual([STAMPED]);
    expect(p!.ghosts.map((g) => g.id)).toEqual([GHOST]);
  });
});

describe("leg 4 — `/api/merges?prs=`", () => {
  const prMerge = {
    sessionId: GHOST,
    repo: "/src/muninn",
    prNumber: 553,
    url: "https://github.com/acme/widget/pull/553",
    subject: null,
    mergedAt: "2026-09-16T11:44:55.071Z",
    mergeOk: true,
    gate: { matched: true, gated: true, gatedBy: "gate", gates: { "gate-review-floor": {} } },
    preStandardization: false,
  };

  test("a page's `prs:` entries find the merging session as a PR ghost", async () => {
    const p = await pageProvenance(
      meta({ sessions: [], prs: ["acme/widget#553"] }),
      ctx({
        sessionLedger: deps({
          fetchMergesForPrs: async () => ({ merges: [prMerge], unmapped: [] }),
        }),
      }),
    );
    expect(p!.ghosts.map((g) => g.id)).toEqual([GHOST]);
    expect(p!.ghosts[0]!.ghost).toEqual({
      via: "pr",
      through: "#553",
      stampRef: `claude-code:${GHOST}`,
    });
    // ...and its merge row is on the spine, gate and all.
    expect(p!.merges.map((m) => m.prNumber)).toEqual([553]);
    expect(p!.merges[0]!.gate).toEqual({
      matched: true,
      gated: true,
      gatedBy: "gate",
      gates: ["gate-review-floor"],
    });
  });

  test("the list is capped client-side, and the cap is said out loud", async () => {
    const asked: string[][] = [];
    const prs = Array.from({ length: PR_READS_MAX + 2 }, (_, i) => `acme/widget#${i + 1}`);
    const p = await pageProvenance(
      meta({ sessions: [], prs }),
      ctx({
        sessionLedger: deps({
          fetchMergesForPrs: async (coords) => {
            asked.push(coords);
            return { merges: [], unmapped: [] };
          },
        }),
      }),
    );
    expect(asked[0]).toHaveLength(PR_READS_MAX);
    expect(p!.links.prsCapped).toBe(true);
  });

  test("a `prs:` value that is not a coordinate is never sent", async () => {
    const asked: string[][] = [];
    await pageProvenance(
      meta({ sessions: [], prs: ["not a coordinate", "acme/widget#553"] }),
      ctx({
        sessionLedger: deps({
          fetchMergesForPrs: async (coords) => {
            asked.push(coords);
            return { merges: [], unmapped: [] };
          },
        }),
      }),
    );
    expect(asked).toEqual([["acme/widget#553"]]);
  });

  test("a leg that throws leaves no PR ghosts and a footer state", async () => {
    const p = await pageProvenance(
      meta({ sessions: [], prs: ["acme/widget#553"] }),
      ctx({
        sessionLedger: deps({
          fetchMergesForPrs: async () => {
            throw new Error("500");
          },
        }),
      }),
    );
    expect(p!.ghosts).toEqual([]);
    expect(p!.links.prs).toEqual({ asked: true, reachable: false });
  });

  test("a page with no `prs:` never asks", async () => {
    const fetchMergesForPrs = mock(async () => ({ merges: [], unmapped: [] }));
    const p = await pageProvenance(meta(), ctx({ sessionLedger: deps({ fetchMergesForPrs }) }));
    expect(fetchMergesForPrs).toHaveBeenCalledTimes(0);
    expect(p!.links.prs.asked).toBe(false);
  });
});

describe("legs 5 and 6 — enriching the ghosts", () => {
  test("a ghost is priced and titled by leg 5, and its own merges arrive on leg 6", async () => {
    const mergeCalls: string[][] = [];
    const p = await pageProvenance(
      meta(),
      ctx({
        sessionLedger: deps({
          fetchHandoff: async () => ranBy(GHOST),
          fetchMerges: async (ids) => {
            mergeCalls.push(ids);
            return ids.includes(GHOST)
              ? {
                  rulesStandardizedDate: "2026-07-30",
                  merges: [
                    {
                      sessionId: GHOST,
                      repo: "/src/muninn",
                      prNumber: 553,
                      url: "https://github.com/acme/widget/pull/553",
                      subject: null,
                      mergedAt: "2026-09-16T11:44:55.071Z",
                      mergeOk: true,
                      gate: { matched: true, gated: true, gatedBy: "gate", gates: {} },
                      preStandardization: false,
                    },
                  ],
                }
              : { merges: [], rulesStandardizedDate: "2026-07-30" };
          },
        }),
      }),
    );
    // Leg 2 over the stamped ids, then leg 6 over the ghost ids — two calls, and
    // the second is the ONLY way #553 is reachable on a page that stamps neither
    // the ghost nor its PR.
    expect(mergeCalls).toEqual([[STAMPED], [GHOST]]);
    expect(p!.merges.map((m) => m.prNumber)).toEqual([553]);
    expect(p!.ghosts[0]!.cost).toBe(101.72);
    expect(p!.ghosts[0]!.title).toBe(`Session ${GHOST}`);
    expect(p!.links.ghostFacts).toEqual({ asked: true, reachable: true });
    expect(p!.links.ghostMerges).toEqual({ asked: true, reachable: true });
    expect(p!.rulesStandardizedDate).toBe("2026-07-30");
  });

  test("leg 5 failing leaves the ghost id-only — no cost, no title, no Stamp ref", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({
        sessionLedger: deps({
          fetchHandoff: async () => ranBy(GHOST),
          fetchSessions: async (ids) => {
            if (ids.includes(GHOST)) throw new Error("down");
            return {
              sessions: ids.map((id) => ({ sessionId: id, provider: "claude", cost: 35.71 })),
            };
          },
        }),
      }),
    );
    const ghost = p!.ghosts[0]!;
    expect(ghost.cost).toBeNull();
    expect(ghost.title).toBeNull();
    expect(ghost.provider).toBeNull();
    expect(ghost.ghost!.stampRef).toBeNull();
    expect(p!.links.ghostFacts).toEqual({ asked: true, reachable: false });
  });

  test("leg 6 failing leaves the ghost row without its merge rows", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({
        sessionLedger: deps({
          fetchHandoff: async () => ranBy(GHOST),
          fetchMerges: async (ids) => {
            if (ids.includes(GHOST)) throw new Error("down");
            return { merges: [] };
          },
        }),
      }),
    );
    expect(p!.ghosts).toHaveLength(1);
    expect(p!.merges).toEqual([]);
    expect(p!.links.ghostMerges).toEqual({ asked: true, reachable: false });
  });

  test("no ghosts ⇒ neither leg runs", async () => {
    const p = await pageProvenance(meta(), ctx());
    expect(p!.links.ghostFacts.asked).toBe(false);
    expect(p!.links.ghostMerges.asked).toBe(false);
  });

  test("a merge reported by both leg 4 and leg 6 renders ONCE", async () => {
    const row = {
      sessionId: GHOST,
      repo: "/src/muninn",
      prNumber: 553,
      url: "https://github.com/acme/widget/pull/553",
      subject: null,
      mergedAt: "2026-09-16T11:44:55.071Z",
      mergeOk: true,
      gate: { matched: false },
      preStandardization: false,
    };
    const p = await pageProvenance(
      meta({ sessions: [], prs: ["acme/widget#553"] }),
      ctx({
        sessionLedger: deps({
          fetchMergesForPrs: async () => ({ merges: [row], unmapped: [] }),
          fetchMerges: async () => ({ merges: [row] }),
        }),
      }),
    );
    expect(p!.merges).toHaveLength(1);
  });
});

describe("the whole fan-out", () => {
  test("legs 1–4 start TOGETHER; 5 and 6 wait for 3 and 4 — two dependent hops at worst", async () => {
    const order: string[] = [];
    await pageProvenance(
      meta({ prs: ["acme/widget#553"] }),
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => {
            order.push(ids.includes(GHOST) ? "facts:ghost" : "facts:stamped");
            return { sessions: [] };
          },
          fetchMerges: async (ids) => {
            order.push(ids.includes(GHOST) ? "merges:ghost" : "merges:stamped");
            return { merges: [] };
          },
          fetchHandoff: async () => {
            order.push("handoff");
            return ranBy(GHOST);
          },
          fetchMergesForPrs: async () => {
            order.push("prs");
            return { merges: [], unmapped: [] };
          },
        }),
      }),
    );
    expect(order.slice(0, 4).sort()).toEqual(["facts:stamped", "handoff", "merges:stamped", "prs"]);
    expect(order.slice(4).sort()).toEqual(["facts:ghost", "merges:ghost"]);
  });

  test("the deadline firing mid-fan-out is reported, and the chain still renders what arrived", async () => {
    const p = await pageProvenance(
      meta(),
      ctx({
        budgetMs: 25,
        sessionLedger: deps({
          fetchHandoff: async () => {
            await new Promise((r) => setTimeout(r, 60));
            return ranBy(GHOST);
          },
        }),
      }),
    );
    expect(p!.links.timedOut).toBe(true);
    expect(p!.sessions).toHaveLength(1);
  });

  test("an unconfigured host runs none of the four legs", async () => {
    const p = await pageProvenance(
      meta({ prs: ["acme/widget#553"] }),
      ctx({ sessionLedger: deps({ urlConfigured: false }) }),
    );
    expect(p!.links.handoffs.asked).toBe(false);
    expect(p!.links.prs.asked).toBe(false);
    expect(p!.ghosts).toEqual([]);
  });
});

describe("stampable", () => {
  test("rides the payload from the ONE predicate, per page", async () => {
    const seen: (string | undefined)[] = [];
    const p = await pageProvenance(
      meta(),
      ctx({
        stampable: (dir) => {
          seen.push(dir);
          return true;
        },
      }),
      "/src/mimir",
    );
    expect(seen).toEqual(["/src/mimir"]);
    expect(p!.stampable).toBe(true);
  });

  test("false when the predicate says so", async () => {
    const p = await pageProvenance(meta(), ctx({ stampable: () => false }), "/src/mimir");
    expect(p!.stampable).toBe(false);
  });
});

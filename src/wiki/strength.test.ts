/**
 * `neighbours` and `nearScores` — each signal and its threshold, each cut on
 * its side, both digest caps, the session-ref normalisation, the hop ordering
 * and the near map's bounds.
 *
 * Driven against a REAL `buildWikiIndex` where the rule reads what the index
 * BUILDS (`outgoing`, `backlinks`, `prRefs`, `sessions`, `parent`) — the reason
 * `related.test.ts` gives. Two cases use a synthetic index: the hop-ordering
 * sweep (pure arithmetic) and the `NEAR_MAX` cap, which needs more pages than a
 * temp wiki should write.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";
import {
  hopOne,
  hopTwo,
  isBookkeeping,
  nearScores,
  neighbours,
  strengthOf,
  type Neighbour,
  type NeighbourSignals,
} from "./strength.ts";
import {
  NEAR_HOP_DECAY,
  NEAR_MAX,
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  STRENGTH_LINK_BOTH_WAYS,
  STRENGTH_LINK_ONE_WAY,
  STRENGTH_MAX,
  STRENGTH_PR_CAP,
  STRENGTH_PR_WEIGHT,
  STRENGTH_SESSION_CAP,
  STRENGTH_SESSION_DIGEST,
  STRENGTH_SESSION_WEIGHT,
} from "./related-constants.ts";

function page(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, ...fm, "---", "", body, ""].join("\n");
}

async function indexOver(
  pages: Array<[string, string]>,
  fn: (index: WikiIndex) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-strength-"));
  try {
    for (const [rel, body] of pages) {
      await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(dir, rel), body, "utf8");
    }
    await fn(await buildWikiIndex(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const byPath = (ns: Neighbour[]): Record<string, Neighbour> =>
  Object.fromEntries(ns.map((n) => [n.relPath, n]));

const S1 = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const S2 = "ses_7f3a9b2c1d";

describe("neighbours — the signals", () => {
  test("a link counts one way at 1.0 and both ways at 1.6", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "Links [[out]] and [[mutual]].")],
        ["plans/out.md", page("Out", [], "Nothing.")],
        ["plans/in.md", page("In", [], "Reads [[open]].")],
        ["plans/mutual.md", page("Mutual", [], "Reads [[open]].")],
      ],
      (index) => {
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/out.md"]!.score).toBe(STRENGTH_LINK_ONE_WAY);
        expect(n["plans/out.md"]!.signals.citedBy).toBe(true);
        expect(n["plans/in.md"]!.score).toBe(STRENGTH_LINK_ONE_WAY);
        expect(n["plans/in.md"]!.signals.cites).toBe(true);
        expect(n["plans/mutual.md"]!.score).toBe(STRENGTH_LINK_BOTH_WAYS);
      },
    );
  });

  test("ONE shared PR is not a signal; two are, at 0.6 each, capped at 1.8", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "muninn#1 muninn#2 muninn#3 muninn#4")],
        ["plans/one.md", page("One", [], "muninn#1")],
        ["plans/two.md", page("Two", [], "muninn#1 muninn#2")],
        ["plans/four.md", page("Four", [], "muninn#4 muninn#3 muninn#2 muninn#1")],
      ],
      (index) => {
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/one.md"]).toBeUndefined();
        expect(n["plans/two.md"]!.score).toBeCloseTo(2 * STRENGTH_PR_WEIGHT, 10);
        expect(n["plans/four.md"]!.score).toBe(STRENGTH_PR_CAP);
        // The open page's spelling and ORDER, not the candidate's.
        expect(n["plans/four.md"]!.signals.prs).toEqual([
          "RuneLind/muninn#1",
          "RuneLind/muninn#2",
          "RuneLind/muninn#3",
          "RuneLind/muninn#4",
        ]);
      },
    );
  });

  test("PR refs match without case", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", ["prs: [RuneLind/muninn#5, RuneLind/muninn#6]"], "Body.")],
        ["plans/low.md", page("Low", ["prs: [runelind/MUNINN#5, runelind/muninn#6]"], "Body.")],
      ],
      (index) => {
        expect(byPath(neighbours(index, "plans/open.md"))["plans/low.md"]!.signals.prs).toEqual([
          "RuneLind/muninn#5",
          "RuneLind/muninn#6",
        ]);
      },
    );
  });

  test("a shared session counts at 1.2, two at the 2.4 cap", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [claude-code:${S1}, opencode:${S2}]`], "Body.")],
        ["plans/one.md", page("One", [`sessions: [claude-code:${S1}]`], "Body.")],
        ["plans/two.md", page("Two", [`sessions: [opencode:${S2}, claude-code:${S1}]`], "Body.")],
      ],
      (index) => {
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/one.md"]!.score).toBe(STRENGTH_SESSION_WEIGHT);
        expect(n["plans/two.md"]!.score).toBe(STRENGTH_SESSION_CAP);
      },
    );
  });

  test("`provider:id` and a bare id are one session; the OPEN page's spelling is kept", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [claude-code:${S1}, ${S2}]`], "Body.")],
        ["plans/bare.md", page("Bare", [`sessions: [${S1}]`], "Body.")],
        ["plans/prefixed.md", page("Prefixed", [`sessions: [opencode:${S2}]`], "Body.")],
      ],
      (index) => {
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/bare.md"]!.signals.sessions).toEqual([`claude-code:${S1}`]);
        expect(n["plans/prefixed.md"]!.signals.sessions).toEqual([S2]);
      },
    );
  });

  test("a page stamping one session twice counts it once", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [claude-code:${S1}]`], "Body.")],
        ["plans/twice.md", page("Twice", [`sessions: [${S1}, claude-code:${S1}]`], "Body.")],
      ],
      (index) => {
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/twice.md"]!.signals.sessions).toEqual([`claude-code:${S1}`]);
        expect(n["plans/twice.md"]!.score).toBe(STRENGTH_SESSION_WEIGHT);
      },
    );
  });

  test("a ref that is not a session id shape pairs nothing", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", ["sessions: [see notes]"], "Body.")],
        ["plans/same.md", page("Same", ["sessions: [see notes]"], "Body.")],
      ],
      (index) => {
        expect(neighbours(index, "plans/open.md")).toEqual([]);
      },
    );
  });

  test("signals add: link + PRs + session", async () => {
    await indexOver(
      [
        [
          "plans/open.md",
          page("Open", [`sessions: [${S1}]`], "Links [[all]]. muninn#1 muninn#2"),
        ],
        ["plans/all.md", page("All", [`sessions: [${S1}]`], "Reads [[open]]. muninn#1 muninn#2")],
      ],
      (index) => {
        const all = byPath(neighbours(index, "plans/open.md"))["plans/all.md"]!;
        expect(all.score).toBeCloseTo(
          STRENGTH_LINK_BOTH_WAYS + 2 * STRENGTH_PR_WEIGHT + STRENGTH_SESSION_WEIGHT,
          10,
        );
      },
    );
  });
});

test("one shared PR ref is no signal even when two pages' relPaths differ only by case", () => {
  // Synthetic: a real scan of a case-insensitive filesystem cannot hold
  // `plans/Other.md` and `plans/other.md` at once. Both normalize to one key,
  // so the inverted PR map lists that key twice under the one ref.
  const metas = new Map<string, WikiPageMeta>();
  const add = (rel: string, prRefs: string[]) =>
    metas.set(rel, { relPath: rel, name: rel, title: rel, type: "plan", tags: [], aliases: [], prRefs } as unknown as WikiPageMeta);
  add("plans/open.md", ["o/r#1", "o/r#2"]);
  add("plans/Other.md", ["o/r#1"]);
  add("plans/other.md", ["o/r#1"]);
  const index = {
    pages: [...metas.values()],
    outgoing: new Map<string, string[]>(),
    backlinks: new Map<string, string[]>(),
    resolveRelPath: (rp: string) => metas.get(rp) ?? [...metas.values()].find((m) => m.relPath.toLowerCase() === rp.toLowerCase()),
  } as unknown as WikiIndex;
  expect(neighbours(index, "plans/open.md")).toEqual([]);
});

describe("neighbours — the digest caps", () => {
  test("a PR digest is cut from the PR signal on EITHER end", async () => {
    const many = Array.from({ length: RELATED_DIGEST_PRS - 1 }, (_, i) => `huginn#${i + 1}`).join(" ");
    const tooMany = Array.from({ length: RELATED_DIGEST_PRS }, (_, i) => `huginn#${i + 1}`).join(" ");
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "muninn#1 muninn#2")],
        // Exactly RELATED_DIGEST_PRS refs: not a digest.
        ["plans/edge.md", page("Edge", [], `muninn#1 muninn#2 ${many.split(" ").slice(0, RELATED_DIGEST_PRS - 2).join(" ")}`)],
        // One over: a digest.
        ["plans/digest.md", page("Digest", [], `muninn#1 muninn#2 ${tooMany}`)],
      ],
      (index) => {
        expect(index.resolveRelPath("plans/edge.md")!.prRefs!.length).toBe(RELATED_DIGEST_PRS);
        expect(index.resolveRelPath("plans/digest.md")!.prRefs!.length).toBeGreaterThan(RELATED_DIGEST_PRS);
        const n = byPath(neighbours(index, "plans/open.md"));
        expect(n["plans/edge.md"]).toBeDefined();
        expect(n["plans/digest.md"]).toBeUndefined();
        // Symmetric: the digest as the OPEN page pairs with nobody on PRs.
        expect(byPath(neighbours(index, "plans/digest.md"))["plans/open.md"]).toBeUndefined();
      },
    );
  });

  test("a session on more than STRENGTH_SESSION_DIGEST pages is no signal; at the cap it is", async () => {
    const stamped = (n: number, id: string): Array<[string, string]> =>
      Array.from({ length: n }, (_, i) => [
        `notes/${id.slice(0, 4)}-${i}.md`,
        page(`F${i}`, [`sessions: [${id}]`], "Body."),
      ]);
    const AT = "aaaa1111-0000-0000-0000-000000000000";
    const OVER = "bbbb2222-0000-0000-0000-000000000000";
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [${AT}, ${OVER}]`], "Body.")],
        // The count includes the open page: 1 + (cap − 1) = cap pages for AT,
        // 1 + cap = cap + 1 pages for OVER.
        ...stamped(STRENGTH_SESSION_DIGEST - 1, AT),
        ...stamped(STRENGTH_SESSION_DIGEST, OVER),
      ],
      (index) => {
        const n = neighbours(index, "plans/open.md");
        expect(n.length).toBe(STRENGTH_SESSION_DIGEST - 1);
        for (const nb of n) expect(nb.signals.sessions).toEqual([AT]);
      },
    );
  });
});

describe("neighbours — the cuts and their sides", () => {
  test("bookkeeping: never a candidate, and an open bookkeeping page gets none", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [${S1}]`], "Body.")],
        ["index.md", page("Index", [`sessions: [${S1}]`], "Catalog of [[open]].")],
      ],
      (index) => {
        expect(isBookkeeping("index.md")).toBe(true);
        expect(neighbours(index, "plans/open.md")).toEqual([]);
        expect(neighbours(index, "index.md")).toEqual([]);
      },
    );
  });

  test("hub: never a candidate, and an open hub gets none", async () => {
    const fillers: Array<[string, string]> = Array.from({ length: RELATED_HUB_BACKLINKS + 1 }, (_, i) => [
      `fill/f${i}.md`,
      page(`Fill ${i}`, [], "Points at [[hub]]."),
    ]);
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "Reads [[hub]].")],
        ["plans/hub.md", page("Hub", [], "Everything.")],
        ...fillers,
      ],
      (index) => {
        expect(neighbours(index, "plans/open.md")).toEqual([]);
        expect(neighbours(index, "plans/hub.md")).toEqual([]);
      },
    );
  });

  test("culled: cut as a candidate, but a culled OPEN page keeps its neighbours", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [`sessions: [${S1}]`], "Body.")],
        ["plans/gone.md", page("Gone", ["signal: none", `sessions: [${S1}]`], "Body.")],
      ],
      (index) => {
        expect(index.resolveRelPath("plans/gone.md")!.culled).toBe(true);
        expect(neighbours(index, "plans/open.md")).toEqual([]);
        expect(neighbours(index, "plans/gone.md").map((n) => n.relPath)).toEqual(["plans/open.md"]);
      },
    );
  });

  test("the open page's OWN attachment is cut; seen from the attachment, the parent is not", async () => {
    await indexOver(
      [
        ["plans/p.md", page("P", [], "See [proto](./p-prototype.html).")],
        ["plans/p-prototype.html", "<html><head><title>P prototype</title></head><body>x</body></html>"],
      ],
      (index) => {
        expect(index.resolveRelPath("plans/p-prototype.html")!.parent).toBe("plans/p.md");
        expect(neighbours(index, "plans/p.md")).toEqual([]);
        expect(neighbours(index, "plans/p-prototype.html").map((n) => n.relPath)).toEqual(["plans/p.md"]);
      },
    );
  });

  test("an unknown relPath answers []", async () => {
    await indexOver([["plans/a.md", page("A", [], "x")]], (index) => {
      expect(neighbours(index, "plans/nope.md")).toEqual([]);
      expect(nearScores(index, "plans/nope.md")).toEqual({});
    });
  });
});

describe("hop ordering", () => {
  test("the tuned numbers are the ones the docblocks were measured against", () => {
    // Value pins: a move must be a deliberate edit here too.
    expect(STRENGTH_LINK_ONE_WAY).toBe(1.0);
    expect(STRENGTH_LINK_BOTH_WAYS).toBe(1.6);
    expect(STRENGTH_PR_WEIGHT).toBe(0.6);
    expect(STRENGTH_PR_CAP).toBe(1.8);
    expect(STRENGTH_SESSION_WEIGHT).toBe(1.2);
    expect(STRENGTH_SESSION_CAP).toBe(2.4);
    expect(STRENGTH_SESSION_DIGEST).toBe(12);
    expect(STRENGTH_MAX).toBeCloseTo(5.8, 10);
    expect(NEAR_HOP_DECAY).toBe(0.55);
    expect(NEAR_MAX).toBe(200);
  });

  test("max(hop 2) < min(hop 1) over every reachable signal combination", () => {
    const scores: number[] = [];
    for (const [cites, citedBy] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      for (let prs = 0; prs <= 5; prs++) {
        for (let sessions = 0; sessions <= 3; sessions++) {
          const signals: NeighbourSignals = {
            cites,
            citedBy,
            prs: Array.from({ length: prs }, (_, i) => `o/r#${i}`),
            sessions: Array.from({ length: sessions }, (_, i) => `s${i}`),
          };
          const s = strengthOf(signals);
          if (s > 0) scores.push(s); // a pair with no counting signal is no neighbour
        }
      }
    }
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...scores)).toBeCloseTo(STRENGTH_MAX, 10);
    const minHop1 = Math.min(...scores.map(hopOne));
    const maxParent = Math.max(...scores.map(hopOne));
    const maxHop2 = Math.max(...scores.map((s) => hopTwo(maxParent, s)));
    expect(minHop1).toBe(0.5);
    expect(maxHop2).toBeLessThan(minHop1);
  });
});

describe("nearScores", () => {
  test("first hop beats second hop; the open page is not in its own map", async () => {
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "Links [[mid]].")],
        ["plans/mid.md", page("Mid", [], "Links [[far]].")],
        ["plans/far.md", page("Far", [], "Nothing.")],
      ],
      (index) => {
        const near = nearScores(index, "plans/open.md");
        expect(near["plans/open.md"]).toBeUndefined();
        expect(near["plans/mid.md"]).toBe(0.5);
        expect(near["plans/far.md"]).toBeCloseTo(0.5 * 0.55 * 0.5, 2);
      },
    );
  });

  test("a hub is never in the map, and nothing is reached THROUGH one", async () => {
    const fillers: Array<[string, string]> = Array.from({ length: RELATED_HUB_BACKLINKS + 1 }, (_, i) => [
      `fill/f${i}.md`,
      page(`Fill ${i}`, [], "Points at [[hub]]."),
    ]);
    await indexOver(
      [
        ["plans/open.md", page("Open", [], "Reads [[hub]].")],
        ["plans/hub.md", page("Hub", [], "Links [[behind]].")],
        ["plans/behind.md", page("Behind", [], "x")],
        ...fillers,
      ],
      (index) => {
        expect(nearScores(index, "plans/open.md")).toEqual({});
        expect(nearScores(index, "plans/hub.md")).toEqual({});
      },
    );
  });

  test("keys are the listing's relPath spelling, capitals kept", async () => {
    await indexOver(
      [
        ["plans/Open.md", page("Open", [], "Links [[Mixed-Case]].")],
        ["Notes/Mixed-Case.md", page("Mixed", [], "x")],
      ],
      (index) => {
        expect(Object.keys(nearScores(index, "plans/Open.md"))).toEqual(["Notes/Mixed-Case.md"]);
      },
    );
  });

  test(`the map keeps the ${NEAR_MAX} strongest entries`, () => {
    // Synthetic: the open page links to 30 pages, each of which links to 10
    // pages of its own — 30 first-hop + 300 second-hop candidates.
    const metas = new Map<string, WikiPageMeta>();
    const outgoing = new Map<string, string[]>();
    const backlinks = new Map<string, string[]>();
    const add = (rel: string) =>
      metas.set(rel, { relPath: rel, name: rel, title: rel, type: "note", tags: [], aliases: [] } as unknown as WikiPageMeta);
    const link = (from: string, to: string) => {
      outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
      backlinks.set(to, [...(backlinks.get(to) ?? []), from]);
    };
    add("open.md");
    for (let i = 0; i < 30; i++) {
      const mid = `mid/m${i}.md`;
      add(mid);
      link("open.md", mid);
      for (let j = 0; j < 10; j++) {
        const far = `far/f${i}-${j}.md`;
        add(far);
        link(mid, far);
      }
    }
    const index = {
      pages: [...metas.values()],
      outgoing,
      backlinks,
      resolveRelPath: (rp: string) => metas.get(rp),
    } as unknown as WikiIndex;
    const near = nearScores(index, "open.md");
    expect(Object.keys(near).length).toBe(NEAR_MAX);
    // Every first-hop page survives the cut: they are the strongest.
    for (let i = 0; i < 30; i++) expect(near[`mid/m${i}.md`]).toBe(0.5);
  });
});

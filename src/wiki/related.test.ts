/**
 * `computeRelated` — the three sources, the two cuts, the order and the
 * never-transitive rule.
 *
 * Driven against a REAL `buildWikiIndex` over a temp wiki rather than a
 * hand-built index: the rule reads `outgoing`, `backlinks` and `prRefs`, and all
 * three are things the index BUILDS — a fixture that fills them by hand would
 * pass while the wiring that produces them is broken.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";
import { computeRelated, RELATED_DIGEST_PRS, RELATED_HUB_BACKLINKS } from "./related.ts";

/** A plan page: frontmatter lines, then the body. */
function page(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, ...fm, "---", "", body, ""].join("\n");
}

/** `relPath → why`, which is the whole decision this module makes. */
function whyByPath(index: WikiIndex, relPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of computeRelated(index, relPath)) out[r.relPath] = r.why;
  return out;
}

const OPEN = "plans/open.md";

/**
 * ONE wiki holding every source and every cut at once:
 *
 *  - `open` — the page under test. Declares `muninn#549` in `prs:` and names
 *    `muninn#550` in its body as a pull URL; links to `cited` and `both`.
 *  - `citer` — links to `open` (source 1).
 *  - `cited` — linked FROM `open` (source 2).
 *  - `both` — both, AND shares two PR refs (three reasons on one row).
 *  - `sharer` — shares both refs and links neither way (source 3).
 *  - `onepr` — shares ONE ref: under `RELATED_SHARED_PRS_MIN`, so not related.
 *  - `digest` — names 16 refs including both of `open`'s: cut from source 3.
 *  - `far` — linked from `cited` only: the transitive case.
 *  - `index.md` — bookkeeping, links to `open`.
 *  - `hub` — links to `open` and is linked from N fillers (written per test).
 */
const PAGES: Array<[string, string]> = [
  [
    OPEN,
    page(
      "Open",
      ["prs: [RuneLind/muninn#549]", "plan_status: in-flight", "status_date: 2026-09-20"],
      "Body links [[cited]] and [[both]], and names https://github.com/RuneLind/muninn/pull/550.",
    ),
  ],
  ["plans/citer.md", page("Citer", ["status_date: 2026-09-10"], "Reads [[open]].")],
  ["plans/cited.md", page("Cited", ["status_date: 2026-09-08"], "Links [[far]].")],
  [
    "plans/both.md",
    page(
      "Both",
      ["status_date: 2026-09-12"],
      "Cites [[open]] and names muninn #549 plus claude-usage#1 and muninn#550.",
    ),
  ],
  [
    "plans/sharer.md",
    page("Sharer", ["status_date: 2026-09-05"], "Names muninn#549 and muninn #550, links nothing."),
  ],
  ["plans/onepr.md", page("Onepr", ["status_date: 2026-09-04"], "Names muninn#549 alone.")],
  [
    "plans/digest.md",
    page(
      "Digest",
      ["status_date: 2026-09-19"],
      // 16 refs — one past RELATED_DIGEST_PRS — two of which are `open`'s.
      ["muninn#549", "muninn#550", ...Array.from({ length: 14 }, (_, i) => `huginn#${i + 1}`)].join(
        ", ",
      ),
    ),
  ],
  ["plans/far.md", page("Far", ["status_date: 2026-09-01"], "Nothing.")],
  ["index.md", page("Index", ["status_date: 2026-09-21"], "Catalog of [[open]].")],
  ["plans/hub.md", page("Hub", ["status_date: 2026-09-11"], "Everything, including [[open]].")],
];

let root = "";
/** Fillers 1..N each link to `hub` and nothing else, so `hub`'s backlink count
 *  is exactly the number of them on disk. The directory is REPLACED, not added
 *  to: a later `writeFillers(0)` must leave an earlier test's 26 behind, or the
 *  hub cut silently stays armed for the rest of the file. */
async function writeFillers(n: number): Promise<void> {
  await rm(path.join(root, "fill"), { recursive: true, force: true });
  await mkdir(path.join(root, "fill"), { recursive: true });
  for (let i = 1; i <= n; i++) {
    await writeFile(
      path.join(root, `fill/f${i}.md`),
      page(`Fill ${i}`, [], "Points at [[hub]]."),
      "utf8",
    );
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-related-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("computeRelated", () => {
  test("the three sources, with a multi-reason why on the page reached by all of them", async () => {
    await writeFillers(0);
    const why = whyByPath(await buildWikiIndex(root), OPEN);
    expect(why["plans/citer.md"]).toBe("cites this page");
    expect(why["plans/cited.md"]).toBe("cited by this page");
    expect(why["plans/sharer.md"]).toBe("shares RuneLind/muninn#549, RuneLind/muninn#550");
    // Reasons in the fixed source order, deduped, joined with ` · `.
    expect(why["plans/both.md"]).toBe(
      "cites this page · cited by this page · shares RuneLind/muninn#549, RuneLind/muninn#550",
    );
  });

  test("ONE shared PR ref is not enough", async () => {
    await writeFillers(0);
    expect(whyByPath(await buildWikiIndex(root), OPEN)["plans/onepr.md"]).toBeUndefined();
  });

  test("NEVER transitive: a page two hops away is not related", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // `open` → `cited` → `far` really is a path in the graph...
    expect(index.outgoing.get("plans/cited.md")).toContain("plans/far.md");
    // ...and `far` is still not a row.
    expect(whyByPath(index, OPEN)["plans/far.md"]).toBeUndefined();
  });

  test("the open page is never its own related row", async () => {
    await writeFillers(0);
    expect(whyByPath(await buildWikiIndex(root), OPEN)[OPEN]).toBeUndefined();
  });

  test("bookkeeping pages are cut whatever the link graph says", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // It really does cite the open page, and its backlink count is far under
    // the hub threshold — the two facts that make this its own cut.
    expect(index.outgoing.get("index.md")).toContain(OPEN);
    expect((index.backlinks.get("index.md") ?? []).length).toBeLessThan(RELATED_HUB_BACKLINKS);
    expect(whyByPath(index, OPEN)["index.md"]).toBeUndefined();
  });

  test("a DIGEST is cut from the PR-sharing source only", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // It shares both of the open page's refs...
    expect(index.resolveRelPath("plans/digest.md")!.prRefs!.length).toBe(RELATED_DIGEST_PRS + 1);
    // ...and is still not a row, because it names nothing else either.
    expect(whyByPath(index, OPEN)["plans/digest.md"]).toBeUndefined();
  });

  test("a digest that LINKS to the page still appears, with the link as its reason", async () => {
    await writeFillers(0);
    const linking = path.join(root, "plans/digest.md");
    const before = await Bun.file(linking).text();
    try {
      await writeFile(linking, before.replace("huginn#14", "huginn#14 — see [[open]]"), "utf8");
      expect(whyByPath(await buildWikiIndex(root), OPEN)["plans/digest.md"]).toBe(
        "cites this page",
      );
    } finally {
      await writeFile(linking, before, "utf8");
    }
  });

  test("the hub cut fires ABOVE the threshold, not at it", async () => {
    await writeFillers(RELATED_HUB_BACKLINKS);
    let index = await buildWikiIndex(root);
    expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS);
    expect(whyByPath(index, OPEN)["plans/hub.md"]).toBe("cites this page");

    await writeFillers(RELATED_HUB_BACKLINKS + 1);
    index = await buildWikiIndex(root);
    expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS + 1);
    expect(whyByPath(index, OPEN)["plans/hub.md"]).toBeUndefined();
  });

  test("rows come back NEWEST first", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), OPEN).map((r) => r.relPath)).toEqual([
      "plans/both.md", // 2026-09-12
      "plans/hub.md", // 2026-09-11
      "plans/citer.md", // 2026-09-10
      "plans/cited.md", // 2026-09-08
      "plans/sharer.md", // 2026-09-05
    ]);
  });

  test("an unknown relPath answers [] rather than throwing", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), "plans/nope.md")).toEqual([]);
  });

  test("ONE neighbour is one row — the transitive page is reached, from the other end", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), "plans/far.md").map((r) => r.relPath)).toEqual(
      ["plans/cited.md"],
    );
  });

  test("a page with no neighbours answers [] — the reader renders no block", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), "plans/onepr.md")).toEqual([]);
  });

  test("a DIGEST open page pairs with nobody on PR refs — the cut is symmetric", async () => {
    await writeFillers(0);
    // `sharer` shares two of the digest's refs, so a candidate-only cut would
    // pair them. The inference "≥2 shared refs means one piece of work" is as
    // false in this direction as in the other.
    const index = await buildWikiIndex(root);
    expect(index.resolveRelPath("plans/sharer.md")!.prRefs).toEqual([
      "RuneLind/muninn#549",
      "RuneLind/muninn#550",
    ]);
    expect(computeRelated(index, "plans/digest.md")).toEqual([]);
  });
});

/**
 * A throwaway wiki for ONE case, built and removed inside the test.
 *
 * Separate from the shared fixture above on purpose: that one's pages are what
 * every ordering and count expectation in the first block is written against,
 * so a page added there moves assertions in tests it has nothing to do with.
 */
async function indexOver(
  pages: Array<[string, string]>,
  fn: (index: WikiIndex) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-related-case-"));
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

/** A bare `.html` explainer — no frontmatter, which is what makes it one. */
function html(title: string): string {
  return `<html><head><title>${title}</title></head><body><p>Body.</p></body></html>`;
}

describe("computeRelated — the cuts applied to the OPEN page", () => {
  test("a BOOKKEEPING page gets no block of its own", async () => {
    await indexOver(
      [
        ["index.md", page("Index", ["status_date: 2026-09-20"], "Catalog of [[a]] and [[b]].")],
        ["log.md", page("Log", ["status_date: 2026-09-19"], "An entry about [[a]].")],
        ["plans/index.md", page("Plan board", ["status_date: 2026-09-18"], "Board of [[a]].")],
        ["plans/a.md", page("A", ["status_date: 2026-09-17"], "Reads [[b]].")],
        ["plans/b.md", page("B", ["status_date: 2026-09-16"], "Nothing.")],
      ],
      (index) => {
        // Each of the three really has neighbours, so the `[]` below is the cut
        // and not an empty graph — measured on mimir, opening `index.md` yielded
        // 340 rows, `plans/index.md` 246 and `log.md` 189.
        for (const meta of ["index.md", "log.md", "plans/index.md"]) {
          expect(index.outgoing.get(meta)).toContain("plans/a.md");
          expect(computeRelated(index, meta)).toEqual([]);
        }
        // …and an ordinary page in the same wiki still answers rows, so the cut
        // is not "this fixture has no edges".
        expect(computeRelated(index, "plans/a.md").map((r) => r.relPath)).toEqual(["plans/b.md"]);
      },
    );
  });

  test("a HUB gets no block of its own", async () => {
    const pages: Array<[string, string]> = [
      ["plans/hub.md", page("Hub", ["status_date: 2026-09-20"], "Everything, incl. [[a]].")],
      ["plans/a.md", page("A", ["status_date: 2026-09-10"], "Nothing.")],
    ];
    for (let i = 1; i <= RELATED_HUB_BACKLINKS + 1; i++) {
      pages.push([`fill/f${i}.md`, page(`Fill ${i}`, [], "Points at [[hub]].")]);
    }
    await indexOver(pages, (index) => {
      expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS + 1);
      // 26 pages cite it and it cites one — every source has something to give,
      // and the block is still empty. (mimir's `flows/how-we-build.mdx`, cut as
      // a candidate at 27 backlinks, yielded 36 rows when OPEN.)
      expect(computeRelated(index, "plans/hub.md")).toEqual([]);
    });
  });

  test("a hub ONE backlink under the threshold still gets its block", async () => {
    const pages: Array<[string, string]> = [
      ["plans/hub.md", page("Hub", ["status_date: 2026-09-20"], "Everything, incl. [[a]].")],
      ["plans/a.md", page("A", ["status_date: 2026-09-10"], "Nothing.")],
    ];
    for (let i = 1; i <= RELATED_HUB_BACKLINKS; i++) {
      pages.push([`fill/f${i}.md`, page(`Fill ${i}`, [], "Points at [[hub]].")]);
    }
    await indexOver(pages, (index) => {
      expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS);
      expect(computeRelated(index, "plans/hub.md").map((r) => r.relPath)).toContain("plans/a.md");
    });
  });
});

describe("computeRelated — bookkeeping is by STEM, whatever the extension", () => {
  test("an `.html` catalog is cut as a candidate AND as the open page", async () => {
    await indexOver(
      [
        [
          "plans/a.md",
          page("A", ["status_date: 2026-09-20"], "See [catalog](./index.html) and [[b]]."),
        ],
        ["plans/index.html", html("Catalog")],
        ["plans/b.md", page("B", ["status_date: 2026-09-10"], "Nothing.")],
      ],
      (index) => {
        // The link really resolved to the `.html` page — `wikiPageStem` strips
        // only `.md`/`.mdx`, so its stem read `index.html` and the rail called it
        // Bookkeeping while this rule called it ordinary related work.
        expect(index.outgoing.get("plans/a.md")).toContain("plans/index.html");
        expect(computeRelated(index, "plans/a.md").map((r) => r.relPath)).toEqual(["plans/b.md"]);
        expect(computeRelated(index, "plans/index.html")).toEqual([]);
      },
    );
  });
});

describe("computeRelated — the open page's own attachments", () => {
  test("an attachment CHILD of the open page is not a related row", async () => {
    await indexOver(
      [
        [
          "plans/p.md",
          page(
            "P",
            ["status_date: 2026-09-20"],
            "See [proto](./p-prototype.html) and [loose](./loose.html).",
          ),
        ],
        ["plans/p-prototype.html", html("P prototype")],
        ["plans/loose.html", html("Loose explainer")],
      ],
      (index) => {
        // The prototype really IS this page's child (pairing rule 2), which is
        // why a related row for it duplicates the rail's own attachment chip…
        expect(index.resolveRelPath("plans/p-prototype.html")!.parent).toBe("plans/p.md");
        // …while the loose explainer is nobody's child and stays an ordinary row,
        // so the exclusion is the PARENT link and not "`.html` pages are out".
        expect(index.resolveRelPath("plans/loose.html")!.parent).toBeUndefined();
        expect(computeRelated(index, "plans/p.md").map((r) => r.relPath)).toEqual([
          "plans/loose.html",
        ]);
      },
    );
  });

  test("a child of ANOTHER page is still related work", async () => {
    await indexOver(
      [
        [
          "plans/open.md",
          page("Open", ["status_date: 2026-09-20"], "Reads [proto](../blogs/q-prototype.html)."),
        ],
        ["blogs/q.md", page("Q", ["status_date: 2026-09-12"], "Its own plan.")],
        ["blogs/q-prototype.html", html("Q prototype")],
      ],
      (index) => {
        expect(index.resolveRelPath("blogs/q-prototype.html")!.parent).toBe("blogs/q.md");
        expect(computeRelated(index, "plans/open.md").map((r) => r.relPath)).toEqual([
          "blogs/q-prototype.html",
        ]);
      },
    );
  });
});

describe("computeRelated — the shares reason", () => {
  /** One pair sharing THREE refs, spelled in the OPPOSITE order on the
   *  candidate, so the reason's order is the open page's and not the match's. */
  const THREE_SHARED: Array<[string, string]> = [
    [
      "plans/open.md",
      page(
        "Open",
        ["status_date: 2026-09-20"],
        "Names muninn#901, then muninn#902, then muninn#903.",
      ),
    ],
    [
      "plans/cand.md",
      page(
        "Cand",
        ["status_date: 2026-09-10"],
        "Names muninn#903, then muninn#902, then muninn#901.",
      ),
    ],
  ];

  test("the refs it names are the first two in the OPEN page's order", async () => {
    await indexOver(THREE_SHARED, (index) => {
      // The candidate really declares them the other way round.
      expect(index.resolveRelPath("plans/cand.md")!.prRefs).toEqual([
        "RuneLind/muninn#903",
        "RuneLind/muninn#902",
        "RuneLind/muninn#901",
      ]);
      expect(whyByPath(index, "plans/open.md")["plans/cand.md"]).toBe(
        "shares RuneLind/muninn#901, RuneLind/muninn#902",
      );
    });
  });

  test("a pair sharing three refs names TWO of them", async () => {
    await indexOver(THREE_SHARED, (index) => {
      const why = whyByPath(index, "plans/open.md")["plans/cand.md"]!;
      expect(why.slice("shares ".length).split(", ")).toHaveLength(2);
      expect(why).not.toContain("muninn#903");
    });
  });

  test("refs match without case, and the OPEN page's spelling is what prints", async () => {
    await indexOver(
      [
        [
          "plans/open.md",
          page("Open", ["status_date: 2026-09-20"], "Names RuneLind/muninn#901, RuneLind/muninn#902."),
        ],
        [
          "plans/cand.md",
          page("Cand", ["status_date: 2026-09-10"], "Names runelind/MUNINN#901, runelind/muninn#902."),
        ],
      ],
      (index) => {
        // The candidate's own refs really are spelled differently — without this
        // the pairing and the printed spelling are the same string by accident.
        expect(index.resolveRelPath("plans/cand.md")!.prRefs).toEqual([
          "runelind/MUNINN#901",
          "runelind/muninn#902",
        ]);
        expect(whyByPath(index, "plans/open.md")["plans/cand.md"]).toBe(
          "shares RuneLind/muninn#901, RuneLind/muninn#902",
        );
      },
    );
  });
});

describe("computeRelated — the self guard", () => {
  /**
   * ⚠️ Driven against a SYNTHETIC index, the one test in this file that is —
   * and the reason is measured: `buildWikiIndex` drops a self-edge at both
   * extraction sites (`store.ts`, `targetKey !== key` and `rel !== key`), so a
   * page linking to itself by `[[wikilink]]` OR by relative path comes back with
   * no self entry in `outgoing`/`backlinks` at all. The guard is therefore
   * unreachable through a real wiki, and a fixture that links to itself proves
   * nothing: it passes with the guard deleted.
   */
  test("a candidate equal to the open page is dropped", () => {
    const meta = (relPath: string): WikiPageMeta =>
      ({ relPath, name: relPath, title: relPath, type: "plan", tags: [] }) as unknown as WikiPageMeta;
    const self = meta("plans/self.md");
    const other = meta("plans/other.md");
    const index = {
      pages: [self, other],
      resolveRelPath: (rp: string) =>
        rp === "plans/self.md" ? self : rp === "plans/other.md" ? other : undefined,
      backlinks: new Map([["plans/self.md", ["plans/self.md", "plans/other.md"]]]),
      outgoing: new Map([["plans/self.md", ["plans/self.md"]]]),
    } as unknown as WikiIndex;

    expect(computeRelated(index, "plans/self.md").map((r) => r.relPath)).toEqual([
      "plans/other.md",
    ]);
  });
});

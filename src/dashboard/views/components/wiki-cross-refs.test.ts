import { test, expect, describe } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import type { WikiPageMeta } from "../../../wiki/store.ts";
import type { XrefAnswer, XrefTarget } from "../../../wiki/core/cross-ref.ts";
import { navTargetFrom } from "../../../wiki/core/wiki-nav.ts";
import { linkRefs } from "./wiki-ref-links.ts";
import { fetchAndResolveXrefs, resolveXrefRuns, wrapXrefRuns, xrefPeekLines, type XrefCandidate } from "./wiki-cross-refs.ts";

/** The browser half (the click through page navigation, the scroll and the
 *  hover card) is driven in e2e/wiki-cross-refs.spec.ts. Assertions compare
 *  strings and counts, never a happy-dom node: a failing match on a node makes
 *  bun print the whole window and the run stalls. */

const A: WikiPageMeta = { name: "A", relPath: "plans/a.md", title: "Page A" } as WikiPageMeta;
const resolve = (t: string) => (t === "A" || t === "plans/a" ? A : undefined);

/** Page B's article in a happy-dom Window of its own, with that window's
 *  globals lent for `fn`. */
function withB<T>(md: string, fn: (article: Element) => T, mutate?: (article: Element) => void): { out: T; article: Element } {
  const win = new Window();
  const article = win.document.createElement("div");
  article.className = "wiki-article";
  article.innerHTML = renderWikiHtml(md, resolve, { readerShapes: true, views: true });
  win.document.body.appendChild(article);
  mutate?.(article as unknown as Element);
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, NodeFilter: g.NodeFilter };
  g.document = win.document;
  g.NodeFilter = win.NodeFilter;
  try {
    return { out: fn(article as unknown as Element), article: article as unknown as Element };
  } finally {
    g.document = saved.document;
    g.NodeFilter = saved.NodeFilter;
  }
}

const target = (anchor: string, over: Partial<XrefTarget> = {}): XrefTarget => ({ kind: "decision", anchor, text: "x", ...over });
const answerOf = (refs: Record<string, XrefTarget>): Map<string, XrefAnswer> => new Map([["plans/a.md", { title: "Page A", refs }]]);
const ids = (cands: XrefCandidate[]) => cands.map((c) => c.ids.join(","));

/** B's own DecisionLog defines O1 and D7. */
const B_LOG = ["", "<DecisionLog>", "", "- **O1** — B's own question.", "- **D7** — B's own decision.", "", "</DecisionLog>", ""].join("\n");

describe("wrapXrefRuns — the candidates", () => {
  test("one id, a run of mixed prefixes, any wiki without idLabels", () => {
    const { out } = withB("Se O1 i [[A]] og D1, O1 og Q-3 på [[A]].\n" + B_LOG, (a) => wrapXrefRuns(a));
    expect(ids(out)).toEqual(["O1", "D1,O1,Q-3"]);
    expect(out.every((c) => c.relPath === "plans/a.md")).toBe(true);
  });

  test("no candidate, no wrapper: a word, plain text after the connector, a tracker key", () => {
    for (const md of ["omtalt i [[A]]", "Q-1 i prod, se [[A]]", "MELOSYS-8308 på [[A]]"]) {
      const { out, article } = withB(md, (a) => wrapXrefRuns(a, ["MELOSYS"]));
      expect(ids(out), md).toEqual([]);
      expect(article.querySelectorAll(".wiki-xref-run").length, md).toBe(0);
    }
  });

  test("an id inside a wrapper (`**D1** i [[A]]`) is read out of it", () => {
    const { out, article } = withB("Se **D1** i [[A]].", (a) => wrapXrefRuns(a));
    expect(ids(out)).toEqual(["D1"]);
    expect(article.querySelector(".wiki-xref-run > strong")?.textContent).toBe("D1");
  });

  test("a `.fact-chip` between the run and the wikilink is read across", () => {
    const chip = (a: Element) => {
      const link = a.querySelector("a.wiki-link")!;
      const span = link.ownerDocument.createElement("span");
      span.className = "fact-chip";
      span.textContent = "merget · i prod";
      link.before(span);
    };
    const { out } = withB("Se D1 i [[A]].", (a) => wrapXrefRuns(a), chip);
    expect(ids(out)).toEqual(["D1"]);
  });
});

describe("the two steps around linkRefs", () => {
  const md = "Ref O1 i [[A]] and D1, O1 i [[A]]; X9 i [[A]] and D7 i [[A]]. Bare O1 and D7 here.\n" + B_LOG;

  test("linkRefs never links a run's id to B's own item; the bare id still does", () => {
    const { out, article } = withB(md, (a) => {
      wrapXrefRuns(a);
      linkRefs(a);
      return Array.from(a.querySelectorAll("a.wiki-ref")).map((x) => x.textContent);
    });
    // Only the two bare ids link in-page.
    expect(out).toEqual(["O1", "D7"]);
    expect(article.querySelectorAll(".wiki-xref-run a.wiki-ref").length).toBe(0);
  });

  test("the answer links what A defines, to A's anchor; the rest goes back to plain text", () => {
    const { out, article } = withB(md, (a) => {
      const cands = wrapXrefRuns(a);
      linkRefs(a);
      // A defines O1 (closed by D2) and D7; it does not define D1 or X9.
      const n = resolveXrefRuns(cands, answerOf({ O1: target("o1", { state: "decided", decision: "D2" }), D7: target("d7-2") }));
      return n;
    });
    expect(out).toBe(3);
    expect(article.querySelectorAll(".wiki-xref-run").length).toBe(0);
    const links = Array.from(article.querySelectorAll("a.wiki-xref")).map((x) => `${x.textContent}→${x.getAttribute("data-relpath")}#${x.getAttribute("data-anchor")}`);
    expect(links).toEqual(["O1→plans/a.md#o1", "O1→plans/a.md#o1", "D7→plans/a.md#d7-2"]);
    expect(article.querySelector("a.wiki-xref")!.getAttribute("href")).toBe("/wiki?relPath=plans%2Fa.md#o1");
    // D1 and X9 are plain text: no link of either kind.
    for (const a of Array.from(article.querySelectorAll("a"))) expect(["D1", "X9"]).not.toContain(a.textContent);
    expect(article.textContent).toContain("D1, O1 i A");
  });

  test("an id A does not define stays plain even where B defines it", () => {
    const { article } = withB("See D7 i [[A]].\n" + B_LOG, (a) => {
      const cands = wrapXrefRuns(a);
      linkRefs(a);
      resolveXrefRuns(cands, answerOf({}));
    });
    const prose = Array.from(article.querySelectorAll("a")).filter((a) => a.textContent === "D7" && !a.closest(".decision-log"));
    expect(prose.map((a) => a.outerHTML)).toEqual([]);
  });

  test("a failed call leaves every id plain", () => {
    const { article } = withB("See O1 i [[A]].\n" + B_LOG, (a) => {
      const cands = wrapXrefRuns(a);
      linkRefs(a);
      resolveXrefRuns(cands, new Map([["plans/a.md", null]]));
    });
    expect(article.querySelectorAll(".wiki-xref-run, a.wiki-xref").length).toBe(0);
  });

  test("a link inside the wrapper keeps the strong: `**D1** i [[A]]`", () => {
    const { article } = withB("Se **D1** i [[A]].", (a) => {
      const cands = wrapXrefRuns(a);
      resolveXrefRuns(cands, answerOf({ D1: target("d1") }));
    });
    expect(article.querySelector("strong > a.wiki-xref")?.textContent).toBe("D1");
  });

  test("the link is a page navigation with the anchor (`navTargetFrom`)", () => {
    const { article } = withB("Se D1 i [[A]].", (a) => {
      resolveXrefRuns(wrapXrefRuns(a), answerOf({ D1: target("d1-2") }));
    });
    const a = article.querySelector("a.wiki-xref")!;
    expect(a.classList.contains("wiki-ref")).toBe(false);
    expect(navTargetFrom(a)).toEqual({ kind: "relPath", relPath: "plans/a.md", anchor: "d1-2" });
  });
});

describe("a run never links inside a link or code (fix round 1 g5)", () => {
  test("a wrapper holding a link ends the run: no anchor inside the link", () => {
    const { out, article } = withB("**[D9](https://x.y/D9) og D9** i [[A]].", (a) => {
      const cands = wrapXrefRuns(a);
      resolveXrefRuns(cands, answerOf({ D9: target("d9") }));
      return cands;
    });
    expect(ids(out)).toEqual([]);
    expect(article.querySelectorAll("a a").length).toBe(0);
    expect(article.querySelectorAll("a.wiki-xref").length).toBe(0);
  });

  test("a wrapper holding code ends the run: nothing links inside the code", () => {
    const { out, article } = withB("**`D9`** i [[A]].", (a) => {
      const cands = wrapXrefRuns(a);
      resolveXrefRuns(cands, answerOf({ D9: target("d9") }));
      return cands;
    });
    expect(ids(out)).toEqual([]);
    expect(article.querySelectorAll("code a").length).toBe(0);
  });

  test("text under code or a hidden .gl-tip inside a run gets no link; the run's own id does", () => {
    const { article } = withB("Se **D9** i [[A]].", (a) => {
      const cands = wrapXrefRuns(a);
      // Planted after the wrap: what the walker meets inside the wrapper.
      const strong = a.querySelector(".wiki-xref-run > strong")!;
      const doc = strong.ownerDocument;
      const tip = doc.createElement("span");
      tip.className = "gl-tip";
      tip.textContent = "D9";
      const code = doc.createElement("code");
      code.textContent = "D9";
      strong.append(tip, code);
      resolveXrefRuns(cands, answerOf({ D9: target("d9") }));
    });
    expect(article.querySelectorAll("a.wiki-xref").length).toBe(1);
    expect(article.querySelectorAll(".gl-tip a, code a").length).toBe(0);
  });
});

describe("a run before a missing page (`wiki-link-missing`)", () => {
  test("stays plain where B defines the id: no in-page link, no call, no wrapper left", async () => {
    const calls: string[] = [];
    const fetchRef = async (relPath: string, ids: string[]) => {
      calls.push(`${relPath}:${ids.join(",")}`);
      return null;
    };
    let pending: Promise<number> = Promise.resolve(0);
    const { article } = withB("Se D7 i [[Nope]].\n" + B_LOG, (a) => {
      const cands = wrapXrefRuns(a);
      linkRefs(a);
      pending = fetchAndResolveXrefs(cands, fetchRef);
    });
    expect(await pending).toBe(0);
    expect(calls).toEqual([]);
    const prose = Array.from(article.querySelectorAll("a.wiki-ref")).filter((x) => !x.closest(".decision-log"));
    expect(prose.map((x) => x.outerHTML)).toEqual([]);
    expect(article.querySelectorAll(".wiki-xref-run").length).toBe(0);
    expect(article.textContent).toContain("Se D7 i Nope");
  });
});

describe("fetchAndResolveXrefs", () => {
  test("one call per linked page with every id its runs name; none without a candidate", async () => {
    const calls: string[] = [];
    const fetchRef = async (relPath: string, ids: string[]) => {
      calls.push(`${relPath}:${ids.join(",")}`);
      return null;
    };
    const win = new Window();
    const article = win.document.createElement("div");
    article.innerHTML = renderWikiHtml("O1 i [[A]], D1 og O1 på [[A]]. omtalt i [[A]].", resolve, {});
    win.document.body.appendChild(article);
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, NodeFilter: g.NodeFilter, matchMedia: g.matchMedia, window: g.window };
    g.document = win.document;
    g.NodeFilter = win.NodeFilter;
    g.window = win;
    try {
      await fetchAndResolveXrefs(wrapXrefRuns(article as unknown as Element), fetchRef);
      expect(calls).toEqual(["plans/a.md:O1,D1"]);
      calls.length = 0;
      const none = win.document.createElement("div");
      none.innerHTML = renderWikiHtml("omtalt i [[A]].", resolve, {});
      await fetchAndResolveXrefs(wrapXrefRuns(none as unknown as Element), fetchRef);
      expect(calls).toEqual([]);
    } finally {
      g.document = saved.document;
      g.NodeFilter = saved.NodeFilter;
      g.window = saved.window;
    }
  });
});

describe("the hover card's lines", () => {
  test("a closed question shows Closed → its decision; a query its answer", () => {
    expect(xrefPeekLines(target("o1", { text: "Ship?", state: "decided", decision: "D2", date: "2026-10-01" }), "en")).toEqual([
      { cls: "xref-text", text: "Ship?" },
      { cls: "xref-meta", text: "Closed → D2 · 2026-10-01" },
    ]);
    expect(xrefPeekLines(target("o1", { state: "open" }), "no").at(-1)).toEqual({ cls: "xref-meta", text: "Åpen" });
    expect(xrefPeekLines({ kind: "query", anchor: "q-3", text: "How many?", answer: "Twelve." }, "en")).toEqual([
      { cls: "xref-text", text: "How many?" },
      { cls: "xref-answer", text: "Twelve." },
    ]);
  });
});

import { test, expect, describe } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import type { WikiPageMeta } from "../../../wiki/store.ts";
import type { XrefAnswer, XrefTarget } from "../../../wiki/core/cross-ref.ts";
import { navTargetFrom } from "../../../wiki/core/wiki-nav.ts";
import { linkRefs } from "./wiki-ref-links.ts";
import { fetchAndResolveXrefs, resolveXrefRuns, wrapXrefRuns, xrefPeekLines, type XrefCandidate } from "./wiki-cross-refs.ts";
import { scanXrefPage } from "../../../wiki/lint-cross-ref.ts";

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

  test("a run inside `<kbd>` links nothing", () => {
    const { out, article } = withB(
      "D9 i [[A]].",
      (a) => {
        const cands = wrapXrefRuns(a);
        resolveXrefRuns(cands, answerOf({ D9: target("d9") }));
        return cands;
      },
      (a) => {
        const p = a.querySelector("a.wiki-link")!.parentElement!;
        const kbd = p.ownerDocument.createElement("kbd");
        kbd.append(...Array.from(p.childNodes));
        p.append(kbd);
      },
    );
    // The run is found (kbd is inline and no skip), so the link test is what stops it.
    expect(ids(out)).toEqual(["D9"]);
    expect(article.querySelectorAll("a.wiki-xref").length).toBe(0);
  });

  test("a link inside a `.fact-chip` the run reads across gets no link; the run's ids do", () => {
    const { out, article } = withB(
      "Se D8 og D9 i [[A]].",
      (a) => {
        const cands = wrapXrefRuns(a);
        resolveXrefRuns(cands, answerOf({ D8: target("d8"), D9: target("d9") }));
        return cands;
      },
      (a) => {
        const text = a.querySelector("a.wiki-link")!.parentElement!.firstChild as Text;
        const rest = text.splitText("Se D8".length);
        const doc = text.ownerDocument;
        const chip = doc.createElement("span");
        chip.className = "fact-chip";
        const link = doc.createElement("a");
        link.setAttribute("href", "#elsewhere");
        link.textContent = "D9";
        chip.append(link);
        rest.before(chip);
      },
    );
    expect(ids(out)).toEqual(["D8,D9"]);
    expect(article.querySelectorAll("a.wiki-xref").length).toBe(2);
    expect(article.querySelectorAll(".fact-chip a.wiki-xref, a a").length).toBe(0);
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

/** Lint check 29 (`src/wiki/lint-cross-ref.ts`) reads the page source and the
 *  reader the rendered page. This table runs both over one text, so a form
 *  the two read differently fails here and not as a finding on a page. */
describe("the linter's linked form is the reader's", () => {
  const readerIds = (md: string) => ids(withB(md, (a) => wrapXrefRuns(a)).out);
  const lintIds = (md: string) => scanXrefPage(md, []).mentions.map((m) => m.ids.join(","));
  /** The same text with every link written as a plain word. */
  const plain = (md: string) => md.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)/g, "siden");

  // [text, the runs the reader takes as candidates, the runs lint reports]
  const LINK_FORMS: [string, string[], string[]][] = [
    ["Q-5 på [[A]] x.", ["Q-5"], []],
    ["Q-5 på [[A|label]] x.", ["Q-5"], []],
    ["Q-5 på [[Nope]] x.", ["Q-5"], []],
    ["Q-5 på _[[A]]_ x.", ["Q-5"], []],
    ["Q-5 på *[[A]]* x.", ["Q-5"], []],
    ["Q-5 på **[[A]]** x.", ["Q-5"], []],
    ["Q-5 på ~~[[A]]~~ x.", ["Q-5"], []],
    ["Q-5 på _~~[[A]]~~_ x.", ["Q-5"], []],
    ["Q-5 på ~~**[[A]]**~~ x.", ["Q-5"], []],
    ["_Q-5 på [[A]]_ x.", ["Q-5"], []],
    ["**Q-5** på [[A]] x.", ["Q-5"], []],
    ["Q-5 **på** [[A]] x.", ["Q-5"], []],
    ["Q-5 på\n[[A]] x.", ["Q-5"], []],
    ["Q-5\npå [[A]] x.", ["Q-5"], []],
    ["Q-5 på [[A]] og D3 på [[A]] x.", ["Q-5", "D3"], []],
    ["Q-5 på «[[A]]» x.", [], ["Q-5"]],
    ["Q-5 på ([[A]]) x.", [], ["Q-5"]],
    ['Q-5 på "[[A]]" x.', [], ["Q-5"]],
    ["Q-5 på '[[A]]' x.", [], ["Q-5"]],
    ["Q-5 på __[[A]]__ x.", [], ["Q-5"]],
    ["Q-5 på ~[[A]]~ x.", [], ["Q-5"]],
    ["Q-5 på ~~~[[A]]~~~ x.", [], ["Q-5"]],
    ["Q-5 på [[]] x.", [], ["Q-5"]],
    ["Q-5 på [label](plans/a.md) x.", [], ["Q-5"]],
    ["Q-5 på <!-- c -->[[A]] x.", [], ["Q-5"]],
    ["Q-5 på `code` [[A]] x.", [], ["Q-5"]],
    // A `---` line, a component tag line and a table cell end the reader's text; lint still reads a run.
    ["D3 på\n---\n[[A]] x.", [], ["D3"]],
    ["Se D3 på\n<Callout>\n[[A]]\n</Callout>", [], ["D3"]],
    ["| a | b |\n|---|---|\n| D3 på | [[A]] x |", [], ["D3"]],
    // The connector ends its block: neither side reads a run.
    ["Q-5 på\n\n[[A]] x.", [], []],
    ["D3 på\n- [[A]] x.", [], []],
    ["D3 på\n## [[A]]", [], []],
    ["Q-5 <!-- c --> på [[A]] x.", [], []],
    ["`Q-5` på [[A]] x.", [], []],
  ];

  test("lint reports a run exactly where the reader takes no candidate", () => {
    for (const [md, reader, lint] of LINK_FORMS) {
      expect([md, readerIds(md), lintIds(md)]).toEqual([md, reader, lint]);
      // Never both: a run the reader links is no finding.
      expect([md, reader.length > 0 && lint.length > 0]).toEqual([md, false]);
    }
  });

  // [text, the run the reader takes]: lint reads the same run off the plain form.
  const RUN_FORMS: [string, string[]][] = [
    ["- D3\n- D4 på [[A]] x.", ["D4"]],
    ["* D3\n* D4 på [[A]] x.", ["D4"]],
    ["1. D3\n2. D4 på [[A]] x.", ["D4"]],
    ["D3\n\nD4 på [[A]] x.", ["D4"]],
    ["## About D3\nD4 på [[A]] x.", ["D4"]],
    ["D3. D4 på [[A]] x.", ["D4"]],
    ["D3 + D4 på [[A]] x.", ["D4"]],
    ["D3,\nD4 på [[A]] x.", ["D3,D4"]],
    ["D3 og\nD4 på [[A]] x.", ["D3,D4"]],
    ["D3  \nD4 på [[A]] x.", ["D3,D4"]],
    ["D3-D5 på [[A]] x.", ["D3,D5"]],
    ["D3–D5 på [[A]] x.", ["D3,D5"]],
    ["D3, D4 og Q-16c på [[A]] x.", ["D3,D4,Q-16c"]],
    ["| a | b |\n|---|---|\n| D3 | D4 på [[A]] x |", ["D4"]],
  ];

  test("the ids of a run are the same on both sides", () => {
    for (const [md, run] of RUN_FORMS) {
      expect([md, readerIds(md), lintIds(md), lintIds(plain(md))]).toEqual([md, run, [], run]);
    }
  });

  test("where the two differ on purpose", () => {
    // `Q-R4` holds no `R4` for lint; the reader asks the linked page for it and finds none.
    expect([readerIds("Q-R4 på [[A]] x."), lintIds("Q-R4 på siden x.")]).toEqual([["R4"], []]);
    // Lint reads no id through `_` or `~~` emphasis, and no blockquote line.
    expect([readerIds("_Q-5_ på [[A]] x."), lintIds("_Q-5_ på siden x.")]).toEqual([["Q-5"], []]);
    expect([readerIds("~~Q-5~~ på [[A]] x."), lintIds("~~Q-5~~ på siden x.")]).toEqual([["Q-5"], []]);
    expect([readerIds("> D3 på [[A]] x."), lintIds("> D3 på siden x.")]).toEqual([["D3"], []]);
    // A line straight after a list item: the reader ends the item, lint reads on.
    expect([readerIds("- D3 på\n[[A]] x."), lintIds("- D3 på\n[[A]] x."), lintIds("- D3 på\nsiden x.")]).toEqual([[], [], ["D3"]]);
    expect([readerIds("- D3,\nD4 på [[A]] x."), lintIds("- D3,\nD4 på siden x.")]).toEqual([["D4"], ["D3,D4"]]);
    // A hyphen that opens a line with no space after it glues the id for lint.
    expect([readerIds("D3,\n-D4 på [[A]] x."), lintIds("D3,\n-D4 på siden x.")]).toEqual([["D4"], []]);
    // Literal text in the reader, taken as the linked form by lint.
    for (const md of ["Q-5 på ~~~~[[A]]~~~~ x.", "Q-5 på [[|]] x.", "Q-5 på _[[A]]_x."]) expect([md, readerIds(md), lintIds(md)]).toEqual([md, [], []]);
    // An emphasis mark never closed is literal text in the reader; lint takes it as opened.
    expect([readerIds("Q-5 på _[[A]] x."), lintIds("Q-5 på _[[A]] x.")]).toEqual([[], []]);
    expect([readerIds("Q-5 på *[[A]] x."), lintIds("Q-5 på *[[A]] x.")]).toEqual([[], []]);
    expect([readerIds("Q-5 på ~~[[A]] x."), lintIds("Q-5 på ~~[[A]] x.")]).toEqual([[], []]);
  });
});

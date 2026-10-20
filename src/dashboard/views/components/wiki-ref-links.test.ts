import { test, expect, describe } from "bun:test";
import { findRefs, headingSlug, isRefId, linkRefs, nounRuns, refTargets } from "./wiki-ref-links.ts";
import { foldSizeLabel, formatChars, readingMinutes } from "./wiki-lens.ts";

/** The browser half (wrapping, the peek, the jump and Back) is driven in
 *  e2e/wiki-ref-links.spec.ts. */

const keys = (text: string, ids: string[], titles: string[] = []) =>
  findRefs(text, new Set(ids), new Set(titles)).map((m) => `${m.kind}:${text.slice(m.start, m.end)}`);

describe("headingSlug", () => {
  test("matches GitHub's slugs on the links kode-wiki pages already carry", () => {
    expect(headingSlug("Runde 3 — 2026-08-18 kveld")).toBe("runde-3--2026-08-18-kveld");
    expect(headingSlug("Kontinuitetsresultat (kjørt i prod 2026-07-02)")).toBe(
      "kontinuitetsresultat-kjørt-i-prod-2026-07-02",
    );
    expect(headingSlug("Q8 — dekningssjekk (paste og annoter)")).toBe("q8--dekningssjekk-paste-og-annoter");
    expect(headingSlug("Q2-oppskrift")).toBe("q2-oppskrift");
    expect(headingSlug("Executive Summary")).toBe("executive-summary");
  });
});

describe("findRefs: ids", () => {
  const ids = ["D4", "D5", "D6", "S1", "S4", "Q-1", "Q-14", "MEL-601780"];

  test("whole ids, in order, including both ends of a range", () => {
    expect(keys("fag sa nei (D5, D6), se Q-1–Q-14 og S1–S4.", ids)).toEqual([
      "id:D5",
      "id:D6",
      "id:Q-1",
      "id:Q-14",
      "id:S1",
      "id:S4",
    ]);
  });

  test("not inside a longer token", () => {
    expect(keys("Q-10 XD4 D4x D4-saken D45 MEL-6017801", ids)).toEqual([]);
  });

  test("an id ending a sentence or followed by a slash or hyphen-space still matches", () => {
    expect(keys("S1/S4. Gjelder D4- og D5.", ids)).toEqual(["id:S1", "id:S4", "id:D4", "id:D5"]);
  });

  test("case-sensitive: d4 is not D4", () => {
    expect(keys("d4 og D4", ids)).toEqual(["id:D4"]);
  });

  test("an undefined id is plain text", () => {
    expect(keys("D1 og D2", ids)).toEqual([]);
  });

  test("a case id with a hyphen", () => {
    expect(keys("saken MEL-601780, ikke MEL-60178", ids)).toEqual(["id:MEL-601780"]);
  });
});

describe("ref ids that are not ids (arch-review 2026-10 #13)", () => {
  /** What `refTargets` links: the chip keys `isRefId` keeps. */
  const linked = (text: string, chips: string[]) => keys(text, chips.filter(isRefId));

  test("a digit-only or one-character key links nothing", () => {
    for (const k of ["A", "1", "10", "2026", "0123", "Q"]) expect(isRefId(k)).toBe(false);
    expect(linked("A decision on 07.10.2026 after 10 runs; step 1, version 1.10.", ["A", "1", "10", "2026"])).toEqual([]);
  });

  test("letter ids link, with or without a digit", () => {
    for (const k of ["D4", "S1", "Q-14", "MEL-601780", "H1", "MELOSYS-1234", "Q-A", "Q-H", "Case-A"]) {
      expect(isRefId(k)).toBe(true);
    }
    // kode-wiki plans/2026-09-22-vedtaksmetadata-rotaarsak.mdx: query ids Q-A … Q-H.
    expect(linked("Q-A–Q-H kjørt; 1981 rader (Q-A). SQL-en for Q-F–Q-H.", ["Q-A", "Q-F", "Q-H"])).toEqual([
      "id:Q-A",
      "id:Q-H",
      "id:Q-A",
      "id:Q-F",
      "id:Q-H",
    ]);
  });

  test("ranges still link both ends, and a sub-step `S1.2` links its step", () => {
    expect(linked("se Q-1–Q-14.", ["Q-1", "Q-14"])).toEqual(["id:Q-1", "id:Q-14"]);
    expect(linked("Steg S1.2 og D4.", ["S1", "D4"])).toEqual(["id:S1", "id:D4"]);
  });

  test("refTargets itself keeps only the chip keys isRefId accepts", () => {
    // A stub root, since `linked` filters with isRefId on its own: only the id
    // chips (ID_TARGETS) answer; the sections query finds nothing.
    const chip = (key: string) => ({ textContent: key, closest: () => ({ id: `case-${key}` }) });
    const root = {
      querySelectorAll: (sel: string) =>
        sel.includes(".dl-id") ? ["A", "10", "Q-A", "q-a", "D4"].map(chip) : [],
    } as unknown as Element;
    // A lowercase letter counts as a letter: `q-a` is an id.
    expect([...refTargets(root).ids.keys()]).toEqual(["Q-A", "q-a", "D4"]);
  });
});

describe("findRefs: quoted titles", () => {
  const titles = ["Q2-oppskrift", "Saker", "As run — decisions"];

  test("all three quote styles, quotes included in the match", () => {
    expect(keys('oppskriften i «Q2-oppskrift», se “Saker” og "As run — decisions".', [], titles)).toEqual([
      "title:«Q2-oppskrift»",
      "title:“Saker”",
      'title:"As run — decisions"',
    ]);
  });

  test("a quote that names no section is no link, and ids inside it still are", () => {
    expect(keys("skiller «vedtak fattet i Melosys» fra «D4 og D5»", ["D4", "D5"], titles)).toEqual([
      "id:D4",
      "id:D5",
    ]);
  });

  test("a stray straight quote does not swallow the next title", () => {
    expect(keys('en 5" skjerm og "Saker"', [], titles)).toEqual(['title:"Saker"']);
  });

  test("surrounding spaces inside the quote are tolerated; case is not", () => {
    expect(keys("se « Saker » og «saker»", [], titles)).toEqual(["title:« Saker »"]);
  });

  test("ids and titles mixed, non-overlapping", () => {
    expect(keys("D4 står i «Saker», D5 også", ["D4", "D5"], titles)).toEqual([
      "id:D4",
      "title:«Saker»",
      "id:D5",
    ]);
  });
});

test("an empty index finds nothing", () => {
  expect(findRefs("D4 «Saker»", new Set(), new Set())).toEqual([]);
});

describe("id nouns in prose (D12)", () => {
  const LABELS = { S: { one: "Spørsmål", other: "spørsmål" }, D: { one: "Beslutning", other: "beslutninger" } };
  const ids = ["D1", "D7", "D11", "S1", "S2", "S6", "O3"];
  const nouns = (text: string) => {
    const ms = findRefs(text, new Set(ids), new Set());
    const runs = nounRuns(text, ms, LABELS);
    return ms.map((m, k) => `${runs.get(k) ?? "-"}:${m.key}`);
  };
  test("one id gets the singular", () => {
    expect(nouns("se D7 for svaret")).toEqual(["Beslutning:D7"]);
  });
  test("a range or a list of one prefix gets the plural once", () => {
    expect(nouns("D1–D11 står")).toEqual(["beslutninger:D1", "-:D11"]);
    expect(nouns("S1, S2 og S6 venter")).toEqual(["spørsmål:S1", "-:S2", "-:S6"]);
  });
  test("a different prefix or prose between ends the run", () => {
    expect(nouns("S1 og D7")).toEqual(["Spørsmål:S1", "Beslutning:D7"]);
    expect(nouns("D1 gjelder, men D7 ikke")).toEqual(["Beslutning:D1", "Beslutning:D7"]);
  });
  test("an id the author already named gets none; an unlabelled prefix gets none", () => {
    expect(nouns("Beslutning D7 står")).toEqual(["-:D7"]);
    expect(nouns("beslutninger D1–D11")).toEqual(["-:D1", "-:D11"]);
    expect(nouns("O3 er åpent")).toEqual(["-:O3"]);
    expect(nounRuns("D7", findRefs("D7", new Set(ids), new Set()), undefined).size).toBe(0);
  });
});

describe("fold size and reading time", () => {
  test("chars as k past a thousand; minutes at 1,200 chars a minute", () => {
    expect(formatChars(950)).toBe("950");
    expect(formatChars(51_600)).toBe("51.6k");
    expect(readingMinutes(500)).toBe("<1");
    expect(readingMinutes(5_900)).toBe("5");
    expect(foldSizeLabel(5_900, "en")).toBe("5.9k chars · 5 min");
    expect(foldSizeLabel(21_000, "no")).toBe("21,0k tegn · 18 min");
    expect(formatChars(12_345, "no")).toBe("12,3k");
  });
});

describe("fix round 1, D-4: a noun the author already wrote", () => {
  const LABELS = { D: { one: "Beslutning", other: "beslutninger" } };
  const ids = ["D1", "D3", "D7", "D11"];
  const nouns = (text: string, preceding = "") => {
    const ms = findRefs(text, new Set(ids), new Set());
    const runs = nounRuns(text, ms, LABELS, preceding);
    return ms.map((m, k) => `${runs.get(k) ?? "-"}:${m.key}`);
  };
  test("an inflected form of the noun leads the run", () => {
    expect(nouns("Se beslutningen D7")).toEqual(["-:D7"]);
    expect(nouns("beslutningene D1–D3 står")).toEqual(["-:D1", "-:D3"]);
  });
  test("the noun at the end of the text before this node leads the run", () => {
    expect(nouns(" D7 står", "Se **Beslutning")).toEqual(["-:D7"]);
    expect(nouns(" D7 står", "Se noe annet")).toEqual(["Beslutning:D7"]);
  });
  test("a word that only ends with the noun does not lead", () => {
    expect(nouns("Forbeslutning D7")).toEqual(["Beslutning:D7"]);
  });
  test("«til» and «to» join a range", () => {
    expect(nouns("D1 til D11")).toEqual(["beslutninger:D1", "-:D11"]);
    expect(nouns("D1 to D11")).toEqual(["beslutninger:D1", "-:D11"]);
  });
});

describe("fix round 2: punctuation and block breaks before an id", () => {
  const LABELS = { D: { one: "Beslutning", other: "beslutninger" } };
  const ids = ["D1", "D3", "D7"];
  const nouns = (text: string, preceding = "") => {
    const ms = findRefs(text, new Set(ids), new Set());
    const runs = nounRuns(text, ms, LABELS, preceding);
    return ms.map((m, k) => `${runs.get(k) ?? "-"}:${m.key}`);
  };
  test("an opening bracket or a colon after the noun still leads the run", () => {
    expect(nouns("Beslutning (D7) står")).toEqual(["-:D7"]);
    expect(nouns("se beslutning: D7")).toEqual(["-:D7"]);
    expect(nouns("beslutningene [D1–D3]")).toEqual(["-:D1", "-:D3"]);
  });
  test("a closing bracket or a full stop after the noun does not", () => {
    expect(nouns("(se beslutning) D7")).toEqual(["Beslutning:D7"]);
    expect(nouns("Ny beslutning. D7 står")).toEqual(["Beslutning:D7"]);
  });
  test("a blank line ends the read-back: the previous paragraph's last word does not lead", () => {
    expect(nouns("\n\nD7 holder.", "Noe om beslutning")).toEqual(["Beslutning:D7"]);
    expect(nouns("Noe om beslutning\n\nD7 holder.")).toEqual(["Beslutning:D7"]);
    // One line break is a wrapped line of the same paragraph.
    expect(nouns("Noe om beslutning\nD7 holder.")).toEqual(["-:D7"]);
  });
});

/** Just enough DOM for `linkRefs`: class, tag and `[id]` selectors, one walker. */
class FakeNode {
  parentElement: FakeEl | null = null;
  replacedBy: unknown = null;
  constructor(public nodeValue: string | null = null) {}
  replaceWith(frag: unknown) {
    this.replacedBy = frag;
  }
}
class FakeEl extends FakeNode {
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  constructor(
    public tagName: string,
    public classes: string[] = [],
    public id = "",
  ) {
    super();
  }
  get textContent() {
    return this.children.map((c) => (c instanceof FakeEl ? c.textContent : c.nodeValue)).join("");
  }
  set textContent(text: string) {
    this.children = [];
    this.add(new FakeNode(text));
  }
  add<T extends FakeNode>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((part) => {
      const p = part.trim();
      if (p === "[id]") return !!this.id;
      if (p.startsWith(".")) return this.classes.includes(p.slice(1));
      return p === this.tagName;
    });
  }
  closest(sel: string): FakeEl | null {
    for (let e: FakeEl | null = this; e; e = e.parentElement) if (e.matches(sel)) return e;
    return null;
  }
  contains(n: FakeNode): boolean {
    for (let e: FakeNode | null = n; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  texts(): FakeNode[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? c.texts() : [c]));
  }
}

describe("linkRefs: hidden text gets no link", () => {
  test("an id inside the lanes' hidden label stays text; the same id in prose links", () => {
    const root = new FakeEl("div", ["wiki-article"]);
    const item = root.add(new FakeEl("div", ["dl-item"], "dl-d4"));
    item.add(new FakeEl("span", ["dl-id"])).add(new FakeNode("D4"));
    const prose = root.add(new FakeEl("p")).add(new FakeNode("Hold rule D4 applies."));
    const lanes = root.add(new FakeEl("section", ["dc-view", "tl-lanes"]));
    const hidden = lanes.add(new FakeEl("span", ["vh"])).add(new FakeNode("2026-09-01: D4"));
    (root as unknown as { querySelectorAll: (s: string) => FakeEl[] }).querySelectorAll = (s) =>
      s.startsWith(".dl-item") ? [item.children[0] as FakeEl] : [];
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, NodeFilter: g.NodeFilter };
    g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
    g.document = {
      getElementById: () => null,
      createDocumentFragment: () => ({ parts: [] as unknown[], append(...xs: unknown[]) { this.parts.push(...xs); } }),
      createElement: (tag: string) => new FakeEl(tag),
      createTreeWalker: (r: FakeEl, _what: number, filter: { acceptNode: (n: FakeNode) => number }) => {
        const nodes = r.texts().filter((n) => filter.acceptNode(n) === 1);
        let i = 0;
        return { nextNode: () => nodes[i++] ?? null };
      },
    };
    try {
      expect(linkRefs(root as unknown as Element)).toBe(1);
    } finally {
      g.document = saved.document;
      g.NodeFilter = saved.NodeFilter;
    }
    expect(prose.replacedBy).not.toBeNull();
    expect(hidden.replacedBy).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  LENS_KEY,
  idNoun,
  idPrefix,
  pageDefaultLens,
  parseDefaultLens,
  parseIdLabels,
  parseLens,
  parseWikiDefaultLens,
  readStoredLens,
  resolveLens,
  writeStoredLens,
} from "./reader-lens.ts";

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};

describe("lens values (D2)", () => {
  test("canonical names and the Norwegian aliases, any case; anything else is null", () => {
    expect(parseLens("overview")).toBe("overview");
    expect(parseLens(" Oversikt ")).toBe("overview");
    expect(parseLens("ALT")).toBe("all");
    expect(parseLens("all")).toBe("all");
    expect(parseLens("agent")).toBe("agent");
    expect(parseLens("summary")).toBeNull();
    expect(parseLens(undefined)).toBeNull();
    expect(parseLens(3)).toBeNull();
  });
});

describe("precedence (D2)", () => {
  const off = { agentAvailable: false };
  test("the URL wins over the stored choice and the default", () => {
    expect(resolveLens({ ...off, url: "overview", stored: "all", pageDefault: "all" })).toBe("overview");
    expect(resolveLens({ ...off, url: "oversikt", stored: "all" })).toBe("overview");
  });
  test("then the stored choice, then the page default, then All", () => {
    expect(resolveLens({ ...off, stored: "overview", pageDefault: "all" })).toBe("overview");
    expect(resolveLens({ ...off, stored: "all", pageDefault: "overview" })).toBe("all");
    expect(resolveLens({ ...off, stored: null, pageDefault: "overview" })).toBe("overview");
    expect(resolveLens({ ...off })).toBe("all");
  });
  test("an unknown URL value is skipped, not All", () => {
    expect(resolveLens({ ...off, url: "nope", stored: "overview" })).toBe("overview");
  });
  test("?lens=agent where Agent is unavailable is All, whatever is stored", () => {
    expect(resolveLens({ ...off, url: "agent", stored: "overview", pageDefault: "overview" })).toBe("all");
    expect(resolveLens({ agentAvailable: true, url: "agent", stored: "overview" })).toBe("agent");
  });
  test("a stored or default agent is never honoured", () => {
    expect(resolveLens({ agentAvailable: true, stored: "agent", pageDefault: "agent" })).toBe("all");
  });
});

describe("the stored choice (D1)", () => {
  test("Overview and All are stored; Agent is never written", () => {
    const s = memStore();
    expect(writeStoredLens(s, "overview")).toBe(true);
    expect(s.m.get(LENS_KEY)).toBe("overview");
    expect(writeStoredLens(s, "agent")).toBe(false);
    expect(s.m.get(LENS_KEY)).toBe("overview");
    expect(readStoredLens(s)).toBe("overview");
  });
  test("a storage failure reads as nothing stored and writes nothing", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredLens(throwing)).toBeNull();
    expect(writeStoredLens(throwing, "all")).toBe(false);
    expect(readStoredLens(undefined)).toBeNull();
  });
  test("a hand-written agent in storage reads as nothing stored", () => {
    const s = memStore();
    s.setItem(LENS_KEY, "agent");
    expect(readStoredLens(s)).toBeNull();
  });
});

describe("WIKI_DEFAULT_LENS (D24)", () => {
  test("wiki=lens pairs, names without case, aliases accepted", () => {
    const d = parseWikiDefaultLens("melosys-felles=overview, Mimir=alt");
    expect([...d.byWiki]).toEqual([
      ["melosys-felles", "overview"],
      ["mimir", "all"],
    ]);
    expect(d.warnings).toEqual([]);
  });
  test("a malformed entry, an unknown lens and agent are dropped by position", () => {
    const d = parseWikiDefaultLens("a=overview,broken,b=agent,c=nope,,=all");
    expect([...d.byWiki]).toEqual([["a", "overview"]]);
    expect(d.warnings).toEqual([
      "WIKI_DEFAULT_LENS entry 2 dropped: expected wiki=lens",
      "WIKI_DEFAULT_LENS entry 3 dropped: agent cannot be a default lens",
      'WIKI_DEFAULT_LENS entry 4 dropped: "nope" is not overview, all, oversikt or alt',
      "WIKI_DEFAULT_LENS entry 6 dropped: expected wiki=lens",
    ]);
  });
  test("the instance default beats the wiki file's; either alone applies", () => {
    const inst = parseWikiDefaultLens("felles=overview");
    expect(pageDefaultLens("Felles", inst, "all")).toBe("overview");
    expect(pageDefaultLens("kode", inst, "all")).toBe("all");
    expect(pageDefaultLens("kode", inst, null)).toBeNull();
    expect(pageDefaultLens(undefined, inst, "overview")).toBe("overview");
  });
});

describe("id labels (D12)", () => {
  const kode = {
    S: { one: "Spørsmål", other: "spørsmål" },
    D: { one: "Beslutning", other: "beslutninger" },
    Q: { one: "Query", other: "queries" },
  };
  test("the prefix is the letters before the digits", () => {
    expect(idPrefix("Q-14")).toBe("Q");
    expect(idPrefix("S1")).toBe("S");
    expect(idPrefix("D12")).toBe("D");
    expect(idPrefix("Case-A")).toBeNull();
    expect(idPrefix("12")).toBeNull();
  });
  test("one noun per id, the plural for a count", () => {
    expect(idNoun(kode, "Q-14")).toBe("Query");
    expect(idNoun(kode, "D7")).toBe("Beslutning");
    expect(idNoun(kode, "D7", 11)).toBe("beslutninger");
    expect(idNoun(kode, "O3")).toBeNull();
    expect(idNoun(undefined, "D7")).toBeNull();
  });
  test("the kode-wiki's labels parse; a bad entry is dropped with a reason", () => {
    expect(parseIdLabels(kode)).toEqual({ labels: kode, warnings: [] });
    const r = parseIdLabels({ D: kode.D, "Q-": kode.Q, S: { one: "Spørsmål" }, X: "x" });
    expect(r.labels).toEqual({ D: kode.D });
    expect(r.warnings).toHaveLength(3);
    expect(parseIdLabels(["D"]).labels).toEqual({});
    expect(parseIdLabels(undefined)).toEqual({ labels: {}, warnings: [] });
  });
});

describe("fix round 1", () => {
  test("D-8: a prototype key is no lens, from any source", () => {
    for (const raw of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(parseLens(raw)).toBeNull();
      expect(resolveLens({ url: raw, stored: raw, pageDefault: raw, agentAvailable: false })).toBe("all");
      expect(parseWikiDefaultLens(`w=${raw}`).byWiki.size).toBe(0);
    }
  });

  test("D-5: an in-place reload keeps the view's lens over the stored choice and the default", () => {
    expect(resolveLens({ inPlace: "all", stored: "overview", pageDefault: "overview", agentAvailable: false })).toBe("all");
    expect(resolveLens({ inPlace: "overview", stored: "all", agentAvailable: false })).toBe("overview");
    // Agent survives a reload only where the server still offers it.
    expect(resolveLens({ inPlace: "agent", stored: "overview", agentAvailable: false })).toBe("overview");
  });
});

describe("fix round 1 cleanups: one default-lens parse, the config warnings", () => {
  test("parseDefaultLens: one warning text for both sources", () => {
    expect(parseDefaultLens("Oversikt")).toEqual({ lens: "overview" });
    expect(parseDefaultLens("agent")).toEqual({ lens: null, warning: "agent cannot be a default lens" });
    expect(parseDefaultLens(" nope ")).toEqual({ lens: null, warning: '"nope" is not overview, all, oversikt or alt' });
    expect(parseWikiDefaultLens("w=nope").warnings).toEqual(['WIKI_DEFAULT_LENS entry 1 dropped: "nope" is not overview, all, oversikt or alt']);
  });
  test("a wiki named twice in WIKI_DEFAULT_LENS warns; the last entry wins", () => {
    const r = parseWikiDefaultLens("w=overview, W=all");
    expect(r.byWiki.get("w")).toBe("all");
    expect(r.warnings).toEqual(['WIKI_DEFAULT_LENS entry 2: "w" is named again — this entry wins']);
  });
  test("a lower-case idLabels key warns and stays", () => {
    const r = parseIdLabels({ d: { one: "Beslutning", other: "beslutninger" } });
    expect(r.labels.d).toEqual({ one: "Beslutning", other: "beslutninger" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('key "d" has a lower-case letter');
  });
});

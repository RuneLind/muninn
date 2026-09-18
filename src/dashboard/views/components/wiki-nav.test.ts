import { test, expect, describe } from "bun:test";
import {
  findPageByName,
  findPageByRelPath,
  isActivePage,
  navTargetFrom,
  NAV_LINK_SELECTOR,
} from "./wiki-nav.ts";

/** Minimal stand-in for the one Element method the resolver uses — the point of
 *  the extraction is that the decision needs no DOM. */
function el(attrs: Record<string, string>) {
  return { getAttribute: (n: string) => (n in attrs ? attrs[n]! : null) };
}

describe("navTargetFrom", () => {
  test("prefers data-relpath over both name attributes", () => {
    // The regression: every `MEMORY.md` row carries the same `data-page`, so a
    // name-keyed delegate opened the same page from all 30 of them.
    expect(
      navTargetFrom(
        el({ "data-page": "MEMORY", "data-relpath": "-Users-x-muninn/memory/MEMORY.md" }),
      ),
    ).toEqual({ kind: "relPath", relPath: "-Users-x-muninn/memory/MEMORY.md" });
    expect(
      navTargetFrom(el({ "data-wiki-page": "MEMORY", "data-relpath": "a/MEMORY.md" })),
    ).toEqual({ kind: "relPath", relPath: "a/MEMORY.md" });
  });

  test("falls back to the name attributes when there is no relPath", () => {
    expect(navTargetFrom(el({ "data-wiki-page": "Harness Engineering" }))).toEqual({
      kind: "name",
      name: "Harness Engineering",
    });
    expect(navTargetFrom(el({ "data-page": "Creatine" }))).toEqual({
      kind: "name",
      name: "Creatine",
    });
    // `data-wiki-page` first, matching the pre-existing delegate's order.
    expect(navTargetFrom(el({ "data-wiki-page": "A", "data-page": "B" }))).toEqual({
      kind: "name",
      name: "A",
    });
  });

  test("a blank relPath is not a target — it falls through to the name", () => {
    expect(navTargetFrom(el({ "data-relpath": "   ", "data-page": "Creatine" }))).toEqual({
      kind: "name",
      name: "Creatine",
    });
  });

  test("no usable attribute (and no element) yields null, so the click is left alone", () => {
    expect(navTargetFrom(el({ "data-page": "" }))).toBeNull();
    expect(navTargetFrom(el({ class: "wiki-list-item" }))).toBeNull();
    expect(navTargetFrom(null)).toBeNull();
  });

  test("the selector covers all three attributes", () => {
    expect(NAV_LINK_SELECTOR).toContain("[data-relpath]");
    expect(NAV_LINK_SELECTOR).toContain("[data-page]");
    expect(NAV_LINK_SELECTOR).toContain("[data-wiki-page]");
  });
});

describe("isActivePage", () => {
  const hubA = { name: "MEMORY", relPath: "-Users-x-muninn/memory/MEMORY.md" };
  const hubB = { name: "MEMORY", relPath: "-Users-x-mimir/memory/MEMORY.md" };

  test("relPath decides when both sides have one — exactly ONE row is active", () => {
    const open = { name: "MEMORY", relPath: hubA.relPath };
    expect(isActivePage(hubA, open)).toBe(true);
    // The bug: the name matches, so this row used to render active too.
    expect(isActivePage(hubB, open)).toBe(false);
  });

  test("comparison is case-insensitive and separator-normalized, like the index", () => {
    expect(isActivePage(hubA, { name: null, relPath: hubA.relPath.toUpperCase() })).toBe(true);
    expect(
      isActivePage({ name: "x", relPath: "a/b/x.md" }, { name: null, relPath: "a\\b\\x.md" }),
    ).toBe(true);
  });

  test("falls back to the name while no relPath is known (the pre-response window)", () => {
    expect(isActivePage(hubA, { name: "MEMORY", relPath: null })).toBe(true);
    expect(isActivePage({ name: "Creatine" }, { name: "Creatine", relPath: "x/y.md" })).toBe(true);
  });

  test("nothing open ⇒ nothing active", () => {
    expect(isActivePage(hubA, { name: null, relPath: null })).toBe(false);
  });
});

describe("findPageByRelPath", () => {
  const pages = [
    { name: "MEMORY", relPath: "-Users-x-muninn/memory/MEMORY.md", type: "note" },
    { name: "internals", relPath: "blogs/Muninn-Internals.html", type: "explainer" },
  ];

  test("matches case-insensitively — an Atlas key or a hand-typed URL is not byte-exact", () => {
    // The regression: `loadPageByRelPath`'s explainer branch compared raw strings,
    // so a `?relPath=` differing only in case skipped the iframe branch entirely
    // and `/api/wiki/page` painted the ESCAPED HTML source into the article pane.
    expect(findPageByRelPath(pages, "blogs/muninn-internals.html")?.type).toBe("explainer");
    expect(findPageByRelPath(pages, "BLOGS/MUNINN-INTERNALS.HTML")?.type).toBe("explainer");
  });

  test("normalizes separators on both sides", () => {
    expect(findPageByRelPath(pages, "blogs\\Muninn-Internals.html")?.name).toBe("internals");
  });

  test("an exact match still matches, and a miss is undefined", () => {
    expect(findPageByRelPath(pages, "-Users-x-muninn/memory/MEMORY.md")?.name).toBe("MEMORY");
    expect(findPageByRelPath(pages, "nope/nope.md")).toBeUndefined();
    expect(findPageByRelPath(pages, "")).toBeUndefined();
  });
});

describe("findPageByName", () => {
  // relPath-ordered, exactly as `/api/wiki/pages` sends it: the `.html` sorts
  // BEFORE its own markdown page, which is what made the first-match lookup
  // open the diagram.
  const pages = [
    { name: "y", relPath: "plans/y.html", type: "explainer", parent: "plans/y.md", pairedBy: "stem" },
    { name: "y", relPath: "plans/y.md", type: "plan" },
    { name: "solo", relPath: "plans/solo.html", type: "explainer" },
    { name: "MEMORY", relPath: "b/MEMORY.md", type: "note" },
    { name: "MEMORY", relPath: "a/MEMORY.md", type: "note" },
  ];

  test("never answers with a rule-1 attachment — the markdown page owns the name", () => {
    // `?page=<stem>` at boot and on popstate, the reader's no-relPath fallback,
    // an Ask citation and a chat wiki citation all land here, and the server's
    // own `index.resolve` answers the markdown page for every one of them.
    expect(findPageByName(pages, "y")?.relPath).toBe("plans/y.md");
  });

  test("an explainer nothing paired still resolves — it is a page of its own", () => {
    expect(findPageByName(pages, "solo")?.relPath).toBe("plans/solo.html");
  });

  test("a genuine same-stem collision answers by relPath, whatever order it arrives in", () => {
    // The server registers first-wins in relPath order, so the answer must not
    // depend on the payload's order.
    expect(findPageByName(pages, "MEMORY")?.relPath).toBe("a/MEMORY.md");
    expect(findPageByName([...pages].reverse(), "MEMORY")?.relPath).toBe("a/MEMORY.md");
  });

  test("a miss is undefined", () => {
    expect(findPageByName(pages, "nope")).toBeUndefined();
    expect(findPageByName(pages, "")).toBeUndefined();
  });
});

import { test, expect, describe } from "bun:test";
import { isActivePage, navTargetFrom, NAV_LINK_SELECTOR } from "./wiki-nav.ts";

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

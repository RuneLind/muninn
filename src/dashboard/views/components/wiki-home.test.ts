import { describe, expect, test } from "bun:test";
import {
  lastWikiRedirect,
  navWikiHref,
  parseStartTab,
  resolveStartTab,
  startTabKey,
  startUrl,
  urlNamesWiki,
} from "./wiki-home.ts";

const KNOWN = ["jarvis", "mimir", "memory"] as const;
const base = { search: "", stored: "mimir", rendered: "jarvis", known: KNOWN };

describe("lastWikiRedirect", () => {
  test("bare /wiki with a remembered, registered, different wiki redirects to it", () => {
    expect(lastWikiRedirect(base)).toBe("/wiki?wiki=mimir");
  });
  test("keeps the other params (view=) on the redirect", () => {
    expect(lastWikiRedirect({ ...base, search: "?view=atlas" })).toBe("/wiki?view=atlas&wiki=mimir");
  });
  test("a URL that names its wiki is left alone, by either name", () => {
    expect(lastWikiRedirect({ ...base, search: "?wiki=jarvis" })).toBeNull();
    expect(lastWikiRedirect({ ...base, search: "?bot=jarvis" })).toBeNull();
  });
  test("a page link into the default wiki is left alone", () => {
    expect(lastWikiRedirect({ ...base, search: "?relPath=a/b.md" })).toBeNull();
    expect(lastWikiRedirect({ ...base, search: "?page=b" })).toBeNull();
  });
  test("nothing remembered, or the rendered wiki remembered, stays put", () => {
    expect(lastWikiRedirect({ ...base, stored: null })).toBeNull();
    expect(lastWikiRedirect({ ...base, stored: "  " })).toBeNull();
    expect(lastWikiRedirect({ ...base, stored: "jarvis" })).toBeNull();
  });
  test("a remembered wiki no longer registered is ignored, not 404'd", () => {
    expect(lastWikiRedirect({ ...base, stored: "gone" })).toBeNull();
  });
  test("the WIKI_DIR override (rendered '') is never redirected away from", () => {
    expect(lastWikiRedirect({ ...base, rendered: "" })).toBeNull();
  });
  test("a stored name is encoded, never a second param", () => {
    const known = ["a&wiki=b", "jarvis"];
    expect(lastWikiRedirect({ ...base, stored: "a&wiki=b", known })).toBe("/wiki?wiki=a%26wiki%3Db");
  });
});

describe("urlNamesWiki", () => {
  test("true only for wiki= / bot=", () => {
    expect(urlNamesWiki("?wiki=mimir")).toBe(true);
    expect(urlNamesWiki("?bot=jarvis&relPath=x.md")).toBe(true);
    expect(urlNamesWiki("?relPath=x.md")).toBe(false);
    expect(urlNamesWiki("")).toBe(false);
  });
});

describe("navWikiHref", () => {
  test("remembered wiki → its URL; nothing → bare /wiki; encoded", () => {
    expect(navWikiHref("mimir")).toBe("/wiki?wiki=mimir");
    expect(navWikiHref(null)).toBe("/wiki");
    expect(navWikiHref("  ")).toBe("/wiki");
    expect(navWikiHref("a&b")).toBe("/wiki?wiki=a%26b");
  });
});

describe("start tab", () => {
  test("parseStartTab accepts the three names only", () => {
    expect(parseStartTab("hubs")).toBe("hubs");
    expect(parseStartTab("timeline")).toBe("timeline");
    expect(parseStartTab("atlas")).toBe("atlas");
    expect(parseStartTab("Atlas")).toBeNull();
    expect(parseStartTab("")).toBeNull();
    expect(parseStartTab(null)).toBeNull();
  });
  test("resolveStartTab: URL beats stored beats hubs; garbage skipped at each level", () => {
    expect(resolveStartTab("atlas", "timeline")).toBe("atlas");
    expect(resolveStartTab(null, "timeline")).toBe("timeline");
    expect(resolveStartTab("nope", "timeline")).toBe("timeline");
    expect(resolveStartTab("nope", "junk")).toBe("hubs");
    expect(resolveStartTab(null, null)).toBe("hubs");
  });
  test("startUrl: hubs is the bare form, other tabs carry view=, wiki encoded", () => {
    expect(startUrl("mimir", "hubs")).toBe("/wiki?wiki=mimir");
    expect(startUrl("mimir", "atlas")).toBe("/wiki?wiki=mimir&view=atlas");
    expect(startUrl("", "hubs")).toBe("/wiki");
    expect(startUrl("", "timeline")).toBe("/wiki?view=timeline");
    expect(startUrl("a b", "hubs")).toBe("/wiki?wiki=a+b");
  });
  test("the tab key is per wiki", () => {
    expect(startTabKey("mimir")).not.toBe(startTabKey("jarvis"));
    expect(startTabKey("")).toBe("muninn.wiki.startTab.v1:");
  });
});

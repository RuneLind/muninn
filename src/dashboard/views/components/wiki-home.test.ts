import { describe, expect, test } from "bun:test";
import {
  lastWikiRedirect,
  parseStartTab,
  rememberWikiName,
  resolveStartTab,
  sameStartUrl,
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

describe("fix round 1", () => {
  test("an EMPTY wiki= / relPath= value is not a named wiki / page (server trims)", () => {
    expect(urlNamesWiki("?wiki=")).toBe(false);
    expect(urlNamesWiki("?bot=%20")).toBe(false);
    expect(lastWikiRedirect({ ...base, search: "?relPath=" })).toBe("/wiki?relPath=&wiki=mimir");
  });
  test("only a wiki the picker offers is remembered — an unknown ?wiki=typo is not", () => {
    expect(rememberWikiName("?wiki=typo", "typo", KNOWN)).toBeNull();
    expect(rememberWikiName("?wiki=mimir", "mimir", KNOWN)).toBe("mimir");
    expect(rememberWikiName("?relPath=a.md", "jarvis", KNOWN)).toBeNull();
    expect(rememberWikiName("?wiki=", "jarvis", KNOWN)).toBeNull();
  });
});

describe("fix round 3: sameStartUrl — does the address bar already DENOTE this overview?", () => {
  test("a bare boot URL with a stored tab denotes the stored tab (the dead-push regression)", () => {
    expect(sameStartUrl("?wiki=X", "X", "timeline", "timeline")).toBe(true);
    expect(sameStartUrl("?wiki=X", "X", "hubs", null)).toBe(true);
    expect(sameStartUrl("", "X", "hubs", null)).toBe(true); // bare /wiki, X is the rendered default
    expect(sameStartUrl("?wiki=X&view=timeline", "X", "timeline", null)).toBe(true);
  });
  test("spelling never matters: encoding, bot=, case", () => {
    expect(sameStartUrl("?wiki=a+b", "a b", "hubs", null)).toBe(true);
    expect(sameStartUrl("?wiki=a%20b", "a b", "hubs", null)).toBe(true);
    expect(sameStartUrl("?bot=x", "X", "hubs", null)).toBe(true);
    expect(sameStartUrl("?wiki=X&view=hubs", "X", "hubs", "timeline")).toBe(true);
  });
  test("a different wiki, a page, or a different resolved tab is NOT the same overview", () => {
    expect(sameStartUrl("?wiki=Y", "X", "hubs", null)).toBe(false);
    expect(sameStartUrl("?wiki=X&relPath=a.md", "X", "hubs", null)).toBe(false);
    expect(sameStartUrl("?wiki=X&page=a", "X", "hubs", null)).toBe(false);
    expect(sameStartUrl("?wiki=X&view=atlas", "X", "timeline", null)).toBe(false);
    expect(sameStartUrl("?wiki=X", "X", "timeline", "hubs")).toBe(false); // bar denotes hubs
    expect(sameStartUrl("?wiki=X", "X", "timeline", null)).toBe(false);
  });
});

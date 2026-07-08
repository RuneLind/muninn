import { test, expect, describe } from "bun:test";
import { buildCollectionWikiMap, matchCitationToPage } from "./citation-links.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import type { WikiPageMeta } from "./store.ts";

/** Minimal WikiPageMeta stub — only fields the helpers read. */
function page(name: string, extra: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return {
    name,
    title: name,
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: `${name}.md`,
    ...extra,
  };
}

/** Fake index.resolve: case-insensitive lookup over name/title/aliases. */
function makeResolve(pages: WikiPageMeta[]): (t: string) => WikiPageMeta | undefined {
  return (target: string) => {
    const key = target.trim().toLowerCase();
    return pages.find(
      (p) =>
        p.name.toLowerCase() === key ||
        p.title.toLowerCase() === key ||
        p.aliases.some((a) => a.toLowerCase() === key),
    );
  };
}

describe("buildCollectionWikiMap", () => {
  const registry: WikiRegistryEntry[] = [
    { name: "jarvis", root: "/j", source: "bot", collections: ["wiki", "wiki-life"] },
    { name: "mimir", root: "/m", source: "extra", collections: ["mimir"] },
    { name: "nocoll", root: "/n", source: "bot" },
  ];

  test("maps each collection to its owning wiki name", () => {
    const map = buildCollectionWikiMap(registry);
    expect(map.get("wiki")).toBe("jarvis");
    expect(map.get("wiki-life")).toBe("jarvis");
    expect(map.get("mimir")).toBe("mimir");
    expect(map.size).toBe(3);
  });

  test("wikis without collections contribute nothing", () => {
    const map = buildCollectionWikiMap(registry);
    expect([...map.values()]).not.toContain("nocoll");
  });

  test("first registry entry that lists a collection wins", () => {
    const map = buildCollectionWikiMap([
      { name: "a", root: "/a", source: "bot", collections: ["shared"] },
      { name: "b", root: "/b", source: "extra", collections: ["shared"] },
    ]);
    expect(map.get("shared")).toBe("a");
  });
});

describe("matchCitationToPage", () => {
  const pages = [
    page("prompt-caching", { title: "Prompt Caching", aliases: ["caching"] }),
    page("agents", { title: "Building Agents" }),
  ];
  const resolve = makeResolve(pages);

  test("matches by doc id basename (strips path + .md)", () => {
    expect(matchCitationToPage({ docId: "concepts/prompt-caching.md" }, resolve)).toBe("prompt-caching");
  });

  test("matches by title when the doc id doesn't resolve", () => {
    expect(matchCitationToPage({ docId: "unknown/x.md", title: "Building Agents" }, resolve)).toBe("agents");
  });

  test("matches by alias", () => {
    expect(matchCitationToPage({ docId: "caching.md" }, resolve)).toBe("prompt-caching");
  });

  test("case-insensitive", () => {
    expect(matchCitationToPage({ title: "PROMPT CACHING" }, resolve)).toBe("prompt-caching");
  });

  test("returns null when nothing resolves", () => {
    expect(matchCitationToPage({ docId: "nope.md", title: "Also Nope" }, resolve)).toBeNull();
  });

  test("returns null for an empty citation", () => {
    expect(matchCitationToPage({}, resolve)).toBeNull();
  });
});

import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCollectionWikiMap,
  enrichCitationsWithPages,
  matchCitationToPage,
} from "./citation-links.ts";
import type { Citation } from "../research/answer.ts";
import { __resetWikiCacheForTest } from "./store.ts";
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
    expect(matchCitationToPage({ docId: "concepts/prompt-caching.md" }, resolve)?.name).toBe("prompt-caching");
  });

  test("matches by title when the doc id doesn't resolve", () => {
    expect(matchCitationToPage({ docId: "unknown/x.md", title: "Building Agents" }, resolve)?.name).toBe("agents");
  });

  test("matches by alias", () => {
    expect(matchCitationToPage({ docId: "caching.md" }, resolve)?.name).toBe("prompt-caching");
  });

  test("case-insensitive", () => {
    expect(matchCitationToPage({ title: "PROMPT CACHING" }, resolve)?.name).toBe("prompt-caching");
  });

  test("returns null when nothing resolves", () => {
    expect(matchCitationToPage({ docId: "nope.md", title: "Also Nope" }, resolve)).toBeNull();
  });

  test("returns null for an empty citation", () => {
    expect(matchCitationToPage({}, resolve)).toBeNull();
  });
});

/**
 * **A citation must stamp the relPath of the page it actually MATCHED.**
 *
 * `index.resolve(stem)` is first-registration-wins, so on a wiki holding two
 * same-stem pages a cite of `projects/yggdrasil/architecture.md` matched — and,
 * before this, re-resolved its NAME back to — `projects/claude-hivemind/…`, and
 * `navTargetFrom` confidently opened the wrong page.
 */
describe("matchCitationToPage on same-stem pages", () => {
  const first = page("architecture", { relPath: "projects/claude-hivemind/architecture.md" });
  const second = page("architecture", { relPath: "projects/yggdrasil/architecture.md" });
  const pages = [first, second];
  const resolve = makeResolve(pages); // first-wins on the stem, like the real index
  const resolveRelPath = (rel: string) =>
    pages.find((p) => p.relPath.toLowerCase() === rel.trim().toLowerCase());

  test("the full doc id wins over the bare stem", () => {
    const meta = matchCitationToPage(
      { docId: "projects/yggdrasil/architecture.md" },
      resolve,
      resolveRelPath,
    );
    expect(meta?.relPath).toBe("projects/yggdrasil/architecture.md");
  });

  test("falls back to the stem when the doc id resolves to nothing", () => {
    const meta = matchCitationToPage({ docId: "elsewhere/architecture.md" }, resolve, resolveRelPath);
    expect(meta?.relPath).toBe("projects/claude-hivemind/architecture.md");
  });
});

describe("enrichCitationsWithPages stamps the matched page's own relPath", () => {
  test("a cite of the second same-stem page opens the second page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "citation-links-"));
    try {
      await mkdir(path.join(root, "projects/claude-hivemind"), { recursive: true });
      await mkdir(path.join(root, "projects/yggdrasil"), { recursive: true });
      await Bun.write(path.join(root, "projects/claude-hivemind/architecture.md"), "# A\n\nHive.\n");
      await Bun.write(path.join(root, "projects/yggdrasil/architecture.md"), "# B\n\nYgg.\n");
      __resetWikiCacheForTest();
      const registry: WikiRegistryEntry[] = [
        { name: "mimir", root, source: "extra", collections: ["mimir"] },
      ];
      const [cite] = await enrichCitationsWithPages(
        [
          {
            collection: "mimir",
            docId: "projects/yggdrasil/architecture.md",
            title: "architecture",
          } as Citation,
        ],
        registry,
      );
      expect(cite!.wikiName).toBe("mimir");
      expect(cite!.pageRelPath).toBe("projects/yggdrasil/architecture.md");
    } finally {
      __resetWikiCacheForTest();
      await rm(root, { recursive: true, force: true });
    }
  });
});

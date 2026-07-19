import { test, expect, describe } from "bun:test";
import { resolveTarget, expectedDir } from "./target-resolve.ts";
import type { Cluster } from "./types.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";

const page = (over: Partial<WikiPageMeta>): WikiPageMeta => ({
  name: "x",
  title: "X",
  type: "concept",
  domain: "ai",
  tags: [],
  aliases: [],
  relPath: "concepts/x.md",
  ...over,
});

const index = (pages: WikiPageMeta[]): WikiIndex => ({
  pages,
  outgoing: new Map(),
  backlinks: new Map(),
  resolve: () => undefined,
  resolveRelPath: () => undefined,
  scannedAt: 0,
  root: "/tmp/wiki",
});

const cluster = (over: Partial<Cluster>): Cluster => ({
  topicKey: "topic",
  kind: "concept",
  domain: "ai",
  label: "Topic",
  docIds: [],
  ...over,
});

describe("resolveTarget", () => {
  test("exact title match of same kind+domain resolves to update", () => {
    const idx = index([
      page({ title: "Agent Loops", name: "Agent Loops", relPath: "concepts/Agent Loops.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "agent loops" }), idx);
    expect(out.mode).toBe("update");
    expect(out.existingRelPath).toBe("concepts/Agent Loops.md");
  });

  test("alias match resolves to update", () => {
    const idx = index([
      page({ title: "Agent Loops", aliases: ["AI Agent Loops"], relPath: "concepts/Agent Loops.md" }),
    ]);
    expect(resolveTarget(cluster({ label: "AI Agent Loops" }), idx).mode).toBe("update");
  });

  test("title collision with a source/analysis page stays a create — never overwrite them", () => {
    const idx = index([
      page({ title: "Context Engineering", type: "source", relPath: "sources/Context Engineering.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "Context Engineering" }), idx);
    expect(out.mode).toBe("create");
    expect(out.targetPath).toBe("concepts/Context Engineering.md");
    expect(out.kind).toBeUndefined();
  });

  test("cross-KIND title match adopts the existing page's kind — entity cluster updates the concept page", () => {
    const idx = index([
      page({ title: "Model Context Protocol", type: "concept", relPath: "concepts/Model Context Protocol.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "Model Context Protocol", kind: "entity" }), idx);
    expect(out.mode).toBe("update");
    expect(out.existingRelPath).toBe("concepts/Model Context Protocol.md");
    expect(out.kind).toBe("concept");
  });

  test("same-kind match wins over an earlier cross-kind match", () => {
    const idx = index([
      page({ title: "Claude Code", type: "concept", relPath: "concepts/claude-code.md" }),
      page({ title: "Claude Code", type: "entity", relPath: "entities/Claude Code.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "Claude Code", kind: "entity" }), idx);
    expect(out.mode).toBe("update");
    expect(out.existingRelPath).toBe("entities/Claude Code.md");
    expect(out.kind).toBeUndefined();
  });

  test("title collision across DOMAINS stays a create — an ai cluster never updates a life/ page", () => {
    const idx = index([
      page({ title: "Meditation", domain: "life", relPath: "life/concepts/Meditation.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "Meditation", domain: "ai" }), idx);
    expect(out.mode).toBe("create");
  });

  test("no match falls through to create in the expected dir", () => {
    const out = resolveTarget(cluster({ label: "Brand New", kind: "entity", domain: "life" }), index([]));
    expect(out.mode).toBe("create");
    expect(out.targetPath).toBe("life/entities/Brand New.md");
  });

  // Fixture guard for the per-wiki type-ontology change (PR: wiki-reader-type-ontology).
  // Widening WikiPageType to `string` must NOT make a custom-typed page a match
  // target — only concept/entity pages are candidates. The gardener runs against the
  // jarvis wiki (no `.wiki-reader.json`), so its behavior is unchanged; this locks that in.
  test("a custom-typed page (e.g. mimir's 'subsystem') is never a match target — stays a create", () => {
    const idx = index([
      page({ title: "Wiki Gardener", type: "subsystem", relPath: "projects/muninn/wiki-gardener.md" }),
    ]);
    const out = resolveTarget(cluster({ label: "Wiki Gardener", kind: "concept" }), idx);
    expect(out.mode).toBe("create");
    expect(out.targetPath).toBe("concepts/Wiki Gardener.md");
    expect(out.kind).toBeUndefined();
  });
});

describe("expectedDir — folder layout per domain + kind", () => {
  test("ai domain: concept/entity/source map to their folders", () => {
    expect(expectedDir("ai", "concept")).toBe("concepts");
    expect(expectedDir("ai", "entity")).toBe("entities");
    expect(expectedDir("ai", "source")).toBe("sources");
  });

  test("life domain nests each under life/", () => {
    expect(expectedDir("life", "concept")).toBe("life/concepts");
    expect(expectedDir("life", "entity")).toBe("life/entities");
    expect(expectedDir("life", "source")).toBe("life/sources");
  });
});

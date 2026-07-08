import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyWikiProposal,
  insertLogEntry,
  reindexCollectionFor,
  type ApplyDeps,
} from "./apply.ts";
import type { WikiProposal } from "../db/wiki-proposals.ts";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const DRAFT_BODY = `---
type: concept
title: Context Compaction
aliases: [Compaction]
created: 2026-07-08
updated: 2026-07-08
tags: [agentic-coding]
sources: [https://example.com/a]
---

# Context Compaction

A technique for shrinking context.

## See also
- [[Harness Engineering]]`;

function makeProposal(overrides: Partial<WikiProposal> = {}): WikiProposal {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    botName: "jarvis",
    topicKey: "context-compaction",
    kind: "concept",
    mode: "create",
    targetPath: "concepts/Context Compaction.md",
    baseHash: null,
    draft: DRAFT_BODY,
    sourceDocs: [
      { collection: "youtube-summaries", docId: "a", title: "A", url: "https://example.com/a" },
      { collection: "x-articles", docId: "b", title: "B", url: "https://example.com/b" },
    ],
    rationale: null,
    status: "approved",
    createdAt: Date.now(),
    resolvedAt: null,
    ...overrides,
  };
}

describe("insertLogEntry", () => {
  const entry = "## [2026-07-08] create | Context Compaction\n- via wiki-gardener, 2 sources";

  test("creates a log with the header when missing", () => {
    const out = insertLogEntry(null, entry);
    expect(out).toBe(`# Activity Log\n\n${entry}\n`);
  });

  test("inserts AFTER the header and BEFORE the first ## [ entry", () => {
    const existing = `# Activity Log\n\n## [2026-07-07] ingest | old batch\n\nsome body text\n`;
    const out = insertLogEntry(existing, entry);
    const lines = out.split("\n");
    // Header first, then our new entry, then the pre-existing entry — in that order.
    expect(lines[0]).toBe("# Activity Log");
    const newIdx = lines.findIndex((l) => l === "## [2026-07-08] create | Context Compaction");
    const oldIdx = lines.findIndex((l) => l === "## [2026-07-07] ingest | old batch");
    expect(newIdx).toBeGreaterThan(0);
    expect(oldIdx).toBeGreaterThan(newIdx);
    // The header still precedes our new entry (not a literal top-of-file prepend).
    expect(newIdx).toBeGreaterThan(lines.indexOf("# Activity Log"));
  });

  test("appends after header when no ## [ entries exist yet", () => {
    const out = insertLogEntry("# Activity Log\n", entry);
    expect(out.startsWith("# Activity Log")).toBe(true);
    expect(out).toContain(entry);
  });
});

describe("reindexCollectionFor", () => {
  test("life/** → wiki-life, else wiki", () => {
    expect(reindexCollectionFor("concepts/Foo.md")).toBe("wiki");
    expect(reindexCollectionFor("entities/Bar.md")).toBe("wiki");
    expect(reindexCollectionFor("life/concepts/Baz.md")).toBe("wiki-life");
    expect(reindexCollectionFor("life/entities/Qux.md")).toBe("wiki-life");
  });
});

describe("applyWikiProposal", () => {
  let wikiDir: string;
  let reindexed: string[];
  let refreshed: number;

  function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
    return {
      wikiDir,
      now: () => Date.parse("2026-07-08T10:00:00Z"),
      readFile: async (absPath) => {
        try {
          return await readFile(absPath, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: async (absPath, content) => {
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, content);
      },
      fileExists: async (absPath) => {
        try {
          await readFile(absPath);
          return true;
        } catch {
          return false;
        }
      },
      refreshIndex: async () => {
        refreshed++;
      },
      reindex: async (collection) => {
        reindexed.push(collection);
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    wikiDir = await mkdtemp(path.join(tmpdir(), "gardener-apply-"));
    reindexed = [];
    refreshed = 0;
  });
  afterEach(async () => {
    await rm(wikiDir, { recursive: true, force: true });
  });

  test("happy-path create writes the file, log.md, refreshes, reindexes", async () => {
    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("applied");

    const written = await readFile(path.join(wikiDir, "concepts/Context Compaction.md"), "utf8");
    expect(written).toContain("# Context Compaction");
    expect(written.endsWith("\n")).toBe(true);

    const logMd = await readFile(path.join(wikiDir, "log.md"), "utf8");
    expect(logMd).toContain("# Activity Log");
    expect(logMd).toContain("## [2026-07-08] create | Context Compaction");
    expect(logMd).toContain("- via wiki-gardener, 2 sources");

    expect(refreshed).toBe(1);
    expect(reindexed).toEqual(["wiki"]);
  });

  test("create-mode existing file ⇒ stale, no write", async () => {
    const target = path.join(wikiDir, "concepts/Context Compaction.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "pre-existing content");

    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("stale");
    // Untouched.
    expect(await readFile(target, "utf8")).toBe("pre-existing content");
    expect(reindexed).toEqual([]);
  });

  test("update-mode happy path writes + logs an update entry, reindex wiki-life for life/**", async () => {
    const target = path.join(wikiDir, "life/concepts/Parenting.md");
    await mkdir(path.dirname(target), { recursive: true });
    const current = "---\ntype: concept\ntitle: Parenting\n---\n\n# Parenting\n\nold body\n";
    await writeFile(target, current);

    const draft = "---\ntype: concept\ntitle: Parenting\n---\n\n# Parenting\n\nnew merged body\n\n## See also\n- [[X]]";
    const proposal = makeProposal({
      mode: "update",
      kind: "concept",
      targetPath: "life/concepts/Parenting.md",
      baseHash: sha256(current),
      draft,
    });

    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("applied");
    expect(await readFile(target, "utf8")).toContain("new merged body");
    const logMd = await readFile(path.join(wikiDir, "log.md"), "utf8");
    expect(logMd).toContain("## [2026-07-08] update | Parenting");
    expect(reindexed).toEqual(["wiki-life"]);
  });

  test("update-mode hash mismatch ⇒ stale, no write", async () => {
    const target = path.join(wikiDir, "concepts/Drifted.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "the file changed on disk after drafting");

    const proposal = makeProposal({
      mode: "update",
      targetPath: "concepts/Drifted.md",
      baseHash: sha256("the ORIGINAL content at draft time"),
      draft: DRAFT_BODY,
    });

    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("stale");
    expect(await readFile(target, "utf8")).toBe("the file changed on disk after drafting");
    expect(reindexed).toEqual([]);
  });

  test("update-mode target vanished ⇒ stale", async () => {
    const proposal = makeProposal({
      mode: "update",
      targetPath: "concepts/Gone.md",
      baseHash: sha256("whatever"),
    });
    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("stale");
  });

  test("path-confinement rejection at apply (escaping target) ⇒ error, no write", async () => {
    const proposal = makeProposal({ targetPath: "../escape.md" });
    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("error");
    expect(reindexed).toEqual([]);
  });

  test("create in wrong dir for kind ⇒ error (confinement)", async () => {
    // concept kind must land under concepts/, not entities/
    const proposal = makeProposal({ kind: "concept", targetPath: "entities/Wrong.md" });
    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("error");
  });
});

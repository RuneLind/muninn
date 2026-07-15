import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyWikiProposal,
  insertLogEntry,
  reindexCollectionFor,
  draftTitle,
  type ApplyDeps,
} from "./apply.ts";
import { sha256 } from "./util.ts";
import { buildWikiIndex } from "../wiki/store.ts";
import type { WikiProposal } from "../db/wiki-proposals.ts";

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
    containedLinks: null,
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

describe("draftTitle", () => {
  test("uses frontmatter title, falling back to topicKey", () => {
    expect(draftTitle(makeProposal())).toBe("Context Compaction");
    expect(draftTitle(makeProposal({ draft: "no frontmatter here" }))).toBe("context-compaction");
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
      getWikiIndex: () => buildWikiIndex(wikiDir),
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

  test("apply re-strips an alias a page created AFTER drafting now owns (TOCTOU guard)", async () => {
    // A canonical page owning "Compaction" appears while the proposal awaited
    // review — the draft's persist-time strip never saw it.
    const canonical = path.join(wikiDir, "concepts/Compaction.md");
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(
      canonical,
      `---\ntype: concept\ntitle: Compaction\naliases: []\n---\n\n# Compaction\n\nCanonical.\n`,
    );

    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("applied");
    const written = await readFile(path.join(wikiDir, "concepts/Context Compaction.md"), "utf8");
    expect(written).toContain("aliases: []");
    expect(written).not.toContain("aliases: [Compaction]");
  });

  test("create-mode existing DIFFERENT file ⇒ stale, no write", async () => {
    const target = path.join(wikiDir, "concepts/Context Compaction.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "pre-existing content");

    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("stale");
    // Untouched.
    expect(await readFile(target, "utf8")).toBe("pre-existing content");
    expect(reindexed).toEqual([]);
  });

  test("re-run safety: target already equals the draft ⇒ applied without rewriting", async () => {
    // Simulates a crash between the file write and the terminal status CAS: the
    // file is on disk (write happened, incl. trailing newline) but the row is
    // still `approved`. Re-approving re-runs apply, which must report applied
    // and not duplicate the log entry.
    const d = deps();
    const first = await applyWikiProposal(makeProposal(), d);
    expect(first.outcome).toBe("applied");
    const logAfterFirst = await readFile(path.join(wikiDir, "log.md"), "utf8");

    const second = await applyWikiProposal(makeProposal(), d);
    expect(second.outcome).toBe("applied");
    const logAfterSecond = await readFile(path.join(wikiDir, "log.md"), "utf8");
    expect(logAfterSecond).toBe(logAfterFirst);
    const entries = logAfterSecond.match(/## \[2026-07-08\] create \| Context Compaction/g) ?? [];
    expect(entries.length).toBe(1);
  });

  test("crash-after-write simulation: file == draft, no log yet ⇒ applied", async () => {
    // DRAFT_BODY's See-also links [[Harness Engineering]]; make it resolvable so
    // apply-time body containment is a no-op and the on-disk pre-write bytes are
    // exactly what apply would write (an unchanged index ⇒ idempotent recovery).
    const linked = path.join(wikiDir, "concepts/Harness Engineering.md");
    await mkdir(path.dirname(linked), { recursive: true });
    await writeFile(linked, "---\ntype: concept\ntitle: Harness Engineering\naliases: []\n---\n\n# Harness Engineering\n");

    const target = path.join(wikiDir, "concepts/Context Compaction.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${DRAFT_BODY}\n`); // exactly what apply would write

    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("applied");
  });

  test("apply-time containment de-links a body link whose page was removed since drafting", async () => {
    // The draft body links [[Harness Engineering]] (resolved at draft time), but no
    // such page exists in the wiki at apply time (deleted between draft and approve).
    // Apply-time containment (fresh index) de-links it so no dangling link ships.
    const res = await applyWikiProposal(makeProposal(), deps());
    expect(res.outcome).toBe("applied");
    const written = await readFile(path.join(wikiDir, "concepts/Context Compaction.md"), "utf8");
    expect(written).not.toContain("[[Harness Engineering]]");
    expect(written).toContain("**Harness Engineering**");
  });

  test("idempotent recovery: re-approving an already-written identical page ⇒ applied, log not duplicated", async () => {
    // The index is unchanged between the two applies, so containment de-links the
    // same link both times → finalContent matches disk on the second pass → applied
    // without a rewrite or a duplicate log entry (the re-run-safe early return).
    const d = deps();
    const first = await applyWikiProposal(makeProposal(), d);
    expect(first.outcome).toBe("applied");
    const logAfterFirst = await readFile(path.join(wikiDir, "log.md"), "utf8");

    const second = await applyWikiProposal(makeProposal(), d);
    expect(second.outcome).toBe("applied");
    const logAfterSecond = await readFile(path.join(wikiDir, "log.md"), "utf8");
    expect(logAfterSecond).toBe(logAfterFirst);
    const entries = logAfterSecond.match(/## \[2026-07-08\] create \| Context Compaction/g) ?? [];
    expect(entries.length).toBe(1);
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
    await writeFile(target, "---\ntitle: Drifted\n---\n\nthe file changed on disk after drafting");

    const proposal = makeProposal({
      mode: "update",
      targetPath: "concepts/Drifted.md",
      baseHash: sha256("the ORIGINAL content at draft time"),
      draft: DRAFT_BODY,
    });

    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("stale");
    expect(await readFile(target, "utf8")).toContain("the file changed on disk");
    expect(reindexed).toEqual([]);
  });

  test("update-mode empty-but-existing page with matching baseHash applies", async () => {
    // Guards the runner-side fix: an empty current page hashes to sha256("").
    const target = path.join(wikiDir, "concepts/Empty.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "");

    const proposal = makeProposal({
      mode: "update",
      targetPath: "concepts/Empty.md",
      baseHash: sha256(""),
      draft: DRAFT_BODY,
    });
    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("applied");
  });

  test("update-mode target not an indexed page ⇒ error (vanished or bogus target)", async () => {
    const proposal = makeProposal({
      mode: "update",
      targetPath: "concepts/Gone.md",
      baseHash: sha256("whatever"),
    });
    const res = await applyWikiProposal(proposal, deps());
    expect(res.outcome).toBe("error");
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

  test("forbidden basenames (log.md / index.md / CLAUDE.md) are rejected", async () => {
    for (const targetPath of ["concepts/log.md", "concepts/index.md", "concepts/CLAUDE.md"]) {
      const res = await applyWikiProposal(makeProposal({ targetPath }), deps());
      expect(res.outcome).toBe("error");
    }
  });

  test("concurrent creates to the same new path: one applied, one stale", async () => {
    // The DB unique index is on topic_key, not target_path — two proposals with
    // different topics can race to the same create path. The per-wikiDir
    // single-flight serializes them: the winner writes, the loser sees the file
    // (different content) and goes stale.
    const p1 = makeProposal({ topicKey: "topic-a", draft: DRAFT_BODY });
    const p2 = makeProposal({
      topicKey: "topic-b",
      draft: DRAFT_BODY.replace("A technique for shrinking context.", "Entirely different body."),
    });
    const d = deps();
    const [r1, r2] = await Promise.all([applyWikiProposal(p1, d), applyWikiProposal(p2, d)]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["applied", "stale"]);
  });
});

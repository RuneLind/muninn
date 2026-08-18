import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeWikiPage, type PageWriteOptions } from "./page-write.ts";
import { appendBlockToPage } from "./append-block.ts";
import { applyEdits, type IntegrateEdit } from "./integrate-edits.ts";
import { buildFactcheckBlock } from "./factcheck-context.ts";
import { commitWikiChange, __resetForTest } from "./commit.ts";
import { __resetWikiWriteQueueForTest, wikiWriteQueueKey } from "./queue.ts";
import { applyWikiProposal } from "../gardener/apply.ts";
import { sha256 } from "../gardener/util.ts";
import type { WikiProposal } from "../db/wiki-proposals.ts";

/** In-memory filesystem whose reads/writes yield to the event loop, so an
 *  unqueued read→write pair WOULD interleave and lose a log entry. */
function makeFs(files: Record<string, string>) {
  return {
    files,
    readFile: async (p: string): Promise<string | null> => {
      await Promise.resolve();
      return p in files ? files[p]! : null;
    },
    writeFile: async (p: string, content: string): Promise<void> => {
      await Promise.resolve();
      files[p] = content;
    },
  };
}

/** The logged-mode options MINUS the commit pair, which `PageWriteCommitOptions`
 *  requires to travel together — the tests that commit build it themselves. */
type LoggedOpts = Omit<PageWriteOptions, "commit" | "commitMessage">;

function baseOpts(fs: ReturnType<typeof makeFs>, over: Partial<LoggedOpts> = {}): LoggedOpts {
  return {
    wikiDir: "/wiki",
    relPath: "analyses/page.md",
    baseHash: sha256(fs.files["/wiki/analyses/page.md"] ?? ""),
    transform: (current) => `${current}appended\n`,
    collections: ["wiki"],
    logKind: "factcheck-integrate",
    logTitle: "Page Title",
    logLine: "fact-check corrections integrated via the wiki reader",
    now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    refreshIndex: async () => {},
    reindex: async () => {},
    ...over,
  };
}

test("writeWikiPage writes, logs with the caller's kind/line, and reindexes", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  const reindexed: string[] = [];
  const res = await writeWikiPage(baseOpts(fs, { reindex: async (c) => { reindexed.push(c); } }));
  expect(res.outcome).toBe("written");
  expect(fs.files["/wiki/analyses/page.md"]).toContain("appended");
  expect(fs.files["/wiki/log.md"]).toContain("factcheck-integrate | Page Title");
  expect(fs.files["/wiki/log.md"]).toContain("fact-check corrections integrated");
  expect(reindexed).toEqual(["wiki"]);
});

test("writeWikiPage rejects a stale baseHash with no write (409-shaped)", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  const before = fs.files["/wiki/analyses/page.md"];
  const res = await writeWikiPage(baseOpts(fs, { baseHash: "deadbeef" }));
  expect(res.outcome).toBe("stale");
  expect(fs.files["/wiki/analyses/page.md"]).toBe(before);
  expect(fs.files["/wiki/log.md"]).toBeUndefined();
});

test("writeWikiPage: a null transform short-circuits — no write, log, reindex, or commit", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  const before = fs.files["/wiki/analyses/page.md"];
  const reindexed: string[] = [];
  let commits = 0;
  const res = await writeWikiPage({
    ...baseOpts(fs, {
      transform: () => null,
      reindex: async (c) => { reindexed.push(c); },
    }),
    commit: async () => { commits++; },
    commitMessage: "[fact-check] integrate: analyses/page.md",
  });
  expect(res.outcome).toBe("noop");
  expect(fs.files["/wiki/analyses/page.md"]).toBe(before);
  expect(fs.files["/wiki/log.md"]).toBeUndefined();
  expect(reindexed).toEqual([]);
  expect(commits).toBe(0);
});

test("writeWikiPage surfaces the CommitWikiResult on the outcome", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  const res = await writeWikiPage({
    ...baseOpts(fs),
    commit: async () => ({ committed: false, reason: "not-a-repo" as const }),
    commitMessage: "[fact-check] integrate: analyses/page.md",
  });
  expect(res).toMatchObject({ outcome: "written", commit: { committed: false, reason: "not-a-repo" } });
});

test("a throwing commitMessage thunk degrades to a warn — the applied write still reports written", async () => {
  // The thunk is resolved AFTER `transform` (it reports what the transform found),
  // so it can throw on real input. Resolved outside the try it propagated out of a
  // write that had already touched the page and log.md, turning a landed write into
  // a 500 — the same failure the logLine thunk is already degraded for.
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  let commits = 0;
  const res = await writeWikiPage({
    ...baseOpts(fs),
    commit: async () => { commits++; },
    commitMessage: () => {
      throw new Error("subject builder blew up");
    },
  });
  expect(res).toMatchObject({ outcome: "written", writtenPath: "analyses/page.md" });
  expect("commit" in res).toBe(false);
  expect(commits).toBe(0);
  // The page and its log entry survived the throw.
  expect(fs.files["/wiki/analyses/page.md"]).toContain("appended");
  expect(fs.files["/wiki/log.md"]).toContain("factcheck-integrate | Page Title");
});

test("writeWikiPage rejects a path-escaping relPath before any read", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n" });
  const res = await writeWikiPage(baseOpts(fs, { relPath: "../escape.md" }));
  expect(res.outcome).toBe("error");
  expect(fs.files["/wiki/log.md"]).toBeUndefined();
});

test("TOCTOU: a concurrent append + integrate-apply on one wiki serialize — no lost log entry", async () => {
  __resetWikiWriteQueueForTest();
  const initial = "# Page\n\nThe device ships 4M units.\n";
  const fs = makeFs({ "/wiki/analyses/page.md": initial });

  const edits: IntegrateEdit[] = [
    { claimIndex: 1, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units", reason: "filing" },
  ];

  // Both writers hold the SAME baseHash (both captured it from the same check).
  // Whoever runs second must see the other's write and go stale — but BOTH must
  // have serialized, so the first one's log.md entry can never be clobbered.
  const applyP = writeWikiPage(
    baseOpts(fs, {
      baseHash: sha256(initial),
      transform: (body) => {
        const r = applyEdits(body, edits);
        return r.appliedCount === 0 ? null : r.body;
      },
    }),
  );
  const appendP = appendBlockToPage({
    wikiDir: "/wiki",
    relPath: "analyses/page.md",
    block: buildFactcheckBlock("Overall: one correction.", "2026-07-29"),
    baseHash: sha256(initial),
    collections: [],
    logTitle: "Page Title",
    now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    refreshIndex: async () => {},
    reindex: async () => {},
  });

  const [apply, append] = await Promise.all([applyP, appendP]);
  const outcomes = [apply.outcome, append.outcome].sort();
  // Exactly one wins; the loser is stale (never a silent lost update).
  expect(outcomes).toEqual(["stale", "written"]);

  // The winner's write AND its log entry both survive.
  const log = fs.files["/wiki/log.md"] ?? "";
  const logEntries = (log.match(/^## \[/gm) ?? []).length;
  expect(logEntries).toBe(1);
  if (apply.outcome === "written") {
    expect(fs.files["/wiki/analyses/page.md"]).toContain("ships 2.1M units");
    expect(log).toContain("factcheck-integrate | Page Title");
  } else {
    expect(fs.files["/wiki/analyses/page.md"]).toContain("factcheck:start");
    expect(log).toContain("factcheck | Page Title");
  }
});

test("the queue is keyed per WIKI ROOT — two pages in one wiki serialize, two wikis don't", async () => {
  __resetWikiWriteQueueForTest();
  const order: string[] = [];
  const fs = makeFs({
    "/wiki/a.md": "A\n",
    "/wiki/b.md": "B\n",
    "/other/c.md": "C\n",
  });
  // A transform that yields several times, so an unserialized pair interleaves.
  const slowTransform = (tag: string) => (current: string) => {
    order.push(`${tag}:start`);
    return `${current}${tag}\n`;
  };
  const run = (wikiDir: string, relPath: string, tag: string) =>
    writeWikiPage(
      baseOpts(fs, {
        wikiDir,
        relPath,
        baseHash: sha256(fs.files[`${wikiDir}/${relPath}`] ?? ""),
        transform: slowTransform(tag),
        collections: [],
        refreshIndex: async () => { order.push(`${tag}:end`); },
      }),
    );

  const results = await Promise.all([
    run("/wiki", "a.md", "a"),
    run("/wiki", "b.md", "b"),
    run("/other", "c.md", "c"),
  ]);
  expect(results.map((r) => r.outcome)).toEqual(["written", "written", "written"]);
  // Same wiki root ⇒ a's critical section completes before b's begins.
  expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("b:start"));
  // Both log entries survived the serialization.
  expect((fs.files["/wiki/log.md"] ?? "").match(/^## \[/gm)?.length).toBe(2);
  // A different wiki root has its own chain (and its own log.md).
  expect((fs.files["/other/log.md"] ?? "").match(/^## \[/gm)?.length).toBe(1);
});

test("TOCTOU: a gardener apply + an append on one wiki serialize — both log entries survive", async () => {
  __resetWikiWriteQueueForTest();
  // The cross-FAMILY race (fixed 2026-07-30): `applyWikiProposal` used to hold a
  // private per-wikiDir chain, so a gardener/source-drafter approve and a
  // fact-check "Add to article" click could read log.md, then both write it —
  // losing one entry. Two DIFFERENT pages here, so log.md is the only contended
  // file and both writers must succeed.
  const initial = "# Page\n\nBody.\n";
  const fs = makeFs({ "/wiki/analyses/page.md": initial });

  const proposal: WikiProposal = {
    id: "22222222-2222-2222-2222-222222222222",
    botName: "jarvis",
    wikiName: null,
    topicKey: "new-concept",
    kind: "concept",
    mode: "create",
    targetPath: "concepts/New Concept.md",
    baseHash: null,
    draft: "---\ntype: concept\ntitle: New Concept\n---\n\n# New Concept\n\nBody.\n",
    sourceDocs: [],
    rationale: null,
    containedLinks: null,
    relatedPages: null,
    status: "approved",
    createdAt: Date.UTC(2026, 6, 30),
    resolvedAt: null,
  };

  const applyP = applyWikiProposal(proposal, {
    wikiDir: "/wiki",
    now: () => Date.UTC(2026, 6, 30, 12, 0, 0),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    // Null index ⇒ create mode skips the alias re-strip and body-link
    // containment; neither is what this test is about.
    getWikiIndex: async () => null,
    refreshIndex: async () => {},
    reindex: async () => {},
  });
  const appendP = appendBlockToPage({
    wikiDir: "/wiki",
    relPath: "analyses/page.md",
    block: buildFactcheckBlock("Overall: one correction.", "2026-07-30"),
    baseHash: sha256(initial),
    collections: [],
    logTitle: "Page Title",
    now: () => Date.UTC(2026, 6, 30, 12, 0, 0),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    refreshIndex: async () => {},
    reindex: async () => {},
  });

  const [apply, append] = await Promise.all([applyP, appendP]);
  expect(apply.outcome).toBe("applied");
  expect(append.outcome).toBe("written");
  expect(fs.files["/wiki/concepts/New Concept.md"]).toContain("# New Concept");
  expect(fs.files["/wiki/analyses/page.md"]).toContain("factcheck:start");

  const log = fs.files["/wiki/log.md"] ?? "";
  expect((log.match(/^## \[/gm) ?? []).length).toBe(2);
  expect(log).toContain("create | New Concept");
  expect(log).toContain("factcheck | Page Title");
});

test("the queue key is realpath-derived — a symlinked root shares ONE chain", async () => {
  __resetWikiWriteQueueForTest();
  const base = await mkdtemp(path.join(tmpdir(), "queue-key-"));
  try {
    const real = path.join(base, "wiki");
    await mkdir(real, { recursive: true });
    const link = path.join(base, "link");
    await symlink(real, link, "dir");
    // Two registry paths for ONE wiki must not get independent chains — they
    // share a single real log.md, which is the whole point of the queue.
    expect(wikiWriteQueueKey(link)).toBe(wikiWriteQueueKey(real));
    // An unresolvable path falls back to the raw string rather than throwing —
    // and that fallback is NOT cached, so a dir created later converges on its
    // realpath instead of keeping a second chain for the process's lifetime.
    const later = path.join(base, "later");
    expect(wikiWriteQueueKey(later)).toBe(later);
    await mkdir(later, { recursive: true });
    const laterLink = path.join(base, "later-link");
    await symlink(later, laterLink, "dir");
    expect(wikiWriteQueueKey(later)).toBe(wikiWriteQueueKey(laterLink));
    expect(wikiWriteQueueKey("/no/such/wiki-root")).toBe("/no/such/wiki-root");
  } finally {
    __resetWikiWriteQueueForTest();
    await rm(base, { recursive: true, force: true });
  }
});

test("no deadlock when the wiki root IS the git toplevel and the commit is awaited", async () => {
  __resetForTest();
  __resetWikiWriteQueueForTest();
  const base = await mkdtemp(path.join(tmpdir(), "integrate-apply-"));
  try {
    // Wiki root == git toplevel: the shape that self-deadlocks if the write queue
    // and the commit queue share one chain map.
    const wikiDir = await mkdtemp(path.join(base, "wiki-"));
    await mkdir(path.join(wikiDir, "analyses"), { recursive: true });
    const relPath = "analyses/page.md";
    const abs = path.join(wikiDir, relPath);
    const initial = "# Page\n\nThe device ships 4M units.\n";
    await writeFile(abs, initial);
    const git = async (args: string[]) => {
      const proc = Bun.spawn(["git", "-C", wikiDir, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return out;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "a@b.c"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "init"]);
    // Assert the shape this test exists for: the wiki root IS the git toplevel.
    expect(await git(["rev-parse", "--show-toplevel"])).toBe(await realpath(wikiDir));

    const edits: IntegrateEdit[] = [
      { claimIndex: 1, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units", reason: "filing" },
    ];
    const res = await Promise.race([
      writeWikiPage({
        wikiDir,
        relPath,
        baseHash: sha256(initial),
        transform: (body) => {
          const r = applyEdits(body, edits);
          return r.appliedCount === 0 ? null : r.body;
        },
        collections: [],
        logKind: "factcheck-integrate",
        logTitle: "Page Title",
        logLine: "fact-check corrections integrated via the wiki reader",
        commitMessage: `[fact-check] integrate: ${relPath}`,
        now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
        readFile: async (p) => {
          try {
            return await Bun.file(p).text();
          } catch {
            return null;
          }
        },
        writeFile: async (p, content) => {
          await Bun.write(p, content);
        },
        refreshIndex: async () => {},
        reindex: async () => {},
        commit: (paths, message) => commitWikiChange(wikiDir, paths, message, { push: false }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlocked")), 10_000)),
    ]);

    expect(res.outcome).toBe("written");
    expect(res.outcome === "written" && res.commit?.committed).toBe(true);
    expect(await Bun.file(abs).text()).toContain("ships 2.1M units");
    const subjects = (await git(["log", "--format=%s"])).split("\n");
    expect(subjects).toEqual([`[fact-check] integrate: ${relPath}`, "init"]);
    const names = (await git(["show", "--name-only", "--format=", "HEAD"])).split("\n").sort();
    expect(names).toEqual(["analyses/page.md", "log.md"]);
    expect(await git(["status", "--porcelain"])).toBe("");
  } finally {
    __resetForTest();
    __resetWikiWriteQueueForTest();
    await rm(base, { recursive: true, force: true });
  }
}, 20_000);

// ---- no-log mode (`logKind: null`) ----------------------------------------
//
// The `/plans` board's priority flips: a metadata write that must not put a line
// in a 4,100-line curated log or spend a reindex, 60 times in a triage sitting.

test("no-log mode writes the page but no log.md entry and no reindex", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n\nBody.\n" });
  const reindexed: string[] = [];
  let refreshed = 0;
  const { logKind: _k, logTitle: _t, logLine: _l, ...common } = baseOpts(fs);
  const res = await writeWikiPage({
    ...common,
    logKind: null,
    collections: ["wiki", "wiki-life"],
    reindex: async (c) => {
      reindexed.push(c);
    },
    refreshIndex: async () => {
      refreshed++;
    },
  });
  expect(res.outcome).toBe("written");
  expect(fs.files["/wiki/analyses/page.md"]).toContain("appended");
  expect(fs.files["/wiki/log.md"]).toBeUndefined();
  expect(reindexed).toEqual([]);
  // The read cache IS still refreshed — the board must see its own write.
  expect(refreshed).toBe(1);
});

test("no-log mode commits the page alone, never a log.md it did not write", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n" });
  const committed: string[][] = [];
  const { logKind: _k, logTitle: _t, logLine: _l, ...common } = baseOpts(fs);
  await writeWikiPage({
    ...common,
    logKind: null,
    commit: async (paths: string[]) => {
      committed.push(paths);
    },
    commitMessage: "[plans] priority: analyses/page.md",
  });
  expect(committed).toEqual([["analyses/page.md"]]);
});

test("the logged path is unchanged beside it", async () => {
  __resetWikiWriteQueueForTest();
  const fs = makeFs({ "/wiki/analyses/page.md": "# Page\n" });
  const reindexed: string[] = [];
  const res = await writeWikiPage(
    baseOpts(fs, { collections: ["wiki"], reindex: async (c) => { reindexed.push(c); } }),
  );
  expect(res.outcome).toBe("written");
  expect(fs.files["/wiki/log.md"]).toContain("factcheck-integrate | Page Title");
  expect(reindexed).toEqual(["wiki"]);
});

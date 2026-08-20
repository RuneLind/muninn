import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  __setReadonlyWikiRootsForTest,
  isReadonlyWikiRoot,
  parseReadonlyWikiRoots,
  readonlyWikiRoots,
  wikiNoEgressReason,
  wikiReadonlyRootReason,
  WIKI_READONLY_ROOTS_ENV,
} from "./readonly.ts";
import { buildWikiRegistry } from "./registry.ts";
import { writeWikiPage } from "./page-write.ts";
import { __resetWikiWriteQueueForTest } from "./queue.ts";
import { buildWikiIndex, __resetWikiCacheForTest } from "./store.ts";
import { applyWikiProposal } from "../gardener/apply.ts";
import { writePlanQueue } from "../plans/write.ts";
import { sha256 } from "../gardener/util.ts";
import type { BotConfig } from "../bots/config.ts";
import type { WikiProposal } from "../db/wiki-proposals.ts";

/**
 * `WIKI_READONLY_ROOTS` — the PER-WIKI read-only mechanism, the sibling of the
 * instance-wide `MUNINN_WIKI_READONLY` (covered in
 * `dashboard/routes/wiki-readonly.test.ts`).
 *
 * Three levels, same shape as that suite:
 *   1. the PARSE — env → resolved roots, and the predicate over them;
 *   2. the SEAMS — all three content writers refuse BEFORE reading anything;
 *   3. the REGISTRY + STORE — the presentational flag, the drift warn, and the
 *      `include` scan filter the memory root needs.
 *
 * The set is always driven through `__setReadonlyWikiRootsForTest`, never the
 * process env, so a crashing test cannot leave the suite with a guarded root.
 */

const REPO = "/repo/muninn";
const bot = (name: string, wikiDir?: string): BotConfig =>
  ({ name, dir: `/bots/${name}`, wikiDir }) as unknown as BotConfig;

afterEach(() => __setReadonlyWikiRootsForTest());

describe("WIKI_READONLY_ROOTS — parse + predicate", () => {
  test("resolves through the WIKI_EXTRA path dialect: ~, relative, absolute", () => {
    const roots = parseReadonlyWikiRoots(" ~/.claude/projects , ../mimir ,/abs/wiki ", REPO);
    expect(roots).toEqual([
      path.join(homedir(), ".claude/projects"),
      "/repo/mimir",
      "/abs/wiki",
    ]);
  });

  test("blank + duplicate entries are dropped, order preserved", () => {
    expect(parseReadonlyWikiRoots("/a,,/b, /a ,", REPO)).toEqual(["/a", "/b"]);
    expect(parseReadonlyWikiRoots(undefined, REPO)).toEqual([]);
    expect(parseReadonlyWikiRoots("   ", REPO)).toEqual([]);
  });

  test("a trailing separator is the SAME root — the two vars are hand-written", () => {
    expect(parseReadonlyWikiRoots("/a/b/", REPO)).toEqual(["/a/b"]);
    __setReadonlyWikiRootsForTest(["/a/b/"]);
    expect(isReadonlyWikiRoot("/a/b")).toBe(true);
    expect(isReadonlyWikiRoot("/a/b/")).toBe(true);
    expect(isReadonlyWikiRoot("/a/b/../b")).toBe(true);
  });

  test("an UNKNOWN root is writable — the default, so the mechanism is inert until used", () => {
    __setReadonlyWikiRootsForTest(["/ro"]);
    expect(isReadonlyWikiRoot("/ro")).toBe(true);
    expect(isReadonlyWikiRoot("/rw")).toBe(false);
    // A prefix is not a match: `/ro-other` is a different wiki.
    expect(isReadonlyWikiRoot("/ro-other")).toBe(false);
    expect(isReadonlyWikiRoot("/ro/sub")).toBe(false);
    expect(isReadonlyWikiRoot(undefined)).toBe(false);
    expect(isReadonlyWikiRoot("")).toBe(false);
  });

  test("nothing configured ⇒ every root writable", () => {
    __setReadonlyWikiRootsForTest([]);
    expect(readonlyWikiRoots()).toEqual([]);
    expect(isReadonlyWikiRoot("/anything")).toBe(false);
  });

  test("a SYMLINKED spelling of the same directory still matches", async () => {
    // The registry and this var are configured independently; one naming the
    // symlink and the other the real path must not open the guard.
    const base = await mkdtemp(path.join(tmpdir(), "ro-symlink-"));
    try {
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      await mkdir(real);
      await symlink(real, link);
      __setReadonlyWikiRootsForTest([link]);
      expect(isReadonlyWikiRoot(real)).toBe(true);
      __setReadonlyWikiRootsForTest([real]);
      expect(isReadonlyWikiRoot(link)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("the refusal copy does NOT reuse the instance sentence", () => {
    // `WIKI_READONLY_REASON` hard-codes MUNINN_WIKI_READONLY=1, which is a false
    // claim about the whole instance on a write-owning host.
    expect(wikiReadonlyRootReason("/ro")).toContain(WIKI_READONLY_ROOTS_ENV);
    expect(wikiReadonlyRootReason("/ro")).not.toContain("MUNINN_WIKI_READONLY");
    expect(wikiReadonlyRootReason("/ro")).toContain("/ro");
    // The egress sentence names the WIKI and says what it refuses, since
    // "read-only" reads as "you can still ask it questions".
    expect(wikiNoEgressReason("memory")).toContain("memory");
    expect(wikiNoEgressReason("memory")).toMatch(/model|web/);
    expect(wikiNoEgressReason("memory")).not.toContain("MUNINN_WIKI_READONLY");
  });
});

describe("WIKI_READONLY_ROOTS — write seams", () => {
  beforeEach(() => __resetWikiWriteQueueForTest());

  test("writeWikiPage refuses BEFORE the read, on the root — not the instance flag", async () => {
    const touched: string[] = [];
    const res = await writeWikiPage({
      wikiDir: "/ro",
      relPath: "page.md",
      baseHash: sha256("body\n"),
      transform: (c) => `${c}more\n`,
      collections: ["wiki"],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      now: () => 0,
      readFile: async (p) => {
        touched.push(`read ${p}`);
        return "body\n";
      },
      writeFile: async (p) => {
        touched.push(`write ${p}`);
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      // The INSTANCE owns writes — this is the whole point of the second mechanism.
      isReadonly: () => false,
      isReadonlyRoot: (root) => root === "/ro",
    });
    expect(res.outcome).toBe("forbidden");
    expect(res.outcome === "forbidden" && res.reason).toBe(wikiReadonlyRootReason("/ro"));
    expect(touched).toEqual([]);
  });

  test("writeWikiPage still writes to a root that is NOT listed", async () => {
    const files: Record<string, string> = { "/rw/page.md": "body\n" };
    const res = await writeWikiPage({
      wikiDir: "/rw",
      relPath: "page.md",
      baseHash: sha256(files["/rw/page.md"]!),
      transform: (c) => `${c}more\n`,
      collections: [],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      now: () => 0,
      readFile: async (p) => files[p] ?? null,
      writeFile: async (p, c) => {
        files[p] = c;
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      isReadonly: () => false,
      isReadonlyRoot: (root) => root === "/ro",
    });
    expect(res.outcome).toBe("written");
    expect(files["/rw/page.md"]).toBe("body\nmore\n");
  });

  test("the seam DEFAULTS to the shared predicate — a caller passing nothing is guarded", async () => {
    __setReadonlyWikiRootsForTest(["/ro"]);
    const res = await writeWikiPage({
      wikiDir: "/ro",
      relPath: "page.md",
      baseHash: "x",
      transform: (c) => c,
      collections: [],
      logKind: "k",
      logTitle: "t",
      logLine: "l",
      now: () => 0,
      readFile: async () => {
        throw new Error("must not read");
      },
      writeFile: async () => {
        throw new Error("must not write");
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      isReadonly: () => false,
    });
    expect(res.outcome).toBe("forbidden");
  });

  test("applyWikiProposal refuses before the write queue is entered", async () => {
    const proposal = {
      id: "p1",
      botName: "jarvis",
      topicKey: "widgets",
      kind: "concept",
      mode: "create",
      targetPath: "concepts/Widgets.md",
      draft: "---\ntitle: Widgets\n---\n\nBody.\n",
      status: "approved",
    } as unknown as WikiProposal;
    let read = 0;
    const res = await applyWikiProposal(proposal, {
      wikiDir: "/ro",
      now: () => 0,
      readFile: async () => {
        read++;
        return null;
      },
      writeFile: async () => {
        throw new Error("must not write");
      },
      getWikiIndex: async () => {
        read++;
        return null;
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      isReadonly: () => false,
      isReadonlyRoot: (root) => root === "/ro",
    });
    expect(res.outcome).toBe("forbidden");
    expect(res.outcome === "forbidden" && res.reason).toBe(wikiReadonlyRootReason("/ro"));
    expect(read).toBe(0);
  });

  test("writePlanQueue refuses before the file is opened", async () => {
    const res = await writePlanQueue({
      wikiDir: "/ro",
      baseHash: "",
      buildContent: () => {
        throw new Error("must not build");
      },
      readQueue: async () => {
        throw new Error("must not read");
      },
      writeFile: async () => {
        throw new Error("must not write");
      },
      isReadonly: () => false,
      isReadonlyRoot: (root) => root === "/ro",
    });
    expect(res.outcome).toBe("forbidden");
    expect(res.outcome === "forbidden" && res.reason).toBe(wikiReadonlyRootReason("/ro"));
  });
});

describe("WIKI_READONLY_ROOTS — registry flag + drift warn", () => {
  test("the options-object signature stamps `readonly` on the matching entry only", () => {
    const reg = buildWikiRegistry({
      bots: [bot("jarvis", "/w")],
      extra: "memory=/ro,mimir=../mimir",
      repoRoot: REPO,
      isReadonlyRoot: (root) => root === "/ro",
      readonlyRoots: ["/ro"],
    });
    expect(reg).toEqual([
      { name: "jarvis", root: "/w", source: "bot" },
      { name: "memory", root: "/ro", source: "extra", readonly: true },
      { name: "mimir", root: "/repo/mimir", source: "extra" },
    ]);
  });

  test("without the readonly inputs the registry is byte-identical to before", () => {
    // Enforcement never reads the flag, so a registry built without them (or a
    // stale memo) is safe — and must not gain a field.
    const reg = buildWikiRegistry({ bots: [], extra: "memory=/ro", repoRoot: REPO });
    expect(reg).toEqual([{ name: "memory", root: "/ro", source: "extra" }]);
  });

  test("a root matching no registered wiki warns LOUDLY — and guards nothing", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      const reg = buildWikiRegistry({
        bots: [],
        extra: "mimir=../mimir",
        repoRoot: REPO,
        isReadonlyRoot: (root) => root === "/typo",
        readonlyRoots: ["/typo"],
      });
      // Fails CLOSED for itself: it names a root nothing writes.
      expect(reg.some((e) => e.readonly)).toBe(false);
      const warns = records.filter((r) => r.level === "warning");
      const hit = warns.find((r) => r.message.join("").includes("WIKI_READONLY_ROOTS"));
      expect(hit).toBeDefined();
      expect(JSON.stringify(hit!.properties)).toContain("/typo");
    } finally {
      await reset();
    }
  });

  test("a matching root does NOT warn", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      buildWikiRegistry({
        bots: [],
        extra: "memory=/ro",
        repoRoot: REPO,
        isReadonlyRoot: (root) => root === "/ro",
        readonlyRoots: ["/ro"],
      });
      expect(
        records.filter((r) => r.message.join("").includes("WIKI_READONLY_ROOTS")),
      ).toEqual([]);
    } finally {
      await reset();
    }
  });
});

describe(".wiki-reader.json `include` — scan scope", () => {
  let root: string;

  beforeEach(async () => {
    __resetWikiCacheForTest();
    root = await mkdtemp(path.join(tmpdir(), "wiki-include-"));
    await mkdir(path.join(root, "proj-a", "memory"), { recursive: true });
    await mkdir(path.join(root, "proj-b", "memory"), { recursive: true });
    await mkdir(path.join(root, "abc-uuid", "session-memory"), { recursive: true });
    await mkdir(path.join(root, "abc-uuid", "tool-results"), { recursive: true });
    await Bun.write(path.join(root, "proj-a", "memory", "MEMORY.md"), "# A hub\n");
    await Bun.write(path.join(root, "proj-a", "memory", "note.md"), "# A note\n");
    await Bun.write(path.join(root, "proj-b", "memory", "MEMORY.md"), "# B hub\n");
    await Bun.write(path.join(root, "abc-uuid", "session-memory", "summary.md"), "# stray\n");
    await Bun.write(path.join(root, "abc-uuid", "tool-results", "artifact-1.html"), "<p>x</p>");
  });
  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const rels = async () => (await buildWikiIndex(root)).pages.map((p) => p.relPath).sort();

  test("absent ⇒ everything is scanned (today's behaviour, byte-identical)", async () => {
    expect(await rels()).toEqual([
      "abc-uuid/session-memory/summary.md",
      "abc-uuid/tool-results/artifact-1.html",
      "proj-a/memory/MEMORY.md",
      "proj-a/memory/note.md",
      "proj-b/memory/MEMORY.md",
    ]);
  });

  test("present ⇒ only matching paths, and the config is read BEFORE the scan", async () => {
    // If the read still happened after the glob, `include` could not scope it and
    // the strays would be in the index regardless of this file.
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ include: ["*/memory/**"] }),
    );
    __resetWikiCacheForTest();
    expect(await rels()).toEqual([
      "proj-a/memory/MEMORY.md",
      "proj-a/memory/note.md",
      "proj-b/memory/MEMORY.md",
    ]);
  });

  test("multiple entries are ANY-match, not all-match", async () => {
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ include: ["proj-a/**", "proj-b/**"] }),
    );
    __resetWikiCacheForTest();
    expect(await rels()).toEqual([
      "proj-a/memory/MEMORY.md",
      "proj-a/memory/note.md",
      "proj-b/memory/MEMORY.md",
    ]);
  });

  test("a bad `include` degrades to unscoped + warns, and keeps the other keys", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ include: "*/memory/**", typeLabels: { project: "Project" } }),
      );
      __resetWikiCacheForTest();
      const index = await buildWikiIndex(root);
      expect(index.pages.length).toBe(5); // unscoped — validate-warn-DEGRADE
      expect(index.readerConfig?.typeLabels).toEqual({ project: "Project" });
      const warns = records.filter((r) => r.level === "warning");
      expect(warns.some((r) => r.message.join("").includes("include"))).toBe(true);
    } finally {
      await reset();
    }
  });

  test("an empty-string entry is a bad include (it would match nothing)", async () => {
    await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ include: ["  "] }));
    __resetWikiCacheForTest();
    expect((await buildWikiIndex(root)).pages.length).toBe(5);
  });

  test("a read-only root with no readable config warns — the scan is unscoped", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      __setReadonlyWikiRootsForTest([root]);
      __resetWikiCacheForTest();
      const index = await buildWikiIndex(root);
      // The GUARD is unaffected — that is the whole point of keeping it in the env.
      expect(isReadonlyWikiRoot(root)).toBe(true);
      expect(index.pages.length).toBe(5);
      const warns = records.filter((r) => r.level === "warning");
      expect(warns.some((r) => r.message.join("").includes(".wiki-reader.json"))).toBe(true);
    } finally {
      await reset();
      __setReadonlyWikiRootsForTest();
    }
  });
});

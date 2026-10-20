/**
 * The gate listing's drift flag agrees with what Approve does, and the shared
 * pre-write checks log once per apply (architecture review 2026-10, finding 63,
 * fix round 2 batch 2). Captures LogTape records, so it resets the logger
 * configuration after each test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { applyWikiProposal, applyWikiProposalGroup, listingDrift, type ApplyDeps } from "./apply.ts";
import { sha256 } from "./util.ts";
import { buildWikiIndex } from "../wiki/store.ts";
import { __resetWikiWriteQueueForTest } from "../wiki/queue.ts";
import type { WikiProposal } from "../db/wiki-proposals.ts";
import { testTempDir } from "../test/temp-dir.ts";

const PAGE = "concepts/Chat.md";
const BASE = "---\ntype: concept\ntitle: Chat\naliases: []\n---\n\n# Chat\n\nBody.\n";

let wikiDir: string;
let records: LogRecord[];

function row(overrides: Partial<WikiProposal> = {}): WikiProposal {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    botName: "jarvis",
    wikiName: null,
    topicKey: "chat",
    groupKey: null,
    lintMeta: null,
    kind: "concept",
    mode: "update",
    targetPath: PAGE,
    baseHash: sha256(BASE),
    draft: BASE.replace("Body.", "Body, see [[Gone Page]]."),
    sourceDocs: [],
    rationale: null,
    containedLinks: null,
    relatedPages: null,
    status: "approved",
    createdAt: Date.now(),
    resolvedAt: null,
    ...overrides,
  };
}

function deps(): ApplyDeps {
  return {
    wikiDir,
    now: () => Date.parse("2026-10-20T10:00:00Z"),
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
    refreshIndex: async () => {},
    reindex: async () => {},
    isReadonly: () => false,
    isReadonlyRoot: () => false,
  };
}

const onDisk = (rel: string) => readFile(path.join(wikiDir, rel), "utf8");
const messages = () => records.map((r) => r.message.map((m) => String(m)).join(""));
const count = (needle: string) => messages().filter((m) => m.includes(needle)).length;

beforeEach(async () => {
  wikiDir = await testTempDir(path.join(tmpdir(), "gardener-drift-"));
  __resetWikiWriteQueueForTest();
  await mkdir(path.join(wikiDir, "concepts"), { recursive: true });
  await writeFile(path.join(wikiDir, PAGE), BASE);
  records = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});
afterEach(async () => {
  await reset();
  await rm(wikiDir, { recursive: true, force: true });
});

describe("listingDrift says what Approve does", () => {
  test("a page equal to the RAW draft is drift when containment now changes the draft", async () => {
    // Someone wrote the raw draft by hand; its body link's target does not exist.
    const r = row();
    await writeFile(path.join(wikiDir, PAGE), r.draft);
    const index = await buildWikiIndex(wikiDir);

    expect(listingDrift(r, await onDisk(PAGE), index)).toBe("target file changed since drafting");
    const res = await applyWikiProposal(r, deps());
    expect(res).toEqual({ outcome: "stale", reason: "target file changed since drafting" });
    expect(await onDisk(PAGE)).toBe(r.draft);
  });

  test("a page equal to the CONTAINED draft is not drift: Approve no-ops it", async () => {
    const r = row();
    const contained = BASE.replace("Body.", "Body, see **Gone Page**.");
    await writeFile(path.join(wikiDir, PAGE), contained);
    const index = await buildWikiIndex(wikiDir);

    expect(listingDrift(r, await onDisk(PAGE), index)).toBeNull();
    const res = await applyWikiProposal(r, deps());
    expect(res).toMatchObject({ outcome: "applied", noop: true });
  });

  test("a lint row whose page is its draft plus a newline is drift (no normalization on lint)", async () => {
    const draft = BASE.replace("Body.\n", "Body, linted.");
    const r = row({ kind: "lint", draft });
    await writeFile(path.join(wikiDir, PAGE), `${draft}\n`);
    const index = await buildWikiIndex(wikiDir);

    expect(listingDrift(r, await onDisk(PAGE), index)).toBe("target file changed since drafting");
    expect(await applyWikiProposal(r, deps())).toMatchObject({ outcome: "stale" });
  });

  test("a concept row whose page is its draft with one trailing newline is not drift", async () => {
    const draft = BASE.replace("Body.\n", "Body, revised.\n\n\n");
    const r = row({ draft });
    await writeFile(path.join(wikiDir, PAGE), BASE.replace("Body.\n", "Body, revised.\n"));
    const index = await buildWikiIndex(wikiDir);

    expect(listingDrift(r, await onDisk(PAGE), index)).toBeNull();
    expect(await applyWikiProposal(r, deps())).toMatchObject({ outcome: "applied", noop: true });
  });

  test("a page still at its base is not drift", async () => {
    const index = await buildWikiIndex(wikiDir);
    expect(listingDrift(row(), await onDisk(PAGE), index)).toBeNull();
  });
});

describe("the pre-write checks log once", () => {
  test("a single Approve logs its alias-strip and de-link lines", async () => {
    await writeFile(
      path.join(wikiDir, "concepts/Owner.md"),
      "---\ntype: concept\ntitle: Owner\naliases: [Talk]\n---\n\n# Owner\n\nBody.\n",
    );
    const r = row({ draft: BASE.replace("aliases: []", "aliases: [Talk]").replace("Body.", "Body, see [[Gone Page]].") });
    const res = await applyWikiProposal(r, deps());

    expect(res.outcome).toBe("applied");
    expect(count("stripped alias(es) owned by other pages")).toBe(1);
    expect(count("de-linked unresolvable body link(s)")).toBe(1);
  });

  test("a single Approve on a page that already is its draft logs the no-op line", async () => {
    const r = row({ draft: BASE.replace("Body.", "Body, revised.") });
    await writeFile(path.join(wikiDir, PAGE), r.draft);
    expect(await applyWikiProposal(r, deps())).toMatchObject({ outcome: "applied", noop: true });
    expect(count("target already matches draft")).toBe(1);
  });

  test("a single Approve whose stem another page owns logs the collision line", async () => {
    await mkdir(path.join(wikiDir, "plans"), { recursive: true });
    await writeFile(path.join(wikiDir, "plans/fresh.mdx"), "---\ntitle: Fresh\n---\n\nBody.\n");
    const r = row({ mode: "create", baseHash: null, targetPath: "concepts/fresh.md", draft: BASE.replace("Chat", "Fresh") });
    expect(await applyWikiProposal(r, deps())).toMatchObject({ outcome: "collision" });
    expect(count("stem is already owned by")).toBe(1);
  });

  test("a group's preflight logs nothing of its own: a no-op member logs once, from the apply", async () => {
    const done = BASE.replace("Body.", "Body, linted.");
    const other = "concepts/Other.md";
    const otherBase = BASE.replace("Chat", "Other");
    await writeFile(path.join(wikiDir, PAGE), done);
    await writeFile(path.join(wikiDir, other), otherBase);
    const group = "lint:series-unnamed:abcdefabcdef";
    const rows = [
      row({ id: "g1", kind: "lint", groupKey: group, topicKey: `${group}:${PAGE}`, draft: done }),
      row({
        id: "g2",
        kind: "lint",
        groupKey: group,
        topicKey: `${group}:${other}`,
        targetPath: other,
        baseHash: sha256(otherBase),
        draft: otherBase.replace("Body.", "Body, linted."),
      }),
    ];
    const res = await applyWikiProposalGroup(rows, deps());

    expect(res.stoppedAt).toBeUndefined();
    expect(count("target already matches draft")).toBe(1);
  });
});

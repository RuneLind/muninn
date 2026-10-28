/**
 * The verdict keys on real indexes (PR 2a, the round-3 class check): a Check
 * run with `asOf` and the STALE tab's GET without it share a key, frontmatter
 * stamps and content-neutral commits reset nothing (D7, D22), and a key reads
 * the page's own title, not the reader's stem-collision label. Check says when
 * an answer fails again. A git temp wiki, a fake model and an in-memory store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotConfig } from "../bots/config.ts";
import { testTempDir } from "../test/temp-dir.ts";
import {
  CHECK_ANSWER_UNREADABLE,
  changedHashOf,
  memoryStaleVerdictStore,
  passageVerdictKey,
  passageVerdicts,
  runStaleCheck,
  statusLineVerdictKey,
  type StaleCheckEvent,
  type StaleModel,
} from "./stale-confirm.ts";
import { linkingBuckets } from "./stale.ts";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";

const BOT = { name: "fakebot", connector: "claude-cli" } as unknown as BotConfig;
const DAY = 24 * 60 * 60_000;
const page = (title: string | null, body: string, extra = "") => `---\n${title === null ? "" : `title: ${title}\n`}${extra}---\n\n${body}\n`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

describe("passage keys across asOf, stamps and commits", () => {
  let root = "";
  const t0 = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (ms: number, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso(ms), "-m", msg);
  };
  // asOf after every commit: the model sees the same subjects as without asOf.
  const asOfSame = t0 - DAY;
  // asOf between the hub's two edits: it cuts «hub: second».
  const asOfCut = t0 - 4 * DAY;

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-keys-"));
    await git(root, "init", "-q", "-b", "main");
    // The hub has no `title:`, so a page sharing its stem relabels it.
    await write("docs/hub.md", page(null, "Body one."));
    await write("notes/old.md", page("Old", "The pin in [[docs/hub]] landed on 23.05."));
    await commitAt(t0 - 10 * DAY, "seed");
    await write("docs/hub.md", page(null, "Body two."));
    await commitAt(t0 - 6 * DAY, "hub: first");
    await write("docs/hub.md", page(null, "Body three."));
    await commitAt(t0 - 3 * DAY, "hub: second");
  }, 30_000);
  afterAll(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const fresh = async () => {
    __resetWikiCacheForTest();
    return (await getWikiIndex({ root, refresh: true }))!;
  };
  const toCheckOf = async (index: WikiIndex, asOfMs?: number) => {
    const b = (await linkingBuckets(index, "docs/hub.md", asOfMs !== undefined ? { asOfMs } : {}))!;
    expect(b.linking.filter((l) => l.bucket === "toCheck").map((l) => l.relPath)).toEqual(["notes/old.md"]);
    return b;
  };
  const keyOf = async (index: WikiIndex, asOfMs?: number) => {
    const b = await toCheckOf(index, asOfMs);
    const hash = (await changedHashOf(index, "docs/hub.md"))!;
    return passageVerdictKey(index, "docs/hub.md", hash, b.linking.find((l) => l.bucket === "toCheck")!);
  };

  test("a Check under asOf is seen by the GET without it, and a reader verdict without asOf under it", async () => {
    const index = await fresh();
    const store = memoryStaleVerdictStore();
    const model: StaleModel = async () => '{"verdict":"stale","reason":"moved"}';
    const events: StaleCheckEvent[] = [];
    await runStaleCheck({ wiki: "w", index, relPath: "docs/hub.md", asOfMs: asOfSame, bot: BOT, store, model, onEvent: (e) => void events.push(e) });
    expect(events.filter((e) => e.type === "verdict")).toHaveLength(1);
    const plain = await toCheckOf(index);
    expect([...(await passageVerdicts("w", index, "docs/hub.md", plain.linking, { store })).values()].map((v) => v.verdict)).toEqual(["stale"]);

    const other = memoryStaleVerdictStore();
    const readerKey = await keyOf(index);
    await other.upsert({ wiki: "w", kind: "passage", page: "notes/old.md", keyHash: readerKey, verdict: "true", reason: "reader", edit: null, checkedBy: "reader" });
    const dated = await toCheckOf(index, asOfSame);
    expect([...(await passageVerdicts("w", index, "docs/hub.md", dated.linking, { store: other })).values()].map((v) => v.checkedBy)).toEqual(["reader"]);
  });

  test("asOf is not a key input: a Check under an asOf that cuts a subject is seen by the GET without it", async () => {
    const index = await fresh();
    const plain = await keyOf(index);
    expect(await keyOf(index, asOfSame)).toBe(plain);
    expect(await keyOf(index, asOfCut)).toBe(plain);
    // An asOf that cuts «hub: second» changes the prompt's subjects, not the key.
    const store = memoryStaleVerdictStore();
    let prompt = "";
    const model: StaleModel = async (p) => ((prompt = p), '{"verdict":"true","reason":"holds"}');
    await runStaleCheck({ wiki: "w", index, relPath: "docs/hub.md", asOfMs: asOfCut, bot: BOT, store, model, onEvent: () => {} });
    expect(prompt).toContain("hub: first");
    expect(prompt).not.toContain("hub: second");
    const plainBuckets = await toCheckOf(index);
    expect([...(await passageVerdicts("w", index, "docs/hub.md", plainBuckets.linking, { store })).values()].map((v) => v.verdict)).toEqual(["true"]);
  });

  test("a `sessions:` stamp or an `updated:` bump on the changed page resets no key, committed or not", async () => {
    const index = await fresh();
    const plain = await keyOf(index);
    await write("docs/hub.md", page(null, "Body three.", "sessions: [abc123]\nupdated: 2026-10-28\n"));
    try {
      const dirty = await fresh();
      expect(dirty.resolveRelPath("docs/hub.md")!.gitDirty).toBe(true);
      expect(await keyOf(dirty)).toBe(plain);
      expect(await keyOf(dirty, asOfSame)).toBe(plain);
    } finally {
      await git(root, "checkout", "-q", "--", "docs/hub.md");
    }
  });

  test("a new commit to the changed page with its content unchanged resets no key", async () => {
    const index = await fresh();
    const plain = await keyOf(index);
    const head = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await write("docs/hub.md", page(null, "Body three.", "sessions: [def456]\n"));
    await commitAt(t0 - 2 * DAY, "wiki: stamp sessions");
    try {
      const after = await fresh();
      expect(after.resolveRelPath("docs/hub.md")!.gitDirty).toBeFalsy();
      expect(await keyOf(after)).toBe(plain);
      expect(await keyOf(after, asOfSame)).toBe(plain);
    } finally {
      await git(root, "reset", "-q", "--hard", head);
    }
  });

  test("a page sharing the stem elsewhere leaves the keys alone", async () => {
    const index = await fresh();
    const before = await keyOf(index);
    expect(index.resolveRelPath("docs/hub.md")!.displayTitle).toBeUndefined();
    await write("archive/hub.md", page("Archived hub", "Nothing here."));
    try {
      const after = await fresh();
      // The reader relabels the hub (the stem collides); its key must not move.
      expect(after.resolveRelPath("docs/hub.md")!.displayTitle).toBeDefined();
      expect(await keyOf(after)).toBe(before);
    } finally {
      await rm(path.join(root, "archive"), { recursive: true, force: true });
    }
  });

  test("Check calls again on every click and says when an answer failed before; a success clears it", async () => {
    const index = await fresh();
    let answer = "Sorry, no JSON today.";
    let calls = 0;
    const model: StaleModel = async () => (calls++, answer);
    const failures = new Map();
    // A fresh store each run, so a stored verdict never hides the next call.
    const run = async () => {
      const events: StaleCheckEvent[] = [];
      await runStaleCheck({ wiki: "w", index, relPath: "docs/hub.md", bot: BOT, store: memoryStaleVerdictStore(), model, failures, onEvent: (e) => void events.push(e) });
      return events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
    };
    expect(await run()).toEqual([CHECK_ANSWER_UNREADABLE]);
    const second = await run();
    expect(second).toHaveLength(1);
    expect(second[0]).toStartWith(CHECK_ANSWER_UNREADABLE);
    expect(second[0]).toContain("2 times in a row");
    expect(calls).toBe(2);
    answer = '{"verdict":"true","reason":"ok"}';
    expect(await run()).toEqual([]);
    answer = "still no JSON";
    // The run of failures starts over after a success: the plain text again.
    expect(await run()).toEqual([CHECK_ANSWER_UNREADABLE]);
    expect(calls).toBe(4);
  });
});

describe("status-line keys read the target's own title, not its prompt evidence", () => {
  let root = "";
  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-title-"));
    // No `title:` on the plan: a page sharing its stem gives it a display label.
    await mkdir(path.join(root, "plans"), { recursive: true });
    await writeFile(path.join(root, "plans/p.md"), page(null, "Body.", "plan_status: shipped\n"));
    await writeFile(path.join(root, "hub.md"), page("Hub", "- [[plans/p]] is in-flight"));
  });
  afterAll(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("adding a same-stem page elsewhere keeps the confirmation key", async () => {
    __resetWikiCacheForTest();
    const index = (await getWikiIndex({ root, refresh: true }))!;
    const hit = index.statusLineHits!.get("hub.md")![0]!;
    const before = statusLineVerdictKey(index, "hub.md", hit);
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes/p.md"), page(null, "Another p."));
    __resetWikiCacheForTest();
    const after = (await getWikiIndex({ root, refresh: true }))!;
    expect(after.resolveRelPath("plans/p.md")!.displayTitle).toBeDefined();
    const hit2 = after.statusLineHits!.get("hub.md")![0]!;
    expect(hit2.target).toBe("plans/p.md");
    expect(statusLineVerdictKey(after, "hub.md", hit2)).toBe(before);
  });

  test("a stamp, an `updated:` bump, a status_note or a description on the target keeps the confirmation key", async () => {
    __resetWikiCacheForTest();
    const index = (await getWikiIndex({ root, refresh: true }))!;
    const before = statusLineVerdictKey(index, "hub.md", index.statusLineHits!.get("hub.md")![0]!);
    const original = await Bun.file(path.join(root, "plans/p.md")).text();
    await writeFile(path.join(root, "plans/p.md"), page(null, "Body.", "plan_status: shipped\nsessions: [abc123]\nupdated: 2026-10-28\nstatus_note: all merged\ndescription: The plan.\n"));
    try {
      __resetWikiCacheForTest();
      const after = (await getWikiIndex({ root, refresh: true }))!;
      expect(after.resolveRelPath("plans/p.md")!.status_note).toBe("all merged");
      expect(statusLineVerdictKey(after, "hub.md", after.statusLineHits!.get("hub.md")![0]!)).toBe(before);
    } finally {
      await writeFile(path.join(root, "plans/p.md"), original);
    }
  });
});

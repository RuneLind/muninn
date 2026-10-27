/**
 * The Stale check's model half (`stale-confirm.ts`): the content keys (D22),
 * the strict answer parse, and the confirm loop (D16) over a temp wiki with a
 * fake model and an in-memory verdict store — no database, no model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotConfig } from "../bots/config.ts";
import { testTempDir } from "../test/temp-dir.ts";
import { PROVENANCE_FRONTMATTER_KEYS } from "./provenance.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "./readonly.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import {
  buildStalePrompt,
  changedPageContentHash,
  CONFIRM_MAX_CALLS,
  CONFIRM_START_CUTOFF_MS,
  memoryStaleVerdictStore,
  otherPlansIn,
  parseStaleAnswer,
  passageKeyHash,
  runStaleConfirm,
  startStaleConfirmLoop,
  statusLineKeyHash,
  stopStaleConfirmLoop,
  type ConfirmDeps,
  type StaleModel,
} from "./stale-confirm.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "./store.ts";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

describe("changedPageContentHash (D22)", () => {
  const base = page("P", "Body text.", "plan_status: in-flight\nstatus_note: two PRs open\n");
  test("a provenance stamp, `updated` or another key leaves the hash alone", () => {
    const h = changedPageContentHash(base);
    for (const key of [...PROVENANCE_FRONTMATTER_KEYS, "updated", "series", "tags", "status_date"]) {
      for (const value of ["[x, y]", "2026-10-27"]) {
        const stamped = base.replace("title: P\n", `title: P\n${key}: ${value}\n`);
        expect({ key, value, same: changedPageContentHash(stamped) === h }).toEqual({ key, value, same: true });
      }
    }
    expect(changedPageContentHash(base.replace("title: P", "title: Q"))).toBe(h);
  });
  test("the body, plan_status and status_note each change it", () => {
    const h = changedPageContentHash(base);
    expect(changedPageContentHash(base.replace("Body text.", "Body text!"))).not.toBe(h);
    expect(changedPageContentHash(base.replace("in-flight", "shipped"))).not.toBe(h);
    expect(changedPageContentHash(base.replace("two PRs open", "one PR open"))).not.toBe(h);
  });
});

describe("verdict keys", () => {
  const hit = { text: "- [[p]] is in-flight", target: "plans/p.md", now: "shipped" as const };
  test("a status-line key ignores the line number and reads text, target and plan_status", () => {
    const k = statusLineKeyHash("hub.md", hit);
    expect(statusLineKeyHash("hub.md", { ...hit })).toBe(k);
    expect(statusLineKeyHash("hub.md", { ...hit, text: "- [[p]] is proposed" })).not.toBe(k);
    expect(statusLineKeyHash("hub.md", { ...hit, now: "in-flight" })).not.toBe(k);
    expect(statusLineKeyHash("other.md", hit)).not.toBe(k);
  });
  test("a passage key reads the linking page, the passage and the changed page's hash", () => {
    const k = passageKeyHash("a.md", "text", "h1");
    expect(passageKeyHash("a.md", "text", "h2")).not.toBe(k);
    expect(passageKeyHash("a.md", "text!", "h1")).not.toBe(k);
    expect(passageKeyHash("b.md", "text", "h1")).not.toBe(k);
  });
});

describe("parseStaleAnswer", () => {
  const passage = "- [[p]] — **prototype bygget, ikke merget (04.09.2026)**: side `/e2e`";
  test("a stale verdict keeps an edit whose old text is in the passage, with its home variant", () => {
    const a = parseStaleAnswer(
      '```json\n{"verdict":"stale","reason":"merged T1–T3","edit":{"old":"prototype bygget, ikke merget (04.09.2026)","new":"i gang","home":""}}\n```',
      passage,
    );
    expect(a).toEqual({ verdict: "stale", reason: "merged T1–T3", edit: { old: "prototype bygget, ikke merget (04.09.2026)", new: "i gang", home: "" } });
  });
  test("an edit whose old text is not verbatim in the passage is dropped, the verdict kept", () => {
    const a = parseStaleAnswer('{"verdict":"stale","reason":"r","edit":{"old":"prototype built","new":"x"}}', passage);
    expect(a).toEqual({ verdict: "stale", reason: "r", edit: null });
  });
  test("an unknown verdict or an unreadable answer is unsure", () => {
    expect(parseStaleAnswer('{"verdict":"outdated","reason":"r"}', passage).verdict).toBe("unsure");
    expect(parseStaleAnswer("I think it is stale.", passage)).toEqual({ verdict: "unsure", reason: "the model's answer could not be read", edit: null });
    expect(parseStaleAnswer('["stale"]', passage).verdict).toBe("unsure");
  });
  test("an edit on a verdict that is not stale is dropped", () => {
    const a = parseStaleAnswer('{"verdict":"true","reason":"r","edit":{"old":"side","new":"x"}}', passage);
    expect(a.edit).toBeNull();
    expect(parseStaleAnswer('{"verdict":"Not-Status","reason":"r"}', passage).verdict).toBe("not-status");
  });
});

describe("buildStalePrompt", () => {
  test("an uncommitted change says so instead of listing subjects; other plans carry their status", () => {
    const p = buildStalePrompt({
      kind: "passage",
      page: "a.md",
      passage: "see [[x]] and [[q]]",
      target: { relPath: "x.md", title: "X" },
      commits: null,
      otherPlans: [{ relPath: "plans/q.md", planStatus: "in-flight", statusNote: "T4 left" }],
    });
    expect(p).toContain("The change to the linked page is uncommitted");
    expect(p).toContain("- [[plans/q.md]]: plan_status in-flight — T4 left");
    expect(p).toContain("plan_status: (none — not a plan)");
  });
  test("a status-line call names the status words and the target's status", () => {
    const p = buildStalePrompt({ kind: "status-line", page: "hub.md", passage: "- [[p]] proposed", target: { relPath: "plans/p.md", title: "P", planStatus: "shipped" }, said: ["proposed"] });
    expect(p).toContain("uses the status word(s) «proposed»");
    expect(p).toContain("plan_status: shipped");
    expect(p).not.toContain("Subjects of the linked page's commits");
  });
});

// ── The confirm loop over a temp wiki ──────────────────────────────────────

const BOT = { name: "fakebot", connector: "claude-cli" } as unknown as BotConfig;

describe("runStaleConfirm (D16)", () => {
  let root = "";
  let entry: WikiRegistryEntry;
  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-confirm-"));
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n- [[p]] is a draft of the lock"));
    entry = { name: "cw", root, source: "extra" } as WikiRegistryEntry;
  });
  afterAll(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });
  afterEach(() => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
  });

  const makeDeps = (over: Partial<ConfirmDeps> = {}) => {
    const store = memoryStaleVerdictStore();
    const prompts: string[] = [];
    const spans: Record<string, unknown>[] = [];
    const model: StaleModel = async (prompt) => {
      prompts.push(prompt);
      return prompt.includes("a draft of the lock") ? '{"verdict":"not-status","reason":"a draft lock"}' : '{"verdict":"stale","reason":"shipped","edit":{"old":"in-flight","new":"shipped"}}';
    };
    const deps: ConfirmDeps = {
      registry: () => [entry],
      bots: () => [BOT],
      index: (r) => getWikiIndex({ root: r, refresh: true }),
      store: () => store,
      model: () => model,
      now: Date.now,
      span: (attrs) => spans.push(attrs),
      tracer: () => null,
      ...over,
    };
    return { deps, store, prompts, spans };
  };

  test("confirms each new hit once, writes one span, and a second run makes no call", async () => {
    const { deps, store, prompts, spans } = makeDeps({ bots: () => [{ ...BOT, name: "cw" } as BotConfig] });
    entry = { ...entry, source: "extra", synthesisBot: "cw" } as WikiRegistryEntry;
    const first = await runStaleConfirm(["CW"], deps);
    expect(first.calls).toBe(2);
    expect(prompts).toHaveLength(2);
    expect([...store.rows.values()].map((r) => [r.verdict, r.kind, r.page, r.checkedBy]).sort()).toEqual([
      ["not-status", "status-line", "hub.md", "model:cw"],
      ["stale", "status-line", "hub.md", "model:cw"],
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ calls: 2, errors: 0, left: 0 });
    const second = await runStaleConfirm(["cw"], deps);
    expect(second.calls).toBe(0);
    expect(second.wikis[0]).toMatchObject({ hits: 2, cached: 2 });
    expect(spans).toHaveLength(1);
  });

  test("a frontmatter stamp on the target plan resets no confirmation", async () => {
    const { deps } = makeDeps();
    await runStaleConfirm(["cw"], deps);
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\nsessions: [claude:abc]\nupdated: 2026-10-27\n"));
    expect((await runStaleConfirm(["cw"], deps)).calls).toBe(0);
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
  });

  test("past 20 new hits the rest wait; no call starts after 3 minutes", async () => {
    const many = Array.from({ length: CONFIRM_MAX_CALLS + 5 }, (_, i) => `- [[p]] is in-flight (${i})`).join("\n");
    await write("many.md", page("Many", many));
    try {
      const { deps } = makeDeps();
      const r = await runStaleConfirm(["cw"], deps);
      expect(r.calls).toBe(CONFIRM_MAX_CALLS);
      expect(r.left).toBe(7);
      let t = 0;
      const late = makeDeps({ now: () => (t += CONFIRM_START_CUTOFF_MS) });
      const r2 = await runStaleConfirm(["cw"], late.deps);
      expect(r2.calls).toBe(0);
      expect(r2.left).toBe(27);
    } finally {
      await rm(path.join(root, "many.md"));
    }
  });

  test("a readonly root is skipped with no index rebuild and no call", async () => {
    __setReadonlyWikiRootsForTest([root]);
    let built = 0;
    const { deps } = makeDeps({ index: async () => ((built++), null) });
    const r = await runStaleConfirm(["cw"], deps);
    expect(r.wikis[0]).toMatchObject({ skipped: "readonly root", calls: 0 });
    expect(built).toBe(0);
  });

  test("a failing call writes nothing, so the next run retries it", async () => {
    const { deps, store } = makeDeps({ model: () => async () => Promise.reject(new Error("boom")) });
    const r = await runStaleConfirm(["cw"], deps);
    expect(r.errors).toBe(2);
    expect(store.rows.size).toBe(0);
  });

  test("the loop starts only with the scheduler on, a writable instance and a registered wiki", async () => {
    const { deps } = makeDeps();
    expect(startStaleConfirmLoop({ schedulerEnabled: false, wikiStaleConfirmWikis: ["cw"] }, { deps })).toEqual([]);
    expect(startStaleConfirmLoop({ schedulerEnabled: true, wikiStaleConfirmWikis: [] }, { deps })).toEqual([]);
    expect(startStaleConfirmLoop({ schedulerEnabled: true, wikiStaleConfirmWikis: ["nope"] }, { deps })).toEqual([]);
    __setWikiReadonlyForTest(true);
    expect(startStaleConfirmLoop({ schedulerEnabled: true, wikiStaleConfirmWikis: ["cw"] }, { deps })).toEqual([]);
    __setWikiReadonlyForTest(false);
    const ran: number[] = [];
    const counting = { ...deps, span: () => ran.push(1) };
    expect(startStaleConfirmLoop({ schedulerEnabled: true, wikiStaleConfirmWikis: ["cw", "nope"] }, { deps: counting, firstDelayMs: 1, intervalMs: 60_000 })).toEqual(["cw"]);
    for (let i = 0; i < 100 && ran.length === 0; i++) await Bun.sleep(20);
    await stopStaleConfirmLoop();
    expect(ran).toEqual([1]);
  });
});

describe("otherPlansIn", () => {
  test("the passage's other plan links with their status, the changed page left out", () => {
    const metas: Record<string, { relPath: string; plan_status?: string; status_note?: string }> = {
      q: { relPath: "plans/q.md", plan_status: "in-flight", status_note: "T4 left" },
      x: { relPath: "x.md" },
      self: { relPath: "plans/self.md", plan_status: "shipped" },
    };
    const index = { resolve: (t: string) => metas[t] as never };
    expect(otherPlansIn(index, "[[q]] and [[x]] and [[self]]", "plans/self.md")).toEqual([{ relPath: "plans/q.md", planStatus: "in-flight", statusNote: "T4 left" }]);
  });
});

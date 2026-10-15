/**
 * The work-sessions memo: the strict parse, the paired commit and the degrade
 * paths, driven through injected deps (the `worked-ledger.test.ts` style — no
 * network, no `mock.module`).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clipSessionsAt,
  __resetWorkSessionsForTest,
  kickWorkSessionsRefresh,
  parsePreWindow,
  parseWorkSessions,
  refreshWorkSessions,
  workSessionsFor,
  type WorkSessionsDeps,
} from "./work-sessions.ts";
import { WORK_WINDOW_MS } from "./work-focus.ts";
import { __resetClaudeUsageWarnsForTest } from "../utils/claude-usage-fetch.ts";
import { __resetWorkedLedgerForTest } from "./worked-ledger.ts";
import { buildWikiIndex } from "./store.ts";
import type { getLog } from "../logging.ts";

type Logger = ReturnType<typeof getLog>;

const NOW = Date.UTC(2026, 9, 15, 8, 0);
const SINCE = NOW - WORK_WINDOW_MS;

beforeEach(() => {
  __resetWorkSessionsForTest();
  __resetWorkedLedgerForTest();
  __resetClaudeUsageWarnsForTest();
});

function recorder(): { levels: string[]; log: Logger } {
  const levels: string[] = [];
  const log = {
    warn: () => levels.push("warn"),
    info: () => levels.push("info"),
    debug: () => {},
    error: () => levels.push("error"),
    fatal: () => {},
    trace: () => {},
  } as unknown as Logger;
  return { levels, log };
}

const session = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  provider: "claude",
  title: "Work on plans/a.mdx",
  first: NOW - 3_600_000,
  last: NOW - 1_800_000,
  bulk: false,
  text: { from: "prompt", paths: ["plans/a.mdx"], links: [{ wiki: null, relPath: "x.md" }], files: [] },
  files: [{ p: "plans/a.mdx", edits: 4, firstMs: NOW - 3_600_000, lastMs: NOW - 1_800_000 }],
  ...over,
});
const sessionsBody = (sessions: unknown[] = [session()]) => ({ form: "sessions", root: "/w", since: SINCE, until: NOW, limit: 200, truncated: false, sessions });
const preBody = (until: number = SINCE) => ({ root: "/w", pageCount: 1, bulk: 10, limit: 5000, truncated: false, until, pages: [{ p: "plans/a.mdx", w: SINCE - 86_400_000, s: 1 }] });

function deps(answers: { sessions?: unknown; pre?: unknown }, over: Partial<WorkSessionsDeps> = {}): WorkSessionsDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    urlConfigured: true,
    baseUrl: "http://ledger.test:8787",
    now: () => NOW,
    registry: async () => [
      { name: "kode", root: "/w" },
      { name: "mimir", root: "/m" },
    ],
    fetchSessions: async (root, since) => {
      calls.push(`sessions ${root} ${since}`);
      const a = answers.sessions ?? sessionsBody();
      if (a instanceof Error) throw a;
      return a;
    },
    fetchPreWindow: async (root, until) => {
      calls.push(`pre ${root} ${until}`);
      const a = answers.pre ?? preBody(until);
      if (a instanceof Error) throw a;
      return a;
    },
    ...over,
  } as WorkSessionsDeps & { calls: string[] };
}

describe("parseWorkSessions", () => {
  test("accepts the sessions form", () => {
    const r = parseWorkSessions(sessionsBody());
    expect(r.ok && r.sessions[0]!.files[0]!.edits).toBe(4);
  });
  test("refuses the raw row form an older claude-usage answers, whose sessions[] holds ids", () => {
    const raw = { root: "/w", sessions: ["s1", "s2"], total: 2, rows: [], limit: 500, offset: 0 };
    expect(parseWorkSessions(raw)).toMatchObject({ ok: false, reason: "not-sessions-form" });
  });
  test("one malformed row rejects the whole answer", () => {
    const bad = sessionsBody([session(), session({ id: "s2", files: [{ p: "x.md", edits: "4", firstMs: 1, lastMs: 2 }] })]);
    expect(parseWorkSessions(bad)).toMatchObject({ ok: false, reason: "malformed-rows" });
    expect(parseWorkSessions(sessionsBody([session({ bulk: "no" })]))).toMatchObject({ ok: false });
    expect(parseWorkSessions(sessionsBody([session({ text: { from: "x", paths: [], links: [], files: [] } })]))).toMatchObject({ ok: false });
  });
});

describe("parsePreWindow", () => {
  test("needs the until echo", () => {
    expect(parsePreWindow(preBody(SINCE), SINCE).ok).toBe(true);
    const { until: _u, ...unbounded } = preBody(SINCE);
    void _u;
    expect(parsePreWindow(unbounded, SINCE)).toMatchObject({ ok: false, reason: "until-not-echoed" });
    expect(parsePreWindow(preBody(SINCE + 1), SINCE)).toMatchObject({ ok: false });
  });
});

describe("refreshWorkSessions", () => {
  test("commits both answers as one entry, with the identity from the registry", async () => {
    const d = deps({});
    const memo = await refreshWorkSessions("/w", d);
    expect(memo).not.toBeNull();
    expect(d.calls).toEqual([`sessions /w ${SINCE}`, `pre /w ${SINCE}`]);
    expect(memo!.sinceMs).toBe(SINCE);
    expect(memo!.asOfMs).toBe(NOW);
    expect(memo!.pre.get("plans/a.mdx")).toBe(SINCE - 86_400_000);
    expect(memo!.identity.name).toBe("kode");
    expect(memo!.otherRoots).toEqual(["/m"]);
    expect(workSessionsFor("/w")).toBe(memo);
  });
  test("an older claude-usage's raw form commits nothing and warns once", async () => {
    const { levels, log } = recorder();
    const raw = { root: "/w", sessions: ["s1"], total: 1, rows: [], limit: 500, offset: 0 };
    expect(await refreshWorkSessions("/w", deps({ sessions: raw }, { log }))).toBeNull();
    expect(await refreshWorkSessions("/w", deps({ sessions: raw }, { log }))).toBeNull();
    expect(levels).toEqual(["warn", "info"]);
    expect(workSessionsFor("/w")).toBeNull();
  });
  test("an unechoed pre-window answer keeps the last good pair", async () => {
    const good = await refreshWorkSessions("/w", deps({}));
    const { until: _u, ...unbounded } = preBody(SINCE);
    void _u;
    const later = await refreshWorkSessions("/w", deps({ sessions: sessionsBody([]), pre: unbounded }));
    expect(later).toBe(good);
    expect(workSessionsFor("/w")!.sessions).toHaveLength(1);
  });
  test("a transport failure on either leg keeps the last good pair", async () => {
    const good = await refreshWorkSessions("/w", deps({}));
    expect(await refreshWorkSessions("/w", deps({ pre: new Error("boom") }))).toBe(good);
    expect(await refreshWorkSessions("/w", deps({ sessions: new Error("boom") }))).toBe(good);
  });
  test("no configured URL fetches nothing", async () => {
    const d = deps({}, { urlConfigured: false });
    expect(await refreshWorkSessions("/w", d)).toBeNull();
    kickWorkSessionsRefresh("/w", { deps: d });
    expect(d.calls).toEqual([]);
  });
  test("a replay asks for the registered root and keys the memo on the clone", async () => {
    const d = deps({});
    const memo = await refreshWorkSessions("/tmp/clone", d, { identityRoot: "/w" });
    expect(d.calls[0]).toBe(`sessions /w ${SINCE}`);
    expect(memo!.identity.roots).toContain("/w");
    expect(memo!.identity.roots).not.toContain("/tmp/clone");
    expect(workSessionsFor("/tmp/clone")).toBe(memo);
  });
  test("a failure backs off on the caller's TTL", async () => {
    const d = deps({ sessions: new Error("down") });
    await refreshWorkSessions("/w", d);
    const n = d.calls.length;
    kickWorkSessionsRefresh("/w", { maxAgeMs: 300_000, deps: d });
    await Bun.sleep(0);
    expect(d.calls.length).toBe(n);
  });
});

describe("the index post-pass", () => {
  test("no memo ⇒ no work field anywhere; a memo ⇒ work on the written page and the threads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "work-sessions-"));
    try {
      await mkdir(path.join(root, "plans"));
      await writeFile(path.join(root, "plans/a.mdx"), "# A\n");
      await writeFile(path.join(root, "plans/b.mdx"), "# B\n");
      const cold = await buildWikiIndex(root);
      expect(JSON.stringify(cold.pages)).not.toContain('"work"');
      expect(cold.work).toBeUndefined();

      await refreshWorkSessions(root, deps({}, { registry: async () => [{ name: "t", root }] }));
      const warm = await buildWikiIndex(root);
      const a = warm.pages.find((p) => p.relPath === "plans/a.mdx")!;
      expect(a.work).toMatchObject({ state: "F", sinceMs: SINCE });
      expect(warm.pages.find((p) => p.relPath === "plans/b.mdx")!.work).toBeUndefined();
      expect(warm.work).toMatchObject({ asOfMs: NOW, sinceMs: SINCE });
      expect(warm.work!.threads.map((t) => t.key)).toEqual(["plans/a.mdx"]);
      // `work` is purely additive: stripped, the pages are the cold build's.
      const strip = (ps: typeof warm.pages) =>
        JSON.stringify(ps.map(({ work: _w, mtimeMs: _m, birthtimeMs: _b, ...rest }) => (void _w, void _m, void _b, rest)));
      expect(strip(warm.pages)).toBe(strip(cold.pages));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("clipSessionsAt — the replay's view of a session that spans --at", () => {
  const AT = Date.UTC(2026, 9, 15, 8, 15);
  const H = 3_600_000;
  const session = (id: string, first: number, last: number, fileLasts: number[]) => ({
    id,
    first,
    last,
    files: fileLasts.map((lastMs, i) => ({ p: `p${i}.md`, edits: 1, firstMs: first, lastMs })),
  });

  test("keeps a spanning session, its last clamped to the newest row the ledger kept", () => {
    // Resumed after --at: upstream already cut the rows after `until`, but
    // `first`/`last` span all of them.
    const spanning = session("s1", AT - 13 * H, AT + 30 * H, [AT - 3 * H, AT - 5 * H]);
    const ended = session("s2", AT - 6 * H, AT - 2 * H, [AT - 2 * H]);
    const { sessions, clipped } = clipSessionsAt([spanning, ended], AT);
    expect(clipped).toBe(1);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sessions[0]).toEqual({ ...spanning, last: AT - 3 * H });
    expect(sessions[1]).toBe(ended);
  });

  test("a file row after --at in the input never moves last past --at", () => {
    // Upstream drops such rows at `until = at`; the clamp must not trust one
    // that slipped through.
    const spanning = session("s1", AT - 13 * H, AT + 30 * H, [AT + 2 * H, AT - 3 * H]);
    const { sessions } = clipSessionsAt([spanning], AT);
    expect(sessions[0]!.last).toBe(AT - 3 * H);
  });

  test("a spanning session with no file rows left is clamped to --at, never past it", () => {
    const { sessions, clipped } = clipSessionsAt([session("s", AT - H, AT + H, [])], AT);
    expect(clipped).toBe(1);
    expect(sessions[0]!.last).toBe(AT);
  });
});

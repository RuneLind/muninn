/**
 * `computeWorkFocus` over a synthetic fixture — one case per rule edge
 * (plan `muninn-wiki-work-threads`, PR 3). No live corpus: the repo is public.
 */

import { describe, expect, test } from "bun:test";
import {
  cleanSessionTitle,
  computeWorkFocus,
  isWorkHub,
  rawWork,
  threadScore,
  WORK_HUB_BACKLINKS,
  WORK_THREADS_MAX,
  WORK_TITLE_MAX,
  workSessionRef,
  type WorkFocusInput,
  type WorkPageInput,
  type WorkSession,
  type WorkSessionFile,
} from "./work-focus.ts";
import { DEFAULT_ACTIVITY_WEIGHTS, rankActivity } from "../dashboard/views/components/wiki-activity-rank.ts";
import { workedShownSignal, workedSortSignal, type WikiListing } from "../dashboard/views/components/wiki-filter.ts";

const H = 3_600_000;
const DAY = 24 * H;
const AS_OF = Date.UTC(2026, 9, 15, 8, 0);
const SINCE = AS_OF - 8 * DAY;
const T = (hoursBefore: number) => AS_OF - hoursBefore * H;

function f(p: string, edits: number, firstMs: number, lastMs = firstMs + 10 * 60_000): WorkSessionFile {
  return { p, edits, firstMs, lastMs };
}

function sess(id: string, files: WorkSessionFile[], over: Partial<WorkSession> & { paths?: string[]; links?: WorkSession["text"]["links"]; names?: string[] } = {}): WorkSession {
  const first = Math.min(...files.map((x) => x.firstMs));
  const last = Math.max(...files.map((x) => x.lastMs));
  return {
    id,
    provider: "claude",
    title: over.title ?? `session ${id}`,
    first: over.first ?? first,
    last: over.last ?? last,
    bulk: over.bulk ?? false,
    text: { from: "prompt", paths: over.paths ?? [], links: over.links ?? [], files: over.names ?? [] },
    files,
  };
}

function pg(relPath: string, over: Partial<WorkPageInput> = {}): WorkPageInput {
  return { relPath, backlinks: 0, ...over };
}

function run(sessions: WorkSession[], pages: WorkPageInput[], over: Partial<WorkFocusInput> = {}) {
  return computeWorkFocus({
    sessions,
    pre: new Map(),
    sinceMs: SINCE,
    asOfMs: AS_OF,
    pages,
    identity: { roots: ["/w/kode"], names: ["kode"] },
    otherRoots: ["/w/mimir"],
    ...over,
  });
}

const kinds = (r: ReturnType<typeof run>, relPath: string) => r.pages.get(relPath)?.events.map((e) => e[2]);

describe("named (D18)", () => {
  // The named page takes 2 edits: at 1, beside the 10-edit page it would be a
  // weak link (pick-up D1), which the weak-link cases below cover.
  const pages = [pg("plans/2026-10-12-vaktsaker.mdx"), pg("plans/other.mdx"), pg("notes/note.mdx"), pg("misc/note.mdx")];
  const write = (s: Partial<Parameters<typeof sess>[2]>) =>
    run([sess("a", [f("plans/2026-10-12-vaktsaker.mdx", 2, T(10)), f("plans/other.mdx", 10, T(10))], s)], pages);

  test("by absolute path under this wiki's root", () => {
    expect(kinds(write({ paths: ["/w/kode/plans/2026-10-12-vaktsaker.mdx"] }), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
  });
  test("by root-relative path", () => {
    expect(kinds(write({ paths: ["plans/2026-10-12-vaktsaker.mdx"] }), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
  });
  test("by a unique file name, with or without the date prefix", () => {
    expect(kinds(write({ names: ["2026-10-12-vaktsaker.mdx"] }), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
    expect(kinds(write({ names: ["vaktsaker.mdx"] }), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
  });
  test("a bare word, a shared file name and an absolute path elsewhere name nothing", () => {
    expect(kinds(write({ names: ["vaktsaker"] }), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["touch"]);
    const r = run(
      [sess("a", [f("notes/note.mdx", 1, T(10)), f("plans/other.mdx", 10, T(10))], { names: ["note.mdx"], paths: ["/tmp/clone/notes/note.mdx"] })],
      pages,
    );
    expect(kinds(r, "notes/note.mdx")).toEqual(["touch"]);
  });
  test("a reader link names a page only when wiki= is this wiki's registry name", () => {
    const link = (wiki: string | null) => write({ links: [{ wiki, relPath: "plans/2026-10-12-vaktsaker.mdx" }] });
    expect(kinds(link("KODE"), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
    expect(kinds(link("mimir"), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["touch"]);
    expect(kinds(link(null), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["touch"]);
  });
  // Arch review 2026-10, finding 71: a root registered twice answers to both names.
  test("a reader link names a page under ANY registry name of this root", () => {
    const link = (wiki: string | null) =>
      run([sess("a", [f("plans/2026-10-12-vaktsaker.mdx", 2, T(10)), f("plans/other.mdx", 10, T(10))], { links: [{ wiki, relPath: "plans/2026-10-12-vaktsaker.mdx" }] })], pages, {
        identity: { roots: ["/w/kode"], names: ["kode", "kode-extra"] },
      });
    expect(kinds(link("kode-extra"), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
    expect(kinds(link("KODE"), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["focus"]);
    expect(kinds(link("mimir"), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["touch"]);
    expect(kinds(link(null), "plans/2026-10-12-vaktsaker.mdx")).toEqual(["touch"]); // D18
  });
  test("on a clone, an absolute path under the REGISTERED root names the page", () => {
    const r = run([sess("a", [f("plans/other.mdx", 2, T(10)), f("notes/note.mdx", 9, T(10))], { paths: ["/reg/kode/plans/other.mdx"] })], pages, {
      identity: { roots: ["/reg/kode"], names: ["kode"] },
    });
    expect(kinds(r, "plans/other.mdx")).toEqual(["focus"]);
  });
  test("bookkeeping pages are not in the vocabulary and carry no events", () => {
    const r = run([sess("a", [f("log.md", 20, T(10)), f("plans/other.mdx", 1, T(10))], { names: ["log.md"], paths: ["log.md"] })], [...pages, pg("log.md")]);
    expect(r.pages.has("log.md")).toBe(false);
    expect(kinds(r, "plans/other.mdx")).toEqual(["touch"]); // naming log.md named nothing
  });
});

describe("created (D2)", () => {
  test("the first writer of a page born in the window, within 10 min of its anchor", () => {
    const anchor = T(30);
    const r = run(
      [
        sess("a", [f("p/new.mdx", 1, anchor - 60_000), f("p/x.mdx", 9, T(31))]),
        sess("b", [f("p/new.mdx", 1, T(5)), f("p/x.mdx", 9, T(5))]),
      ],
      [pg("p/new.mdx", { gitCreatedMs: anchor + 3 * 60_000, birthtimeMs: anchor }), pg("p/x.mdx")],
    );
    expect(kinds(r, "p/new.mdx")).toEqual(["touch", "focus"]);
  });
  test("a gardener-created page committed before the session is not credited", () => {
    const r = run([sess("a", [f("p/g.mdx", 1, T(10)), f("p/x.mdx", 9, T(10))])], [pg("p/g.mdx", { gitCreatedMs: T(12) }), pg("p/x.mdx")]);
    expect(kinds(r, "p/g.mdx")).toEqual(["touch"]);
  });
  test("with neither git creation nor birthtime the rule does not apply", () => {
    const r = run([sess("a", [f("p/u.mdx", 1, T(10)), f("p/x.mdx", 9, T(10))])], [pg("p/u.mdx"), pg("p/x.mdx")]);
    expect(kinds(r, "p/u.mdx")).toEqual(["touch"]);
  });
  test("a page with a pre-window position is not created, though git dates its creation inside the window", () => {
    // Renamed and rewritten at once: git's rename detection fails, so the
    // creation commit lands in the window while the old path has history.
    const viaAlias = run(
      [sess("A", [f("plans/old.mdx", 1, SINCE + DAY)]), sess("B", [f("plans/x.mdx", 5, T(5))])],
      [pg("plans/new.mdx", { aliasPaths: ["plans/old.mdx"], gitCreatedMs: SINCE + 5 * DAY }), pg("plans/x.mdx")],
      { pre: new Map([["plans/old.mdx", SINCE - 30 * DAY]]) },
    );
    expect(viaAlias.pages.get("plans/new.mdx")).toMatchObject({ state: "T", preMs: SINCE - 30 * DAY });
    expect(kinds(viaAlias, "plans/new.mdx")).toEqual(["touch"]);
    expect(viaAlias.threads.some((t) => t.pages.includes("plans/new.mdx"))).toBe(false);
    const viaGit = run(
      [sess("A", [f("p/r.mdx", 1, SINCE + DAY), f("p/x.mdx", 9, SINCE + DAY)])],
      [pg("p/r.mdx", { gitCreatedMs: SINCE + 2 * DAY, preGitMs: SINCE - 10 * DAY }), pg("p/x.mdx")],
    );
    expect(kinds(viaGit, "p/r.mdx")).toEqual(["touch"]);
  });
  test("only the earliest writer is credited, though a later one is inside the slack too", () => {
    // The anchor is a late commit: both sessions write within 10 min of it.
    const anchor = T(30);
    const r = run(
      [
        sess("a", [f("p/new.mdx", 1, anchor - 5 * 60_000), f("p/x.mdx", 9, anchor - 5 * 60_000)]),
        sess("b", [f("p/new.mdx", 1, anchor + 2 * 60_000), f("p/x.mdx", 9, anchor + 2 * 60_000)]),
      ],
      [pg("p/new.mdx", { gitCreatedMs: anchor }), pg("p/x.mdx")],
    );
    expect(kinds(r, "p/new.mdx")).toEqual(["touch", "focus"]);
  });
  test("a page born just before the window is not created, with no pre-window position to say so", () => {
    // No ledger write before the window and no preGitMs: only the
    // creation-date-in-window clause refuses it.
    const r = run(
      [sess("a", [f("p/edge.mdx", 1, SINCE + 60_000), f("p/x.mdx", 9, SINCE + 60_000)])],
      [pg("p/edge.mdx", { gitCreatedMs: SINCE - 5 * 60_000 }), pg("p/x.mdx")],
    );
    expect(r.pages.get("p/edge.mdx")).toMatchObject({ state: "T0" });
    expect(r.pages.get("p/edge.mdx")!.preMs).toBeUndefined();
    expect(kinds(r, "p/edge.mdx")).toEqual(["touch"]);
  });
  test("a page born before the window is never created", () => {
    const r = run([sess("a", [f("p/o.mdx", 1, T(10)), f("p/x.mdx", 9, T(10))])], [pg("p/o.mdx", { gitCreatedMs: SINCE - DAY }), pg("p/x.mdx")]);
    expect(kinds(r, "p/o.mdx")).toEqual(["touch"]);
  });
});

describe("busy (D2) and bookkeeping (D16)", () => {
  test("≥3 edits and ≥ half of the busiest page, with log.md the busiest file", () => {
    const r = run(
      [sess("a", [f("log.md", 40, T(10)), f("p/a.mdx", 4, T(10)), f("p/b.mdx", 2, T(10)), f("p/c.mdx", 3, T(10))])],
      [pg("log.md"), pg("p/a.mdx"), pg("p/b.mdx"), pg("p/c.mdx")],
    );
    expect(kinds(r, "p/a.mdx")).toEqual(["focus"]);
    expect(kinds(r, "p/b.mdx")).toEqual(["touch"]); // under 3
    expect(kinds(r, "p/c.mdx")).toEqual(["focus"]); // 3 ≥ 4 / 2
    expect(r.pages.has("log.md")).toBe(false);
  });
  test("under half of the busiest page is a touch", () => {
    const r = run([sess("a", [f("p/c.mdx", 3, T(10)), f("p/d.mdx", 8, T(10))])], [pg("p/c.mdx"), pg("p/d.mdx")]);
    expect(kinds(r, "p/c.mdx")).toEqual(["touch"]);
    expect(kinds(r, "p/d.mdx")).toEqual(["focus"]);
  });
});

describe("roll-up (D3)", () => {
  test("a CSV counts at half weight toward the page that reads it", () => {
    const r = run([sess("a", [f("data/q.csv", 6, T(10))])], [pg("p/report.mdx", { refs: ["data/q.csv"] })]);
    expect(r.pages.get("p/report.mdx")!.events).toEqual([[T(10) + 10 * 60_000, 3, "focus"]]);
  });
  test("a CSV in a folder named like a page's undated stem counts toward that page", () => {
    const r = run(
      [sess("a", [f("plans/aarsavregning-2025-vaktsaker/Q-10b.csv", 8, T(10)), f("plans/aarsavregning-2025-vaktsaker/Q-2.sql", 2, T(9))])],
      [pg("plans/2026-10-12-aarsavregning-2025-vaktsaker.mdx"), pg("plans/other.mdx")],
    );
    const w = r.pages.get("plans/2026-10-12-aarsavregning-2025-vaktsaker.mdx")!;
    expect(w.events[0]![1]).toBe(5);
    expect(w.state).toBe("F");
  });
  test("a file nobody owns counts toward nothing", () => {
    const r = run([sess("a", [f("scripts/x.ts", 9, T(10))])], [pg("p/a.mdx")]);
    expect(r.pages.size).toBe(0);
  });
  test("an alias path a live page sits at is that page's, not the renamed one's", () => {
    const r = run(
      [sess("a", [f("p/new.mdx", 1, T(5)), f("p/old.mdx", 9, T(5))])],
      [pg("p/new.mdx", { aliasPaths: ["p/old.mdx"] }), pg("p/old.mdx")],
      { pre: new Map([["p/old.mdx", SINCE - DAY]]) },
    );
    const w = r.pages.get("p/new.mdx")!;
    expect(w.state).toBe("T0");
    expect(w.preMs).toBeUndefined();
    expect(r.pages.get("p/old.mdx")).toMatchObject({ state: "F", preMs: SINCE - DAY });
  });
  test("a renamed page keeps its old path's rows and pre-window write", () => {
    const r = run([sess("a", [f("plans/old.mdx", 5, T(10))])], [pg("plans/new.mdx", { aliasPaths: ["plans/old.mdx"] })], {
      pre: new Map([["plans/old.mdx", SINCE - DAY]]),
    });
    const w = r.pages.get("plans/new.mdx")!;
    expect(w.events).toEqual([[T(10) + 10 * 60_000, 5, "focus"]]);
    expect(w.preMs).toBe(SINCE - DAY);
  });
});

describe("passes (D4)", () => {
  test("a bulk session leaves weight-0 markers and joins no thread", () => {
    const pages = ["a", "b", "c"].map((x) => pg(`p/${x}.mdx`));
    const r = run([sess("bulk", pages.map((p) => f(p.relPath, 5, T(10))), { bulk: true })], pages, {
      pre: new Map([["p/a.mdx", SINCE - DAY]]),
    });
    expect(kinds(r, "p/a.mdx")).toEqual(["pass"]);
    expect(r.pages.get("p/a.mdx")!.state).toBe("T");
    expect(r.pages.get("p/b.mdx")!.state).toBe("T0");
    expect(rawWork(r.pages.get("p/a.mdx")!.events, AS_OF)).toBe(0);
    expect(r.threads).toEqual([]);
  });
  test("a session driven from another registered wiki is a pass; a code-repo session is not", () => {
    const pages = [pg("p/a.mdx"), pg("p/b.mdx")];
    const writes = () => [f("p/a.mdx", 5, T(10)), f("p/b.mdx", 5, T(10))];
    const elsewhere = run([sess("m", writes(), { paths: ["/w/mimir/plans/muninn-x.mdx"], names: ["log.md"] })], pages);
    expect(kinds(elsewhere, "p/a.mdx")).toEqual(["pass"]);
    const api = run([sess("api", writes(), { paths: ["/src/melosys-api/src/main/kotlin/Foo.kt", "service/src/Bar.kt"] })], pages);
    expect(kinds(api, "p/a.mdx")).toEqual(["focus"]);
  });
  test("a prompt naming another wiki's path AND a page here is not elsewhere", () => {
    const r = run([sess("m", [f("p/a.mdx", 1, T(10))], { paths: ["/w/mimir/plans/x.mdx", "/w/kode/p/a.mdx"] })], [pg("p/a.mdx")]);
    expect(kinds(r, "p/a.mdx")).toEqual(["focus"]);
  });
  test("POPP shape: a page whose only event is a 9-page elsewhere pass, with a pre-window date", () => {
    const pages = Array.from({ length: 9 }, (_, i) => pg(`concepts/c${i}.mdx`));
    const r = run([sess("tldr", pages.map((p) => f(p.relPath, 1, T(20))), { paths: ["/w/mimir/plans/muninn-tldr-coverage.mdx"] })], pages, {
      pre: new Map([["concepts/c0.mdx", SINCE - 30 * DAY]]),
    });
    const w = r.pages.get("concepts/c0.mdx")!;
    expect(w).toEqual({ sinceMs: SINCE, preMs: SINCE - 30 * DAY, state: "T", events: [[T(20) + 10 * 60_000, 1, "pass"]] });
    expect(r.threads).toEqual([]);
  });
});

describe("threads (D6, D16)", () => {
  test("two sessions joined by a shared focus page form one thread keyed on its earliest focus", () => {
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 5, T(40)), f("p/b.mdx", 1, T(40))]),
        sess("s2", [f("p/a.mdx", 5, T(10)), f("p/c.mdx", 5, T(10))]),
      ],
      [pg("p/a.mdx"), pg("p/b.mdx"), pg("p/c.mdx")],
    );
    expect(r.threads).toHaveLength(1);
    const t = r.threads[0]!;
    expect(t.key).toBe("p/a.mdx");
    expect(new Set(t.pages)).toEqual(new Set(["p/a.mdx", "p/c.mdx"]));
    expect(t.touched).toEqual(["p/b.mdx"]);
    expect(t.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
  test("two sessions joined only through a hub stay apart; the hub's focus row goes to one", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 6, T(30)), f("flows/hub.mdx", 6, T(30))]),
        sess("s2", [f("p/b.mdx", 4, T(5)), f("flows/hub.mdx", 3, T(5))]),
      ],
      [hub, pg("p/a.mdx"), pg("p/b.mdx")],
    );
    expect(r.threads).toHaveLength(2);
    const keys = r.threads.map((t) => t.key);
    expect(new Set(keys).size).toBe(2);
    const owners = r.threads.filter((t) => t.pages.includes("flows/hub.mdx"));
    expect(owners).toHaveLength(1);
    const other = r.threads.find((t) => !t.pages.includes("flows/hub.mdx"))!;
    expect(other.touched).toContain("flows/hub.mdx");
  });
  test("a thread keys on its earliest NON-hub focus page, though the hub was focused first", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    const r = run([sess("s1", [f("flows/hub.mdx", 6, T(30)), f("p/a.mdx", 6, T(29))])], [hub, pg("p/a.mdx")]);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]!.pages).toContain("flows/hub.mdx");
    expect(r.threads[0]!.key).toBe("p/a.mdx");
  });
  test("equal raw work on a hub: the thread whose session ended later owns its row", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    // Same edits and lastMs on the hub (equal raw); different firstMs so the
    // fork dedupe keeps both rows. s2 started later and ends later.
    const r = run(
      [
        sess("s1", [f("flows/hub.mdx", 5, T(22), T(20)), f("p/a.mdx", 5, T(22), T(20))]),
        sess("s2", [f("flows/hub.mdx", 5, T(21), T(20)), f("p/b.mdx", 5, T(3), T(2))]),
      ],
      [hub, pg("p/a.mdx"), pg("p/b.mdx")],
    );
    expect(r.threads).toHaveLength(2);
    const owner = r.threads.find((t) => t.pages.includes("flows/hub.mdx"))!;
    expect(owner.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(r.threads.find((t) => t.key === "p/a.mdx")!.touched).toContain("flows/hub.mdx");
  });
  test("a thread left with only a hub owned elsewhere is dropped; a touch-only session forms none", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 6, T(30)), f("flows/hub.mdx", 9, T(5))]),
        sess("s2", [f("flows/hub.mdx", 3, T(50))]),
        sess("s3", [f("p/z.mdx", 1, T(2)), f("p/y.mdx", 1, T(2))]),
      ],
      [hub, pg("p/a.mdx"), pg("p/y.mdx"), pg("p/z.mdx")],
    );
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]!.sessions.map((s) => s.id)).toEqual(["s1"]);
  });
  test("heavier work orders first, and the client's score from the shipped events agrees", () => {
    const r = run(
      [sess("light", [f("p/l.mdx", 3, T(1))]), sess("heavy", [f("p/h.mdx", 30, T(12)), f("p/h2.mdx", 20, T(12))])],
      [pg("p/l.mdx"), pg("p/h.mdx"), pg("p/h2.mdx")],
    );
    expect(r.threads.map((t) => t.key)).toEqual(["p/h.mdx", "p/l.mdx"]);
    const scores = r.threads.map((t) => threadScore(t, (p) => r.pages.get(p), AS_OF));
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
});

describe("events and states", () => {
  test("fork dedupe: a row identical in path, times and edits counts once", () => {
    const row = f("p/a.mdx", 4, T(10));
    const r = run([sess("parent", [row]), sess("fork", [{ ...row }], { first: row.firstMs + 1 })], [pg("p/a.mdx")]);
    expect(r.pages.get("p/a.mdx")!.events).toHaveLength(1);
  });
  test("the shipped set keeps 12 focus events, the newest touch and the newest pass", () => {
    const sessions: WorkSession[] = [];
    for (let i = 0; i < 15; i++) sessions.push(sess(`f${i}`, [f("p/a.mdx", 5, T(100 + i))]));
    sessions.push(sess("t1", [f("p/a.mdx", 1, T(3)), f("p/x.mdx", 9, T(3))]));
    sessions.push(sess("t2", [f("p/a.mdx", 1, T(2)), f("p/x.mdx", 9, T(2))]));
    sessions.push(sess("p1", [f("p/a.mdx", 1, T(1))], { bulk: true }));
    const r = run(sessions, [pg("p/a.mdx"), pg("p/x.mdx")]);
    const ev = r.pages.get("p/a.mdx")!.events;
    expect(ev.filter((e) => e[2] === "focus")).toHaveLength(12);
    expect(ev.filter((e) => e[2] === "touch")).toEqual([[T(2) + 10 * 60_000, 1, "touch"]]);
    expect(ev.filter((e) => e[2] === "pass")).toHaveLength(1);
    expect(ev.map((e) => e[0])).toEqual([...ev.map((e) => e[0])].sort((a, b) => b - a));
    expect(r.pages.get("p/a.mdx")!.focusMs).toBe(T(100) + 10 * 60_000);
  });
  test("a row that ended before the window is not an event", () => {
    const r = run([sess("old", [f("p/a.mdx", 9, SINCE - DAY, SINCE - 1), f("p/b.mdx", 9, T(10))])], [pg("p/a.mdx"), pg("p/b.mdx")]);
    expect(r.pages.has("p/a.mdx")).toBe(false);
  });
  test("the pre-touch position is the newer of the ledger's and git's", () => {
    const r = run([sess("a", [f("p/a.mdx", 1, T(5)), f("p/z.mdx", 9, T(5))])], [pg("p/a.mdx", { preGitMs: SINCE - 2 * DAY }), pg("p/z.mdx")], {
      pre: new Map([["p/a.mdx", SINCE - 5 * DAY]]),
    });
    expect(r.pages.get("p/a.mdx")).toMatchObject({ state: "T", preMs: SINCE - 2 * DAY });
  });
  test("a ledger path in NFD matches the page's NFC relPath", () => {
    const nfc = "plans/s\u00e5k.mdx";
    const nfd = "plans/sa\u030ak.mdx";
    const r = run([sess("a", [f(nfd, 5, T(10))])], [pg(nfc)], { pre: new Map([[nfd, SINCE - DAY]]) });
    expect(r.pages.get(nfc)).toMatchObject({ state: "F", preMs: SINCE - DAY });
  });
  test("an NFD prompt path or file name names the NFC page", () => {
    const nfc = "plans/s\u00e5k.mdx";
    const nfd = "plans/sa\u030ak.mdx";
    const pages = [pg(nfc), pg("plans/x.mdx")];
    const writes = () => [f(nfc, 2, T(10)), f("plans/x.mdx", 10, T(10))];
    expect(kinds(run([sess("a", writes(), { paths: [`/w/kode/${nfd}`] })], pages), nfc)).toEqual(["focus"]);
    expect(kinds(run([sess("a", writes(), { paths: [nfd] })], pages), nfc)).toEqual(["focus"]);
    expect(kinds(run([sess("a", writes(), { names: ["sa\u030ak.mdx"] })], pages), nfc)).toEqual(["focus"]);
  });
  test("a root and a prompt path match across NFC and NFD, here and elsewhere", () => {
    const pages = [pg("p/a.mdx"), pg("p/b.mdx")];
    const writes = () => [f("p/a.mdx", 2, T(10)), f("p/b.mdx", 10, T(10))];
    const named = (path: string, root: string) =>
      kinds(run([sess("a", writes(), { paths: [path] })], pages, { identity: { roots: [root], names: ["kode"] } }), "p/a.mdx");
    expect(named("/w/ka\u030ade/p/a.mdx", "/w/k\u00e5de")).toEqual(["focus"]);
    expect(named("/w/k\u00e5de/p/a.mdx", "/w/ka\u030ade")).toEqual(["focus"]);
    const away = run([sess("a", writes(), { paths: ["/w/mi\u0301mir/x.mdx"] })], pages, { otherRoots: ["/w/m\u00edmir"] });
    expect(kinds(away, "p/a.mdx")).toEqual(["pass"]);
  });
  test("session titles are cleaned and capped", () => {
    expect(cleanSessionTitle("  a\n\n b  ")).toBe("a b");
    expect([...cleanSessionTitle("x".repeat(500))]).toHaveLength(WORK_TITLE_MAX);
  });
});

describe("the hub threshold", () => {
  test("more than WORK_HUB_BACKLINKS (25) backlinks is a hub; exactly 25 is not", () => {
    expect(WORK_HUB_BACKLINKS).toBe(25);
    expect(isWorkHub(25)).toBe(false);
    expect(isWorkHub(26)).toBe(true);
    expect(isWorkHub(0)).toBe(false);
  });
});

describe("contributions (grouping evidence)", () => {
  const rows = (r: ReturnType<typeof run>) => r.contributions.map(([s, p, t, k, e]) => [s, p, t, k, e]);

  test("each kept event names the thread that kept it; threads and page events are unchanged", () => {
    const sessions = [
      sess("s1", [f("p/a.mdx", 5, T(40)), f("p/b.mdx", 1, T(40))]),
      sess("s2", [f("p/a.mdx", 5, T(10)), f("p/c.mdx", 5, T(10))]),
      sess("s3", [f("p/x.mdx", 4, T(5))]),
    ];
    const pages = [pg("p/a.mdx"), pg("p/b.mdx"), pg("p/c.mdx"), pg("p/x.mdx")];
    const r = run(sessions, pages);
    expect(r.candidates).toBe(2);
    expect(rows(r).filter((c) => c[2] === "p/a.mdx")).toEqual([
      ["claude-code:s2", "p/a.mdx", "p/a.mdx", "focus", 5],
      ["claude-code:s2", "p/c.mdx", "p/a.mdx", "focus", 5],
      ["claude-code:s1", "p/a.mdx", "p/a.mdx", "focus", 5],
      ["claude-code:s1", "p/b.mdx", "p/a.mdx", "touch", 1],
    ]);
    expect(rows(r).filter((c) => c[2] === "p/x.mdx")).toEqual([["claude-code:s3", "p/x.mdx", "p/x.mdx", "focus", 4]]);
    // Every session of a thread contributes, and every focus page has a focus row.
    for (const t of r.threads) {
      const mine = r.contributions.filter((c) => c[2] === t.key);
      expect(new Set(mine.map((c) => c[0]))).toEqual(new Set(t.sessions.map(workSessionRef)));
      for (const p of t.pages) expect(mine.some((c) => c[1] === p && c[3] === "focus")).toBe(true);
    }
    // The first and last event times are the rolled-up row's.
    expect(r.contributions.find((c) => c[0] === "claude-code:s3")!.slice(5)).toEqual([T(5), T(5) + 10 * 60_000]);
  });

  test("a hub the D16 rule moved to another thread is a touch in the thread that lost it", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 6, T(30)), f("flows/hub.mdx", 6, T(30))]),
        sess("s2", [f("p/b.mdx", 4, T(5)), f("flows/hub.mdx", 3, T(5))]),
      ],
      [hub, pg("p/a.mdx"), pg("p/b.mdx")],
    );
    const owner = r.threads.find((t) => t.pages.includes("flows/hub.mdx"))!;
    const other = r.threads.find((t) => t !== owner)!;
    const hubRow = (key: string) => r.contributions.find((c) => c[2] === key && c[1] === "flows/hub.mdx")![3];
    expect(hubRow(owner.key)).toBe("focus");
    expect(hubRow(other.key)).toBe("touch");
  });

  test("passes, touch-only sessions and a dropped hub-only thread contribute nothing", () => {
    const hub = pg("flows/hub.mdx", { backlinks: 30 });
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 6, T(30)), f("flows/hub.mdx", 9, T(5))]),
        sess("s2", [f("flows/hub.mdx", 3, T(50))]),
        sess("s3", [f("p/z.mdx", 1, T(2)), f("p/y.mdx", 1, T(2))]),
        sess("bulk", [f("p/a.mdx", 9, T(1))], { bulk: true }),
      ],
      [hub, pg("p/a.mdx"), pg("p/y.mdx"), pg("p/z.mdx")],
    );
    expect(new Set(r.contributions.map((c) => c[0]))).toEqual(new Set(["claude-code:s1"]));
  });

  test("fork dedupe: the fork's repeated rows are not credited to it", () => {
    const row = f("p/a.mdx", 5, T(10));
    // A fork starts after its original and carries the original's rows.
    const r = run([sess("orig", [row]), sess("fork", [row, f("p/b.mdx", 4, T(3))], { first: T(9) })], [pg("p/a.mdx"), pg("p/b.mdx")]);
    expect(r.contributions.filter((c) => c[1] === "p/a.mdx").map((c) => c[0])).toEqual(["claude-code:orig"]);
    expect(r.contributions.filter((c) => c[0] === "claude-code:fork").map((c) => c[1])).toEqual(["p/b.mdx"]);
  });

  test("attachments and aliases: a contribution names the canonical owner page", () => {
    const r = run(
      [sess("a", [f("data/q.csv", 6, T(10)), f("p/old.mdx", 4, T(9))])],
      [pg("p/report.mdx", { refs: ["data/q.csv"] }), pg("p/new.mdx", { aliasPaths: ["p/old.mdx"] })],
    );
    expect(rows(r).map((c) => [c[1], c[4]]).sort()).toEqual([
      ["p/new.mdx", 4],
      ["p/report.mdx", 3],
    ]);
  });

  test("past the thread cap, candidates count every thread and contributions cover the shipped ones only", () => {
    const n = WORK_THREADS_MAX + 3;
    const sessions = Array.from({ length: n }, (_, i) => sess(`s${i}`, [f(`p/t${i}.mdx`, 3 + i, T(1 + i))]));
    const r = run(
      sessions,
      Array.from({ length: n }, (_, i) => pg(`p/t${i}.mdx`)),
    );
    expect(r.threads).toHaveLength(WORK_THREADS_MAX);
    expect(r.candidates).toBe(n);
    const shipped = new Set(r.threads.map((t) => t.key));
    expect(new Set(r.contributions.map((c) => c[2]))).toEqual(shipped);
  });
});

describe("fix round 1 batch 3 — I: a contribution names its session the way the repo does", () => {
  test("refs go through the provenance mapping, and a thread session joins its rows through workSessionRef", () => {
    const r = run(
      [
        sess("s1", [f("p/a.mdx", 5, T(30))]),
        { ...sess("o1", [f("p/a.mdx", 4, T(20))]), provider: "opencode" },
        { ...sess("x1", [f("p/a.mdx", 3, T(10))]), provider: "codex" },
      ],
      [pg("p/a.mdx")],
    );
    // `claude` is the ledger's spelling; `claude-code` is the frontmatter's, the
    // stamper's and `providerGlyph`'s. An unknown provider passes through.
    expect(new Set(r.contributions.map((c) => c[0]))).toEqual(new Set(["claude-code:s1", "opencode:o1", "codex:x1"]));
    const t = r.threads[0]!;
    expect(t.sessions.find((s) => s.id === "s1")!.provider).toBe("claude");
    expect(new Set(t.sessions.map(workSessionRef))).toEqual(new Set(r.contributions.map((c) => c[0])));
  });

  test("a provider the mapping does not name keeps its own spelling", () => {
    expect(workSessionRef({ provider: "", id: "x" })).toBe(":x");
  });
});

describe("weak links and families (plan muninn-wiki-pick-up, D1/D10)", () => {
  const threadOf = (r: ReturnType<typeof run>, id: string) => r.threads.find((t) => t.sessions.some((s) => s.id === id));
  const ids = (r: ReturnType<typeof run>, id: string) => threadOf(r, id)?.sessions.map((s) => s.id).sort();

  test("strong page + a 1-edit page the prompt names: the named page is a touch; joins only through the strong page", () => {
    const pages = [pg("plans/mdx.mdx"), pg("plans/grocery.mdx")];
    const r = run(
      [
        sess("a", [f("plans/mdx.mdx", 17, T(30)), f("plans/grocery.mdx", 1, T(30))], { names: ["grocery.mdx"] }),
        sess("b", [f("plans/grocery.mdx", 5, T(40))]),
        sess("c", [f("plans/mdx.mdx", 4, T(10))]),
      ],
      pages,
    );
    expect(r.weakLinks).toBe(1);
    expect(ids(r, "a")).toEqual(["a", "c"]);
    expect(threadOf(r, "a")!.key).toBe("plans/mdx.mdx");
    expect(threadOf(r, "a")!.touched).toEqual(["plans/grocery.mdx"]);
    expect(ids(r, "b")).toEqual(["b"]);
    expect(r.contributions.filter((c) => c[0] === "claude-code:a").map((c) => [c[1], c[3]])).toEqual(
      expect.arrayContaining([["plans/mdx.mdx", "focus"], ["plans/grocery.mdx", "touch"]]),
    );
  });

  test("strong page + a 1-edit page it created: both focus; joins through both", () => {
    const anchor = T(30);
    const r = run(
      [
        sess("a", [f("plans/main.mdx", 5, T(31)), f("plans/born.mdx", 1, anchor - 60_000)]),
        sess("b", [f("plans/born.mdx", 4, T(10))]),
        sess("c", [f("plans/main.mdx", 4, T(5))]),
      ],
      [pg("plans/main.mdx"), pg("plans/born.mdx", { gitCreatedMs: anchor })],
    );
    expect(r.weakLinks).toBe(0);
    expect(r.threads).toHaveLength(1);
    expect(ids(r, "a")).toEqual(["a", "b", "c"]);
  });

  test("two strong pages (3 + 3): joins through both", () => {
    const r = run(
      [
        sess("a", [f("p/x.mdx", 3, T(30)), f("p/y.mdx", 3, T(30))]),
        sess("b", [f("p/x.mdx", 4, T(10))]),
        sess("c", [f("p/y.mdx", 4, T(5))]),
      ],
      [pg("p/x.mdx"), pg("p/y.mdx")],
    );
    expect(r.weakLinks).toBe(0);
    expect(ids(r, "a")).toEqual(["a", "b", "c"]);
  });

  test("two weak pages, neither created: the one with more edits stays focus, the other is a touch", () => {
    // q.mdx's 1 edit plus its CSV's 1 at half weight is 1.5 — weak, but heavier than p's 1.
    const pages = [pg("p/p.mdx"), pg("p/q.mdx", { refs: ["p/q.csv"] })];
    const r = run([sess("a", [f("p/p.mdx", 1, T(30)), f("p/q.mdx", 1, T(20)), f("p/q.csv", 1, T(20))], { names: ["p.mdx", "q.mdx"] })], pages);
    expect(kinds(r, "p/q.mdx")).toEqual(["focus"]);
    expect(kinds(r, "p/p.mdx")).toEqual(["touch"]);
    expect(r.weakLinks).toBe(1);
    // Equal edits: the earliest event stays.
    const tie = run([sess("a", [f("p/p.mdx", 1, T(20)), f("p/q.mdx", 1, T(30))], { names: ["p.mdx", "q.mdx"] })], pages);
    expect(kinds(tie, "p/q.mdx")).toEqual(["focus"]);
    expect(kinds(tie, "p/p.mdx")).toEqual(["touch"]);
    // Equal edits and times: relPath decides.
    const flat = run([sess("a", [f("p/p.mdx", 1, T(20)), f("p/q.mdx", 1, T(20))], { names: ["p.mdx", "q.mdx"] })], pages);
    expect(kinds(flat, "p/p.mdx")).toEqual(["focus"]);
    expect(kinds(flat, "p/q.mdx")).toEqual(["touch"]);
  });

  test("one strong session and three sessions with the same page as a weak link: focus only in the strong thread", () => {
    const pages = [pg("p/shared.mdx"), pg("p/w1.mdx"), pg("p/w2.mdx"), pg("p/w3.mdx")];
    const weak = (id: string, own: string, h: number) => sess(id, [f(own, 6, T(h)), f("p/shared.mdx", 1, T(h))], { names: ["shared.mdx"] });
    const r = run([sess("s", [f("p/shared.mdx", 5, T(50))]), weak("w1", "p/w1.mdx", 40), weak("w2", "p/w2.mdx", 30), weak("w3", "p/w3.mdx", 20)], pages);
    expect(r.weakLinks).toBe(3);
    expect(r.threads).toHaveLength(4);
    expect(r.threads.filter((t) => t.pages.includes("p/shared.mdx")).map((t) => t.key)).toEqual(["p/shared.mdx"]);
    expect(ids(r, "s")).toEqual(["s"]);
    for (const w of ["w1", "w2", "w3"]) {
      expect(ids(r, w)).toEqual([w]);
      expect(threadOf(r, w)!.touched).toEqual(["p/shared.mdx"]);
    }
  });

  test("a hub-only session joins no thread (D16, unchanged)", () => {
    const pages = [pg("flows/hub.mdx", { backlinks: 30 }), pg("p/a.mdx")];
    const r = run([sess("h", [f("flows/hub.mdx", 5, T(30))]), sess("b", [f("flows/hub.mdx", 2, T(10)), f("p/a.mdx", 5, T(10))])], pages);
    expect(r.weakLinks).toBe(0);
    expect(ids(r, "b")).toEqual(["b"]);
    expect(ids(r, "h")).toEqual(["h"]);
  });

  test("a hub plus a 1-edit named page: the page is the only non-hub family, stays focus and joins its thread", () => {
    const pages = [pg("flows/hub.mdx", { backlinks: 30 }), pg("p/q.mdx")];
    const r = run(
      [sess("a", [f("flows/hub.mdx", 8, T(30)), f("p/q.mdx", 1, T(30))], { names: ["q.mdx"] }), sess("b", [f("p/q.mdx", 4, T(10))])],
      pages,
    );
    expect(r.weakLinks).toBe(0);
    expect(r.pages.get("p/q.mdx")!.events.map((e) => e[2])).toEqual(["focus", "focus"]);
    expect(ids(r, "a")).toEqual(["a", "b"]);
    expect(threadOf(r, "a")!.key).toBe("p/q.mdx");
  });

  test("a superseded old plan edited once beside its successor: two pages, no family", () => {
    const pages = [pg("plans/new.mdx"), pg("plans/old.mdx", { parent: "plans/new.mdx", pairedBy: "superseded" })];
    const r = run([sess("a", [f("plans/new.mdx", 5, T(30)), f("plans/old.mdx", 1, T(30))])], pages);
    expect(r.pages.get("plans/old.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([[1, "touch"]]);
    expect(r.pages.get("plans/new.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([[5, "focus"]]);
  });

  test("a plan edited once plus its same-stem .html edited once: one family with 2 edits, keyed on the plan", () => {
    const pages = [pg("plans/x.mdx"), pg("plans/x.html", { parent: "plans/x.mdx", pairedBy: "stem" }), pg("p/big.mdx")];
    const r = run(
      [
        sess("a", [f("p/big.mdx", 9, T(30)), f("plans/x.mdx", 1, T(20)), f("plans/x.html", 1, T(25))], { names: ["x.html"] }),
        sess("b", [f("plans/x.html", 4, T(10))]),
      ],
      pages,
    );
    // The child's own rows, at the family's kind in each session.
    expect(r.pages.get("plans/x.html")!.events.map((e) => [e[1], e[2]])).toEqual([
      [4, "focus"],
      [1, "focus"],
    ]);
    expect(r.pages.get("plans/x.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([
      [4, "focus"],
      [2, "focus"],
    ]);
    expect(r.weakLinks).toBe(0);
    expect(ids(r, "a")).toEqual(["a", "b"]);
    expect(r.contributions.some((c) => c[1] === "plans/x.html")).toBe(false);
    // `suffix` and `link` pairs are families too, at full weight.
    for (const pairedBy of ["suffix", "link"] as const) {
      const fam = run(
        [sess("a", [f("p/big.mdx", 9, T(30)), f("plans/x.mdx", 1, T(20)), f("plans/x-prototype.html", 1, T(25))], { names: ["x.mdx"] })],
        [pg("plans/x.mdx"), pg("plans/x-prototype.html", { parent: "plans/x.mdx", pairedBy }), pg("p/big.mdx")],
      );
      expect(fam.pages.get("plans/x.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([[2, "focus"]]);
    }
  });

  test("shipped thread keys are unique", () => {
    const pages = ["a", "b", "c", "d", "e"].map((x) => pg(`p/${x}.mdx`));
    const sessions = [
      sess("1", [f("p/a.mdx", 5, T(60)), f("p/b.mdx", 1, T(60))], { names: ["b.mdx"] }),
      sess("2", [f("p/b.mdx", 5, T(50)), f("p/c.mdx", 1, T(50))], { names: ["c.mdx"] }),
      sess("3", [f("p/c.mdx", 1, T(40)), f("p/d.mdx", 1, T(40))], { names: ["c.mdx", "d.mdx"] }),
      sess("4", [f("p/d.mdx", 5, T(30)), f("p/e.mdx", 1, T(30))], { names: ["e.mdx", "a.mdx"] }),
      sess("5", [f("p/e.mdx", 1, T(20)), f("p/a.mdx", 1, T(20))], { names: ["e.mdx", "a.mdx"] }),
    ];
    const r = run(sessions, pages);
    const keys = r.threads.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const focusIn = new Map<string, number>();
    for (const t of r.threads) for (const p of t.pages) focusIn.set(p, (focusIn.get(p) ?? 0) + 1);
    expect([...focusIn.values()].every((n) => n === 1)).toBe(true);
  });

  test("a file rolled up through a ref or folder counts 0.5 toward the 2-edit bar", () => {
    const pages = [pg("p/big.mdx"), pg("p/q.mdx", { refs: ["data/q.csv"] }), pg("p/r.mdx")];
    const one = run([sess("a", [f("p/big.mdx", 9, T(30)), f("p/q.mdx", 1, T(30)), f("data/q.csv", 1, T(30))], { names: ["q.mdx"] })], pages);
    expect(r1(one, "p/q.mdx")).toEqual([1.5, "touch"]);
    const two = run(
      [sess("a", [f("p/big.mdx", 9, T(30)), f("p/q.mdx", 1, T(30)), f("data/q.csv", 2, T(30))], { names: ["q.mdx"] })],
      pages,
    );
    expect(r1(two, "p/q.mdx")).toEqual([2, "focus"]);
    // A folder named after the page: p/r/x.json rolls into p/r.mdx.
    const folder = run([sess("a", [f("p/big.mdx", 9, T(30)), f("p/r.mdx", 1, T(30)), f("p/r/x.json", 1, T(30))], { names: ["r.mdx"] })], pages);
    expect(r1(folder, "p/r.mdx")).toEqual([1.5, "touch"]);
  });
  const r1 = (r: ReturnType<typeof run>, relPath: string) => {
    const e = r.pages.get(relPath)!.events[0]!;
    return [e[1], e[2]];
  };
});

describe("family members carry the family's classification (pick-up D1, fix round 1)", () => {
  const FAM = [
    pg("plans/x.mdx", { gitCreatedMs: AS_OF - 200 * DAY, preGitMs: AS_OF - 60 * DAY }),
    pg("plans/x.html", { gitCreatedMs: AS_OF - 200 * DAY, preGitMs: AS_OF - 70 * DAY, parent: "plans/x.mdx", pairedBy: "stem" }),
    pg("p/big.mdx", { gitCreatedMs: AS_OF - 200 * DAY, preGitMs: AS_OF - 60 * DAY }),
  ];
  const NOW = AS_OF + H;
  /** The client's view: a listing row per page, carrying the server's `work`. */
  const listing = (r: ReturnType<typeof run>, worked: Record<string, number>): WikiListing[] =>
    FAM.map((p) => ({
      relPath: p.relPath,
      name: p.relPath.split("/").pop()!.replace(/\.[^.]+$/, ""),
      title: p.relPath,
      type: p.relPath.endsWith(".html") ? "explainer" : "plan",
      addedMs: p.gitCreatedMs,
      gitCreatedMs: p.gitCreatedMs,
      updatedMs: worked[p.relPath],
      gitUpdatedMs: worked[p.relPath],
      workedMs: worked[p.relPath],
      ...(p.parent ? { parent: p.parent, pairedBy: p.pairedBy } : {}),
      ...(p.relPath === "plans/x.mdx" ? { children: ["plans/x.html"] } : {}),
      ...(r.pages.get(p.relPath) ? { work: r.pages.get(p.relPath) } : {}),
    })) as unknown as WikiListing[];
  const activity = (r: ReturnType<typeof run>, worked: Record<string, number>) =>
    rankActivity(listing(r, worked), DEFAULT_ACTIVITY_WEIGHTS, NOW, { open: true, candidates: 3, covered: 3, coverage: 1, asOfMs: AS_OF });
  const childOf = (r: ReturnType<typeof run>) => listing(r, {}).find((p) => p.relPath === "plans/x.html")!;

  test("a child written once beside a strong page is a touch: it carries a T work state and lifts neither itself nor its parent", () => {
    const r = run([sess("a", [f("p/big.mdx", 9, T(5)), f("plans/x.html", 1, T(2))])], FAM);
    expect(r.pages.get("plans/x.mdx")!.events.map((e) => e[2])).toEqual(["touch"]);
    const child = r.pages.get("plans/x.html")!;
    expect(child).toMatchObject({ state: "T", preMs: AS_OF - 70 * DAY });
    expect(child.events.map((e) => [e[1], e[2]])).toEqual([[1, "touch"]]);
    // Worked-on sorts the child at its pre-touch position, marked touched.
    expect(workedSortSignal(childOf(r), NOW).ms).toBe(AS_OF - 70 * DAY);
    expect(workedShownSignal(childOf(r), NOW).touched).toBeDefined();
    // Activity: the parent's row is not lifted through the child's write.
    const rows = activity(r, { "plans/x.mdx": AS_OF - 60 * DAY, "p/big.mdx": T(5) + 600_000, "plans/x.html": T(2) + 600_000 });
    const parent = rows.find((row) => row.page.relPath === "plans/x.mdx");
    expect(parent?.via).toBeUndefined();
    expect(parent?.score ?? 0).toBeLessThan(0.2);
  });

  test("a child written by an elsewhere session is a pass: no parent row, no newer-child dot", () => {
    const r = run([sess("e", [f("plans/x.html", 3, T(2))], { paths: ["/w/mimir/foo.md"] })], FAM);
    expect(r.pages.get("plans/x.html")!.events.map((e) => [e[1], e[2]])).toEqual([[3, "pass"]]);
    expect(workedSortSignal(childOf(r), NOW).ms).toBe(AS_OF - 70 * DAY);
    const rows = activity(r, { "plans/x.mdx": AS_OF - 60 * DAY, "p/big.mdx": T(5) + 600_000, "plans/x.html": T(2) + 600_000 });
    const parent = rows.find((row) => row.page.relPath === "plans/x.mdx");
    expect(parent?.via).toBeUndefined();
    expect(parent?.newerChildren).toBeUndefined();
  });

  test("a child in a focus family carries its own rows as focus", () => {
    const r = run([sess("a", [f("plans/x.html", 6, T(2))])], FAM);
    const child = r.pages.get("plans/x.html")!;
    expect(child).toMatchObject({ state: "F", focusMs: T(2) + 10 * 60_000 });
    expect(child.events.map((e) => [e[1], e[2]])).toEqual([[6, "focus"]]);
    expect(workedSortSignal(childOf(r), NOW).ms).toBe(T(2) + 10 * 60_000);
    // Threads and contributions still name only the parent.
    expect(r.threads.map((t) => t.key)).toEqual(["plans/x.mdx"]);
    expect(r.contributions.some((c) => c[1] === "plans/x.html")).toBe(false);
  });

  test("a session that creates only an attachment creates the family: focus, and it joins the plan's thread", () => {
    const pages = [
      pg("plans/x.mdx", { gitCreatedMs: AS_OF - 200 * DAY, preGitMs: AS_OF - 60 * DAY }),
      pg("plans/x-prototype.html", { gitCreatedMs: T(20), parent: "plans/x.mdx", pairedBy: "suffix" }),
    ];
    const sessions = [sess("a", [f("plans/x-prototype.html", 1, T(20) - 60_000)]), sess("b", [f("plans/x.mdx", 4, T(5))])];
    const r = run(sessions, pages);
    expect(r.pages.get("plans/x.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([
      [4, "focus"],
      [1, "focus"],
    ]);
    expect(r.threads.map((t) => [t.key, t.sessions.map((s) => s.id).sort()])).toEqual([["plans/x.mdx", ["a", "b"]]]);
    // An attachment with pre-window rows was not created in the window.
    const old = run(sessions, [pages[0]!, { ...pages[1]!, preGitMs: AS_OF - 30 * DAY }]);
    expect(old.pages.get("plans/x.mdx")!.events.map((e) => [e[1], e[2]])).toEqual([
      [4, "focus"],
      [1, "touch"],
    ]);
    // A later session's write is not the attachment's first, though inside the slack.
    const later = run([...sessions, sess("c", [f("plans/x-prototype.html", 1, T(20) - 30_000)])], pages);
    expect(later.pages.get("plans/x-prototype.html")!.events.map((e) => [e[1], e[2]])).toEqual([
      [1, "touch"],
      [1, "focus"],
    ]);
  });
});

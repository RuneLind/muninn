/**
 * The worked-on ledger client: the parse, the memo, the root-spelling retry and
 * the rate guard.
 *
 * Mock-free by construction — every case drives the real `refreshWorkedLedger`
 * through an injected `fetchPages`, so the validation, the memo and the degrade
 * paths are the shipped ones rather than a second implementation. That is also
 * why this file needs no `bun test` link of its own (`mock-isolation.test.ts`).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetWorkedLedgerForTest,
  defaultWorkedLedgerDeps,
  kickWorkedLedgerRefresh,
  normalizeWorkedPath,
  parseWorkedPages,
  refreshWorkedLedger,
  workedLedgerFor,
  workedLedgerDepsFromEnv,
  WORKED_EMPTY_RELEASE_MS,
  type WorkedLedgerDeps,
} from "./worked-ledger.ts";
import { __resetWorkedMatchWarnsForTest, workedMatchWarnDue } from "./store.ts";
import { __resetClaudeUsageWarnsForTest } from "../utils/claude-usage-fetch.ts";
import type { getLog } from "../logging.ts";

type Logger = ReturnType<typeof getLog>;

beforeEach(() => {
  __resetWorkedLedgerForTest();
  __resetWorkedMatchWarnsForTest();
  __resetClaudeUsageWarnsForTest();
});

/**
 * A logger that records the LEVEL each line went out at — the only observable a
 * warn-once has (`claude-usage-warn.test.ts`'s recorder). An UNCONFIGURED logger
 * is a silent no-op under `bun test`, so a degrade's warn is unassertable
 * without injecting one.
 */
function recorder(): { levels: string[]; log: Logger } {
  const levels: string[] = [];
  const log = {
    warn: () => levels.push("warn"),
    info: () => levels.push("info"),
    debug: () => levels.push("debug"),
    error: () => levels.push("error"),
    fatal: () => levels.push("fatal"),
    trace: () => levels.push("trace"),
  } as unknown as Logger;
  return { levels, log };
}

/** A deps object whose fetcher answers one body per root spelling. */
function deps(
  answers: Record<string, unknown> | ((root: string) => unknown),
  over: Partial<WorkedLedgerDeps> = {},
): WorkedLedgerDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    urlConfigured: true,
    baseUrl: "http://ledger.test:8787",
    fetchPages: async (root) => {
      asked.push(root);
      const body = typeof answers === "function" ? answers(root) : answers[root];
      if (body === undefined) return { root, pages: [] };
      if (body instanceof Error) throw body;
      return body;
    },
    ...over,
  } as WorkedLedgerDeps & { asked: string[] };
}

describe("parseWorkedPages", () => {
  test("folds the summary form into relPath → epoch ms", () => {
    const out = parseWorkedPages({
      root: "/w",
      pages: [
        { p: "plans/a.mdx", w: 1000, s: 1 },
        { p: "blogs/b.md", w: 2000, b: 9999, s: 3 },
      ],
      pageCount: 2,
      bulk: 10,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.returned).toBe(2);
    expect(out.pages.get("plans/a.mdx")).toBe(1000);
    // `b` (the bash-derived touch) rides the payload and is deliberately unread.
    expect(out.pages.get("blogs/b.md")).toBe(2000);
  });

  test("the RAW row form is rejected as no-pages-key, never read as an empty wiki", () => {
    // Byte-shape of what an un-upgraded claude-usage answers: 200, with
    // `sessions`/`rows` and no `pages` at all.
    const out = parseWorkedPages({
      root: "/w",
      sessions: [{ path: "/w/a.md", sessionId: "x" }],
      total: 1,
      rows: 1,
      limit: 2000,
      offset: 0,
    });
    expect(out).toMatchObject({ ok: false, reason: "no-pages-key" });
    if (out.ok) return;
    expect(out.detail).toContain("summary form");
  });

  test("a non-object body is a no-pages-key answer too", () => {
    expect(parseWorkedPages(null)).toMatchObject({ ok: false, reason: "no-pages-key" });
    expect(parseWorkedPages([{ p: "a.md", w: 1 }])).toMatchObject({
      ok: false,
      reason: "no-pages-key",
    });
  });

  test("ONE malformed row rejects the whole answer, naming the offender", () => {
    for (const bad of [
      { p: 5, w: 1 },
      { p: "a.md", w: "1" },
      { p: "a.md", w: 0 },
      { p: "   ", w: 1 },
      { p: "a.md" },
      "nope",
    ]) {
      const out = parseWorkedPages({ pages: [{ p: "ok.md", w: 10 }, bad] });
      expect(out).toMatchObject({ ok: false, reason: "malformed-rows" });
      if (!out.ok) expect(out.detail).toContain("pages[1]");
    }
  });

  test("two spellings of one path fold to one key, newest write wins", () => {
    const out = parseWorkedPages({
      pages: [
        { p: "Plans/A.mdx", w: 1000 },
        { p: "./plans/a.mdx", w: 3000 },
        { p: "plans/a.mdx", w: 2000 },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pages.size).toBe(1);
    expect(out.pages.get("plans/a.mdx")).toBe(3000);
    // `returned` counts ROWS, not keys: it is the match rate's denominator.
    expect(out.returned).toBe(3);
  });

  test("an empty pages array is a valid answer, not a failure", () => {
    expect(parseWorkedPages({ pages: [] })).toMatchObject({ ok: true, returned: 0 });
  });
});

describe("normalizeWorkedPath", () => {
  test("posix-separates, strips a leading ./ or /, lower-cases", () => {
    expect(normalizeWorkedPath("Plans\\A.MDX")).toBe("plans/a.mdx");
    expect(normalizeWorkedPath("./x/y.md")).toBe("x/y.md");
    expect(normalizeWorkedPath("/x/y.md")).toBe("x/y.md");
  });
});

describe("refreshWorkedLedger", () => {
  test("a good answer lands in the memo with its base URL and asked root", async () => {
    const d = deps({ "/w": { pages: [{ p: "a.md", w: 42 }] } });
    const memo = await refreshWorkedLedger("/w", d);
    expect(memo?.pages.get("a.md")).toBe(42);
    expect(memo?.returned).toBe(1);
    expect(memo?.baseUrl).toBe("http://ledger.test:8787");
    expect(memo?.rootAsked).toBe("/w");
    expect(workedLedgerFor("/w")).toBe(memo!);
  });

  test("an unconfigured URL fetches NOTHING", async () => {
    const d = deps({}, { urlConfigured: false });
    expect(await refreshWorkedLedger("/w", d)).toBeNull();
    expect(d.asked).toEqual([]);
  });

  test("a transport failure leaves the LAST GOOD memo in place", async () => {
    let fail = false;
    const d = deps((root) => (fail ? new Error("boom") : { root, pages: [{ p: "a.md", w: 7 }] }));
    await refreshWorkedLedger("/w", d);
    fail = true;
    const after = await refreshWorkedLedger("/w", d);
    // Not blanked: one failed poll must not take the axis off every page.
    expect(after?.pages.get("a.md")).toBe(7);
  });

  test("an un-upgraded upstream leaves the memo untouched too", async () => {
    const d = deps({ "/w": { root: "/w", sessions: [], total: 0, rows: 0 } });
    expect(await refreshWorkedLedger("/w", d)).toBeNull();
    expect(workedLedgerFor("/w")).toBeNull();
  });

  test("roots are independent — one wiki's failure never touches another's", async () => {
    const d = deps({
      "/a": { pages: [{ p: "x.md", w: 1 }] },
      "/b": new Error("down"),
    });
    await refreshWorkedLedger("/a", d);
    await refreshWorkedLedger("/b", d);
    expect(workedLedgerFor("/a")?.pages.size).toBe(1);
    expect(workedLedgerFor("/b")).toBeNull();
  });

  test("a second refresh during a slow one JOINS it rather than opening a second", async () => {
    let resolveFetch!: (v: unknown) => void;
    const asked: string[] = [];
    const d: WorkedLedgerDeps = {
      urlConfigured: true,
      baseUrl: "http://ledger.test:8787",
      fetchPages: (root) => {
        asked.push(root);
        return new Promise((r) => (resolveFetch = r));
      },
    };
    const first = refreshWorkedLedger("/w", d);
    const second = refreshWorkedLedger("/w", d);
    resolveFetch({ pages: [{ p: "a.md", w: 1 }] });
    expect(await first).toBe(await second);
    expect(asked).toEqual(["/w"]);
  });

  test("a ZERO-row answer retries the REALPATH, and the retry's answer wins", async () => {
    const real = await mkdtemp(path.join(tmpdir(), "worked-real-"));
    const link = path.join(path.dirname(real), `worked-link-${process.pid}`);
    await symlink(real, link);
    try {
      // `realpath` of the link, not the mkdtemp path: on macOS `/var` is itself
      // a symlink to `/private/var`, so the two differ by a second hop.
      const resolved = await realpath(link);
      const d = deps({ [link]: { pages: [] }, [resolved]: { pages: [{ p: "a.md", w: 5 }] } });
      const memo = await refreshWorkedLedger(link, d);
      expect(d.asked).toEqual([link, resolved]);
      expect(memo?.pages.get("a.md")).toBe(5);
      // The memo is keyed on the CONFIGURED root (what the store looks it up
      // with); `rootAsked` records the spelling that answered.
      expect(workedLedgerFor(link)).toBe(memo!);
      expect(memo?.rootAsked).toBe(resolved);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  test("a NON-empty answer is never retried against the realpath", async () => {
    const real = await mkdtemp(path.join(tmpdir(), "worked-real2-"));
    const link = path.join(path.dirname(real), `worked-link2-${process.pid}`);
    await symlink(real, link);
    try {
      const d = deps({ [link]: { pages: [{ p: "a.md", w: 1 }] } });
      await refreshWorkedLedger(link, d);
      expect(d.asked).toEqual([link]);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});

describe("kickWorkedLedgerRefresh", () => {
  test("returns before the fetch settles and warms the memo", async () => {
    const d = deps({ "/w": { pages: [{ p: "a.md", w: 1 }] } });
    kickWorkedLedgerRefresh("/w", { deps: d });
    expect(workedLedgerFor("/w")).toBeNull(); // not awaited
    await Promise.resolve();
    await Promise.resolve();
    expect(workedLedgerFor("/w")?.pages.size).toBe(1);
  });

  test("a memo younger than maxAgeMs is re-used; maxAgeMs 0 forces", async () => {
    const d = deps({ "/w": { pages: [{ p: "a.md", w: 1 }] } });
    await refreshWorkedLedger("/w", d);
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 60_000 });
    await Promise.resolve();
    expect(d.asked).toEqual(["/w"]);
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(d.asked).toEqual(["/w", "/w"]);
  });

  test("an unconfigured URL kicks nothing", async () => {
    const d = deps({}, { urlConfigured: false });
    kickWorkedLedgerRefresh("/w", { deps: d });
    await Promise.resolve();
    expect(d.asked).toEqual([]);
  });
});

describe("defaultWorkedLedgerDeps / workedLedgerDepsFromEnv", () => {
  test("the request is the summary form, with the wiki root encoded", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ pages: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const d = defaultWorkedLedgerDeps("http://host:1234/", true);
      expect(d.baseUrl).toBe("http://host:1234");
      await d.fetchPages("/Users/x/my wiki");
      expect(seen[0]).toBe(
        "http://host:1234/api/files?root=%2FUsers%2Fx%2Fmy%20wiki&summary=1",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a blank CLAUDE_USAGE_URL reports unconfigured; a set one reports configured", () => {
    const prev = process.env.CLAUDE_USAGE_URL;
    try {
      process.env.CLAUDE_USAGE_URL = "   ";
      expect(workedLedgerDepsFromEnv().urlConfigured).toBe(false);
      process.env.CLAUDE_USAGE_URL = "http://elsewhere:9999";
      const d = workedLedgerDepsFromEnv();
      expect(d.urlConfigured).toBe(true);
      expect(d.baseUrl).toBe("http://elsewhere:9999");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_USAGE_URL;
      else process.env.CLAUDE_USAGE_URL = prev;
    }
  });
});

describe("the match-rate guard", () => {
  test("fires below the rate, and never on an empty answer", () => {
    // Driven AT the boundary in both directions, so moving the constant is a
    // measurement rather than an edit. A fresh root each time, because the
    // predicate is THROTTLED per root (below).
    expect(workedMatchWarnDue("/r1", 4, 10)).toBe(true);
    expect(workedMatchWarnDue("/r2", 5, 10)).toBe(false);
    expect(workedMatchWarnDue("/r3", 0, 10)).toBe(true);
    // A healthy band — rows for pages since renamed or deleted.
    expect(workedMatchWarnDue("/r4", 75, 100)).toBe(false);
    // Zero rows is the ordinary state of an un-worked wiki, not a keying bug.
    expect(workedMatchWarnDue("/r5", 0, 0)).toBe(false);
  });

  test("warns ONCE per root, then stays silent until the rate recovers", () => {
    // The condition is durable and the caller is not: the index rebuilds every
    // five minutes and on every `?refresh=1`, and the un-throttled predicate
    // warned on every one of them (measured: 5 builds, 5 identical warns).
    expect(workedMatchWarnDue("/w", 1, 10)).toBe(true);
    expect(workedMatchWarnDue("/w", 1, 10)).toBe(false);
    expect(workedMatchWarnDue("/w", 0, 10)).toBe(false);
    // RECOVERY clears the root, so a second onset is reported again.
    expect(workedMatchWarnDue("/w", 9, 10)).toBe(false);
    expect(workedMatchWarnDue("/w", 1, 10)).toBe(true);
  });

  test("the throttle is PER ROOT — one wiki's warn never silences another's", () => {
    expect(workedMatchWarnDue("/a", 1, 10)).toBe(true);
    expect(workedMatchWarnDue("/b", 1, 10)).toBe(true);
  });
});

describe("a SUCCESSFUL zero-row answer never blanks a good memo", () => {
  test("the memo survives, and the empty answer is not committed", async () => {
    let empty = false;
    const d = deps((root) => (empty ? { root, pages: [] } : { root, pages: [{ p: "a.md", w: 7 }] }));
    await refreshWorkedLedger("/w", d);
    empty = true;
    const after = await refreshWorkedLedger("/w", d);
    // Proven before the fix: memo 1 → 0, the sort option hides, nothing logs.
    expect(after?.pages.get("a.md")).toBe(7);
    expect(workedLedgerFor("/w")?.pages.size).toBe(1);
  });

  test("…but a FIRST empty answer is committed — a wiki nobody has written", async () => {
    const d = deps({ "/w": { pages: [] } });
    const memo = await refreshWorkedLedger("/w", d);
    expect(memo?.pages.size).toBe(0);
    expect(memo?.returned).toBe(0);
    // Which is what lets the listing report `matched: 0` and hide the option.
    expect(workedLedgerFor("/w")).toBe(memo!);
  });

  test("a retry that THROWS keeps the memo, never falls through to the empty commit", async () => {
    const real = await mkdtemp(path.join(tmpdir(), "worked-retry-throw-"));
    const link = path.join(path.dirname(real), `worked-retry-link-${process.pid}`);
    await symlink(real, link);
    try {
      const resolved = await realpath(link);
      let good = true;
      const d = deps((root) => {
        if (root === link) return good ? { pages: [{ p: "a.md", w: 5 }] } : { pages: [] };
        // The realpath leg is the one that fails — measured end to end on a
        // symlinked root, where one ETIMEDOUT there blanked the whole axis.
        return new Error("ETIMEDOUT");
      });
      await refreshWorkedLedger(link, d);
      expect(workedLedgerFor(link)?.pages.size).toBe(1);
      good = false;
      const after = await refreshWorkedLedger(link, d);
      expect(d.asked).toEqual([link, link, resolved]);
      expect(after?.pages.get("a.md")).toBe(5);
      expect(workedLedgerFor(link)?.pages.size).toBe(1);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});

describe("the root SPELLING", () => {
  test("an unnormalized root is RESOLVED before the ask", async () => {
    // Upstream's `canonicalRoot` refuses a non-canonical root with a 400 — and a
    // 400 is not the zero-row answer the realpath retry keys on, so an
    // unnormalized `WIKI_DIR` would degrade forever with no way back.
    const d = deps({ "/w/x": { pages: [{ p: "a.md", w: 1 }] } });
    const memo = await refreshWorkedLedger("/w/y/../x", d);
    expect(d.asked).toEqual(["/w/x"]);
    expect(memo?.rootAsked).toBe("/w/x");
    // The memo is keyed on the CONFIGURED spelling, which is what the store
    // looks it up with.
    expect(workedLedgerFor("/w/y/../x")).toBe(memo!);
  });

  test("the spelling that ANSWERED is asked FIRST on the next refresh", async () => {
    const real = await mkdtemp(path.join(tmpdir(), "worked-hint-"));
    const link = path.join(path.dirname(real), `worked-hint-link-${process.pid}`);
    await symlink(real, link);
    try {
      const resolved = await realpath(link);
      const d = deps({ [link]: { pages: [] }, [resolved]: { pages: [{ p: "a.md", w: 5 }] } });
      await refreshWorkedLedger(link, d);
      expect(d.asked).toEqual([link, resolved]);
      // Second refresh: one fetch, no `realpath`, the winning spelling first.
      await refreshWorkedLedger(link, d);
      expect(d.asked).toEqual([link, resolved, resolved]);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});

describe("a CLIPPED answer", () => {
  test("`truncated` rides the memo, and an absent field is not a clip", async () => {
    const d = deps({
      "/w": { pages: [{ p: "a.md", w: 1 }], truncated: true, limit: 5000 },
      "/q": { pages: [{ p: "a.md", w: 1 }] },
    });
    expect((await refreshWorkedLedger("/w", d))?.truncated).toBe(true);
    expect((await refreshWorkedLedger("/q", d))?.truncated).toBe(false);
  });

  test("the parse reads upstream's own limit, so the warn can name it", () => {
    const out = parseWorkedPages({ pages: [], truncated: true, limit: 5000 });
    expect(out).toMatchObject({ ok: true, truncated: true, limit: 5000 });
    // A non-numeric limit is simply not reported rather than echoed raw.
    expect(parseWorkedPages({ pages: [], limit: "lots" })).not.toHaveProperty("limit");
  });
});

describe("a NON-OBJECT throw", () => {
  test("is classified without touching `.status`, so the refresh still resolves", async () => {
    // `(err as {status?: unknown}).status` THROWS a TypeError inside the catch
    // for a thrown string or null, which rejected `refreshWorkedLedger` and
    // contradicted its "never throws" contract.
    for (const thrown of ["boom", null, 42]) {
      __resetWorkedLedgerForTest();
      const d: WorkedLedgerDeps = {
        urlConfigured: true,
        baseUrl: "http://ledger.test:8787",
        fetchPages: () => Promise.reject(thrown),
      };
      expect(await refreshWorkedLedger("/w", d)).toBeNull();
    }
  });

  test("a typed HTTP status is still read off the error", async () => {
    const d = deps({ "/w": Object.assign(new Error("nope"), { status: 503 }) });
    expect(await refreshWorkedLedger("/w", d)).toBeNull();
    expect(workedLedgerFor("/w")).toBeNull();
  });
});

describe("the degraded-upstream back-off", () => {
  test("a FAILED attempt is not repeated inside the caller's TTL", async () => {
    const d = deps({ "/w": new Error("down") });
    // AWAITED, so the failure is recorded and the in-flight entry is gone —
    // otherwise the second kick would join the first and pass on that alone.
    await refreshWorkedLedger("/w", d);
    expect(d.asked).toEqual(["/w"]);
    // The un-upgraded raw row form is ~800 KB and was re-fetched once per index
    // build, forever. The second kick inside the window asks nothing.
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 60_000 });
    await Promise.resolve();
    expect(d.asked).toEqual(["/w"]);
    // …while a FORCED kick (`?refresh=1`) still retries at once.
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(d.asked).toEqual(["/w", "/w"]);
  });

  test("one success clears it", async () => {
    let fail = true;
    const d = deps((root) => (fail ? new Error("down") : { root, pages: [{ p: "a.md", w: 1 }] }));
    await refreshWorkedLedger("/w", d);
    fail = false;
    await refreshWorkedLedger("/w", d);
    expect(d.asked.length).toBe(2);
    // The memo is fresh now, so the next TTL-bounded kick skips on ITS age
    // rather than on a failure that no longer stands.
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 60_000 });
    await Promise.resolve();
    expect(d.asked.length).toBe(2);
  });
});

describe("the index fold", () => {
  test("stamps workedMs on matching pages and reports coverage", async () => {
    const { buildWikiIndex } = await import("./store.ts");
    const root = await mkdtemp(path.join(tmpdir(), "worked-index-"));
    try {
      await mkdir(path.join(root, "plans"), { recursive: true });
      await writeFile(path.join(root, "plans", "one.mdx"), "---\ntitle: One\n---\n\nbody\n");
      await writeFile(path.join(root, "two.md"), "---\ntitle: Two\n---\n\nbody\n");
      await refreshWorkedLedger(
        root,
        deps({
          [root]: {
            pages: [
              { p: "plans/one.mdx", w: 1_700_000_000_000 },
              // A row for a page that has since been deleted — the ordinary
              // reason a healthy refresh does not match 100%.
              { p: "gone.md", w: 1_600_000_000_000 },
            ],
          },
        }),
      );
      const index = await buildWikiIndex(root);
      const one = index.pages.find((p) => p.relPath === "plans/one.mdx");
      const two = index.pages.find((p) => p.relPath === "two.md");
      expect(one?.workedMs).toBe(1_700_000_000_000);
      expect(two?.workedMs).toBeUndefined();
      expect(index.workedCoverage).toEqual({ matched: 1, total: 2, returned: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the coverage DENOMINATOR is the listing, not the pre-drop page set", async () => {
    const { buildWikiIndex } = await import("./store.ts");
    const root = await mkdtemp(path.join(tmpdir(), "worked-index-drop-"));
    try {
      await mkdir(path.join(root, "a"), { recursive: true });
      await mkdir(path.join(root, "b"), { recursive: true });
      await writeFile(path.join(root, "a", "x.md"), "---\ntitle: X\n---\n\nbody\n");
      // A same-stem `.html` in ANOTHER folder: a real collision, dropped from
      // the index — so it must not be in the denominator either. Measured on
      // mimir, counting it read `total: 550` against a 549-row listing.
      await writeFile(path.join(root, "b", "x.html"), "<title>X</title><p>body</p>");
      await refreshWorkedLedger(root, deps({ [root]: { pages: [{ p: "a/x.md", w: 1_700_000_000_000 }] } }));
      const index = await buildWikiIndex(root);
      expect(index.workedCoverage).toEqual({ matched: 1, total: index.pages.length, returned: 1 });
      expect(index.shadowed?.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no memo ⇒ NO coverage field at all — absent is not `matched: 0`", async () => {
    const { buildWikiIndex } = await import("./store.ts");
    const root = await mkdtemp(path.join(tmpdir(), "worked-index-cold-"));
    try {
      await writeFile(path.join(root, "a.md"), "---\ntitle: A\n---\n\nbody\n");
      const index = await buildWikiIndex(root);
      expect(index.workedCoverage).toBeUndefined();
      expect(index.pages[0]!.workedMs).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── Fix round 2 ─────────────────────────────────────────────────────────────

describe("the empty-answer RELEASE window", () => {
  /** A clock the test moves by hand — the window is an hour, and no suite waits
   *  one. `deps.now` is the module's only clock read. */
  function clocked(answers: (root: string) => unknown) {
    let at = Date.parse("2026-09-22T09:00:00Z");
    const d = deps(answers, { now: () => at });
    return { d, advance: (ms: number) => (at += ms), at: () => at };
  }

  test("an empty answer KEEPS the pages and still advances fetchedAt", async () => {
    // Both halves matter. Keeping the pages is the rule this module shipped
    // with; advancing `fetchedAt` is the fix — without it the memo stayed
    // permanently stale to the TTL gate and the root was re-asked on EVERY
    // index build, i.e. the back-off defeated through the empty path.
    let empty = false;
    const { d, advance } = clocked((root) =>
      empty ? { root, pages: [] } : { root, pages: [{ p: "a.md", w: 7 }] },
    );
    const first = await refreshWorkedLedger("/w", d);
    const firstFetched = first!.fetchedAt;
    empty = true;
    advance(60_000);
    const after = await refreshWorkedLedger("/w", d);
    expect(after?.pages.get("a.md")).toBe(7);
    expect(after!.fetchedAt).toBeGreaterThan(firstFetched);
    // …and the TTL gate now HOLDS, so the next build asks nothing.
    const asked = d.asked.length;
    kickWorkedLedgerRefresh("/w", { deps: d, maxAgeMs: 5 * 60_000 });
    await Promise.resolve();
    expect(d.asked.length).toBe(asked);
  });

  test("an empty answer AFTER the window is believed — the memo is cleared", async () => {
    let empty = false;
    const { d, advance } = clocked((root) =>
      empty ? { root, pages: [] } : { root, pages: [{ p: "a.md", w: 7 }] },
    );
    await refreshWorkedLedger("/w", d);
    empty = true;
    // Still inside the window: held.
    advance(WORKED_EMPTY_RELEASE_MS - 1);
    expect((await refreshWorkedLedger("/w", d))?.pages.size).toBe(1);
    // Past it: a wiki that really went N → 0 (every session discounted, the root
    // renamed upstream) stops showing dates for writes nobody claims.
    advance(2);
    const released = await refreshWorkedLedger("/w", d);
    expect(released?.pages.size).toBe(0);
    expect(workedLedgerFor("/w")?.pages.size).toBe(0);
    expect(workedLedgerFor("/w")?.returned).toBe(0);
  });

  test("a NON-empty answer in between resets the window", async () => {
    let empty = true;
    const { d, advance } = clocked((root) =>
      empty ? { root, pages: [] } : { root, pages: [{ p: "a.md", w: 7 }] },
    );
    empty = false;
    await refreshWorkedLedger("/w", d);
    empty = true;
    advance(WORKED_EMPTY_RELEASE_MS - 60_000);
    expect((await refreshWorkedLedger("/w", d))?.pages.size).toBe(1);
    // The service comes back…
    empty = false;
    advance(60_000);
    expect((await refreshWorkedLedger("/w", d))?.pages.size).toBe(1);
    // …so the clock the release is measured against starts again: an empty
    // answer just past the ORIGINAL deadline is held, not believed.
    empty = true;
    advance(120_000);
    expect((await refreshWorkedLedger("/w", d))?.pages.size).toBe(1);
    advance(WORKED_EMPTY_RELEASE_MS);
    expect((await refreshWorkedLedger("/w", d))?.pages.size).toBe(0);
  });
});

describe("the degrade warns", () => {
  test("two ROOTS failing the same way both reach warn", async () => {
    // The warn-once key carries the root: one process reads several wikis off
    // one claude-usage, and without it the second root's failure dropped
    // straight to `info` — the axis dark on a whole wiki with nothing at warn
    // level naming it.
    const rec = recorder();
    const d = deps(() => new Error("down"), { log: rec.log });
    await refreshWorkedLedger("/a", d);
    await refreshWorkedLedger("/b", d);
    expect(rec.levels).toEqual(["warn", "warn"]);
    // …and the SAME root failing twice is still one warn.
    await refreshWorkedLedger("/a", d);
    expect(rec.levels).toEqual(["warn", "warn", "info"]);
  });

  test("a CLIPPED answer warns, naming upstream's own limit", async () => {
    // The clip drops the OLDEST-worked pages while every row that did arrive
    // still matches, so the store's match-rate guard cannot see it: this warn is
    // the only signal the axis silently shortened.
    const rec = recorder();
    const d = deps(
      {
        "/w": { pages: [{ p: "a.md", w: 1 }], truncated: true, limit: 5000 },
        "/q": { pages: [{ p: "a.md", w: 1 }] },
      },
      { log: rec.log },
    );
    await refreshWorkedLedger("/w", d);
    expect(rec.levels).toEqual(["warn"]);
    // An answer that was NOT clipped warns about nothing.
    await refreshWorkedLedger("/q", d);
    expect(rec.levels).toEqual(["warn"]);
  });

  test("the RELEASE is announced too, and it is not the same warn as the hold", async () => {
    const rec = recorder();
    let empty = false;
    let at = Date.parse("2026-09-22T09:00:00Z");
    const d = deps((root) => (empty ? { root, pages: [] } : { root, pages: [{ p: "a.md", w: 7 }] }), {
      log: rec.log,
      now: () => at,
    });
    await refreshWorkedLedger("/w", d);
    empty = true;
    at += 60_000;
    await refreshWorkedLedger("/w", d);
    at += WORKED_EMPTY_RELEASE_MS;
    await refreshWorkedLedger("/w", d);
    // Two DISTINCT reasons ⇒ two first sightings; one shared key would have
    // reported the drop at `info`, under a line saying the memo was kept.
    expect(rec.levels).toEqual(["warn", "warn"]);
  });
});

describe("the ?refresh=1 escape hatch", () => {
  /** Poll until `ok()` or the budget runs out — the kick is fire-and-forget, so
   *  there is nothing to await. */
  async function until(ok: () => boolean, budgetMs = 2000): Promise<void> {
    const stop = Date.now() + budgetMs;
    while (!ok() && Date.now() < stop) await Bun.sleep(10);
  }

  test("a FORCED index build re-asks a failed upstream; a TTL rebuild does not", async () => {
    // Driven through the REAL env deps and a real socket, because the wiring is
    // the whole finding: the module documents a forced kick as the way past the
    // back-off, and `buildWikiIndex` sent the index TTL on every build, so the
    // hatch did not exist.
    const { buildWikiIndex, getWikiIndex } = await import("./store.ts");
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    const prev = process.env.CLAUDE_USAGE_URL;
    const root = await mkdtemp(path.join(tmpdir(), "worked-forced-"));
    try {
      process.env.CLAUDE_USAGE_URL = `http://127.0.0.1:${server.port}`;
      await writeFile(path.join(root, "a.md"), "---\ntitle: A\n---\n\nbody\n");

      await buildWikiIndex(root);
      await until(() => hits >= 1);
      expect(hits).toBe(1);

      // Inside the TTL, with the failure backed off: asks nothing.
      await buildWikiIndex(root);
      await Bun.sleep(50);
      expect(hits).toBe(1);

      // `?refresh=1` — the operator saying "ask again now".
      await buildWikiIndex(root, { forced: true });
      await until(() => hits >= 2);
      expect(hits).toBe(2);

      // A programmatic `refresh: true` — what every page write passes after it
      // lands — is NOT the hatch: it busts the index TTL and leaves the ledger's
      // back-off in force, or a gardener drain would re-ask upstream per page.
      await getWikiIndex({ root, refresh: true });
      await Bun.sleep(50);
      expect(hits).toBe(2);

      // …the operator's `?refresh=1` is, through the caller the route uses.
      await getWikiIndex({ root, refresh: true, forceLedger: true });
      await until(() => hits >= 3);
      expect(hits).toBe(3);
    } finally {
      server.stop(true);
      if (prev === undefined) delete process.env.CLAUDE_USAGE_URL;
      else process.env.CLAUDE_USAGE_URL = prev;
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
  type WorkedLedgerDeps,
} from "./worked-ledger.ts";
import { WORKED_MATCH_WARN_RATE, workedMatchRateLow } from "./store.ts";

beforeEach(() => __resetWorkedLedgerForTest());

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
    expect(WORKED_MATCH_WARN_RATE).toBe(0.5);
    // Driven AT the boundary in both directions, so moving the constant is a
    // measurement rather than an edit.
    expect(workedMatchRateLow(4, 10)).toBe(true);
    expect(workedMatchRateLow(5, 10)).toBe(false);
    expect(workedMatchRateLow(0, 10)).toBe(true);
    // The healthy band (75–90% on mimir: rows for renamed/deleted pages).
    expect(workedMatchRateLow(75, 100)).toBe(false);
    // Zero rows is the ordinary state of an un-worked wiki, not a keying bug.
    expect(workedMatchRateLow(0, 0)).toBe(false);
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

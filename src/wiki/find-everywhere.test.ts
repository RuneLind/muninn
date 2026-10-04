/**
 * Find everywhere — the three legs, the session join, fusion with heads
 * first, the bounds and every way a leg degrades. Driven against REAL
 * `buildWikiIndex` output over temp wikis (the session join reads what the
 * index parses out of `sessions:` frontmatter, the pool rule what the store
 * pairs), with huginn and claude-usage as injected fakes — and, for the fetch
 * seam's error labels, against real local HTTP servers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { buildWikiIndex, type WikiIndex } from "./store.ts";
import {
  FIND_EVERYWHERE_LIMIT_DEFAULT,
  FIND_EVERYWHERE_LIMIT_MAX,
  LegFetchError,
  QUERY_MAX_CHARS,
  QUERY_MAX_WORDS,
  SESSIONS_HEAD_TOP,
  SNIPPET_MAX,
  capFindEverywhereQuery,
  findEverywhere,
  fuseLegs,
  markedSnippet,
  parseFindEverywhereLimit,
  plainSnippet,
  sessionPages,
  type FindEverywhereDeps,
  type FindEverywhereWiki,
} from "./find-everywhere.ts";
import {
  __setFindEverywhereDepsForTest,
  fetchLegJson,
  findSelfWikiName,
  registerWikiFindEverywhereRoute,
} from "../dashboard/routes/wiki-find-everywhere.ts";
import { createOriginMiddleware } from "../auth/origin.ts";
import type { Config } from "../config.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function page(title: string, fm: string[] = [], body = "x"): string {
  return ["---", `title: ${title}`, ...fm, "---", "", body, ""].join("\n");
}

const dirs: string[] = [];
afterEach(async () => {
  __setFindEverywhereDepsForTest();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function wiki(pages: Record<string, string>): Promise<{ root: string; index: WikiIndex }> {
  const root = await mkdtemp(path.join(tmpdir(), "find-everywhere-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  return { root, index: await buildWikiIndex(root) };
}

interface Fakes {
  huginn?: unknown | Error;
  /** `null` ⇒ no CLAUDE_USAGE_URL. */
  sessions?: unknown | Error | null;
  titles?: unknown | Error;
}

/** Deps over built wikis; each fake answers a fixed body or throws. */
function deps(
  wikis: Array<FindEverywhereWiki & { index: WikiIndex }>,
  fakes: Fakes,
  calls: string[] = [],
): FindEverywhereDeps {
  const answer = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    wikis: () => wikis,
    index: async (root) => wikis.find((w) => w.root === root)?.index ?? null,
    huginn: async (p) => {
      calls.push(`huginn ${p}`);
      return answer(fakes.huginn ?? { results: [] });
    },
    claudeUsage:
      fakes.sessions === null
        ? null
        : async (p) => {
            calls.push(`usage ${p}`);
            if (p.startsWith("/api/sessions-by-id")) return answer(fakes.titles ?? { sessions: [] });
            return answer(fakes.sessions ?? { sessions: [] });
          },
    now: () => Date.parse("2026-10-04T12:00:00Z"),
  };
}

/** A promise that settles only when `signal` aborts — a hung upstream. */
const hang = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

const keyOf = (r: { wiki: string; relPath: string }) => `${r.wiki}:${r.relPath}`;

describe("fuseLegs — reciprocal rank fusion, heads first", () => {
  test("a leg's head leads even when another page is #2 in two legs", () => {
    // Plain RRF: M scores 2/61 ≈ 0.0328, H scores 1/60 ≈ 0.0167 — M wins.
    const fused = fuseLegs([
      { keys: ["T", "M"], heads: ["T"] },
      { keys: ["H", "M"], heads: ["H"] },
      { keys: ["S", "M"], heads: ["S"] },
    ]);
    const order = fused.map((f) => f.key);
    expect(order.slice(0, 3).sort()).toEqual(["H", "S", "T"]);
    expect(order[3]).toBe("M");
    expect(fused.find((f) => f.key === "M")!.head).toBe(false);
  });

  test("heads keep fused order among themselves", () => {
    const fused = fuseLegs([
      { keys: ["A", "B"], heads: ["A"] },
      { keys: ["B", "A"], heads: ["B"] },
      { keys: ["C"], heads: ["C"] },
    ]);
    // A: 1/60 + 1/61, B: 1/61 + 1/60 — tie, broken on the key.
    expect(fused.map((f) => f.key)).toEqual(["A", "B", "C"]);
  });

  test("a leg that names no head votes but promotes nothing", () => {
    const fused = fuseLegs([{ keys: ["P", "M"], heads: [] }, { keys: ["H", "M"], heads: ["H"] }]);
    expect(fused.map((f) => [f.key, f.head])).toEqual([
      ["H", true],
      ["M", false],
      ["P", false],
    ]);
  });
});

describe("the query", () => {
  test("capFindEverywhereQuery keeps `#12` for the text leg and sends the digits to the remote legs", () => {
    expect(capFindEverywhereQuery("#12 review type:plan #tag")).toEqual({ text: "#12 review", remote: "12 review", truncated: false });
  });

  test("the cap counts code points and free words; longer input is truncated and says so", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const w = capFindEverywhereQuery(words);
    expect(w.truncated).toBe(true);
    expect(w.remote.split(" ")).toHaveLength(QUERY_MAX_WORDS);
    // 200 emoji are 400 UTF-16 units and exactly at the cap: not truncated.
    expect(capFindEverywhereQuery("😀".repeat(QUERY_MAX_CHARS)).truncated).toBe(false);
    const over = capFindEverywhereQuery("😀".repeat(QUERY_MAX_CHARS + 1));
    expect(over.truncated).toBe(true);
    expect(Array.from(over.text)).toHaveLength(QUERY_MAX_CHARS);
  });

  test("a 20,000-character query is cut before any leg runs, and the text leg stays fast", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    const r = await findEverywhere("palette ".repeat(2500), 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    expect(r.sources.query.truncated).toBe(true);
    expect(Array.from(r.q).length).toBeLessThanOrEqual(QUERY_MAX_CHARS);
    expect(r.sources.text.ms).toBeLessThan(50);
    const sent = new URL(`http://x${calls.find((c) => c.startsWith("huginn"))!.slice(7)}`).searchParams.get("q")!;
    expect(sent.split(" ").length).toBeLessThanOrEqual(QUERY_MAX_WORDS);
  });

  test("the two-character minimum counts code points", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    // One emoji is two UTF-16 units but one code point: under the minimum.
    for (const q of ["", " ", "p", "😀", "type:plan", "#tag"]) {
      const r = await findEverywhere(q, 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
      expect(r.results).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  test("`#12` reaches the remote legs as `12` and stays a hard number in the text leg", async () => {
    const a = await wiki({
      "a.md": page("Round 12 review"),
      "b.md": page("Review notes"),
    });
    const calls: string[] = [];
    const r = await findEverywhere("#12 review", 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    expect(calls.find((c) => c.startsWith("huginn"))).toContain("q=12+review&");
    expect(decodeURIComponent(calls.find((c) => c.startsWith("usage"))!)).toContain("q=12 review&");
    expect(r.results.map((x) => [x.relPath, x.legs.text?.rank])).toEqual([["a.md", 1]]);
  });

  test("filter tokens never reach the remote legs", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    await findEverywhere('find type:plan in:"two words" #tag palette', 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    expect(decodeURIComponent(calls.find((c) => c.startsWith("usage /api/search"))!)).toContain("q=find palette&");
    expect(calls.find((c) => c.startsWith("huginn"))).toContain("q=find+palette&");
  });
});

describe("findEverywhere — legs and the join", () => {
  test("joins a claude-usage session onto the page whose sessions: names it, provider prefix or not", async () => {
    const a = await wiki({
      "plans/shared.mdx": page("Shared bucket rollout", [`sessions: [claude-code:${S1}]`]),
      "plans/other.mdx": page("Other plan", [`sessions: [${S3}]`]),
    });
    const b = await wiki({ "notes/twin.md": page("Twin note", [`sessions: [${S1}, ${S2}]`]) });
    const wikis = [
      { name: "alpha", root: a.root, index: a.index },
      { name: "beta", root: b.root, index: b.index },
    ];
    const r = await findEverywhere(
      "felles kode",
      20,
      deps(wikis, {
        sessions: {
          sessions: [
            { sessionId: S2, snippet: "the \u0002felles\u0003 bucket" },
            { sessionId: S1, snippet: "\u0002felles\u0003 \u0002kode\u0003-wiki" },
          ],
        },
        titles: { sessions: [{ sessionId: S1, title: "Find the felles page" }] },
      }),
    );
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.sources.huginn).toMatchObject({ status: "unconfigured", error: "no wiki collections" });
    const shared = r.results.find((x) => keyOf(x) === "alpha:plans/shared.mdx")!;
    expect(shared.legs.sessions).toEqual([
      { id: S1, rank: 2, title: "Find the felles page", snippet: { text: "felles kode-wiki", marks: [[0, 6], [7, 11]] } },
    ]);
    expect(shared.legs.text).toBeUndefined();
    const twin = r.results.find((x) => keyOf(x) === "beta:notes/twin.md")!;
    expect(twin.legs.sessions!.map((s) => s.id)).toEqual([S2, S1]);
    expect(twin.head).toBe(true);
    expect(r.results.findIndex((x) => x === twin)).toBeLessThan(r.results.findIndex((x) => x === shared));
    expect(r.results.some((x) => x.relPath === "plans/other.mdx")).toBe(false);
  });

  test("a provider-prefixed id in claude-usage's answer joins like a bare one", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "palette",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions: [{ sessionId: `claude-code:${S1}`, snippet: "" }] } }),
    );
    expect(r.results.map((x) => x.legs.sessions?.[0]?.id)).toEqual([S1]);
  });

  test("huginn hits map through the wiki that owns the collection; unresolvable hits are dropped", async () => {
    const a = await wiki({ "plans/gate.mdx": page("Konsoll gate-kjøringer"), "plans/two.mdx": page("Two") });
    const calls: string[] = [];
    const r = await findEverywhere(
      "which gate runs",
      20,
      deps(
        [{ name: "kode", root: a.root, index: a.index, collections: ["kode-coll"] }],
        {
          sessions: null,
          huginn: {
            results: [
              { collection: "kode-coll", id: "plans/missing.mdx", snippet: "gone" },
              { collection: "unowned", id: "plans/gate.mdx", snippet: "wrong collection" },
              { collection: "kode-coll", id: "plans/gate.mdx", snippet: "  gate\n runs  " },
              { collection: "kode-coll", id: "plans/gate.mdx", snippet: "second chunk" },
              { collection: "kode-coll", id: "plans/two.mdx", snippet: "two" },
              { id: "no-collection" },
            ],
          },
        },
        calls,
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("brief=true");
    expect(calls[0]).toContain("collection=kode-coll");
    expect(calls[0]).toContain("limit=15");
    const gate = r.results.find((x) => x.relPath === "plans/gate.mdx")!;
    expect(gate.legs.huginn).toEqual({ rank: 1, snippet: "gate runs" });
    expect(gate.head).toBe(true);
    expect(r.results.find((x) => x.relPath === "plans/two.mdx")!.legs.huginn!.rank).toBe(2);
    expect(r.results.some((x) => x.relPath === "plans/missing.mdx")).toBe(false);
  });

  test("a wiki that resolves the hit decides it: a hidden page is dropped, never found in the next wiki", async () => {
    const a = await wiki({ "plans/x.mdx": page("Gate old", ["signal: none"]) });
    const b = await wiki({ "plans/x.mdx": page("Gate live twin") });
    const r = await findEverywhere(
      "zzqq",
      20,
      deps(
        [
          { name: "first", root: a.root, index: a.index, collections: ["c"] },
          { name: "second", root: b.root, index: b.index, collections: ["c"] },
        ],
        { sessions: null, huginn: { results: [{ collection: "c", id: "plans/x.mdx" }] } },
      ),
    );
    expect(r.results).toEqual([]);
  });

  test("the remote legs drop what the palette's pool drops: retired, bookkeeping and attachment children", async () => {
    const a = await wiki({
      "plans/live.mdx": page("Gate live", [`sessions: [${S1}]`]),
      "plans/old.mdx": page("Gate old", [`sessions: [${S1}]`, "signal: none"]),
      "log.md": page("Gate log", [`sessions: [${S1}]`]),
      "plans/live-prototype.html": "<html><head><title>Gate prototype</title></head><body>x</body></html>",
    });
    expect(a.index.pages.find((p) => p.relPath === "plans/live-prototype.html")?.pairedBy).toBe("suffix");
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        huginn: {
          results: [
            { collection: "c", id: "plans/live-prototype.html" },
            { collection: "c", id: "plans/old.mdx" },
            { collection: "c", id: "log.md" },
          ],
        },
        sessions: { sessions: [{ sessionId: S1, snippet: "gate" }] },
      }),
    );
    expect(r.results.map((x) => x.relPath)).toEqual(["plans/live.mdx"]);
  });

  test("an unconfigured claude-usage is reported and never called; no collections means no huginn call", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    const r = await findEverywhere("palette", 20, deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }, calls));
    expect(r.sources.huginn).toMatchObject({ status: "unconfigured", error: "no wiki collections" });
    expect(r.sources.sessions).toMatchObject({ status: "unconfigured", error: "CLAUDE_USAGE_URL unset" });
    expect(calls).toEqual([]);
    expect(r.results.map((x) => x.relPath)).toEqual(["p.md"]);
  });

  test("limit caps the results", async () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 8; i++) pages[`p${i}.md`] = page(`Palette ${i}`);
    const a = await wiki(pages);
    const r = await findEverywhere("palette", 3, deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }));
    expect(r.results).toHaveLength(3);
  });
});

describe("findEverywhere — heads", () => {
  test("a partial-band text #1 is no head", async () => {
    const a = await wiki({
      "plans/partial.mdx": page("Which count note"),
      "plans/target.mdx": page("Konsoll kjøringer"),
    });
    const r = await findEverywhere(
      "which gate runs count",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        sessions: null,
        huginn: { results: [{ collection: "c", id: "plans/target.mdx" }] },
      }),
    );
    const partial = r.results.find((x) => x.relPath === "plans/partial.mdx")!;
    expect(partial.legs.text?.rank).toBe(1);
    expect(partial.head).toBe(false);
    expect(r.results[0]!.relPath).toBe("plans/target.mdx");
  });

  test("a sessions-leg #1 is a head only when its session is in claude-usage's top 5", async () => {
    const a = await wiki({ "far.md": page("Far", [`sessions: [${sid(SESSIONS_HEAD_TOP + 1)}]`]) });
    const unmatched = Array.from({ length: SESSIONS_HEAD_TOP }, (_, i) => ({ sessionId: sid(i + 1), snippet: "" }));
    const run = (sessions: unknown[]) =>
      findEverywhere("zzqq", 20, deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions } }));
    const sixth = await run([...unmatched, { sessionId: sid(SESSIONS_HEAD_TOP + 1), snippet: "" }]);
    expect(sixth.results.map((x) => [x.relPath, x.head, x.legs.sessions![0]!.rank])).toEqual([["far.md", false, 6]]);
    const fifth = await run([...unmatched.slice(1), { sessionId: sid(SESSIONS_HEAD_TOP + 1), snippet: "" }]);
    expect(fifth.results.map((x) => [x.relPath, x.head])).toEqual([["far.md", true]]);
  });

  test("pages tied with a head on that leg's score are heads too", async () => {
    const a = await wiki({
      "b-text.md": page("Zeta gate"),
      "a-text.md": page("Zeta gate"),
      "c-session.md": page("One", [`sessions: [${S1}]`]),
      "d-session.md": page("Two", [`sessions: [${S1}]`]),
      "e-hug.md": page("Hug one"),
      "f-hug.md": page("Hug two"),
    });
    const r = await findEverywhere(
      "zeta gate",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        huginn: {
          results: [
            { collection: "c", id: "e-hug.md", relevance: 0.7 },
            { collection: "c", id: "f-hug.md", relevance: 0.7 },
          ],
        },
        sessions: { sessions: [{ sessionId: S1, snippet: "" }] },
      }),
    );
    const heads = r.results.filter((x) => x.head).map((x) => x.relPath).sort();
    expect(heads).toEqual(["a-text.md", "b-text.md", "c-session.md", "d-session.md", "e-hug.md", "f-hug.md"]);
  });

  test("an untied huginn #2 is no head", async () => {
    const a = await wiki({ "e.md": page("E"), "f.md": page("F") });
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        sessions: null,
        huginn: { results: [{ collection: "c", id: "e.md", relevance: 0.8 }, { collection: "c", id: "f.md", relevance: 0.7 }] },
      }),
    );
    expect(r.results.map((x) => [x.relPath, x.head])).toEqual([["e.md", true], ["f.md", false]]);
  });
});

describe("findEverywhere — bounds and degrade", () => {
  test("indexes load under their own bound; a late or failing wiki is skipped and named, and no leg's ms counts the wait", async () => {
    const a = await wiki({ "plans/palette.mdx": page("Find palette") });
    const base = deps([{ name: "ok", root: a.root, index: a.index, collections: ["c"] }], {
      huginn: { results: [{ collection: "c", id: "plans/palette.mdx" }] },
      sessions: { sessions: [] },
    });
    const r = await findEverywhere("find palette", 20, {
      ...base,
      wikis: () => [
        { name: "ok", root: a.root, collections: ["c"] },
        { name: "slow", root: "/slow" },
        { name: "broken", root: "/broken" },
      ],
      index: async (root) => {
        if (root === "/slow") return new Promise(() => {});
        if (root === "/broken") throw new Error("ENOENT");
        await new Promise((res) => setTimeout(res, 120));
        return a.index;
      },
      indexTimeoutMs: 250,
    });
    expect(r.sources.indexes.skipped).toEqual([
      { wiki: "slow", error: "timeout" },
      { wiki: "broken", error: "failed" },
    ]);
    expect(r.sources.indexes.ms).toBeGreaterThanOrEqual(240);
    expect(r.sources.huginn.status).toBe("ok");
    expect(r.sources.huginn.ms).toBeLessThan(100);
    expect(r.sources.sessions.ms).toBeLessThan(100);
    expect(r.results.map((x) => x.relPath)).toEqual(["plans/palette.mdx"]);
  });

  test("a hung huginn is cut at its budget even when the seam ignores its signal", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const t0 = performance.now();
    const r = await findEverywhere("palette", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], { sessions: null }),
      huginn: () => new Promise(() => {}),
      huginnTimeoutMs: 80,
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.sources.huginn).toMatchObject({ status: "error", error: "timeout" });
    expect(r.results.map((x) => x.relPath)).toEqual(["p.md"]);
  });

  test("the titles call has its own small budget and never costs the search", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere("zzqq", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index }], {}),
      claudeUsage: async (p, signal) => {
        if (p.startsWith("/api/sessions-by-id")) return hang(signal);
        return { sessions: [{ sessionId: S1, snippet: "" }] };
      },
      sessionsTimeoutMs: 2000,
      titlesTimeoutMs: 60,
    });
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.sources.sessions.ms).toBeLessThan(500);
    expect(r.results[0]!.legs.sessions![0]!.title).toBeUndefined();
  });

  test("the caller's abort reaches every leg's signal and is reported as aborted", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const ctrl = new AbortController();
    const seen: AbortSignal[] = [];
    const pending = findEverywhere("palette", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}),
      huginn: (_p, signal) => {
        seen.push(signal);
        return hang(signal);
      },
      claudeUsage: (_p, signal) => {
        seen.push(signal);
        return hang(signal);
      },
      signal: ctrl.signal,
      // Budgets far past the test: only the abort can end these legs.
      huginnTimeoutMs: 20_000,
      sessionsTimeoutMs: 20_000,
    });
    await new Promise((res) => setTimeout(res, 30));
    const t0 = performance.now();
    ctrl.abort();
    const r = await pending;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.aborted)).toBe(true);
    expect(r.sources.huginn).toMatchObject({ status: "error", error: "aborted" });
    expect(r.sources.sessions).toMatchObject({ status: "error", error: "aborted" });
  });

  test("each failure carries its own label", async () => {
    const a = await wiki({ "p.md": page("Palette", [`sessions: [${S1}]`]) });
    const run = (huginn: unknown, sessions: unknown) =>
      findEverywhere("palette", 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], { huginn, sessions }));
    const r1 = await run(new LegFetchError("unreachable"), new LegFetchError("http", 503));
    expect(r1.sources.huginn.error).toBe("unreachable");
    expect(r1.sources.sessions.error).toBe("HTTP 503");
    const r2 = await run({ nope: true }, { sessions: "not a list" });
    expect(r2.sources.huginn.error).toBe("bad response");
    expect(r2.sources.sessions.error).toBe("bad response");
    const r3 = await run(new LegFetchError("bad response"), new Error("boom"));
    expect(r3.sources.huginn.error).toBe("bad response");
    expect(r3.sources.sessions.error).toBe("failed");
    // The text leg answers whatever the remote legs did.
    expect(r3.results[0]!.legs.text?.rank).toBe(1);
  });

  test("a failed title lookup keeps the leg ok", async () => {
    const a = await wiki({ "p.md": page("Palette", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "palette",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], {
        sessions: { sessions: [{ sessionId: S1, snippet: "palette" }] },
        titles: new Error("HTTP 500"),
      }),
    );
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.results[0]!.legs.sessions![0]!.title).toBeUndefined();
  });
});

describe("fetchLegJson — the route's fetch seam", () => {
  test("labels a closed port, an HTTP status, a non-JSON body and an over-cap body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/503") return new Response("down", { status: 503 });
        if (p === "/html") return new Response("<html>not json</html>");
        if (p === "/big") return new Response(JSON.stringify({ pad: "x".repeat(5000) }));
        return Response.json({ ok: true });
      },
    });
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const base = `http://127.0.0.1:${server.port}`;
    const kind = async (url: string, max = 100_000) => {
      try {
        await fetchLegJson(url, AbortSignal.timeout(2000), max);
        return "ok";
      } catch (err) {
        return err instanceof LegFetchError ? err.message : `other: ${String(err)}`;
      }
    };
    try {
      expect(await kind(`${base}/ok`)).toBe("ok");
      expect(await kind(`${base}/503`)).toBe("HTTP 503");
      expect(await kind(`${base}/html`)).toBe("bad response");
      expect(await kind(`${base}/big`, 1000)).toBe("bad response");
      expect(await kind(`${deadUrl}/x`)).toBe("unreachable");
    } finally {
      server.stop(true);
    }
  });
});

describe("helpers", () => {
  test("sessionPages keys bare ids, drops malformed refs, and is rebuilt per index build", async () => {
    const a = await wiki({
      "a.md": page("A", [`sessions: [claude-code:${S1}, ${S1}, "bad id with space", opencode:ses_abc]`]),
      "b.md": page("B", [`sessions: [${S1}]`]),
    });
    const map = sessionPages(a.index);
    expect(map.get(S1)).toEqual(["a.md", "b.md"]);
    expect(map.get("ses_abc")).toEqual(["a.md"]);
    expect([...map.keys()].some((k) => k.includes(" "))).toBe(false);
    expect(sessionPages(a.index)).toBe(map);
  });

  test("markedSnippet turns markers into offsets, collapses whitespace and caps the text", () => {
    expect(markedSnippet("  a \u0002hit\u0003\n\n b \u0002\u0003 ")).toEqual({ text: "a hit b", marks: [[2, 5]] });
    const long = markedSnippet(`${"x".repeat(SNIPPET_MAX - 2)}\u0002abcdef\u0003 tail`);
    expect(Array.from(long.text)).toHaveLength(SNIPPET_MAX + 1);
    expect(long.text.endsWith("ab…")).toBe(true);
    expect(long.marks).toEqual([[SNIPPET_MAX - 2, SNIPPET_MAX]]);
    expect(markedSnippet(`${"y".repeat(SNIPPET_MAX + 5)}\u0002late\u0003`).marks).toEqual([]);
  });

  test("plainSnippet strips the breadcrumb, tags, wikilinks and emphasis before clipping", () => {
    expect(
      plainSnippet(
        'tags: muninn, wiki, testing\n## 38. MELOSYS-8161 — feilen\n<Callout tone="info">A **bold** and _soft_ [[plans/x|the plan]] or [[other]] via [reader](http://x/y).</Callout>',
      ),
    ).toBe("A bold and soft the plan or other via reader.");
    expect(plainSnippet("Plain text\n\n### Inner heading\nmore")).toBe("Plain text Inner heading more");
    expect(Array.from(plainSnippet("z".repeat(SNIPPET_MAX + 50)))).toHaveLength(SNIPPET_MAX + 1);
  });

  test("parseFindEverywhereLimit clamps", () => {
    expect(parseFindEverywhereLimit(undefined)).toBe(FIND_EVERYWHERE_LIMIT_DEFAULT);
    expect(parseFindEverywhereLimit("abc")).toBe(FIND_EVERYWHERE_LIMIT_DEFAULT);
    expect(parseFindEverywhereLimit("0")).toBe(1);
    expect(parseFindEverywhereLimit("7")).toBe(7);
    expect(parseFindEverywhereLimit("999")).toBe(FIND_EVERYWHERE_LIMIT_MAX);
  });

  test("findSelfWikiName names the served root's registry entry, the WIKI_DIR override included", async () => {
    const a = await wiki({ "p.md": page("P") });
    const registry = [
      { name: "other", root: "/nowhere" },
      { name: "mine", root: a.root },
    ];
    expect(findSelfWikiName(registry, { name: "picked" }, a.root)).toBe("picked");
    expect(findSelfWikiName(registry, undefined, a.root)).toBe("mine");
    expect(findSelfWikiName(registry, undefined, `${a.root}/`)).toBe("mine");
    expect(findSelfWikiName(registry, undefined, "/unregistered")).toBe("");
    expect(findSelfWikiName(registry, undefined, null)).toBe("");
  });
});

describe("GET /api/wiki/find-everywhere", () => {
  const config = { knowledgeApiUrl: "http://unused", claudeUsageUrl: null } as unknown as Config;

  test("answers the core's JSON, no-store, and an empty set for a one-letter query", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    __setFindEverywhereDepsForTest(deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }));
    const app = new Hono();
    registerWikiFindEverywhereRoute(app, config);
    const res = await app.request("/api/wiki/find-everywhere?q=palette&limit=5");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { q: string; results: Array<{ relPath: string; wiki: string }> };
    expect(body.q).toBe("palette");
    expect(body.results.map((r) => `${r.wiki}:${r.relPath}`)).toEqual(["w:p.md"]);
    const short = (await (await app.request("/api/wiki/find-everywhere?q=p")).json()) as { results: unknown[] };
    expect(short.results).toEqual([]);
  });

  test("the request's own signal reaches the deps", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const seen: AbortSignal[] = [];
    __setFindEverywhereDepsForTest((signal) => {
      seen.push(signal);
      return { ...deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }), signal };
    });
    const app = new Hono();
    registerWikiFindEverywhereRoute(app, config);
    const ctrl = new AbortController();
    await app.request(new Request("http://x/api/wiki/find-everywhere?q=palette", { signal: ctrl.signal }));
    expect(seen).toHaveLength(1);
    ctrl.abort();
    expect(seen[0]!.aborted).toBe(true);
  });

  for (const mode of ["off", "authenticating"] as const) {
    test(`a cross-site request is refused 403 before any upstream call (origin guard, ${mode})`, async () => {
      const a = await wiki({ "p.md": page("Palette") });
      const calls: string[] = [];
      __setFindEverywhereDepsForTest(deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
      const app = new Hono();
      app.use("*", createOriginMiddleware([], 3010, mode));
      registerWikiFindEverywhereRoute(app, config);
      const res = await app.request("/api/wiki/find-everywhere?q=palette", {
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
      const own = await app.request("/api/wiki/find-everywhere?q=palette", { headers: { "sec-fetch-site": "same-origin" } });
      expect(own.status).toBe(200);
      expect(calls.length).toBeGreaterThan(0);
    });
  }
});

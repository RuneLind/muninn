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
  SESSIONS_TIMEOUT_MS,
  SNIPPET_MAX,
  __resetFindEverywhereIndexesForTest,
  capFindEverywhereQuery,
  findEverywhere,
  fuseLegs,
  markedSnippet,
  parseFindEverywhereLimit,
  plainSnippet,
  sessionPages,
  type FindEverywhereDeps,
  type FindEverywhereResponse,
  type FindEverywhereWiki,
} from "./find-everywhere.ts";
import {
  USAGE_MAX_BYTES,
  __resetFindEverywhereWarnsForTest,
  __setFindEverywhereDepsForTest,
  fetchLegJson,
  logLegFailures,
  uniqueWikiRoots,
  usageLegJson,
  findSelfWikiName,
  registerWikiFindEverywhereRoute,
} from "../dashboard/routes/wiki-find-everywhere.ts";
import { createOriginMiddleware } from "../auth/origin.ts";
import type { Config } from "../config.ts";
import {
  everywhereRequestQuery,
  findFreeTokens,
  freeText,
  parseFindQuery,
} from "../dashboard/views/components/wiki-find.ts";

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
  __resetFindEverywhereIndexesForTest();
  __resetFindEverywhereWarnsForTest();
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

/** The `q` a recorded call to `leg` ("huginn" or "usage") sent to `/api/search`. */
const sentQ = (calls: string[], leg: "huginn" | "usage"): string =>
  new URL(`http://x${calls.find((c) => c.startsWith(`${leg} /api/search`))!.slice(leg.length + 1)}`).searchParams.get("q")!;

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
    expect(sentQ(calls, "usage")).toBe("12 review");
    expect(r.results.map((x) => [x.relPath, x.legs.text?.rank])).toEqual([["a.md", 1]]);
  });

  test("filter tokens never reach the remote legs", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    await findEverywhere('find type:plan in:"two words" #tag palette', 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    expect(sentQ(calls, "usage")).toBe("find palette");
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
    // No other leg returned it, so huginn's #1 only votes (`agreedHuginnHeads`).
    expect(gate.head).toBe(false);
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
      "plans/target.mdx": page("Konsoll kjøringer", [`sessions: [${S1}]`]),
    });
    const r = await findEverywhere(
      "which gate runs count",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        sessions: { sessions: [{ sessionId: S1, snippet: "" }] },
        huginn: { results: [{ collection: "c", id: "plans/target.mdx", snippet: "which gate runs count" }] },
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
      "e-hug.md": page("Hug one", [`sessions: [${S2}]`]),
      "f-hug.md": page("Hug two", [`sessions: [${S2}]`]),
    });
    const r = await findEverywhere(
      "zeta gate",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        huginn: {
          results: [
            { collection: "c", id: "e-hug.md", relevance: 0.7, snippet: "a zeta note" },
            { collection: "c", id: "f-hug.md", relevance: 0.7, snippet: "the gate" },
          ],
        },
        // S2 puts both huginn pages in the sessions leg, below its #1: agreement, not a sessions head.
        sessions: { sessions: [{ sessionId: S1, snippet: "" }, { sessionId: S2, snippet: "" }] },
      }),
    );
    const heads = r.results.filter((x) => x.head).map((x) => x.relPath).sort();
    expect(heads).toEqual(["a-text.md", "b-text.md", "c-session.md", "d-session.md", "e-hug.md", "f-hug.md"]);
  });

  test("an untied huginn #2 is no head", async () => {
    const far = SESSIONS_HEAD_TOP + 1;
    const a = await wiki({ "e.md": page("E", [`sessions: [${sid(far)}]`]), "f.md": page("F", [`sessions: [${sid(far)}]`]) });
    // Both pages agree through a session past the sessions head gate, so only huginn's order decides.
    const unmatched = Array.from({ length: SESSIONS_HEAD_TOP }, (_, i) => ({ sessionId: sid(i + 1), snippet: "" }));
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        sessions: { sessions: [...unmatched, { sessionId: sid(far), snippet: "" }] },
        huginn: {
          results: [
            { collection: "c", id: "e.md", relevance: 0.8, snippet: "zzqq here" },
            { collection: "c", id: "f.md", relevance: 0.7, snippet: "zzqq there" },
          ],
        },
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

// ── Fix round 1 ─────────────────────────────────────────────────────────────

describe("fix round 1 — sessions budget and the titles call (item 6)", () => {
  test("the search budget is 3 s, matching huginn's", () => {
    expect(SESSIONS_TIMEOUT_MS).toBe(3000);
  });

  test("the leg's ms is the search alone and the titles outcome is reported beside it", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere("zzqq", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index }], {}),
      claudeUsage: async (p, signal) => {
        if (p.startsWith("/api/sessions-by-id")) return hang(signal);
        return { sessions: [{ sessionId: S1, snippet: "" }] };
      },
      titlesTimeoutMs: 300,
    });
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.sources.sessions.ms).toBeLessThan(150);
    expect(r.sources.sessions.titles).toBe("timeout");
  });

  test("titles: ok when they land, failed on an error, skipped with nothing to look up", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const run = (sessions: unknown, titles: unknown) =>
      findEverywhere("zzqq", 20, deps([{ name: "w", root: a.root, index: a.index }], { sessions, titles }));
    const one = { sessions: [{ sessionId: S1, snippet: "" }] };
    expect((await run(one, { sessions: [{ sessionId: S1, title: "T" }] })).sources.sessions.titles).toBe("ok");
    expect((await run(one, new Error("down"))).sources.sessions.titles).toBe("failed");
    expect((await run({ sessions: [] }, {})).sources.sessions.titles).toBe("skipped");
  });
});

describe("fix round 1 — a late index answers from its last-good build (item 7)", () => {
  test("after one good load, a rebuild past the bound serves the last-good index and says stale", async () => {
    const a = await wiki({ "plans/palette.mdx": page("Find palette") });
    let slow = false;
    const d: FindEverywhereDeps = {
      ...deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }),
      index: async () => (slow ? new Promise<WikiIndex>(() => {}) : a.index),
      indexTimeoutMs: 80,
    };
    const first = await findEverywhere("find palette", 20, d);
    slow = true;
    const second = await findEverywhere("find palette", 20, d);
    expect(second.results.map((x) => x.relPath)).toEqual(["plans/palette.mdx"]);
    expect(second.sources.indexes.skipped).toEqual([]);
    expect(first.sources.indexes.stale).toEqual([]);
    expect(second.sources.indexes.stale).toEqual([{ wiki: "w", error: "timeout" }]);
  });

  test("a wiki with no last-good index is still skipped", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const r = await findEverywhere("palette", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }),
      index: async () => new Promise<WikiIndex>(() => {}),
      indexTimeoutMs: 60,
    });
    expect(r.sources.indexes.skipped).toEqual([{ wiki: "w", error: "timeout" }]);
    expect(r.sources.indexes.stale).toEqual([]);
  });

  test("a rebuild that lands after the bound becomes the next request's index", async () => {
    const a = await wiki({ "old.md": page("Old palette") });
    const b = await wiki({ "new.md": page("New palette") });
    let release!: (i: WikiIndex) => void;
    let mode: "a" | "late" | "b" = "a";
    const d: FindEverywhereDeps = {
      ...deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }),
      index: async () => {
        if (mode === "a") return a.index;
        if (mode === "b") return new Promise<WikiIndex>(() => {});
        return new Promise<WikiIndex>((res) => (release = res));
      },
      indexTimeoutMs: 60,
    };
    await findEverywhere("palette", 20, d);
    mode = "late";
    const stale = await findEverywhere("palette", 20, d);
    expect(stale.results.map((x) => x.relPath)).toEqual(["old.md"]);
    release(b.index);
    await new Promise((res) => setTimeout(res, 10));
    mode = "b";
    const r = await findEverywhere("palette", 20, d);
    expect(r.sources.indexes.stale).toEqual([{ wiki: "w", error: "timeout" }]);
    expect(r.results.map((x) => x.relPath)).toEqual(["new.md"]);
  });
});

describe("fix round 1 — honest statuses (item 8)", () => {
  test("collections registered but no index loaded: huginn is skipped, not unconfigured", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    const r = await findEverywhere("palette", 20, {
      ...deps([{ name: "plain", root: a.root, index: a.index }], { sessions: null }, calls),
      wikis: () => [
        { name: "plain", root: a.root },
        { name: "coll", root: "/broken", collections: ["c"] },
      ],
      index: async (root) => (root === a.root ? a.index : null),
    });
    expect(r.sources.huginn).toMatchObject({ status: "skipped", error: "no wiki index loaded" });
    expect(calls).toEqual([]);
  });

  test("an abort during the index load runs no leg and reports aborted", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const ctrl = new AbortController();
    const calls: string[] = [];
    const r = await findEverywhere("palette", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls),
      index: async () => {
        ctrl.abort();
        return a.index;
      },
      signal: ctrl.signal,
    });
    expect(calls).toEqual([]);
    for (const leg of ["text", "huginn", "sessions"] as const) {
      expect(r.sources[leg]).toMatchObject({ status: "error", error: "aborted" });
    }
  });

  test("a query under two code points reports every leg skipped", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    for (const sessions of [undefined, null]) {
      const r = await findEverywhere("p", 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], { sessions }));
      for (const leg of ["text", "huginn", "sessions"] as const) {
        expect(r.sources[leg]).toMatchObject({ status: "skipped", error: "query too short" });
      }
    }
  });
});

describe("fix round 1 — short numbers (item 9)", () => {
  test("`#5` runs the text leg; the remote legs skip its one-digit remote form", async () => {
    const a = await wiki({ "a.md": page("Round 5 review"), "b.md": page("Review notes") });
    const calls: string[] = [];
    const r = await findEverywhere("#5", 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    expect(r.results.map((x) => [x.relPath, x.legs.text?.rank])).toEqual([["a.md", 1]]);
    expect(r.sources.text.status).toBe("ok");
    expect(r.sources.huginn).toMatchObject({ status: "skipped", error: "query too short" });
    expect(r.sources.sessions).toMatchObject({ status: "skipped", error: "query too short" });
    expect(calls).toEqual([]);
  });
});

describe("fix round 1 — deterministic ties (item 11)", () => {
  test("keys ICU collates as equal still order by code unit, whatever the input order", () => {
    const x = "mimir\u0000x.md";
    const y = "mimi\u0000rx.md";
    expect(x.localeCompare(y)).toBe(0);
    for (const legs of [[{ keys: [x] }, { keys: [y] }], [{ keys: [y] }, { keys: [x] }]]) {
      expect(fuseLegs(legs).map((f) => f.key)).toEqual([y, x]);
    }
  });
});

describe("fix round 1 — session ranks count well-formed rows (item 12)", () => {
  test("malformed rows shift neither ranks nor the head gate", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const junk = [{ sessionId: 42 }, { sessionId: "bad id" }, null, { sessionId: "" }, { nope: true }, { sessionId: "x y" }];
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions: [...junk, { sessionId: S1, snippet: "" }] } }),
    );
    expect(r.results.map((x) => [x.relPath, x.legs.sessions![0]!.rank, x.head])).toEqual([["p.md", 1, true]]);
  });
});

describe("fix round 1 — a lone surrogate reaches claude-usage (item 13)", () => {
  test("the session search URL is built without throwing", async () => {
    const a = await wiki({ "p.md": page("Felles", [`sessions: [${S1}]`]) });
    const calls: string[] = [];
    const r = await findEverywhere(
      "felles \uD800 wiki",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions: [{ sessionId: S1, snippet: "" }] } }, calls),
    );
    expect(r.sources.sessions.status).toBe("ok");
    expect(sentQ(calls, "usage")).toBe("felles � wiki");
  });
});

describe("fix round 1 — plainSnippet over clipped markup (item 14)", () => {
  const cases: Array<[string, string, string]> = [
    ["unterminated trailing tag", 'See the prototype <Embed src="./p.html" title="Prototype 2: the find', "See the prototype"],
    ["quoted > in an attribute", '<Pill tone="a>b">label</Pill> after', "label after"],
    ["braced > in an attribute", 'Before <ComparisonTable rows={[{a: "1 > 0"}]} /> after', "Before after"],
    ["JSX comment", "Kept {/* a > b note */} text", "Kept text"],
    ["JSX expression", "Count {items.length > 3 ? 'many' : 'few'} rows", "Count rows"],
    ["HTML comment", "One <!-- hidden > text --> two", "One two"],
    ["unterminated HTML comment", "One <!-- cut off", "One"],
    ["code fence", "Before\n```ts\nconst a = <b>;\n```\nafter", "Before after"],
    ["unclosed code fence", "Before\n```\ncode only", "Before"],
    ["list bullets", "- one\n* two\n1. three\n2) four", "one two three four"],
    ["checkboxes", "- [ ] open\n- [x] done", "open done"],
    ["table rows", "| A | B |\n| --- | :-: |\n| 1 | 2 |", "A · B 1 · 2"],
    ["blockquote", "> quoted line\n> > nested", "quoted line nested"],
    ["obsidian callout marker", "> [!note] Heads up\n> body", "Heads up body"],
    ["inline backticks", "Run `bun test` now", "Run bun test now"],
    ["inline code keeps markup", "Use `<Fact>` here", "Use <Fact> here"],
    ["unclosed wikilink", "See [[plans/next-step", "See plans/next-step"],
    ["unclosed wikilink with label", "See [[plans/x|the pla", "See the pla"],
    ["unclosed link bracket", "See [the reader", "See the reader"],
    ["link cut in its url", "See [reader](http://x/y", "See reader"],
    ["image", "![diagram](a.png) caption", "diagram caption"],
    ["entities", "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &amp;lt;", "a & b <c> \"d\" 'e' &lt;"],
    ["prose comparison stays", "x<y and z>w", "x<y and z>w"],
    ["dunder stays", "call __init__ first", "call __init__ first"],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      expect(plainSnippet(raw)).toBe(want);
    });
  }

  // Guards against overreach: green before and after the fix by design.
  test("guards: spaced comparisons, snake_case and strong emphasis", () => {
    expect(plainSnippet("if a < b and c > d")).toBe("if a < b and c > d");
    expect(plainSnippet("use snake_case_name")).toBe("use snake_case_name");
    expect(plainSnippet("a __bold text__ b")).toBe("a bold text b");
  });

  test("the real huginn shapes from the review", () => {
    expect(
      plainSnippet(
        'tags: plans\n## Prototypes\nThree layouts were tried. <Embed src="./find-palette-prototype.html" title="Prototype 2: the palette with an Everywhere section',
      ),
    ).toBe("Three layouts were tried.");
    expect(plainSnippet('<Verdict tone="ok">Ship it</Verdict>\n- [x] review floor\n| leg | ms |\n|---|---|\n| huginn | 210 |')).toBe(
      "Ship it review floor leg · ms huginn · 210",
    );
  });
});

describe("fix round 1 — the sessions leg reads through claudeUsageJson (item 15)", () => {
  test("labels a closed port, an HTTP status, a non-JSON body and an over-cap body", async () => {
    const big = JSON.stringify({ pad: "x".repeat(USAGE_MAX_BYTES + 10) });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/503") return new Response("down", { status: 503 });
        if (p === "/html") return new Response("<html>not json</html>");
        if (p === "/big") return new Response(big);
        return Response.json({ sessions: [] });
      },
    });
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const base = `http://127.0.0.1:${server.port}`;
    const kind = async (root: string, path: string) => {
      try {
        await usageLegJson(root, path, AbortSignal.timeout(5000));
        return "ok";
      } catch (err) {
        return err instanceof LegFetchError ? err.message : `other: ${String(err)}`;
      }
    };
    try {
      expect(await kind(base, "/ok?q=x")).toBe("ok");
      expect(await kind(base, "/503?q=x")).toBe("HTTP 503");
      expect(await kind(base, "/html?q=x")).toBe("bad response");
      expect(await kind(base, "/big?q=x")).toBe("bad response");
      expect(await kind(deadUrl, "/x?q=x")).toBe("unreachable");
    } finally {
      server.stop(true);
    }
  });

  test("an aborted read is rethrown for the core to label", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const ctrl = new AbortController();
      const p = usageLegJson(`http://127.0.0.1:${server.port}`, "/api/search?q=x", ctrl.signal);
      setTimeout(() => ctrl.abort(), 20);
      const err = await p.catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(LegFetchError);
    } finally {
      server.stop(true);
    }
  });
});

describe("fix round 1 — leg failures are logged once per (leg, label, host) (item 17)", () => {
  const body = (huginn: string | null, sessions: string | null): FindEverywhereResponse => ({
    q: "a secret query",
    results: [],
    sources: {
      query: { truncated: false },
      indexes: { ms: 0, skipped: [], stale: [] },
      text: { status: "ok", ms: 0 },
      huginn: huginn ? { status: "error", ms: 0, error: huginn } : { status: "ok", ms: 0 },
      sessions: sessions ? { status: "error", ms: 0, error: sessions } : { status: "ok", ms: 0 },
    },
  });

  test("first sighting warns, a repeat is info, a new label warns again, an abort is silent", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const logger = {
      warn: (_m: string, props: Record<string, unknown>) => void lines.push(["warn", props]),
      info: (_m: string, props: Record<string, unknown>) => void lines.push(["info", props]),
    };
    const hosts = { huginn: "h:8321", sessions: "u:8787" };
    logLegFailures(body("timeout", null), hosts, logger);
    logLegFailures(body("timeout", null), hosts, logger);
    logLegFailures(body("HTTP 503", "aborted"), hosts, logger);
    logLegFailures(body(null, "unreachable"), hosts, logger);
    expect(lines.map(([level, p]) => [level, p.leg, p.error, p.host])).toEqual([
      ["warn", "huginn", "timeout", "h:8321"],
      ["info", "huginn", "timeout", "h:8321"],
      ["warn", "huginn", "HTTP 503", "h:8321"],
      ["warn", "sessions", "unreachable", "u:8787"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });
});

describe("fix round 1 — registry entries sharing a root (item 18)", () => {
  test("uniqueWikiRoots keeps the first entry per root, trailing slash or not", async () => {
    const a = await wiki({ "p.md": page("P") });
    const kept = uniqueWikiRoots([
      { name: "a", root: a.root },
      { name: "b", root: `${a.root}/` },
      { name: "c", root: "/elsewhere" },
    ]);
    expect(kept.map((w) => w.name)).toEqual(["a", "c"]);
  });

  test("the route lists an aliased root's pages once", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const base = deps([{ name: "a", root: a.root, index: a.index }], { sessions: null });
    __setFindEverywhereDepsForTest({ ...base, wikis: () => [{ name: "a", root: a.root }, { name: "b", root: a.root }] });
    const app = new Hono();
    registerWikiFindEverywhereRoute(app, { knowledgeApiUrl: "http://unused", claudeUsageUrl: null } as unknown as Config);
    const res = await app.request("/api/wiki/find-everywhere?q=palette");
    const body = (await res.json()) as { results: Array<{ wiki: string; relPath: string }> };
    expect(body.results.map(keyOf)).toEqual(["a:p.md"]);
  });
});

// ── Fix round 2 ─────────────────────────────────────────────────────────────

describe("fix round 2 — registry entries sharing a root merge collections (item 2)", () => {
  test("uniqueWikiRoots keeps the first name and unions the collections", async () => {
    const a = await wiki({ "p.md": page("P") });
    const kept = uniqueWikiRoots([
      { name: "a", root: a.root, collections: ["c1"] },
      { name: "b", root: `${a.root}/`, collections: ["c2", "c1"] },
      { name: "c", root: "/elsewhere" },
    ]);
    expect(kept.map((w) => [w.name, w.collections])).toEqual([
      ["a", ["c1", "c2"]],
      ["c", undefined],
    ]);
  });

  test("the route asks huginn for both collections and a c2 hit resolves once", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    const base = deps(
      [{ name: "a", root: a.root, index: a.index }],
      { sessions: null, huginn: { results: [{ collection: "c2", id: "p.md", relevance: 1, snippet: "zzqq" }] } },
      calls,
    );
    __setFindEverywhereDepsForTest({
      ...base,
      wikis: () => [
        { name: "a", root: a.root, collections: ["c1"] },
        { name: "b", root: a.root, collections: ["c2"] },
      ],
    });
    const app = new Hono();
    registerWikiFindEverywhereRoute(app, { knowledgeApiUrl: "http://unused", claudeUsageUrl: null } as unknown as Config);
    const res = await app.request("/api/wiki/find-everywhere?q=zzqq");
    const body = (await res.json()) as FindEverywhereResponse;
    const sent = new URL(`http://x${calls.find((c) => c.startsWith("huginn"))!.slice(7)}`).searchParams.getAll("collection");
    expect(sent).toEqual(["c1", "c2"]);
    expect(body.results.map((r) => [keyOf(r), r.legs.huginn?.rank])).toEqual([["a:p.md", 1]]);
  });
});

describe("fix round 2 — plainSnippet ends only on markup the clip cut off (item 3)", () => {
  const cases: Array<[string, string, string]> = [
    ["an apostrophe inside braces", "f(x) = {x | x's > 0} and then more text here", "f(x) = and then more text here"],
    ["a lone brace in prose", "Use { to open a block; then close it later", "Use { to open a block; then close it later"],
    ["a lone brace before an ellipsis", "Use { to open a block; then…", "Use { to open a block; then…"],
    ["a `<` before a letter in prose", "when n <k the loop ends…", "when n <k the loop ends…"],
    ["a `<` before a letter, punctuation after", "when n <k the loop ends early, so it holds", "when n <k the loop ends early, so it holds"],
    ["a stray quote pairing past the closer", "{x's} and it's done", "and it's done"],
    ["a paired quote still guards a brace", 'Count {a: "}", b: x\'s} rows', "Count rows"],
    ["a `<` before plain words to the end", "if n <k then stop", "if n <k then stop"],
    ["a `<` before an `=` that is no attribute", "when n <k we call f(x) = y", "when n <k we call f(x) = y"],
    ["a cut bare tag name still ends", "tail <Callout", "tail"],
    ["a cut expression still ends", "tail {items.map(", "tail"],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      expect(plainSnippet(raw)).toBe(want);
    });
  }
});

describe("fix round 2 — plainSnippet pins (item 6)", () => {
  test("brace depth inside a tag protects a bare `>`", () => {
    expect(plainSnippet("Before <X a={b > c} /> after")).toBe("Before after");
  });

  test("a backtick quote inside braces protects a `}`", () => {
    expect(plainSnippet("Count {`a}b`} rows")).toBe("Count rows");
  });

  test("a fence closes only on its own character, at least as long", () => {
    expect(plainSnippet("Before\n````\ncode\n```\nstill code\n````\nafter")).toBe("Before after");
    expect(plainSnippet("Before\n```\ncode\n~~~\nstill code\n```\nafter")).toBe("Before after");
  });

  test("`<!` opens a tag", () => {
    expect(plainSnippet("a <!DOCTYPE html> b")).toBe("a b");
  });
});

describe("fix round 2 — the palette's request parses back to the box's free words (item 4)", () => {
  // `wire` is what the palette sends: the free words' text forms, joined.
  const wire = (box: string) =>
    findFreeTokens(box)
      .map((t) => t.text)
      .join(" ");
  const boxes: Array<[string, string]> = [
    ['"type:plan" felles', "type:plan felles"],
    ['"#tag" felles', "#tag felles"],
    ['foo:"x type:plan"', "foo:x type:plan"],
    ['"#12"', "#12"],
  ];
  for (const [box, remote] of boxes) {
    test(`${box} reaches the legs as the box's words`, async () => {
      const sent = wire(box);
      expect(findFreeTokens(sent)).toEqual(findFreeTokens(box));
      const cap = capFindEverywhereQuery(sent);
      expect(cap.remote).toBe(freeText(box));
      expect(cap.remote).toBe(remote);
      const parsed = parseFindQuery(cap.text);
      expect([parsed.types, parsed.tags, parsed.numbers]).toEqual([[], [], []]);
      const a = await wiki({ "p.md": page("P") });
      const calls: string[] = [];
      await findEverywhere(sent, 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
      expect(sentQ(calls, "usage")).toBe(remote);
    });
  }

  test("the palette sends exactly that form", () => {
    for (const [box] of boxes) expect(everywhereRequestQuery(box)).toBe(wire(box));
  });
});

describe("fix round 2 — legs and logging pins (item 6)", () => {
  test("an abort during the index load names each wiki `aborted`", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const ctrl = new AbortController();
    const r = await findEverywhere("palette", 20, {
      ...deps([{ name: "w", root: a.root, index: a.index }], { sessions: null }),
      index: async () => {
        ctrl.abort();
        return a.index;
      },
      signal: ctrl.signal,
    });
    expect(r.sources.indexes.skipped).toEqual([{ wiki: "w", error: "aborted" }]);
  });

  test("titles: failed on an answer without a sessions list", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions: [{ sessionId: S1, snippet: "" }] }, titles: { nope: 1 } }),
    );
    expect(r.sources.sessions.titles).toBe("failed");
  });

  test("a page's session score follows its session's rank", async () => {
    const a = await wiki({ "a.md": page("A", [`sessions: [${S2}]`]), "b.md": page("B", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], {
        sessions: { sessions: [{ sessionId: S1, snippet: "" }, { sessionId: S2, snippet: "" }] },
      }),
    );
    expect(r.results.map((x) => x.relPath)).toEqual(["b.md", "a.md"]);
  });

  test("a session id with surrounding white space still joins", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "zzqq",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], { sessions: { sessions: [{ sessionId: `  ${S1} `, snippet: "" }] } }),
    );
    expect(r.results.map((x) => x.relPath)).toEqual(["p.md"]);
  });

  // `ab` and `a­b` collate as equal under ICU; by code unit `ab` is first.
  const twins = (index: WikiIndex, order: "ab-first" | "shy-first") => {
    const w = [
      { name: "ab", root: "/r-ab", index },
      { name: "a­b", root: "/r-shy", index },
    ];
    return order === "ab-first" ? w : [w[1]!, w[0]!];
  };

  test("the text leg breaks a cross-wiki tie by code unit, whatever the registry order", async () => {
    expect("ab".localeCompare("a­b")).toBe(0);
    const a = await wiki({ "p.md": page("Palette notes") });
    for (const order of ["ab-first", "shy-first"] as const) {
      const r = await findEverywhere("palette", 20, deps(twins(a.index, order), { sessions: null }));
      expect(r.results.map((x) => [x.wiki, x.legs.text?.rank])).toEqual([
        ["ab", 1],
        ["a­b", 2],
      ]);
    }
  });

  test("the sessions leg breaks a score tie by code unit, whatever the registry order", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    for (const order of ["ab-first", "shy-first"] as const) {
      const r = await findEverywhere("zzqq", 20, deps(twins(a.index, order), { sessions: { sessions: [{ sessionId: S1, snippet: "" }] } }));
      expect(r.results.map((x) => x.wiki)).toEqual(["ab", "a­b"]);
      expect(r.results[0]!.score).toBeGreaterThan(r.results[1]!.score);
    }
  });

  test("the warn-once key includes the host", () => {
    const lines: string[] = [];
    const logger = { warn: () => void lines.push("warn"), info: () => void lines.push("info") };
    const body: FindEverywhereResponse = {
      q: "x",
      results: [],
      sources: {
        query: { truncated: false },
        indexes: { ms: 0, skipped: [], stale: [] },
        text: { status: "ok", ms: 0 },
        huginn: { status: "error", ms: 0, error: "timeout" },
        sessions: { status: "ok", ms: 0 },
      },
    };
    logLegFailures(body, { huginn: "h1:8321", sessions: "u" }, logger);
    logLegFailures(body, { huginn: "h2:8321", sessions: "u" }, logger);
    expect(lines).toEqual(["warn", "warn"]);
  });
});

// ── Fix round 3 (class check) ───────────────────────────────────────────────

/** The huginn #1 `id` for `q` (relevance 1, this snippet), and what the other legs made of it. */
async function huginnOne(
  files: Record<string, string>,
  q: string,
  id: string,
  snippet: string,
  sessions: unknown[] | null = null,
): Promise<FindEverywhereResponse["results"][number]> {
  const a = await wiki(files);
  const r = await findEverywhere(
    q,
    20,
    deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
      sessions: sessions === null ? null : { sessions },
      huginn: { results: [{ collection: "c", id, relevance: 1, snippet }] },
    }),
  );
  return r.results.find((x) => x.relPath === id)!;
}

describe("fix round 3 — a huginn head needs another leg to agree", () => {
  // The function words the round-2 verify pass found leaking past the stopword list.
  const leaked = ["about", "will", "were", "also", "more", "jeg", "noe", "hvem", "være", "etter", "mellom"];
  for (const w of leaked) {
    test(`"${w} qzxv wplkj" makes no huginn head, the word in title and snippet`, async () => {
      const hit = await huginnOne({ "cap.md": page(`Capra ${w} notes`) }, `${w} qzxv wplkj`, "cap.md", `what ${w} the team said`);
      expect(hit.legs.text).toBeUndefined();
      expect(hit.legs.huginn?.rank).toBe(1);
      expect(hit.head).toBe(false);
    });
  }

  test("a real query word in the title alone makes no huginn head", async () => {
    const hit = await huginnOne({ "pal.md": page("Palette notes") }, "palette qzxv wplkj", "pal.md", "the palette");
    expect(hit.legs.text).toBeUndefined();
    expect(hit.head).toBe(false);
  });

  test("nonsense words or an emoji get no huginn head", async () => {
    for (const q of ["qzxv wplkj frobnicate", "🧭🧭"]) {
      expect((await huginnOne({ "cap.md": page("Capra notes") }, q, "cap.md", "semantic neighbour")).head).toBe(false);
    }
  });

  test("the huginn #1 the text leg also returned is a head, though it is not the text head", async () => {
    // `palette export`: full.md is the text leg's full-band #1; pal.md is a
    // partial row, so the text leg alone would never make it a head.
    const hit = await huginnOne(
      { "full.md": page("Palette export"), "pal.md": page("Palette notes") },
      "palette export",
      "pal.md",
      "",
    );
    expect(hit.legs.text?.rank).toBe(2);
    expect(hit.head).toBe(true);
  });

  test("the huginn #1 the sessions leg also returned is a head, though it is not the sessions head", async () => {
    const far = SESSIONS_HEAD_TOP + 1;
    const unmatched = Array.from({ length: SESSIONS_HEAD_TOP }, (_, i) => ({ sessionId: sid(i + 1), snippet: "" }));
    const files = { "cap.md": page("Capra notes", [`sessions: [${sid(far)}]`]) };
    const hit = await huginnOne(files, "qzxv wplkj", "cap.md", "", [...unmatched, { sessionId: sid(far), snippet: "" }]);
    expect(hit.legs.sessions?.[0]?.rank).toBe(far);
    expect(hit.legs.text).toBeUndefined();
    expect(hit.head).toBe(true);
  });
});

describe("fix round 3 — uniqueWikiRoots unions past duplicate collections", () => {
  test("a kept entry with a duplicate collection still gains the next entry's", () => {
    const kept = uniqueWikiRoots([
      { name: "a", root: "/w", collections: ["c1", "c1"] },
      { name: "b", root: "/w", collections: ["c2"] },
    ]);
    expect(kept.map((w) => [w.name, w.collections])).toEqual([["a", ["c1", "c2"]]]);
  });
});

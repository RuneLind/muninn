/**
 * Find everywhere — the three legs, the session join, fusion with heads
 * first, and every way a leg degrades. Driven against REAL `buildWikiIndex`
 * output over temp wikis (the session join reads what the index parses out of
 * `sessions:` frontmatter), with huginn and claude-usage as injected fakes.
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
  SNIPPET_MAX,
  findEverywhere,
  fuseLegs,
  markedSnippet,
  parseFindEverywhereLimit,
  sessionPages,
  type FindEverywhereDeps,
  type FindEverywhereWiki,
} from "./find-everywhere.ts";
import {
  __setFindEverywhereDepsForTest,
  registerWikiFindEverywhereRoute,
} from "../dashboard/routes/wiki-find-everywhere.ts";
import type { Config } from "../config.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";

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
  huginn?: unknown | Error | null;
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
    huginn:
      fakes.huginn === null
        ? null
        : async (p) => {
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

const keyOf = (r: { wiki: string; relPath: string }) => `${r.wiki}:${r.relPath}`;

describe("fuseLegs — reciprocal rank fusion, heads first", () => {
  test("a leg's #1 leads even when another page is #2 in two legs", () => {
    // Plain RRF: M scores 2/61 ≈ 0.0328, H scores 1/60 ≈ 0.0167 — M wins.
    const fused = fuseLegs([
      { keys: ["T", "M"] },
      { keys: ["H", "M"] },
      { keys: ["S", "M"] },
    ]);
    const order = fused.map((f) => f.key);
    expect(order.slice(0, 3).sort()).toEqual(["H", "S", "T"]);
    expect(order[3]).toBe("M");
    expect(fused.find((f) => f.key === "H")!.head).toBe(true);
    expect(fused.find((f) => f.key === "M")!.head).toBe(false);
  });

  test("heads keep fused order among themselves", () => {
    const fused = fuseLegs([{ keys: ["A", "B"] }, { keys: ["B", "A"] }, { keys: ["C"] }]);
    // A: 1/60 + 1/61, B: 1/61 + 1/60 — tie, broken on the key.
    expect(fused.map((f) => f.key)).toEqual(["A", "B", "C"]);
  });

  test("a leg marked not headable votes but promotes nothing", () => {
    const fused = fuseLegs([{ keys: ["P", "M"], headable: false }, { keys: ["H", "M"] }]);
    expect(fused.map((f) => [f.key, f.head])).toEqual([
      ["H", true],
      ["M", false],
      ["P", false],
    ]);
  });
});

describe("findEverywhere", () => {
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
        huginn: null,
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
    expect(r.sources.huginn.status).toBe("unconfigured");
    const shared = r.results.find((x) => keyOf(x) === "alpha:plans/shared.mdx")!;
    expect(shared.legs.sessions).toEqual([
      { id: S1, rank: 2, title: "Find the felles page", snippet: { text: "felles kode-wiki", marks: [[0, 6], [7, 11]] } },
    ]);
    expect(shared.legs.text).toBeUndefined();
    // Both sessions name the twin, so it outscores `shared` in the session leg.
    const twin = r.results.find((x) => keyOf(x) === "beta:notes/twin.md")!;
    expect(twin.legs.sessions!.map((s) => s.id)).toEqual([S2, S1]);
    expect(twin.head).toBe(true);
    expect(r.results.findIndex((x) => x === twin)).toBeLessThan(r.results.findIndex((x) => x === shared));
    // A session nobody matched joins nothing.
    expect(r.results.some((x) => x.relPath === "plans/other.mdx")).toBe(false);
  });

  test("a provider-prefixed id in claude-usage's answer joins like a bare one", async () => {
    const a = await wiki({ "p.md": page("P", [`sessions: [${S1}]`]) });
    const r = await findEverywhere(
      "palette",
      20,
      deps([{ name: "w", root: a.root, index: a.index }], {
        huginn: null,
        sessions: { sessions: [{ sessionId: `claude-code:${S1}`, snippet: "" }] },
      }),
    );
    expect(r.results.map((x) => x.legs.sessions?.[0]?.id)).toEqual([S1]);
  });

  test("huginn hits map through the wiki that owns the collection; unresolvable hits are dropped", async () => {
    const a = await wiki({ "plans/gate.mdx": page("Konsoll gate-kjøringer"), "plans/two.mdx": page("Two") });
    const wikis = [{ name: "kode", root: a.root, index: a.index, collections: ["kode-coll"] }];
    const calls: string[] = [];
    const r = await findEverywhere(
      "which gate runs",
      20,
      deps(
        wikis,
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

  test("a failing leg degrades to its own error; the others still answer", async () => {
    const a = await wiki({
      "plans/palette.mdx": page("Find palette", [`sessions: [${S1}]`]),
    });
    const wikis = [{ name: "w", root: a.root, index: a.index, collections: ["c"] }];
    const r = await findEverywhere(
      "find palette",
      20,
      deps(wikis, { huginn: new Error("Knowledge API unreachable"), sessions: { sessions: [{ sessionId: S1, snippet: "" }] } }),
    );
    expect(r.sources.huginn).toMatchObject({ status: "error", error: "Knowledge API unreachable" });
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.sources.text.status).toBe("ok");
    const hit = r.results[0]!;
    expect(hit.relPath).toBe("plans/palette.mdx");
    expect(hit.legs.text?.rank).toBe(1);
    expect(hit.legs.sessions?.[0]?.id).toBe(S1);
  });

  test("a malformed answer is an error, and a failed title lookup keeps the leg ok", async () => {
    const a = await wiki({ "p.md": page("Palette", [`sessions: [${S1}]`]) });
    const wikis = [{ name: "w", root: a.root, index: a.index, collections: ["c"] }];
    const r = await findEverywhere(
      "palette",
      20,
      deps(wikis, {
        huginn: { nope: true },
        sessions: { sessions: [{ sessionId: S1, snippet: "palette" }] },
        titles: new Error("claude-usage returned HTTP 500"),
      }),
    );
    expect(r.sources.huginn.status).toBe("error");
    expect(r.sources.sessions.status).toBe("ok");
    expect(r.results[0]!.legs.sessions![0]!.title).toBeUndefined();
  });

  test("an unconfigured leg is reported, never called", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    const r = await findEverywhere("palette", 20, deps([{ name: "w", root: a.root, index: a.index }], { huginn: null, sessions: null }, calls));
    expect(r.sources.huginn.status).toBe("unconfigured");
    expect(r.sources.sessions.status).toBe("unconfigured");
    expect(calls).toEqual([]);
    expect(r.results.map((x) => x.relPath)).toEqual(["p.md"]);
  });

  test("a query under two characters answers empty and asks no leg", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    for (const q of ["", " ", "p", "type:plan", "#tag"]) {
      const r = await findEverywhere(q, 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
      expect(r.results).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  test("filter tokens never reach the remote legs", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    const calls: string[] = [];
    await findEverywhere('find type:plan in:"two words" #tag palette', 20, deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {}, calls));
    const usage = calls.find((c) => c.startsWith("usage /api/search"))!;
    expect(decodeURIComponent(usage)).toContain("q=find palette&");
    expect(calls.find((c) => c.startsWith("huginn"))).toContain("q=find+palette&");
  });

  test("retired and bookkeeping pages are dropped from every leg", async () => {
    const a = await wiki({
      "plans/live.mdx": page("Gate live", [`sessions: [${S1}]`]),
      "plans/old.mdx": page("Gate old", [`sessions: [${S1}]`, "signal: none"]),
      "log.md": page("Gate log", [`sessions: [${S1}]`]),
    });
    const r = await findEverywhere(
      "gate",
      20,
      deps([{ name: "w", root: a.root, index: a.index, collections: ["c"] }], {
        huginn: { results: [{ collection: "c", id: "plans/old.mdx" }, { collection: "c", id: "log.md" }] },
        sessions: { sessions: [{ sessionId: S1, snippet: "gate" }] },
      }),
    );
    expect(r.results.map((x) => x.relPath)).toEqual(["plans/live.mdx"]);
  });

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

  test("limit caps the results", async () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 8; i++) pages[`p${i}.md`] = page(`Palette ${i}`);
    const a = await wiki(pages);
    const r = await findEverywhere("palette", 3, deps([{ name: "w", root: a.root, index: a.index }], { huginn: null, sessions: null }));
    expect(r.results).toHaveLength(3);
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

  test("parseFindEverywhereLimit clamps", () => {
    expect(parseFindEverywhereLimit(undefined)).toBe(FIND_EVERYWHERE_LIMIT_DEFAULT);
    expect(parseFindEverywhereLimit("abc")).toBe(FIND_EVERYWHERE_LIMIT_DEFAULT);
    expect(parseFindEverywhereLimit("0")).toBe(1);
    expect(parseFindEverywhereLimit("7")).toBe(7);
    expect(parseFindEverywhereLimit("999")).toBe(FIND_EVERYWHERE_LIMIT_MAX);
  });
});

describe("GET /api/wiki/find-everywhere", () => {
  test("answers the core's JSON, no-store, and an empty set for a one-letter query", async () => {
    const a = await wiki({ "p.md": page("Palette") });
    __setFindEverywhereDepsForTest(deps([{ name: "w", root: a.root, index: a.index }], { huginn: null, sessions: null }));
    const app = new Hono();
    registerWikiFindEverywhereRoute(app, { knowledgeApiUrl: "http://unused", claudeUsageUrl: null } as unknown as Config);
    const res = await app.request("/api/wiki/find-everywhere?q=palette&limit=5");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { q: string; results: Array<{ relPath: string; wiki: string }> };
    expect(body.q).toBe("palette");
    expect(body.results.map((r) => `${r.wiki}:${r.relPath}`)).toEqual(["w:p.md"]);
    const short = (await (await app.request("/api/wiki/find-everywhere?q=p")).json()) as { results: unknown[] };
    expect(short.results).toEqual([]);
  });
});

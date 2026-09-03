import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import {
  registerWikiRoutes,
  __resetWikiDigestCacheForTest,
  __seedWikiDigestForTest,
  __setSimilarSearchForTest,
  __setSynthesisDraftDepsForTest,
  __setAskChatDepsForTest,
  resolveAskChatTarget,
  type AskChatDeps,
  coerceClientEdits,
  confirmSynthesisCandidate,
  digestCacheDecision,
  isAnnotatablePage,
  resolveExplainPreflight,
  resolveFactcheckPreflight,
  fetchSavedNotes,
  fetchSavedNotesBlock,
  raceTimeout,
  type SavedNotesDeps,
} from "./wiki-routes.ts";
import {
  synthesisTopicKey,
  type SemanticOverlay,
} from "../views/components/wiki-atlas-semantic.ts";
import { slugifyTopicKey } from "../../gardener/doc-page-map.ts";
import { countFactWrappers, stripFactWrappers } from "../../format/markdown-ast.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { WikiIndex, WikiPageMeta } from "../../wiki/store.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { readLogMtimeMs, type WikiDigest } from "../../wiki/digest.ts";
import { EXPLAINER_BRIDGE_MARKER } from "../../wiki/explainer-bridge.ts";
import { ASK_CHAT_SEED_MAX } from "../../wiki/ask-chat.ts";
import {
  FACTCHECK_SENTINEL_START,
  FACTCHECK_SENTINEL_END,
  FACTCHECK_ANSWER_MAX,
  buildFactcheckBlock,
} from "../../wiki/factcheck-context.ts";
import { spliceSentinelBlock, withTrailingNewline } from "../../wiki/append-block.ts";
import { todayOslo } from "../../gardener/util.ts";

/**
 * Route-level tests for the explainer-serving seam `/api/wiki/html`. Uses the
 * legacy `WIKI_DIR` env override (a bare request, no `?wiki=`) so the memoized
 * bot registry is irrelevant — the store resolves the temp dir directly.
 */
describe("GET /api/wiki/html", () => {
  let root: string;
  let app: Hono;
  let prevWikiDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-html-route-"));
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await mkdir(path.join(root, "concepts"), { recursive: true });
    await Bun.write(
      path.join(root, "blogs/Explainer One.html"),
      "<!doctype html><html><head><title>Explainer One</title></head><body>hello</body></html>",
    );
    await Bun.write(
      path.join(root, "concepts/A Concept.md"),
      "---\ntype: concept\ntitle: A Concept\n---\n\nBody.",
    );
    prevWikiDir = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    __resetWikiCacheForTest();
    app = new Hono();
    // The /api/wiki/html tests never touch the ask route, so a stub config is fine.
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevWikiDir;
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("serves an explainer's raw HTML as text/html", async () => {
    const res = await app.request("/api/wiki/html?name=" + encodeURIComponent("Explainer One"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>Explainer One</title>");
  });

  test("appends the Select-to-Explain bridge to the served explainer HTML", async () => {
    const res = await app.request("/api/wiki/html?name=" + encodeURIComponent("Explainer One"));
    const body = await res.text();
    // Original content survives...
    expect(body).toContain("<title>Explainer One</title>");
    // ...and the forwarder is appended at the end.
    expect(body).toContain(EXPLAINER_BRIDGE_MARKER);
    expect(body.trimEnd().endsWith("</script>")).toBe(true);
  });

  test("400 without a name param", async () => {
    const res = await app.request("/api/wiki/html");
    expect(res.status).toBe(400);
  });

  test("404 for a markdown (non-explainer) page", async () => {
    const res = await app.request("/api/wiki/html?name=" + encodeURIComponent("A Concept"));
    expect(res.status).toBe(404);
  });

  test("404 for an unknown page name", async () => {
    const res = await app.request("/api/wiki/html?name=does-not-exist");
    expect(res.status).toBe(404);
  });

  // The explainer view's Connections panel is fed by /api/wiki/page — it must
  // serve explainers (meta + backlinks), not just markdown pages.
  test("/api/wiki/page serves an explainer with its backlinks", async () => {
    await Bun.write(
      path.join(root, "concepts/Linker.md"),
      "---\ntype: concept\ntitle: Linker\n---\n\nSee the [explainer](../blogs/Explainer%20One.html).",
    );
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/page?name=" + encodeURIComponent("Explainer One"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      meta: { type: string };
      backlinks: Array<{ name: string }>;
      outgoing: unknown[];
    };
    expect(data.meta.type).toBe("explainer");
    expect(data.backlinks.map((b) => b.name)).toContain("Linker");
    expect(data.outgoing).toEqual([]);
  });

  // Native .mdx pages are first-class markdown: /api/wiki/page renders them inline
  // (rendered HTML in the payload, non-explainer type so the client never iframes
  // them), with a component from the shared AST and resolved connections.
  test("/api/wiki/page renders a native .mdx page inline with a component + backlinks", async () => {
    await mkdir(path.join(root, "blogs/src"), { recursive: true });
    await Bun.write(
      path.join(root, "blogs/src/Native Page.mdx"),
      [
        "---",
        'title: "Native Page"',
        "tags: [muninn, tracing]",
        "---",
        "",
        "# Native Page",
        "",
        '<Callout tone="good" title="Shipped">',
        "This renders inline, no iframe.",
        "</Callout>",
      ].join("\n"),
    );
    await Bun.write(
      path.join(root, "concepts/Cites Native.md"),
      "---\ntype: concept\ntitle: Cites Native\n---\n\nSee [native](../blogs/src/Native%20Page.mdx).",
    );
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/page?name=" + encodeURIComponent("Native Page"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      meta: { type: string; tags: string[] };
      html: string;
      backlinks: Array<{ name: string }>;
    };
    // Non-explainer type ⇒ the client renders it inline (never an iframe).
    expect(data.meta.type).not.toBe("explainer");
    expect(data.meta.tags).toEqual(["muninn", "tracing"]);
    // Component from the shared AST is rendered, not escaped.
    expect(data.html).toContain('class="callout callout-good"');
    expect(data.html).toContain("This renders inline, no iframe.");
    // Frontmatter never leaks into the rendered body.
    expect(data.html).not.toContain("tags: [muninn");
    // The .md → .mdx relative link resolves onto the .mdx page as a backlink.
    expect(data.backlinks.map((b) => b.name)).toContain("Cites Native");
  });

  // /api/wiki/atlas returns the projected payload (all seven keys) over the same
  // TTL-cached index, and re-reads no wiki page files on a repeat request within
  // the TTL (projection purity — the second call is served from the cached index).
  test("/api/wiki/atlas returns a seven-key payload and re-reads nothing on repeat", async () => {
    await Bun.write(
      path.join(root, "concepts/Skills.md"),
      "---\ntype: concept\n---\n\nThe skills system.",
    );
    await Bun.write(
      path.join(root, "sources/Talk.md"),
      "---\ntype: source\n---\n\n# Talk\n\nSource: YouTube, 2026-03-25 — https://x\n\nLinks [[Skills]].",
    );
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/atlas");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      types: Array<{ key: string }>;
      nodes: Record<string, { name: string; t: string }>;
      monthKeys: string[];
      months: Record<string, string[]>;
      topics: Array<{ name: string; count: number }>;
      trails: unknown[];
      omitted: { byType: Record<string, number>; byMonth: Record<string, number> };
    };
    for (const k of ["types", "nodes", "monthKeys", "months", "topics", "trails", "omitted"]) {
      expect(data).toHaveProperty(k);
    }
    expect(data.types.map((t) => t.key)).toContain("source");
    expect(data.months["2026-03"]).toContain("sources/talk.md");
    expect(data.topics.find((t) => t.name === "Skills")?.count).toBe(1);

    // Delete the wiki dir, then repeat WITHOUT busting the cache: a purely
    // index-projected route serves the same payload with no disk reads.
    await rm(path.join(root, "sources/Talk.md"), { force: true });
    const res2 = await app.request("/api/wiki/atlas");
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as typeof data;
    expect(data2.months["2026-03"]).toContain("sources/talk.md");
  });

  // Colliding-stem navigation: the Atlas tab opens nodes by their exact relPath
  // (a node's payload key), NOT by name — so on a mimir-shaped wiki with several
  // same-stem pages in different folders, a click resolves the INTENDED page
  // rather than the first-stem-match the by-`name` route would return.
  test("/api/wiki/page?relPath resolves a colliding stem to the exact page", async () => {
    await mkdir(path.join(root, "projects/a"), { recursive: true });
    await mkdir(path.join(root, "projects/b"), { recursive: true });
    await Bun.write(
      path.join(root, "projects/a/architecture.md"),
      "---\ntype: concept\ntitle: Architecture\n---\n\nProject A architecture.",
    );
    await Bun.write(
      path.join(root, "projects/b/architecture.md"),
      "---\ntype: concept\ntitle: Architecture\n---\n\nProject B architecture.",
    );
    __resetWikiCacheForTest();

    // The Atlas payload keys both pages distinctly by normalized relPath.
    const atlas = (await (await app.request("/api/wiki/atlas")).json()) as {
      nodes: Record<string, { name: string }>;
    };
    expect(Object.keys(atlas.nodes)).toContain("projects/a/architecture.md");
    expect(Object.keys(atlas.nodes)).toContain("projects/b/architecture.md");

    // relPath navigation opens each page's OWN body — no first-stem shadowing.
    const a = (await (
      await app.request("/api/wiki/page?relPath=" + encodeURIComponent("projects/a/architecture.md"))
    ).json()) as { meta: { relPath: string }; html: string };
    const b = (await (
      await app.request("/api/wiki/page?relPath=" + encodeURIComponent("projects/b/architecture.md"))
    ).json()) as { meta: { relPath: string }; html: string };
    expect(a.meta.relPath).toBe("projects/a/architecture.md");
    expect(a.html).toContain("Project A architecture.");
    expect(b.meta.relPath).toBe("projects/b/architecture.md");
    expect(b.html).toContain("Project B architecture.");

    // The by-name route can only ever return ONE of the two (first-stem-match) —
    // which is exactly why the Atlas navigates by relPath instead.
    const byName = (await (
      await app.request("/api/wiki/page?name=" + encodeURIComponent("architecture"))
    ).json()) as { html: string; error?: string };
    expect(byName.error).toBeUndefined();

    // Missing both params is a 400; an unknown relPath is a clean 404.
    expect((await app.request("/api/wiki/page")).status).toBe(400);
    expect(
      (await app.request("/api/wiki/page?relPath=" + encodeURIComponent("projects/z/nope.md")))
        .status,
    ).toBe(404);
  });

  // A refresh=1 request busts the TTL and re-reads the tree.
  test("/api/wiki/atlas?refresh=1 rebuilds from disk", async () => {
    await Bun.write(path.join(root, "sources/One.md"), "---\ntype: source\n---\n\nOne.");
    __resetWikiCacheForTest();
    const first = (await (await app.request("/api/wiki/atlas")).json()) as {
      nodes: Record<string, unknown>;
    };
    const firstCount = Object.keys(first.nodes).length;
    await Bun.write(path.join(root, "sources/Two.md"), "---\ntype: source\n---\n\nTwo.");
    const refreshed = (await (await app.request("/api/wiki/atlas?refresh=1")).json()) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(refreshed.nodes).length).toBe(firstCount + 1);
  });
});

/**
 * Wiki Ask route resolution. Exercises only the branches that never reach
 * `streamResearchAnswer` (no Huginn / no `claude` spawn): an unknown wiki and a
 * registered wiki with no search collections both emit a clean `app_error` SSE
 * event. Uses a `WIKI_EXTRA` temp wiki (no collections) and resets the memoized
 * registry so the env is picked up deterministically.
 */
describe("GET /api/wiki/ask — resolution errors", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-ask-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `askwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 without a q param", async () => {
    const res = await app.request("/api/wiki/ask?wiki=askwiki");
    expect(res.status).toBe(400);
  });

  test("registered wiki with no collections → app_error SSE", async () => {
    const res = await app.request("/api/wiki/ask?wiki=askwiki&q=hello");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No search collection connected");
    expect(body).toContain("event: end");
  });

  test("unknown wiki → app_error SSE", async () => {
    const res = await app.request("/api/wiki/ask?wiki=does-not-exist&q=hello");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki configured");
  });
});

/**
 * `POST /api/wiki/remember` resolution branches that never reach the DB / Haiku
 * router: missing question/answer are 400, an unknown wiki is 404. The distill /
 * save happy path and the no-mapping 409 both touch `getBotDefaultUser` (DB) and
 * the Haiku router, which have no injection seam here — same discipline as the
 * Ask-route tests (which only cover branches that never spawn / hit Huginn). Those
 * are covered by the live smoke.
 */
describe("POST /api/wiki/remember — resolution branches", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  const post = (query: string, body: unknown) =>
    app.request("/api/wiki/remember" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-remember-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `remwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 when question is missing/empty", async () => {
    const res = await post("?wiki=remwiki", { answer: "an answer" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("question");
  });

  test("400 when answer is missing/empty", async () => {
    const res = await post("?wiki=remwiki", { question: "a question", answer: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("answer");
  });

  test("404 for an unknown wiki (before any DB touch)", async () => {
    const res = await post("?wiki=does-not-exist", { question: "q", answer: "a" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("no wiki configured");
  });
});

/**
 * `coerceClientEdits` — the apply route's client-payload validator. It must stay
 * at PARITY with `parseEditList` (the model-side entry into the SAME write path):
 * both reject a blank anchor and an EMPTY `new` (a silent deletion), both
 * normalize a bare ⚠, both trim `reason`, both neutralize injected sentinels.
 */
describe("coerceClientEdits — client-payload parity with parseEditList", () => {
  const ok = { claimIndex: 2, verdict: "⚠", old: "ships 4M units", new: "ships 2.1M", reason: " f " };

  test("accepts a well-formed list, normalizing ⚠ → ⚠️ and trimming the reason", () => {
    const edits = coerceClientEdits([ok])!;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.verdict).toBe("⚠️");
    expect(edits[0]!.reason).toBe("f");
    expect(edits[0]!.claimIndex).toBe(2);
  });

  test("rejects the malformed shapes wholesale (null ⇒ the route's 400)", () => {
    expect(coerceClientEdits(null)).toBeNull();
    expect(coerceClientEdits([])).toBeNull();
    expect(coerceClientEdits(["not an object"])).toBeNull();
    expect(coerceClientEdits([[]])).toBeNull(); // an array is not an edit object
    expect(coerceClientEdits([{ ...ok, old: "   " }])).toBeNull(); // whitespace-only anchor
    expect(coerceClientEdits([{ ...ok, old: undefined }])).toBeNull();
    expect(coerceClientEdits([{ ...ok, new: "" }])).toBeNull(); // empty ⇒ silent deletion
    expect(coerceClientEdits([{ ...ok, new: undefined }])).toBeNull();
  });

  test("neutralizes injected fact-check sentinels in `new`", () => {
    const edits = coerceClientEdits([
      { ...ok, new: `fixed ${FACTCHECK_SENTINEL_START} text ${FACTCHECK_SENTINEL_END}` },
    ])!;
    expect(edits[0]!.new).not.toContain(FACTCHECK_SENTINEL_START);
    expect(edits[0]!.new).not.toContain(FACTCHECK_SENTINEL_END);
    expect(edits[0]!.new).toContain("factcheck:start");
  });
});

/**
 * The integrate routes' cheap rejection branches — every one of these fires
 * BEFORE the 90s one-shot / before the write queue, so none of them needs a model
 * or a DB. The happy paths are covered by `integrate-edits.test.ts` (the pure
 * engine) + `page-write.test.ts` (the write sequence) + the live smoke.
 */
describe("integrate routes — pre-model / pre-write rejections", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  const post = (path_: string, body: unknown) =>
    app.request(path_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const editsFor = (old: string, nw: string) => [
    { claimIndex: 1, verdict: "❌", old, new: nw, reason: "filing" },
  ];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-integrate-route-"));
    await Bun.write(path.join(root, "Widgets.md"), "# Widgets\n\nThe device ships 4M units.\n");
    await Bun.write(path.join(root, "index.md"), "# Index\n\n- [[Widgets]]\n");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `intwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("propose on index.md is a clean 400 — never a spent one-shot", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "index",
      answer: "### ❌ Claim 1/1 — Wrong\n\nIt is wrong.",
      baseHash: "whatever",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("reserved wiki infrastructure");
  });

  test("apply on index.md is the SAME 400, not the confinement 500", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "index",
      baseHash: "whatever",
      edits: editsFor("Index", "Catalog"),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("reserved wiki infrastructure");
  });

  test("apply rejects an empty `new` before touching the page", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: "whatever",
      edits: editsFor("ships 4M units", ""),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("non-empty");
    // The page is untouched — an empty replacement never became a deletion.
    expect(await Bun.file(path.join(root, "Widgets.md")).text()).toContain("ships 4M units");
  });

  test("apply enforces INTEGRATE_BODY_MAX with the same copy as propose", async () => {
    await Bun.write(path.join(root, "Widgets.md"), `# Widgets\n\n${"prose ".repeat(6000)}\n`);
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: "whatever",
      edits: editsFor("prose prose", "text text"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; max: number };
    expect(body.error).toBe("page too long to integrate");
    expect(body.max).toBe(24_000);
  });

  test("apply 409s a stale baseHash without writing", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: "deadbeef",
      edits: editsFor("ships 4M units", "ships 2.1M units"),
    });
    expect(res.status).toBe(409);
    expect(await Bun.file(path.join(root, "Widgets.md")).text()).toContain("ships 4M units");
  });

  // ── PR 2 additive fields ───────────────────────────────────────────────────
  // Both reachable without a model call: `hasSentinelBlock` rides the zero-claims
  // early return (which precedes bot resolution), and apply never calls a model.

  const hashOf = async (rel: string) =>
    createHash("sha256").update(await Bun.file(path.join(root, rel)).text()).digest("hex");

  test("propose reports hasSentinelBlock:false for a page with no prior callout", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.", // no ❌/⚠️ ⇒ early return, no one-shot
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hasSentinelBlock: boolean }).toMatchObject({
      edits: [],
      hasSentinelBlock: false,
    });
  });

  test("propose reports hasSentinelBlock:true once the page carries a fact-check block", async () => {
    await Bun.write(
      path.join(root, "Widgets.md"),
      `# Widgets\n\nThe device ships 4M units.\n\n${FACTCHECK_SENTINEL_START}\n> [!factcheck] old\n${FACTCHECK_SENTINEL_END}\n`,
    );
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasSentinelBlock: boolean }).hasSentinelBlock).toBe(true);
  });

  test("propose's supersede count is what apply's strip will remove — appendix-quoted marks included", async () => {
    // All-✅ on an ANNOTATABLE `.mdx` page: the relaxed gate lets the request past
    // the zero-claims early return WITHOUT resolving a synthesis bot or spending a
    // one-shot (`claims.length > 0` gates both), so the full response — and with it
    // `supersededNote` — is reachable model-free.
    //
    // The number must be what apply's `stripFactWrappers(raw)` removes from the
    // WHOLE body, appendix included: 3, not the 2 a region-stripped count reports.
    const body = [
      "---",
      "type: source",
      "title: Marked",
      "---",
      "",
      "# Marked",
      "",
      'It <Fact n="1" v="bad">ships 4M units</Fact> a year.',
      "",
      'Its shell is <Fact n="2" v="warn">one billet</Fact>.',
      "",
      FACTCHECK_SENTINEL_START,
      '<FactCheck date="2026-08-01" bad="1">',
      "",
      "### ❌ Claim 1/1 — Mass",
      "",
      'Was: it <Fact n="3" v="bad">weighs 9 kg</Fact> dry.',
      "</FactCheck>",
      FACTCHECK_SENTINEL_END,
      "",
    ].join("\n");
    await Bun.write(path.join(root, "Marked.mdx"), body);
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Marked",
      answer: "### ✅ Claim 1/1 — Units\n\nAll good.",
      baseHash: createHash("sha256").update(body).digest("hex"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { supersededNote?: string; annotatable?: boolean };
    expect(json.annotatable).toBe(true);
    expect(json.supersededNote).toContain("3 marks from a previous check superseded");
    // The claim the note makes, checked against the strip apply actually runs.
    expect(countFactWrappers(body) - countFactWrappers(stripFactWrappers(body))).toBe(3);
  });

  // ── Claim quotes (PR 2) ────────────────────────────────────────────────────
  // Also reachable on the zero-claims early return, so no model call is spent.

  test("propose echoes validated claim quotes", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/2 — Right\n\nAll good.\n\n### ✅ Claim 2/2 — Also right\n\nFine.",
      baseHash: await hashOf("Widgets.md"),
      quotes: [{ index: 2, quote: "The device ships 4M units." }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { quotes: unknown[] }).toMatchObject({
      quotes: [{ index: 2, quote: "The device ships 4M units." }],
    });
  });

  test("propose drops a misaligned quote list whole and says so — still a 200", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
      // Claim 2 does not exist in this answer — an off-by-one here would later
      // paint a passage with the wrong claim's verdict.
      quotes: [{ index: 2, quote: "The device ships 4M units." }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: unknown[]; quotesNote?: string };
    expect(body.quotes).toEqual([]);
    expect(body.quotesNote).toContain("matches no claim");
  });

  test("propose without quotes reports an empty list and no note", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotes: unknown[]; quotesNote?: string };
    expect(body.quotes).toEqual([]);
    expect(body.quotesNote).toBeUndefined();
  });

  test("apply with appendCallout writes the edits AND the callout in ONE write", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: "Mostly right.\n\n### ❌ Claim 1/1 — Ships 4M units\n\nThe filing reports 2.1M.",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { applied: number; calloutAdded: boolean }).toMatchObject({
      applied: 1,
      calloutAdded: true,
      committed: false, // a bare temp dir is not a git repo
      reason: "not-a-repo",
    });
    const written = await Bun.file(path.join(root, "Widgets.md")).text();
    expect(written).toContain("ships 2.1M units"); // the prose edit landed
    expect(written).not.toContain("ships 4M units");
    expect(written).toContain(FACTCHECK_SENTINEL_START); // …and so did the callout
    expect(written).toContain("The filing reports 2.1M.");
  });

  test("apply with appendCallout REPLACES an existing block instead of stacking one", async () => {
    await Bun.write(
      path.join(root, "Widgets.md"),
      `# Widgets\n\nThe device ships 4M units.\n\n${FACTCHECK_SENTINEL_START}\n> [!factcheck] stale\n> Older verdicts.\n${FACTCHECK_SENTINEL_END}\n`,
    );
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: "### ❌ Claim 1/1 — Ships 4M units\n\nFresh verdict.",
    });
    expect(res.status).toBe(200);
    const written = await Bun.file(path.join(root, "Widgets.md")).text();
    expect(written.split(FACTCHECK_SENTINEL_START).length - 1).toBe(1);
    expect(written).toContain("Fresh verdict.");
    expect(written).not.toContain("Older verdicts.");
  });

  test("apply without appendCallout writes prose only (no callout regression)", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { calloutAdded: boolean }).calloutAdded).toBe(false);
    const written = await Bun.file(path.join(root, "Widgets.md")).text();
    expect(written).toContain("ships 2.1M units");
    expect(written).not.toContain(FACTCHECK_SENTINEL_START);
  });

  test("appendCallout without an answer is a 400 — never a callout-less silent write", async () => {
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("answer is required");
    expect(await Bun.file(path.join(root, "Widgets.md")).text()).toContain("ships 4M units");
  });

  test("one combined callout+edits write produces exactly ONE log.md entry", async () => {
    await Bun.write(path.join(root, "log.md"), "# Log\n");
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: "### ❌ Claim 1/1 — Ships 4M units\n\nThe filing reports 2.1M.",
    });
    expect(res.status).toBe(200);
    // ONE commit attempt too — a single `CommitWikiResult` rides the outcome
    // (`not-a-repo` on a bare temp dir), never one per spliced artefact.
    expect((await res.json()) as { committed: boolean; reason: string }).toMatchObject({
      committed: false,
      reason: "not-a-repo",
    });
    const logText = await Bun.file(path.join(root, "log.md")).text();
    // ONE write ⇒ ONE entry: the callout must ride the edits' write, never a
    // second POST (which would 409 anyway, the edits having staled the baseHash).
    expect(logText.split("factcheck-integrate").length - 1).toBe(1);
    // …and the entry names the callout variant.
    expect(logText).toContain("(with summary callout)");
  });

  test("an edits-only write logs the plain variant, once", async () => {
    await Bun.write(path.join(root, "log.md"), "# Log\n");
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
    });
    expect(res.status).toBe(200);
    const logText = await Bun.file(path.join(root, "log.md")).text();
    expect(logText.split("factcheck-integrate").length - 1).toBe(1);
    expect(logText).toContain("fact-check corrections integrated via the wiki reader");
    expect(logText).not.toContain("(with summary callout)");
  });

  test("both branches end the file with exactly one trailing newline", async () => {
    // Byte parity: ticking the callout checkbox must not be the reason an
    // unrelated trailing byte changed.
    const noNewline = "# Widgets\n\nThe device ships 4M units.";
    await Bun.write(path.join(root, "Widgets.md"), noNewline);
    __resetWikiCacheForTest();
    let res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
    });
    expect(res.status).toBe(200);
    let written = await Bun.file(path.join(root, "Widgets.md")).text();
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);

    await Bun.write(path.join(root, "Widgets.md"), noNewline);
    __resetWikiCacheForTest();
    res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: "### ❌ Claim 1/1 — Ships 4M units\n\nThe filing reports 2.1M.",
    });
    expect(res.status).toBe(200);
    written = await Bun.file(path.join(root, "Widgets.md")).text();
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);
  });

  test("an over-cap answer is a 400 naming the bound — at BOTH write routes", async () => {
    const huge = "x".repeat(FACTCHECK_ANSWER_MAX + 1);
    const hash = await hashOf("Widgets.md");
    const apply = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: hash,
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: huge,
    });
    expect(apply.status).toBe(400);
    expect(((await apply.json()) as { error: string }).error).toContain(String(FACTCHECK_ANSWER_MAX));
    const append = await post("/api/wiki/factcheck/append?wiki=intwiki", {
      page: "Widgets",
      baseHash: hash,
      answer: huge,
    });
    expect(append.status).toBe(400);
    expect(((await append.json()) as { error: string }).error).toContain(String(FACTCHECK_ANSWER_MAX));
    // Neither route wrote anything.
    expect(await Bun.file(path.join(root, "Widgets.md")).text()).toContain("ships 4M units");
  });

  test("an answer AT the cap still writes (the bound is inclusive)", async () => {
    const atCap = "### ❌ Claim 1/1 — Ships 4M units\n\n" + "x".repeat(FACTCHECK_ANSWER_MAX - 45);
    expect(atCap.length).toBeLessThanOrEqual(FACTCHECK_ANSWER_MAX);
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("ships 4M units", "ships 2.1M units"),
      appendCallout: true,
      answer: atCap,
    });
    expect(res.status).toBe(200);
  });

  test("propose reports hasSentinelBlock:false for an ORPHAN start sentinel", async () => {
    // A bare `includes(START)` said true here, defaulting the reader's refresh
    // checkbox ON for a page with no block to replace.
    await Bun.write(
      path.join(root, "Widgets.md"),
      `# Widgets\n\n${FACTCHECK_SENTINEL_START}\n> half-written\n\nThe device ships 4M units.\n`,
    );
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate?wiki=intwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasSentinelBlock: boolean }).hasSentinelBlock).toBe(false);
  });

  test("a zero-resolving apply stays a clean no-op even with appendCallout set", async () => {
    const before = await Bun.file(path.join(root, "Widgets.md")).text();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=intwiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: editsFor("text that is not on the page", "replacement"),
      appendCallout: true,
      answer: "### ❌ Claim 1/1 — Nope\n\nUnfindable.",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { applied: number; calloutAdded: boolean }).toMatchObject({
      applied: 0,
      calloutAdded: false,
    });
    expect(await Bun.file(path.join(root, "Widgets.md")).text()).toBe(before);
  });
});

/**
 * `/api/wiki/index-coverage` resolution branches that never hit huginn: an
 * unknown wiki and a registered wiki with no backing collections both return a
 * clean 200 + `{ error }` with null coverage fields (never a 5xx). The happy path
 * (real collection listings) is covered at the unit level on `buildIndexCoverageResponse`.
 */
describe("GET /api/wiki/index-coverage — resolution branches", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-idxcov-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `covwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("registered wiki with no collections → 200 + clean error, null coverage", async () => {
    const res = await app.request("/api/wiki/index-coverage?wiki=covwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; totalMd: number | null; indexed: number | null };
    expect(body.error).toContain("no search collection connected");
    expect(body.totalMd).toBeNull();
    expect(body.indexed).toBeNull();
  });

  test("unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/index-coverage?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });
});

/**
 * `/api/wiki/reindex` + `/api/wiki/reindex-status` resolution branches that never
 * hit huginn: an unknown wiki and a registered wiki with no backing collections
 * both return a clean 200 + `{ collections: [], error }` (never a 5xx). The huginn
 * fan-out + 409/unknown mapping is covered at the unit level on `src/wiki/reindex.ts`.
 */
describe("wiki reindex routes — resolution branches", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-reindex-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `rixwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("POST reindex, wiki with no collections → 200 + clean error, empty collections", async () => {
    const res = await app.request("/api/wiki/reindex?wiki=rixwiki", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; collections: unknown[] };
    expect(body.error).toContain("no search collection connected");
    expect(body.collections).toEqual([]);
  });

  test("POST reindex, unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("GET reindex-status, wiki with no collections → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex-status?wiki=rixwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; collections: unknown[] };
    expect(body.error).toContain("no search collection connected");
    expect(body.collections).toEqual([]);
  });

  test("GET reindex-status, unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex-status?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });
});

/**
 * `/api/wiki/similar` — semantic cousins for a page. The Huginn search is
 * injected via `__setSimilarSearchForTest`, so happy / self-exclusion /
 * unresolved-drop / huginn-down all run without a live Huginn. No-collections
 * and unknown-wiki resolution branches (clean 404s) need no injection.
 */
describe("GET /api/wiki/similar", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-similar-route-"));
    await mkdir(path.join(root, "sub"), { recursive: true });
    await Bun.write(path.join(root, "Current.md"), "---\ntype: concept\ntitle: Current\n---\n\nBody of current.");
    await Bun.write(path.join(root, "Cousin A.md"), "---\ntype: concept\ntitle: Cousin A\n---\n\nBody A.");
    await Bun.write(path.join(root, "sub/Cousin B.md"), "---\ntype: concept\ntitle: Cousin B\n---\n\nBody B.");
    await Bun.write(
      path.join(root, "sub/An Explainer.html"),
      '<!doctype html><html><head><title>An Explainer</title>' +
        '<meta name="keywords" content="Corrective RAG, Retrieval">' +
        '<meta name="description" content="Head meta description prose.">' +
        "</head><body>hello</body></html>",
    );
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki WITH a collection (3rd segment) so similar can search.
    process.env.WIKI_EXTRA = `simwiki=${root}=simcoll`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setSimilarSearchForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("happy path resolves hits to wiki pages, ordered by relevance", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.5 },
        { collection: "simcoll", id: "sub/Cousin B.md", relevance: 0.9 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { similar: { name: string; title: string; relPath: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin B", "Cousin A"]);
  });

  test("excludes the current page from its own similar list", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "Current.md", relevance: 0.99 },
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.4 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    const body = (await res.json()) as { similar: { title: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin A"]);
  });

  test("drops hits that don't resolve to a wiki page", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "external/not-in-wiki.md", title: "Nope", relevance: 0.8 },
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.3 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    const body = (await res.json()) as { similar: { title: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin A"]);
  });

  test("wiki with no collections → clean 404", async () => {
    process.env.WIKI_EXTRA = `nocoll=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/similar?wiki=nocoll&page=Current");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no search collection connected");
  });

  test("unknown wiki → clean 404", async () => {
    const res = await app.request("/api/wiki/similar?wiki=does-not-exist&page=Current");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("missing page param → 400", async () => {
    const res = await app.request("/api/wiki/similar?wiki=simwiki");
    expect(res.status).toBe(400);
  });

  test("explainer sends the enriched query (title + tags + head description)", async () => {
    let seenPath = "";
    __setSimilarSearchForTest(async (_baseUrl, p) => {
      seenPath = p;
      return { results: [] };
    });
    const res = await app.request(
      "/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("An Explainer"),
    );
    expect(res.status).toBe(200);
    const q = new URLSearchParams(seenPath.split("?")[1]).get("q")!;
    expect(q).toContain("An Explainer");
    expect(q).toContain("corrective-rag retrieval");
    expect(q).toContain("Head meta description prose");
  });

  test("page-list payload carries tags + description for explainers", async () => {
    const res = await app.request("/api/wiki/pages?wiki=simwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: { name: string; type: string; tags: string[]; description?: string }[];
    };
    const ex = body.pages.find((p) => p.name === "An Explainer")!;
    expect(ex.type).toBe("explainer");
    expect(ex.tags).toEqual(["corrective-rag", "retrieval"]);
    expect(ex.description).toBe("Head meta description prose.");
  });

  test("huginn down → 200 with empty similar (section hides, page never errors)", async () => {
    __setSimilarSearchForTest(async () => {
      throw new Error("Knowledge API unreachable");
    });
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { similar: unknown[] };
    expect(body.similar).toEqual([]);
  });
});

/**
 * `/api/wiki/explain` — Select-to-Explain. Sibling of the Ask route. Like the Ask
 * tests, we exercise only the seams the code allows without a live Huginn/`claude`:
 * the 400s for missing params, the `app_error` preflights (unknown wiki / no
 * collections / missing index / unknown page), the status-200 explainer case (now
 * supported via htmlToText — preflight-removal proven in the pure
 * `resolveExplainPreflight` tests), and the risk-note-4 behavioral check that a
 * THROWING similar-search fn still reaches
 * `streamResearchSSE` without a 500. All prompt-composition assertions live in the
 * pure `explain-context.test.ts` — the route stays a thin I/O shell here.
 */
describe("GET /api/wiki/explain — resolution + preflight", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-explain-route-"));
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    await Bun.write(
      path.join(root, "blogs/An Explainer.html"),
      "<!doctype html><html><head><title>An Explainer</title></head><body>hi</body></html>",
    );
    prevExtra = process.env.WIKI_EXTRA;
    // explwiki: has a collection (page-level preflights reachable).
    // nocoll:   same dir, no collection.
    // badidx:   has a collection but points at a missing dir (index unloadable).
    process.env.WIKI_EXTRA =
      `explwiki=${root}=explcoll,nocoll=${root},badidx=${path.join(root, "missing-subdir")}=badcoll`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setSimilarSearchForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 without a sel param", async () => {
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&page=" + encodeURIComponent("A Concept"),
    );
    expect(res.status).toBe(400);
  });

  test("400 without a page param", async () => {
    const res = await app.request("/api/wiki/explain?wiki=explwiki&sel=hello");
    expect(res.status).toBe(400);
  });

  test("unknown wiki → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=does-not-exist&sel=hi&page=X");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki configured");
    expect(body).toContain("event: end");
  });

  test("wiki with no collections → app_error SSE", async () => {
    const res = await app.request(
      "/api/wiki/explain?wiki=nocoll&sel=hi&page=" + encodeURIComponent("A Concept"),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No search collection connected");
  });

  test("missing/unloadable index → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=badidx&sel=hi&page=X");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("wiki directory not found");
  });

  test("unknown page → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=explwiki&sel=hi&page=Nope");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki page named");
    expect(body).toContain("Nope");
  });

  test("explainer page → 200 SSE (now supported via htmlToText, no preflight-out)", async () => {
    // Explainers are no longer preflighted out. We assert only the status —
    // reading the body would drive the real (unreachable) synthesis path, and a
    // status-only check cannot distinguish old (app_error) from new (synthesis)
    // anyway; the preflight-removal proof lives in the pure resolveExplainPreflight
    // unit tests below.
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&sel=hi&page=" + encodeURIComponent("An Explainer"),
    );
    expect(res.status).toBe(200);
  });

  test("throwing similar search still reaches streamResearchSSE without a 500", async () => {
    // risk-note-4: a thrown similar-search degrades to no Related-pages context and
    // the request still streams (returns a 200 SSE Response). We assert only the
    // status — reading the body would drive the real (unreachable) synthesis path.
    __setSimilarSearchForTest(async () => {
      throw new Error("Huginn unreachable");
    });
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&page=" +
        encodeURIComponent("A Concept") +
        "&sel=" +
        encodeURIComponent("Body."),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Pure preflight decision chain for `/api/wiki/explain`. This is the seam that
 * proves the explainer-preflight REMOVAL: an explainer meta yields `null` (no
 * error), while the unknown-wiki / no-collections / unknown-page branches are
 * unchanged. A status-only route test can't show this (both old and new paths
 * are 200, and reading the body drives the unreachable synthesis path).
 */
describe("resolveExplainPreflight", () => {
  const entry = { name: "w", root: "/x", source: "extra", collections: ["c"] } as WikiRegistryEntry;
  const index = {} as WikiIndex;
  const mdMeta = { type: "concept" } as WikiPageMeta;
  const explainerMeta = { type: "explainer" } as WikiPageMeta;

  test("explainer meta → null (no more preflight-out)", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: explainerMeta, page: "P" }),
    ).toBeNull();
  });

  test("markdown meta → null", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: mdMeta, page: "P" }),
    ).toBeNull();
  });

  test("unknown wiki → configured error (interpolates the raw wiki name)", () => {
    expect(
      resolveExplainPreflight({
        wiki: "ghost",
        unknownWiki: true,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
      }),
    ).toBe('No wiki configured for "ghost".');
  });

  test("no entry with blank wiki → (none) fallback", () => {
    expect(
      resolveExplainPreflight({
        wiki: "",
        unknownWiki: false,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
      }),
    ).toBe('No wiki configured for "(none)".');
  });

  test("entry with no collections → no-collection error", () => {
    const noColl = { name: "w", root: "/x", source: "extra" } as WikiRegistryEntry;
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry: noColl, index: null, meta: undefined, page: "P" }),
    ).toBe("No search collection connected for this wiki.");
  });

  test("unloadable index → directory-not-found error", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index: null, meta: undefined, page: "P" }),
    ).toBe("wiki directory not found");
  });

  test("unknown page → named error (interpolates the page)", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: undefined, page: "Nope" }),
    ).toBe('No wiki page named "Nope".');
  });
});

/**
 * `resolveFactcheckPreflight` — the fact-check decision chain, extracted for the
 * same reason `resolveExplainPreflight` was AND because the claim-retry route
 * (`GET /api/wiki/factcheck/claim`) runs the identical chain: the web-tools
 * connector check must not exist twice. Table-driven over the five outcomes the
 * chain can produce, plus the two things a status-only route assertion can never
 * show — that collections are deliberately NOT required (fact-check is
 * corpus-independent) and that a bot-less wiki is not reported as a connector
 * problem (the scaffold's "no bots configured" app_error owns that).
 */
describe("resolveFactcheckPreflight", () => {
  const entry = { name: "w", root: "/x", source: "extra", collections: ["c"] } as WikiRegistryEntry;
  const index = {} as WikiIndex;
  const meta = { type: "concept" } as WikiPageMeta;
  const webBot = { name: "jarvis", connector: "claude-sdk" } as BotConfig;
  const noWebBot = { name: "melosys", connector: "copilot-sdk" } as BotConfig;
  const base = { wiki: "w", unknownWiki: false, entry, index, meta, page: "P" };

  test("happy path (web-tools connector) → null", () => {
    expect(resolveFactcheckPreflight({ ...base, botConfig: webBot })).toBeNull();
  });

  test("unknown wiki → configured error (interpolates the raw wiki name)", () => {
    expect(
      resolveFactcheckPreflight({
        wiki: "ghost",
        unknownWiki: true,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
        botConfig: webBot,
      }),
    ).toBe('No wiki configured for "ghost".');
  });

  test("no entry with blank wiki → (none) fallback", () => {
    expect(
      resolveFactcheckPreflight({
        wiki: "",
        unknownWiki: false,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
        botConfig: webBot,
      }),
    ).toBe('No wiki configured for "(none)".');
  });

  test("unloadable index → directory-not-found error", () => {
    expect(
      resolveFactcheckPreflight({ ...base, index: null, meta: undefined, botConfig: webBot }),
    ).toBe("wiki directory not found");
  });

  test("unknown page → named error (interpolates the page)", () => {
    expect(
      resolveFactcheckPreflight({ ...base, meta: undefined, page: "Nope", botConfig: webBot }),
    ).toBe('No wiki page named "Nope".');
  });

  test("non-web connector → the web-tools refusal, naming the bot", () => {
    const err = resolveFactcheckPreflight({ ...base, botConfig: noWebBot });
    expect(err).toContain("melosys");
    expect(err).toContain("no web tools");
  });

  test("a collection-less wiki is NOT a preflight error (fact-check is corpus-independent)", () => {
    const noColl = { name: "w", root: "/x", source: "extra" } as WikiRegistryEntry;
    expect(
      resolveFactcheckPreflight({ ...base, entry: noColl, botConfig: webBot }),
    ).toBeNull();
  });

  test("no bot resolved → null (the scaffold reports 'no bots configured', not a connector fault)", () => {
    expect(resolveFactcheckPreflight({ ...base, botConfig: null })).toBeNull();
    expect(resolveFactcheckPreflight({ ...base, botConfig: undefined })).toBeNull();
  });
});

/**
 * `isAnnotatablePage` — the inline-`<Fact>` POLICY predicate. `renderWikiHtml` is
 * extension-agnostic, so this is not about what CAN render: `.md` pages are read raw
 * outside the reader (GitHub) and deliberately keep the blockquote callout form.
 */
describe("isAnnotatablePage", () => {
  test("native .mdx pages are annotatable", () => {
    expect(isAnnotatablePage("plans/thing.mdx", "plan")).toBe(true);
    expect(isAnnotatablePage("Deep Dive.mdx", "note")).toBe(true);
  });

  test(".md pages are NOT annotatable (policy — they render raw on GitHub)", () => {
    expect(isAnnotatablePage("concepts/thing.md", "concept")).toBe(false);
    expect(isAnnotatablePage("index.md", "note")).toBe(false);
  });

  test("explainers and other extensions are never annotatable", () => {
    expect(isAnnotatablePage("blogs/x.html", "explainer")).toBe(false);
    // Belt-and-braces: a type/extension mismatch can't opt an explainer in.
    expect(isAnnotatablePage("blogs/x.mdx", "explainer")).toBe(false);
    expect(isAnnotatablePage("notes/x.txt", "note")).toBe(false);
    expect(isAnnotatablePage("mdx", "note")).toBe(false);
  });
});

/**
 * Saved-notes injection helper (PR C). `fetchSavedNotes` is fully injectable, so
 * the load-bearing branches — the null-embedding guard, no-mapping skip, throwing
 * lookup, and the `wiki-note` tag scoping — are unit-tested here without a DB. The
 * `raceTimeout` bound (a hanging lookup degrades to the fallback within budget) is
 * tested directly with a short override.
 */
describe("fetchSavedNotes", () => {
  const baseDeps = (over: Partial<SavedNotesDeps> = {}): SavedNotesDeps => ({
    botName: "jarvis",
    question: "what is corrective retrieval?",
    getBotDefaultUser: async () => "user-1",
    generateEmbedding: async () => Array.from({ length: 384 }, () => 0.1),
    searchMemoriesHybrid: async () => [{ content: "a saved note" }],
    ...over,
  });

  test("happy path scopes the search to the wiki-note tag, limit 5", async () => {
    let seen: { userId?: string; limit?: number; botName?: string; tags?: string[] } = {};
    const notes = await fetchSavedNotes(
      baseDeps({
        searchMemoriesHybrid: async (userId, _q, _emb, limit, botName, tags) => {
          seen = { userId, limit, botName, tags };
          return [{ content: "a saved note" }];
        },
      }),
    );
    expect(notes).toEqual([{ content: "a saved note" }]);
    expect(seen.userId).toBe("user-1");
    expect(seen.limit).toBe(5);
    expect(seen.botName).toBe("jarvis");
    expect(seen.tags).toEqual(["wiki-note"]);
  });

  test("null-embedding guard: bails to [] WITHOUT calling searchMemoriesHybrid", async () => {
    let searchCalled = false;
    const notes = await fetchSavedNotes(
      baseDeps({
        generateEmbedding: async () => null,
        searchMemoriesHybrid: async () => {
          searchCalled = true;
          return [{ content: "should not appear" }];
        },
      }),
    );
    expect(notes).toEqual([]);
    expect(searchCalled).toBe(false);
  });

  test("no bot_default_user mapping: skips silently (no embed, no search)", async () => {
    let embedCalled = false;
    const notes = await fetchSavedNotes(
      baseDeps({
        getBotDefaultUser: async () => null,
        generateEmbedding: async () => {
          embedCalled = true;
          return [];
        },
      }),
    );
    expect(notes).toEqual([]);
    expect(embedCalled).toBe(false);
  });

  test("a throwing lookup degrades to [] (never rejects)", async () => {
    const notes = await fetchSavedNotes(
      baseDeps({
        searchMemoriesHybrid: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(notes).toEqual([]);
  });

  test("fetchSavedNotesBlock renders the block, null when empty", async () => {
    const block = await fetchSavedNotesBlock(baseDeps());
    expect(block).toContain("READER'S SAVED WIKI NOTES");
    expect(block).toContain("- a saved note");

    const empty = await fetchSavedNotesBlock(baseDeps({ searchMemoriesHybrid: async () => [] }));
    expect(empty).toBeNull();
  });

  test("raceTimeout: a hanging lookup resolves to the fallback within budget", async () => {
    const hang = new Promise<string | null>(() => {}); // never settles
    const out = await raceTimeout(hang, null, 15);
    expect(out).toBeNull();
  });
});

describe("digestCacheDecision", () => {
  const digest = { logMtimeMs: 1000 } as WikiDigest;

  test("refresh always regenerates, even on a matching mtime", () => {
    expect(digestCacheDecision(digest, 1000, true)).toBe("regenerate");
  });

  test("hit when cached and mtime matches", () => {
    expect(digestCacheDecision(digest, 1000, false)).toBe("hit");
  });

  test("regenerate when mtime differs (log.md changed)", () => {
    expect(digestCacheDecision(digest, 2000, false)).toBe("regenerate");
  });

  test("regenerate when nothing cached", () => {
    expect(digestCacheDecision(undefined, 1000, false)).toBe("regenerate");
  });
});

/**
 * `/api/wiki/digest` route seams that don't require a connector run: a wiki
 * without a `log.md` yields `{ digest: null }`, and a pre-seeded cache whose
 * `logMtimeMs` matches the on-disk `log.md` is served straight back (cache hit,
 * no generation). Uses a `WIKI_EXTRA` temp wiki so there IS a registry entry to
 * resolve (the digest route needs one — the bare `WIKI_DIR` override never
 * claims a wiki). Cache-hit returns the seeded digest, proving no regeneration.
 */
describe("GET /api/wiki/digest", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-digest-route-"));
    await Bun.write(
      path.join(root, "knowledge-graph.md"),
      "---\ntype: concept\ntitle: knowledge-graph\n---\n\nBody.",
    );
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `digwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiDigestCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiDigestCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("wiki without log.md → { digest: null }", async () => {
    const res = await app.request("/api/wiki/digest?wiki=digwiki");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest: null });
  });

  test("cache hit: seeded digest with matching mtime is served (bullets rendered to html)", async () => {
    await Bun.write(
      path.join(root, "log.md"),
      "# Log\n\n## [2026-05-01] note | Init\n\nBody mentions [[knowledge-graph]].",
    );
    const mtime = (await readLogMtimeMs(root))!;
    const seeded: WikiDigest = {
      bullets: "- Grew [[knowledge-graph]]",
      generatedAt: 42,
      logMtimeMs: mtime,
      entryCount: 1,
      fromDate: "2026-05-01",
      toDate: "2026-05-01",
    };
    __seedWikiDigestForTest("digwiki", seeded);
    const res = await app.request("/api/wiki/digest?wiki=digwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digest: (WikiDigest & { html: string }) | null };
    expect(body.digest).not.toBeNull();
    // Same seeded generatedAt ⇒ not regenerated.
    expect(body.digest!.generatedAt).toBe(42);
    expect(body.digest!.bullets).toBe("- Grew [[knowledge-graph]]");
    // The wikilink resolved to a real page ⇒ rendered as an in-reader anchor.
    expect(body.digest!.html).toContain('data-wiki-page="knowledge-graph"');
  });
});

/**
 * `POST /api/wiki/atlas/draft-synthesis` — the consolidation gardener's
 * Draft-synthesis button. Server re-validates candidacy against a fresh overlay
 * (never trusts the client badge), dedups on live topic_keys, and launches the
 * draft detached. These cover the rejection + dedup branches (no bot/model call);
 * the started-happy path is covered live in calibration + the drafter unit tests.
 */
describe("POST /api/wiki/atlas/draft-synthesis", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  // Three plan-type members forming a candidate cluster.
  const members = ["plans/alpha.md", "plans/beta.md", "plans/gamma.md"];
  const candidateOverlay: SemanticOverlay = {
    edges: [
      ["plans/alpha.md", "plans/beta.md", 0.99],
      ["plans/beta.md", "plans/gamma.md", 0.99],
    ],
    communities: [],
    nodeCommunity: {},
    nodeType: { "plans/alpha.md": "plan", "plans/beta.md": "plan", "plans/gamma.md": "plan" },
    nodeTags: {},
  };

  const post = (query: string, body: unknown) =>
    app.request("/api/wiki/atlas/draft-synthesis" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-synth-route-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    for (const [rel, title] of [
      ["plans/alpha.md", "Alpha Plan"],
      ["plans/beta.md", "Beta Plan"],
      ["plans/gamma.md", "Gamma Plan"],
    ] as const) {
      await Bun.write(path.join(root, rel), `---\ntype: plan\ntitle: ${title}\n---\n\nBody.`);
    }
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki WITH a backing collection (mimir-style).
    process.env.WIKI_EXTRA = `synthwiki=${root}=mimir`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setSynthesisDraftDepsForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 when label / members are missing", async () => {
    expect((await post("?wiki=synthwiki", { members })).status).toBe(400);
    expect((await post("?wiki=synthwiki", { label: "X" })).status).toBe(400);
  });

  test("404 for an unknown wiki", async () => {
    const res = await post("?wiki=nope", { label: "Saga", members });
    expect(res.status).toBe(404);
  });

  test("400 (blob guard) for an oversized member payload", async () => {
    const many = Array.from({ length: 45 }, (_, i) => `plans/p${i}.md`);
    const res = await post("?wiki=synthwiki", { label: "Saga", members: many });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("too large");
  });

  test("400 when a member is not a page in this wiki", async () => {
    const res = await post("?wiki=synthwiki", {
      label: "Saga",
      members: ["plans/alpha.md", "plans/ghost.md", "plans/gamma.md"],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not a page");
  });

  test("400 when the members don't form a synthesis candidate", async () => {
    // Overlay with no edges ⇒ no cluster ⇒ not a candidate.
    __setSynthesisDraftDepsForTest({
      getOverlay: async () => ({ ...candidateOverlay, edges: [] }),
    });
    const res = await post("?wiki=synthwiki", { label: "Saga", members });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("candidate");
  });

  test("409 when a live proposal already exists for the topic (dedup)", async () => {
    let drafted = false;
    __setSynthesisDraftDepsForTest({
      getOverlay: async () => candidateOverlay,
      getLiveTopics: async () => [synthesisTopicKey("The Saga")],
      draft: async () => {
        drafted = true;
        return { ok: true, proposal: null, topicKey: synthesisTopicKey("The Saga") };
      },
    });
    const res = await post("?wiki=synthwiki", { label: "The Saga", members });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { state: string }).state).toBe("pending");
    expect(drafted).toBe(false); // never reached the drafter
  });

  test("409 (pending) when an APPLIED proposal already covers the topic (dedup includes applied)", async () => {
    // The POST dedups on the applied-inclusive set (default getLiveOrAppliedTopicKeysByWiki),
    // matching the GET's pending-mark — so a topic that was already APPLIED 409s a re-POST
    // instead of silently re-drafting. Modeled here via the injected getLiveTopics.
    let drafted = false;
    __setSynthesisDraftDepsForTest({
      getOverlay: async () => candidateOverlay,
      getLiveTopics: async () => [synthesisTopicKey("The Saga")], // an applied topic
      draft: async () => {
        drafted = true;
        return { ok: true, proposal: null, topicKey: synthesisTopicKey("The Saga") };
      },
    });
    const res = await post("?wiki=synthwiki", { label: "The Saga", members });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { state: string }).state).toBe("pending");
    expect(drafted).toBe(false);
  });

  test("409 (running) when another draft is already in flight for the same wiki (single-flight)", async () => {
    // Hang the first draft so its in-flight key stays in the set, then POST a
    // DIFFERENT topic on the same wiki — the per-wiki single-flight guard rejects it
    // even though the per-topic key differs (closes the label-drift double-spend).
    __setSynthesisDraftDepsForTest({
      getOverlay: async () => candidateOverlay,
      getLiveTopics: async () => [],
      draft: () => new Promise(() => {}), // never settles ⇒ stays in flight
    });
    const first = await post("?wiki=synthwiki", { label: "The Saga", members });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { state: string }).state).toBe("started");

    const second = await post("?wiki=synthwiki", { label: "A Different Saga", members });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { state: string }).state).toBe("running");
  });
});

describe("synthesis topic_key slug parity", () => {
  test("client synthesisTopicKey matches the server slugifyTopicKey shape", () => {
    for (const s of [
      "The Alpha-Gamma Story",
      "Context Compaction & Retrieval",
      "  Trailing / Slashes  ",
      "Ünïcode Prøse",
      "!!!",
    ]) {
      expect(synthesisTopicKey(s)).toBe(slugifyTopicKey(s));
    }
  });

  test("confirmSynthesisCandidate recomputes candidacy from the overlay", () => {
    const overlay: SemanticOverlay = {
      edges: [
        ["a.md", "b.md", 0.99],
        ["b.md", "c.md", 0.99],
      ],
      communities: [],
      nodeCommunity: {},
      nodeType: { "a.md": "plan", "b.md": "report", "c.md": "plan" },
      nodeTags: {},
    };
    expect(confirmSynthesisCandidate(overlay, ["a.md", "b.md", "c.md"])).toBe(true);
    // A synthesis-type member disqualifies the candidate badge.
    const withBlog: SemanticOverlay = { ...overlay, nodeType: { ...overlay.nodeType, "c.md": "blog" } };
    expect(confirmSynthesisCandidate(withBlog, ["a.md", "b.md", "c.md"])).toBe(false);
    // A subset that isn't itself a component doesn't confirm.
    expect(confirmSynthesisCandidate(overlay, ["a.md", "b.md"])).toBe(false);
  });
});

// The four plan-status fields must survive `toListing` on BOTH read routes.
// `/api/wiki/pages` and `/api/wiki/page` share that one function, so a field
// stripped there for listing-payload size (as `desc`/`pubDate` deliberately are)
// silently goes out of reach of the single-page reader too.
describe("plan-status fields on /api/wiki/pages + /api/wiki/page", () => {
  let root: string;
  let app: Hono;
  let prevWikiDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-planstatus-route-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    await Bun.write(
      path.join(root, "plans/Lifecycle Plan.md"),
      [
        "---",
        'title: "Lifecycle Plan"',
        "plan_status: in-flight",
        "status_date: 2026-07-30",
        "followups: open",
        "status_note: capped at 4 rounds, R4 fixes unreviewed",
        "---",
        "",
        "Plan body.",
      ].join("\n"),
    );
    // A page whose plan_status is invalid: the field must be absent on the wire,
    // never echoed through as an unrecognized string.
    await Bun.write(
      path.join(root, "plans/Bad Status.md"),
      ["---", 'title: "Bad Status"', "plan_status: in_flight", "---", "", "Body."].join("\n"),
    );
    // A linking page, so BOTH `listings()` arrays on the single-page response are
    // non-empty — that is the third `toListing` caller, and the one an `includeDesc`
    // opt-in must never reach.
    await Bun.write(
      path.join(root, "plans/Linker.md"),
      ["---", 'title: "Linker"', "---", "", "Points at [[Lifecycle Plan]]."].join("\n"),
    );
    prevWikiDir = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    __resetWikiCacheForTest();
    __resetWikiRegistryForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevWikiDir;
    __resetWikiCacheForTest();
    __resetWikiRegistryForTest();
    await rm(root, { recursive: true, force: true });
  });

  type PlanListing = {
    name: string;
    plan_status?: string;
    status_date?: string;
    followups?: string;
    status_note?: string;
  };

  test("all four fields survive on /api/wiki/pages", async () => {
    const res = await app.request("/api/wiki/pages");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pages: PlanListing[] };
    const listing = data.pages.find((p) => p.name === "Lifecycle Plan")!;
    expect(listing.plan_status).toBe("in-flight");
    expect(listing.status_date).toBe("2026-07-30");
    expect(listing.followups).toBe("open");
    expect(listing.status_note).toBe("capped at 4 rounds, R4 fixes unreviewed");
    // An invalid value is absent, not echoed through.
    expect(data.pages.find((p) => p.name === "Bad Status")!.plan_status).toBeUndefined();
  });

  test("the page listing is never cacheable", async () => {
    // Not hygiene. The client loads this listing ONCE at boot and never refetches,
    // so it is the only source of the reader's page set — and with no
    // `Cache-Control` at all a browser may heuristically cache it, which made a
    // freshly written page unfindable even by search with the filters cleared, and
    // even after a plain reload. A wiki gains pages constantly (the gardener writes
    // them, so does the user), so this response must never be served from a cache.
    const res = await app.request("/api/wiki/pages");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("all four fields survive on /api/wiki/page's meta", async () => {
    const res = await app.request("/api/wiki/page?name=" + encodeURIComponent("Lifecycle Plan"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { meta: PlanListing };
    expect(data.meta.plan_status).toBe("in-flight");
    expect(data.meta.status_date).toBe("2026-07-30");
    expect(data.meta.followups).toBe("open");
    // The trap this test exists for: `toListing` is shared, so a strip here would
    // put `status_note` out of reach of every single-page client.
    expect(data.meta.status_note).toBe("capped at 4 rounds, R4 fixes unreviewed");
  });

  /**
   * `desc` (the first prose line) is the mirror-image case: opted IN for exactly
   * ONE of `toListing`'s three callers. The Discuss popover shows it as a question
   * hint, and the single-page `meta` is the only place the reader's own page
   * arrives — but the hot listing and the single-page LINK ARRAYS are the payload
   * bulk this field was stripped from in the first place (~100 KB on jarvis).
   */
  describe("desc is scoped to the single-page meta", () => {
    type DescListing = { name: string; desc?: string };

    test("the hot /api/wiki/pages listing never carries it", async () => {
      const res = await app.request("/api/wiki/pages");
      const data = (await res.json()) as { pages: DescListing[] };
      expect(data.pages.length).toBeGreaterThan(0);
      expect(data.pages.some((p) => p.desc !== undefined)).toBe(false);
    });

    test("the single page's own meta DOES carry it", async () => {
      const res = await app.request("/api/wiki/page?name=" + encodeURIComponent("Lifecycle Plan"));
      const data = (await res.json()) as { meta: DescListing };
      expect(data.meta.desc).toBe("Plan body.");
    });

    test("the outgoing/backlink arrays on that same response do NOT", async () => {
      // Opting these in re-bloats exactly the link-heavy pages the strip protects.
      const back = await app.request("/api/wiki/page?name=" + encodeURIComponent("Lifecycle Plan"));
      const backData = (await back.json()) as { meta: DescListing; backlinks: DescListing[] };
      expect(backData.backlinks.map((p) => p.name)).toContain("Linker");
      expect(backData.backlinks.every((p) => p.desc === undefined)).toBe(true);

      const out = await app.request("/api/wiki/page?name=Linker");
      const outData = (await out.json()) as { meta: DescListing; outgoing: DescListing[] };
      // The linking page's own meta still has one, so this isn't a wiki-wide absence.
      expect(outData.meta.desc).toBe("Points at Lifecycle Plan.");
      expect(outData.outgoing.map((p) => p.name)).toContain("Lifecycle Plan");
      expect(outData.outgoing.every((p) => p.desc === undefined)).toBe(true);
    });
  });
});

/**
 * `POST /api/wiki/ask/chat` — the Ask tab's "Continue in chat →" escalation.
 * Every side-effecting seam (bot discovery, chat config, threads, chat state, the
 * pending-message store) is injected via `__setAskChatDepsForTest`, so these run
 * with no DB and no chat process: what's under test is the resolution chain
 * (owning bot → user → thread name → 409/forceNew) and the seeded message.
 */
/**
 * Every ask→chat seam, stubbed to THROW. Both HTTP suites below spread this
 * before their own overrides, so a seam added to `AskChatDeps` later can never
 * silently fall through to the live database in a test that didn't think about
 * it — it fails loudly on first use instead.
 */
const throwingAskChatDeps = (): AskChatDeps => {
  const nope = (seam: string) => () => {
    throw new Error("unstubbed ask-chat seam: " + seam);
  };
  return {
    discoverBots: nope("discoverBots"),
    loadChatConfig: nope("loadChatConfig"),
    getBotDefaultUser: nope("getBotDefaultUser"),
    findThreadByName: nope("findThreadByName"),
    createThread: nope("createThread"),
    setPendingMessage: nope("setPendingMessage"),
    hasPendingMessage: nope("hasPendingMessage"),
    setPendingMessageIfAbsent: nope("setPendingMessageIfAbsent"),
    listConnectors: nope("listConnectors"),
    getPreferredConnector: nope("getPreferredConnector"),
    getConnector: nope("getConnector"),
    getThreadById: nope("getThreadById"),
    updateThreadConnector: nope("updateThreadConnector"),
    findOrCreateConversation: nope("findOrCreateConversation"),
  } as unknown as AskChatDeps;
};

describe("POST /api/wiki/ask/chat", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  // Captured seam traffic.
  let created: { userId: string; botName: string; name: string; description?: string }[];
  let pending: { threadId: string; text: string }[];
  let existingThreadNames: string[];
  /** Descriptions of the threads above, by name — the article-identity tag. */
  let threadDescriptionsByName: Record<string, string | undefined>;
  let users: { id: string; name: string }[];
  let bots: string[];
  let defaultUser: string | null;
  // Connector / existing-thread / pending-store seam state.
  let connectorRows: { id: string; name: string; connectorType: string }[];
  let threadsById: Record<
    string,
    { id: string; userId: string; botName: string; connectorId?: string; description?: string }
  >;
  let livePending: string[];
  let connectorStamps: { threadId: string; connectorId: string | null }[];
  let createdConnectorIds: (string | undefined)[];

  /** Every non-DB seam, so no test can reach the live database. Shared by the
   *  suite's two `__setAskChatDepsForTest` blocks. */
  const fakeDeps = () => ({
    ...throwingAskChatDeps(),
    discoverBots: () => bots.map((name) => ({ name }) as unknown as BotConfig),
    loadChatConfig: async () => ({ users }),
    getBotDefaultUser: async () => defaultUser,
    // Carries the DESCRIPTION, like the real row does — in article mode it is
    // what says whether a name collision is this article's own thread or an
    // unrelated thread that merely owns the name.
    findThreadByName: async (_userId: string, _botName: string, name: string) =>
      existingThreadNames.includes(name)
        ? { id: "existing-thread", name, description: threadDescriptionsByName[name] }
        : null,
    hasPendingMessage: (threadId: string) => livePending.includes(threadId),
    setPendingMessageIfAbsent: (threadId: string, text: string) => {
      if (livePending.includes(threadId)) return false;
      pending.push({ threadId, text });
      return true;
    },
    listConnectors: async () => connectorRows as never,
    getConnector: async (id: string) => (connectorRows.find((r) => r.id === id) ?? null) as never,
    getThreadById: async (id: string) => threadsById[id] ?? null,
    updateThreadConnector: async (threadId: string, connectorId: string | null) => {
      connectorStamps.push({ threadId, connectorId });
      const row = threadsById[threadId];
      if (row) row.connectorId = connectorId ?? undefined;
      return true;
    },
  });

  /** A syntactically valid UUID that names no connector row. */
  const UNKNOWN_UUID = "11111111-2222-4333-8444-555555555555";
  /** A copilot-sdk row — no web tools. */
  const CONNECTOR_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  /** A claude-cli row — web tools. */
  const CLI_CONNECTOR_UUID = "dddddddd-eeee-4fff-8000-111111111111";

  const post = (body: unknown, query = "") =>
    app.request("/api/wiki/ask/chat" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const askBody = (over: Record<string, unknown> = {}) => ({
    wiki: "jarviswiki",
    question: "How does the gardener cluster summaries?",
    answer: "It clusters by topic key, then drafts one page per cluster.",
    citations: [{ pageName: "Wiki Gardener" }, { title: "Ingest backlog" }],
    ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-askchat-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // A standalone wiki (no owner) alongside the fabricated BOT wiki below — the
    // 400 "belongs to no bot" branch needs a real ownerless entry.
    process.env.WIKI_EXTRA = `lonewiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setWikiRegistryForTest([
      { name: "jarviswiki", root, source: "bot" },
      { name: "lonewiki", root, source: "extra" },
      // A standalone wiki carrying a synthesis-bot PIN (the `WIKI_EXTRA` 4th
      // segment) — the real shape of mimir + melosys-kode-wiki on this install.
      { name: "pinnedwiki", root, source: "extra", synthesisBot: "melosys" },
      // …and one whose pin names no discovered bot (must NOT resolve).
      { name: "ghostpinwiki", root, source: "extra", synthesisBot: "not-a-bot" },
      // A standalone wiki WITH backing collections — the direct seed may tell the
      // bot to search this one's own notes, unlike `lonewiki`.
      { name: "collwiki", root, source: "extra", synthesisBot: "melosys", collections: ["wiki"] },
    ]);

    created = [];
    pending = [];
    existingThreadNames = [];
    threadDescriptionsByName = {};
    users = [{ id: "user-1", name: "rune" }];
    bots = ["jarviswiki", "melosys"];
    defaultUser = null;
    connectorRows = [
      { id: CONNECTOR_UUID, name: "Copilot", connectorType: "copilot-sdk" },
      { id: CLI_CONNECTOR_UUID, name: "Sonnet CLI", connectorType: "claude-cli" },
    ];
    threadsById = {};
    livePending = [];
    connectorStamps = [];
    createdConnectorIds = [];

    __setAskChatDepsForTest({
      ...fakeDeps(),
      // Models the DB: a created name is thereafter FOUND, so a second escalation
      // in the same minute collides on the timestamp-suffixed name exactly as it
      // does live (where `createThread`'s ON CONFLICT DO UPDATE would otherwise
      // hand back the first thread).
      createThread: async (userId, botName, name, description, connectorId) => {
        created.push({ userId, botName, name, description });
        createdConnectorIds.push(connectorId);
        existingThreadNames.push(name);
        threadDescriptionsByName[name] = description;
        return { id: "thread-" + created.length };
      },
      setPendingMessage: (threadId, text) => { pending.push({ threadId, text }); },
      findOrCreateConversation: async () => ({ id: "conv-1" }),
    });

    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setAskChatDepsForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 when question or answer is missing", async () => {
    expect((await post(askBody({ question: "  " }))).status).toBe(400);
    expect((await post(askBody({ answer: "" }))).status).toBe(400);
    // A missing answer stays a 400 WITHOUT the explicit direct discriminator: a
    // client bug that drops the answer must not silently escalate a seed framed
    // as if the reader never asked.
    expect((await post(askBody({ answer: undefined }))).status).toBe(400);
    // …and a question is required even in direct mode.
    expect((await post(askBody({ question: " ", answer: undefined, mode: "direct" }))).status)
      .toBe(400);
    expect(created).toHaveLength(0);
  });

  test("404 for an unknown wiki", async () => {
    const res = await post(askBody({ wiki: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  test("happy path: creates a thread on the OWNING bot and seeds the message", async () => {
    const res = await post(askBody());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threadId: string; conversationId: string; chatUrl: string };
    expect(data.threadId).toBe("thread-1");
    expect(data.conversationId).toBe("conv-1");
    // No `&src=wiki`: this body expressed no connector decision (see the
    // stamp-suppression block below), so the chat page's sidebar preference must
    // keep stamping the thread exactly as it always has.
    expect(data.chatUrl).toBe("/chat?bot=jarviswiki&thread=thread-1&user=user-1");

    // The thread belongs to the wiki's OWNER, not a synthesis/research fallback.
    expect(created).toHaveLength(1);
    expect(created[0]!.botName).toBe("jarviswiki");
    expect(created[0]!.userId).toBe("user-1");
    expect(created[0]!.name).toBe("how does the gardener cluster summaries?");

    // Seed: question + quoted answer + sources, on the created thread.
    expect(pending).toHaveLength(1);
    expect(pending[0]!.threadId).toBe("thread-1");
    expect(pending[0]!.text).toContain("How does the gardener cluster summaries?");
    expect(pending[0]!.text).toContain("> It clusters by topic key, then drafts one page per cluster.");
    expect(pending[0]!.text).toContain("Sources cited by the wiki: Wiki Gardener · Ingest backlog");
  });

  test("thread name is truncated to createThread's 50-char limit", async () => {
    const question =
      "What exactly happens when the wiki gardener drains the whole ingest backlog in one run?";
    const res = await post(askBody({ question }));
    expect(res.status).toBe(200);
    expect(created[0]!.name.length).toBeLessThanOrEqual(50);
    expect(created[0]!.name.endsWith("...")).toBe(true);
    expect(/[\n\r\t]/.test(created[0]!.name)).toBe(false);
  });

  test("400 needsUser when several users exist and the bot has no default mapping", async () => {
    users = [{ id: "user-1", name: "rune" }, { id: "user-2", name: "other" }];
    const res = await post(askBody());
    expect(res.status).toBe(400);
    const data = (await res.json()) as { needsUser: boolean; users: { id: string }[] };
    expect(data.needsUser).toBe(true);
    expect(data.users.map((u) => u.id)).toEqual(["user-1", "user-2"]);
    expect(created).toHaveLength(0);
  });

  test("several users + a bot_default_user mapping resolves without a picker", async () => {
    users = [{ id: "user-1", name: "rune" }, { id: "user-2", name: "other" }];
    defaultUser = "user-2";
    const res = await post(askBody());
    expect(res.status).toBe(200);
    expect(created[0]!.userId).toBe("user-2");
  });

  test("a default mapping pointing at a user this bot doesn't have still 400s", async () => {
    users = [{ id: "user-1", name: "rune" }, { id: "user-2", name: "other" }];
    defaultUser = "someone-else";
    const res = await post(askBody());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { needsUser: boolean }).needsUser).toBe(true);
    expect(created).toHaveLength(0);
  });

  test("an explicit userId picks that user (and an unknown one 400s)", async () => {
    users = [{ id: "user-1", name: "rune" }, { id: "user-2", name: "other" }];
    const ok = await post(askBody({ userId: "user-2" }));
    expect(ok.status).toBe(200);
    expect(created[0]!.userId).toBe("user-2");
    const bad = await post(askBody({ userId: "nope" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { needsUser: boolean }).needsUser).toBe(true);
  });

  test("409 when a thread of that name exists; forceNew retries with a suffixed name", async () => {
    existingThreadNames = ["how does the gardener cluster summaries?"];
    const conflict = await post(askBody());
    expect(conflict.status).toBe(409);
    const data = (await conflict.json()) as { threadExists: boolean; existingThreadId: string };
    expect(data.threadExists).toBe(true);
    expect(data.existingThreadId).toBe("existing-thread");
    expect(created).toHaveLength(0);

    const forced = await post(askBody({ forceNew: true }));
    expect(forced.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).not.toBe("how does the gardener cluster summaries?");
    expect(created[0]!.name.length).toBeLessThanOrEqual(50);
    expect(/-\d{4}-\d{2}-\d{2}-\d{4}$/.test(created[0]!.name)).toBe(true);
  });

  test("400 for a standalone wiki — no owning bot to escalate into", async () => {
    const res = await post(askBody({ wiki: "lonewiki" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; needsBot: boolean; bots: { name: string }[] };
    expect(data.needsBot).toBe(true);
    expect(data.error).toContain("belongs to no bot");
    expect(data.bots.map((b) => b.name)).toEqual(["jarviswiki", "melosys"]);
    expect(created).toHaveLength(0);
  });

  test("an explicit bot override escalates a standalone wiki (unknown name 400s)", async () => {
    const ok = await post(askBody({ wiki: "lonewiki", bot: "melosys" }));
    expect(ok.status).toBe(200);
    expect(created[0]!.botName).toBe("melosys");
    const bad = await post(askBody({ bot: "ghost" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("Unknown bot");
  });

  test("400 when the owning bot is no longer configured", async () => {
    bots = ["melosys"];
    const res = await post(askBody());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no longer configured");
    expect(created).toHaveLength(0);
  });

  test("addresses the DETERMINISTIC web conversation for this user+bot", async () => {
    // The seam is `findOrCreateBotConversation` (deterministicId "<user>:<bot>:web"),
    // not `createConversation` with a fresh UUID: a randomly-id'd shell is invisible
    // to later off-band broadcasters that address `botConversationId`, so their
    // messages would never render in the tab this route just opened.
    let calls = 0;
    const seen: { botName: string; userId: string; username: string }[] = [];
    __setAskChatDepsForTest({
      ...fakeDeps(),
      findThreadByName: async () => null,
      createThread: async () => ({ id: "thread-x" }),
      setPendingMessage: (threadId, text) => { pending.push({ threadId, text }); },
      findOrCreateConversation: async (params) => {
        calls++;
        seen.push(params);
        return { id: "conv-deterministic" };
      },
    });
    const res = await post(askBody());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { conversationId: string }).conversationId).toBe(
      "conv-deterministic",
    );
    expect(calls).toBe(1);
    expect(seen[0]).toEqual({ botName: "jarviswiki", userId: "user-1", username: "rune" });
  });

  test("a standalone wiki with a synthesis-bot PIN escalates to the pinned bot", async () => {
    // `WIKI_EXTRA`'s 4th segment is the operator naming the bot that speaks for a
    // wiki nobody owns — on this install that's mimir→jarvis and
    // melosys-kode-wiki→melosys, i.e. the button was dead on 2 of 3 wikis.
    const res = await post(askBody({ wiki: "pinnedwiki" }));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]!.botName).toBe("melosys");
  });

  test("an explicit bot still beats the pin", async () => {
    const res = await post(askBody({ wiki: "pinnedwiki", bot: "jarviswiki" }));
    expect(res.status).toBe(200);
    expect(created[0]!.botName).toBe("jarviswiki");
  });

  test("a pin naming no discovered bot falls through to the clean needsBot 400", async () => {
    const res = await post(askBody({ wiki: "ghostpinwiki" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { needsBot: boolean }).needsBot).toBe(true);
    expect(created).toHaveLength(0);
  });

  test("two forceNew escalations in the same minute get DISTINCT threads", async () => {
    // The suffix is minute-precision and `createThread` upserts, so a colliding
    // name silently returned the FIRST thread and clobbered its unsent seed.
    existingThreadNames = ["how does the gardener cluster summaries?"];
    const first = await post(askBody({ forceNew: true }));
    const second = await post(askBody({ forceNew: true }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { threadId: string };
    const b = (await second.json()) as { threadId: string };
    expect(a.threadId).not.toBe(b.threadId);
    expect(created).toHaveLength(2);
    expect(created[0]!.name).not.toBe(created[1]!.name);
    expect(created[1]!.name.length).toBeLessThanOrEqual(50);
    // Each thread got its OWN seed — the clobber this guards against.
    expect(pending.map((p) => p.threadId)).toEqual([a.threadId, b.threadId]);
  });

  test("400 (and NO thread) for a non-string citation field", async () => {
    // A number pageName used to reach `flatten`'s `.replace` and 500 — AFTER the
    // thread was created, leaving a dead sidebar entry for a call the caller was
    // told had failed. Validated up front now, before any side effect.
    const res = await post(askBody({ citations: [{ pageName: 123 }] }));
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
    expect(pending).toHaveLength(0);
    // A nameless entry is still just dropped — that's a shape the client can send.
    const ok = await post(askBody({ citations: [{}, { pageName: "A Page" }] }));
    expect(ok.status).toBe(200);
    expect(pending[0]!.text).toContain("Sources cited by the wiki: A Page");
  });

  test("400 for a non-string wiki / bot / userId", async () => {
    for (const over of [{ wiki: 123 }, { bot: 5 }, { userId: {} }]) {
      const res = await post(askBody(over));
      expect(res.status).toBe(400);
    }
    expect(created).toHaveLength(0);
  });

  test("400 for a non-string connectorId / threadName / existingThreadId", async () => {
    for (const over of [{ connectorId: 1 }, { threadName: [] }, { existingThreadId: {} }]) {
      expect((await post(askBody(over))).status).toBe(400);
    }
    expect(created).toHaveLength(0);
  });

  // ── Direct mode (the "New chat" entry point) ────────────────────────
  describe("direct mode", () => {
    const directBody = (over: Record<string, unknown> = {}) =>
      askBody({ answer: undefined, mode: "direct", ...over });

    test("creates the thread and seeds a FRESH-question framing (no quoted answer)", async () => {
      const res = await post(directBody());
      expect(res.status).toBe(200);
      expect(created).toHaveLength(1);
      expect(created[0]!.description).toContain("Started from the jarviswiki wiki");
      const seed = pending[0]!.text;
      expect(seed).toContain("How does the gardener cluster summaries?");
      expect(seed).not.toContain("Ask tab answered");
      expect(seed).not.toContain("\n>");
    });

    test("the seed names web search only when the effective connector has it", async () => {
      // Default bot (no `connector` field) ⇒ claude-cli ⇒ web tools.
      await post(directBody());
      expect(pending[0]!.text).toContain("including web search");
      // …but a chosen Copilot connector row has none, and the seed must not
      // instruct the agent to use a tool it doesn't have.
      pending = [];
      await post(directBody({ connectorId: CONNECTOR_UUID, forceNew: true }));
      expect(pending[0]!.text).not.toContain("web search");
    });

    test("the seed is bounded even for an absurd question", async () => {
      await post(directBody({ question: "q".repeat(200_000) }));
      expect(pending[0]!.text.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    });

    test("askDeclined re-frames the seed instead of ordering the failed search", async () => {
      // The decline hook posts this: the wiki's index has already been searched for
      // this exact question and had nothing solid, which the route cannot know from
      // anything else in the body.
      // `collwiki` is the fixture WITH backing collections, i.e. the only shape
      // whose ordinary seed carries the notes-first clause this flag replaces.
      await post(directBody({ wiki: "collwiki", askDeclined: true }));
      expect(pending[0]!.text).toContain("already been searched");
      expect(pending[0]!.text).not.toContain("wiki's own notes first");
      // Absent ⇒ the ordinary direct seed, unchanged.
      pending = [];
      await post(directBody({ wiki: "collwiki", forceNew: true }));
      expect(pending[0]!.text).toContain("wiki's own notes first");
    });

    test("askDeclined is ignored outside direct mode, and 400s when it isn't a boolean", async () => {
      // The escalate seed quotes an answer the wiki DID produce — a decline flag
      // there is meaningless, so it is scoped rather than trusted wherever sent.
      await post(askBody({ askDeclined: true }));
      expect(pending[0]!.text).not.toContain("already been searched");
      const res = await post(askBody({ askDeclined: "yes" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("askDeclined");
    });

    test("declineReason carries the verdict, and unreachable does NOT claim a search ran", async () => {
      // The whole point of the field: `askDeclined` was a boolean, so an outage
      // and an empty corpus arrived identically and the seed told the model the
      // index had already been searched for a search that never happened.
      await post(directBody({ wiki: "collwiki", declineReason: "unreachable" }));
      expect(pending[0]!.text).not.toContain("already been searched");
      // …while a verdict where the index DID run keeps the clause.
      pending = [];
      await post(directBody({ wiki: "collwiki", forceNew: true, declineReason: "no_hits" }));
      expect(pending[0]!.text).toContain("already been searched");
    });

    test("declineReason beats the retired boolean, and an unknown value 400s", async () => {
      // A tab opened before this shipped sends only `askDeclined: true`, which
      // meant "declined AND the index ran" — exactly `no_hits`. When both arrive,
      // the named verdict is the more specific one and wins.
      await post(directBody({ wiki: "collwiki", askDeclined: true, declineReason: "unreachable" }));
      expect(pending[0]!.text).not.toContain("already been searched");
      const res = await post(directBody({ wiki: "collwiki", forceNew: true, declineReason: "from_the_future" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("declineReason");
    });

    // NB there is deliberately no "ignored outside direct mode" case for
    // `declineReason`. Escalate mode builds its seed with `buildAskChatSeed`,
    // which takes no such parameter, so a seed assertion holds however the route
    // treats the field: one was written, it could not fail (measured — deleting
    // the `!direct ?` scoping entirely leaves the file green), and a test that
    // cannot fail is worse than none.
    //
    // ⚠️ The two `askDeclined is ignored …` cases (":2381" above, "…here too"
    // below) are the SAME non-cover on their scoping half, for the same reason —
    // they earn their keep on the 400/type half only. Do not read them as
    // proving the mode scoping. Pinning that needs a seam that can observe it
    // (the resolved value, not the rendered seed).

    test("a wiki with NO collections isn't told to search notes it can't search", async () => {
      // `collwiki` has collections, `lonewiki` (a bare WIKI_EXTRA entry) does not.
      await post(directBody({ wiki: "collwiki" }));
      expect(pending[0]!.text).toContain("wiki's own notes");
      pending = [];
      await post(directBody({ wiki: "lonewiki", bot: "melosys", forceNew: true }));
      expect(pending[0]!.text).not.toContain("wiki's own notes");
      expect(pending[0]!.text).toContain("research it with");
    });
  });

  /**
   * Article mode — the breadcrumb's "💬 Discuss" button. Like direct mode it
   * carries no Ask answer; unlike it, the seed is anchored to ONE page, which the
   * route re-resolves against the wiki index (the client posts a reference, never
   * the title/path/summary the seed quotes).
   */
  describe("article mode", () => {
    const articleBody = (over: Record<string, unknown> = {}) =>
      askBody({
        answer: undefined,
        mode: "article",
        page: "A Concept",
        question: "Why does this matter for the gardener?",
        ...over,
      });

    beforeEach(async () => {
      // Three summary shapes: authored frontmatter `description`, first-prose-line
      // `desc` only, and neither.
      await Bun.write(
        path.join(root, "Described.md"),
        "---\ntitle: Described\ndescription: An authored one-liner.\n---\n\nFirst prose line.\n",
      );
      await Bun.write(path.join(root, "Plain.md"), "---\ntitle: Plain\n---\n\nJust a prose line.\n");
      await Bun.write(path.join(root, "Bare.md"), "---\ntitle: Bare\n---\n\n# Heading only\n");
      __resetWikiCacheForTest();
    });

    test("seeds a page-anchored message carrying the article's PATH", async () => {
      const res = await post(articleBody());
      expect(res.status).toBe(200);
      expect(created).toHaveLength(1);
      const seed = pending[0]!.text;
      expect(seed).toContain("Why does this matter for the gardener?");
      // The path is the whole point: it is what lets the bot pull the real page
      // instead of re-searching for a title.
      expect(seed).toContain("A Concept.md");
      expect(seed).toContain("A Concept");
      // No Ask answer behind this mode.
      expect(seed).not.toContain("\n>");
      expect(seed).not.toContain("Ask tab answered");
      // A connector decision was made here, so the chat page must not re-stamp it.
      const data = (await res.json()) as { chatUrl: string };
      expect(data.chatUrl).toContain("&src=wiki");
    });

    test("the thread is named after the ARTICLE and says so in its description", async () => {
      await post(articleBody());
      // Not "why does this matter…" — every later question about this page has to
      // land in this same thread, which is what the name is doing.
      expect(created[0]!.name).toBe("a concept");
      expect(created[0]!.description).toContain('Discussion of the wiki article "A Concept"');
      // …and the description carries the machine tag that makes the thread
      // IDENTIFIABLE, since the name alone can't be (see the identity suite).
      expect(created[0]!.description).toContain("(jarviswiki:A Concept.md)");
      // NOT the Ask-tab line: this conversation never touched the Ask tab.
      expect(created[0]!.description).not.toContain("Ask tab");
    });

    test("a repeat visit 409s onto the SAME thread — that is the designed path", async () => {
      await post(articleBody());
      const again = await post(articleBody({ question: "and what about the cap?" }));
      expect(again.status).toBe(409);
      const data = (await again.json()) as { threadExists: boolean; existingThreadId: string; chatUrl: string };
      expect(data.threadExists).toBe(true);
      expect(data.existingThreadId).toBe("existing-thread");
      // The client's "Send there →" is served the deep link by the ROUTE.
      expect(data.chatUrl).toContain("&src=wiki");
      expect(created).toHaveLength(1);
    });

    test("an empty question 400s, and no answer is required", async () => {
      expect((await post(articleBody({ question: "   " }))).status).toBe(400);
      // …while the missing `answer` — a 400 in every other mode — is fine here.
      expect((await post(articleBody())).status).toBe(200);
    });

    test("a missing page 400s and an unresolvable one 404s — never a pathless seed", async () => {
      const missing = await post(articleBody({ page: undefined }));
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toContain("page is required");
      const unknown = await post(articleBody({ page: "No Such Page" }));
      expect(unknown.status).toBe(404);
      expect(created).toHaveLength(0);
    });

    test("relPath wins over name — the collision-proof reference", async () => {
      await post(articleBody({ page: "Plain", relPath: "Described.md" }));
      expect(pending[0]!.text).toContain("Described.md");
      expect(pending[0]!.text).not.toContain("Plain.md");
    });

    test("the description parenthetical: frontmatter, else first prose line, else none", async () => {
      await post(articleBody({ page: "Described" }));
      expect(pending[0]!.text).toContain("(An authored one-liner)");
      // No frontmatter description ⇒ the extracted first prose line stands in.
      pending = [];
      await post(articleBody({ page: "Plain" }));
      expect(pending[0]!.text).toContain("(Just a prose line)");
      // Neither ⇒ no empty parenthetical.
      pending = [];
      await post(articleBody({ page: "Bare" }));
      expect(pending[0]!.text).not.toContain("()");
      expect(pending[0]!.text).toContain("Bare.md");
    });

    test("the seed names web search only when the effective connector has it", async () => {
      await post(articleBody());
      expect(pending[0]!.text).toContain("including web search");
      pending = [];
      await post(articleBody({ page: "Plain", connectorId: CONNECTOR_UUID }));
      expect(pending[0]!.text).not.toContain("web search");
    });

    test("a collection-less wiki isn't told to look the page up in collections", async () => {
      await post(articleBody({ wiki: "collwiki" }));
      expect(pending[0]!.text).toContain("knowledge tools");
      pending = [];
      await post(articleBody({ wiki: "lonewiki", bot: "melosys", page: "Plain" }));
      expect(pending[0]!.text).not.toContain("knowledge tools");
      expect(pending[0]!.text).toContain("research it with");
    });

    test("askDeclined is ignored here too — it is direct-mode only", async () => {
      await post(articleBody({ wiki: "collwiki", askDeclined: true }));
      expect(pending[0]!.text).not.toContain("already been searched");
    });

    test("a non-string page/relPath 400s before anything resolves", async () => {
      expect((await post(articleBody({ page: 7 }))).status).toBe(400);
      expect((await post(articleBody({ relPath: [] }))).status).toBe(400);
      expect(created).toHaveLength(0);
    });

    test("a stale relPath (a rename) falls back to the NAME instead of 404ing", async () => {
      // An open tab holds the path from before the page moved; the name beside it
      // still resolves, so the Discuss button used to 404 on a page plainly there.
      const res = await post(articleBody({ page: "A Concept", relPath: "moved/away.md" }));
      expect(res.status).toBe(200);
      expect(pending[0]!.text).toContain("A Concept.md");
      // Both unresolvable ⇒ still a 404, quoting BOTH references it was given.
      const gone = await post(articleBody({ page: "No Such Page", relPath: "moved/away.md" }));
      expect(gone.status).toBe(404);
      const err = ((await gone.json()) as { error: string }).error;
      expect(err).toContain("moved/away.md");
      expect(err).toContain("No Such Page");
    });

    test("a page-less article POST is a 400 even on a wiki with no bot", async () => {
      // Body shape is answered beside the other body-shape checks, before bot
      // resolution — a wiki whose bot is gone used to reply "belongs to no bot",
      // which is true but not what the caller got wrong.
      const res = await post(articleBody({ wiki: "ghostpinwiki", page: undefined }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("page is required");
    });

    /**
     * Thread IDENTITY — the fix for a name-keyed lookup on a lossy key.
     *
     * `findThreadByName` is (user, bot, name)-scoped and an article thread's name
     * is its page title: mimir + jarvis carry 13 colliding title groups over 30
     * pages, two wikis owned by one bot collide with each other, and an ordinary
     * `/topic` chat thread can own the name outright. So the 409 path asks the
     * COLLIDING thread's description whether it is this article's.
     */
    describe("thread identity (the article tag)", () => {
      beforeEach(async () => {
        // A second page with the SAME title — the live collision, reproduced.
        await Bun.write(path.join(root, "Dup.md"), "---\ntitle: A Concept\n---\n\nAnother page.\n");
        __resetWikiCacheForTest();
      });

      test("the same article again 409s onto its OWN thread — Send there is offered", async () => {
        await post(articleBody());
        const again = await post(articleBody({ question: "and the cap?" }));
        expect(again.status).toBe(409);
        const data = (await again.json()) as {
          threadExists?: boolean;
          nameTaken?: boolean;
          existingThreadId?: string;
        };
        expect(data.threadExists).toBe(true);
        expect(data.nameTaken).toBeUndefined();
        expect(data.existingThreadId).toBe("existing-thread");
      });

      test("a DIFFERENT page with the same title gets the nameTaken 409, no Send-there", async () => {
        await post(articleBody()); // "A Concept.md" → thread "a concept"
        const clash = await post(articleBody({ page: undefined, relPath: "Dup.md" }));
        expect(clash.status).toBe(409);
        const data = (await clash.json()) as {
          nameTaken?: boolean;
          threadExists?: boolean;
          existingThreadId?: string;
          error: string;
        };
        expect(data.nameTaken).toBe(true);
        // The two fields "Send there →" needs are BOTH absent: offering it would
        // seed a question about Dup.md into A Concept.md's conversation.
        expect(data.threadExists).toBeUndefined();
        expect(data.existingThreadId).toBeUndefined();
        expect(data.error).toContain("start a new thread");
        expect(created).toHaveLength(1);
      });

      test("…and forceNew then lands a suffixed thread of its own", async () => {
        await post(articleBody());
        await post(articleBody({ page: undefined, relPath: "Dup.md" }));
        const forced = await post(articleBody({ page: undefined, relPath: "Dup.md", forceNew: true }));
        expect(forced.status).toBe(200);
        expect(created).toHaveLength(2);
        expect(created[1]!.name).not.toBe(created[0]!.name);
        expect(created[1]!.name.startsWith("a concept-")).toBe(true);
        // Its OWN identity tag — so the next visit to Dup.md finds this thread.
        expect(created[1]!.description).toContain("(jarviswiki:Dup.md)");
      });

      test("the same page in ANOTHER wiki on the same bot is a different article", async () => {
        // `repos/huginn.md` in mimir vs `entities/Huginn.md` in jarvis, in
        // miniature: two registered wikis resolving to one bot.
        const first = await post(articleBody({ wiki: "pinnedwiki", bot: "melosys" }));
        expect(first.status).toBe(200);
        expect(created[0]!.description).toContain("(pinnedwiki:A Concept.md)");
        const other = await post(articleBody({ wiki: "collwiki", bot: "melosys" }));
        expect(other.status).toBe(409);
        expect((await other.json()) as { nameTaken?: boolean }).toMatchObject({ nameTaken: true });
      });

      test("an ordinary chat thread that owns the name is never seeded", async () => {
        // The worst case: `findThreadByName` is not article-scoped at all, so a
        // `/topic` thread called "a concept" answers the lookup.
        existingThreadNames.push("a concept");
        threadDescriptionsByName["a concept"] = undefined;
        const res = await post(articleBody());
        expect(res.status).toBe(409);
        expect((await res.json()) as { nameTaken?: boolean }).toMatchObject({ nameTaken: true });
        expect(pending).toHaveLength(0);
      });

      test('"Send there →" re-verifies the thread it was handed', async () => {
        const THREAD = "cccccccc-dddd-4eee-8fff-000000000000";
        threadsById[THREAD] = {
          id: THREAD,
          userId: "user-1",
          botName: "jarviswiki",
          description: 'Discussion of the wiki article "Other" (jarviswiki:Dup.md)',
        };
        const wrong = await post(articleBody({ existingThreadId: THREAD }));
        expect(wrong.status).toBe(409);
        expect((await wrong.json()) as { nameTaken?: boolean }).toMatchObject({ nameTaken: true });
        expect(pending).toHaveLength(0);

        // A plain chat thread (no tag at all) is refused the same way…
        threadsById[THREAD]!.description = "Started from the jarviswiki wiki";
        expect((await post(articleBody({ existingThreadId: THREAD }))).status).toBe(409);
        expect(pending).toHaveLength(0);

        // …and the article's OWN thread is seeded, which is the designed path.
        threadsById[THREAD]!.description =
          'Discussion of the wiki article "A Concept" (jarviswiki:A Concept.md)';
        const right = await post(articleBody({ existingThreadId: THREAD }));
        expect(right.status).toBe(200);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.threadId).toBe(THREAD);
      });

      test("direct and escalate modes are untouched by the tag logic", async () => {
        // Their threads carry no article tag at all, so a tag check applied to
        // them would turn every legitimate "Send this question there" into a
        // nameTaken refusal.
        existingThreadNames = ["how does the gardener cluster summaries?"];
        const escalate = await post(askBody());
        expect(escalate.status).toBe(409);
        expect((await escalate.json()) as Record<string, unknown>).toMatchObject({
          threadExists: true,
          existingThreadId: "existing-thread",
        });

        const direct = await post(askBody({ answer: undefined, mode: "direct" }));
        expect(direct.status).toBe(409);
        const data = (await direct.json()) as { threadExists?: boolean; nameTaken?: boolean };
        expect(data.threadExists).toBe(true);
        expect(data.nameTaken).toBeUndefined();

        // …including the reuse path, on a thread with no description whatsoever.
        const THREAD = "cccccccc-dddd-4eee-8fff-000000000000";
        threadsById[THREAD] = { id: THREAD, userId: "user-1", botName: "jarviswiki" };
        expect((await post(askBody({ existingThreadId: THREAD }))).status).toBe(200);
        expect(pending).toHaveLength(1);
      });
    });
  });

  // ── connectorId ─────────────────────────────────────────────────────
  test("a malformed connectorId 400s BEFORE it reaches getConnector", async () => {
    // A non-UUID hitting the uuid-column WHERE is a Postgres error, i.e. a 500 out
    // of the blanket catch — every sibling route guards the shape first.
    const res = await post(askBody({ connectorId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("UUID");
    expect(created).toHaveLength(0);
  });

  test("a well-formed but unknown connectorId 400s", async () => {
    const res = await post(askBody({ connectorId: UNKNOWN_UUID }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Unknown connector");
    expect(created).toHaveLength(0);
  });

  test("the posted connectorId ARRIVES at createThread", async () => {
    // A 200 proves nothing here: the whole point of the picker is that the thread
    // is born on the chosen model, and the seam is where that can silently drop.
    const res = await post(askBody({ connectorId: CONNECTOR_UUID }));
    expect(res.status).toBe(200);
    expect(createdConnectorIds).toEqual([CONNECTOR_UUID]);
    // …and an escalation with no pick creates a connector-LESS thread ("bot
    // default" is the absence of a connector, not a connector).
    await post(askBody({ forceNew: true }));
    expect(createdConnectorIds[1]).toBeUndefined();
  });

  // ── threadName override ─────────────────────────────────────────────
  test("threadName overrides the derived name through the SAME normalization", async () => {
    const res = await post(askBody({ threadName: "  My Gardener\tNotes  " }));
    expect(res.status).toBe(200);
    expect(created[0]!.name).toBe("my gardener notes");
  });

  test("an over-long threadName is truncated, not rejected", async () => {
    await post(askBody({ threadName: "n".repeat(200) }));
    expect(created[0]!.name.length).toBeLessThanOrEqual(50);
  });

  test("a blank threadName falls back to the question", async () => {
    await post(askBody({ threadName: "   " }));
    expect(created[0]!.name).toBe("how does the gardener cluster summaries?");
  });

  test("a threadName of only CONTROL chars falls back to the question, not 'wiki ask'", async () => {
    // Truthy, so the old `.trim()` gate let it through — and it then flattened to
    // nothing, pinning every such thread to the stable generic fallback while the
    // perfectly good question sat right there.
    await post(askBody({ threadName: "\u0001\u0002" }));
    expect(created[0]!.name).toBe("how does the gardener cluster summaries?");
  });

  // ── existingThreadId ("Send there →") ───────────────────────────────
  describe("existingThreadId", () => {
    beforeEach(() => {
      threadsById["cccccccc-dddd-4eee-8fff-000000000000"] = {
        id: "cccccccc-dddd-4eee-8fff-000000000000",
        userId: "user-1",
        botName: "jarviswiki",
      };
    });
    const THREAD = "cccccccc-dddd-4eee-8fff-000000000000";

    test("seeds onto the existing thread and creates NOTHING", async () => {
      const res = await post(askBody({ existingThreadId: THREAD }));
      expect(res.status).toBe(200);
      const data = (await res.json()) as { threadId: string; reusedThread: boolean; chatUrl: string };
      expect(data.threadId).toBe(THREAD);
      expect(data.reusedThread).toBe(true);
      expect(data.chatUrl).toContain("thread=" + THREAD);
      expect(created).toHaveLength(0);
      expect(pending).toEqual([{ threadId: THREAD, text: expect.any(String) }]);
    });

    test("400 for a thread belonging to another user or another bot", async () => {
      threadsById[THREAD]!.userId = "someone-else";
      expect((await post(askBody({ existingThreadId: THREAD }))).status).toBe(400);
      threadsById[THREAD]!.userId = "user-1";
      threadsById[THREAD]!.botName = "melosys";
      expect((await post(askBody({ existingThreadId: THREAD }))).status).toBe(400);
      expect(pending).toHaveLength(0);
    });

    test("400 for an unknown or malformed thread id", async () => {
      expect((await post(askBody({ existingThreadId: "nope" }))).status).toBe(400);
      expect((await post(askBody({ existingThreadId: UNKNOWN_UUID }))).status).toBe(400);
      expect(pending).toHaveLength(0);
    });

    test("a LIVE pending seed is not clobbered — 409 'already queued'", async () => {
      // `setPendingMessage` is last-write-wins on a 5-min TTL: a second seed here
      // would silently delete a question nobody has opened yet, and the caller
      // would be told it succeeded.
      livePending.push(THREAD);
      const res = await post(askBody({ existingThreadId: THREAD }));
      expect(res.status).toBe(409);
      const data = (await res.json()) as { alreadyQueued: boolean; error: string; chatUrl: string };
      expect(data.alreadyQueued).toBe(true);
      expect(data.error).toContain("already queued");
      expect(data.chatUrl).toContain("thread=" + THREAD);
      expect(pending).toHaveLength(0);
    });

    test("a chosen connector is applied ONLY when the thread has none", async () => {
      await post(askBody({ existingThreadId: THREAD, connectorId: CONNECTOR_UUID }));
      expect(connectorStamps).toEqual([{ threadId: THREAD, connectorId: CONNECTOR_UUID }]);
      // An established thread keeps the model it has been answering with.
      connectorStamps = [];
      threadsById[THREAD]!.connectorId = "some-other-connector";
      await post(askBody({ existingThreadId: THREAD, connectorId: CONNECTOR_UUID }));
      expect(connectorStamps).toEqual([]);
    });

    // ── the DROPPED pick is reported, never silent ────────────────────
    test("connectorApplied says whether the pick actually landed", async () => {
      const applied = await post(askBody({ existingThreadId: THREAD, connectorId: CONNECTOR_UUID }));
      expect(applied.status).toBe(200);
      expect((await applied.json()) as { connectorApplied: boolean }).toMatchObject({
        connectorApplied: true,
      });

      // Now the thread carries one of its own: the pick is dropped, and the caller
      // must be told — it used to 200 with no signal at all, so the client wrote
      // the ignored pick to localStorage as if it had been honored.
      threadsById[THREAD]!.connectorId = CLI_CONNECTOR_UUID;
      const dropped = await post(askBody({ existingThreadId: THREAD, connectorId: CONNECTOR_UUID }));
      expect(dropped.status).toBe(200);
      const body = (await dropped.json()) as { connectorApplied: boolean; keptConnectorId: string };
      expect(body.connectorApplied).toBe(false);
      expect(body.keptConnectorId).toBe(CLI_CONNECTOR_UUID);
    });

    test("no pick ⇒ no connectorApplied field at all (nothing was decided)", async () => {
      const res = await post(askBody({ existingThreadId: THREAD }));
      const body = (await res.json()) as Record<string, unknown>;
      expect("connectorApplied" in body).toBe(false);
    });

    // ── the seed reflects the thread's EFFECTIVE connector ────────────
    describe("seed capability on reuse", () => {
      const directTo = (over: Record<string, unknown> = {}) =>
        post(askBody({ answer: undefined, mode: "direct", existingThreadId: THREAD, ...over }));

      test("a connector-CARRYING thread's own model decides, not the pick", async () => {
        // The thread's connector wins at processing time, so a seed built from the
        // picked (or bot-default) connector promised web search a copilot-pinned
        // thread cannot deliver — reproduced live before this fix.
        threadsById[THREAD]!.connectorId = CONNECTOR_UUID; // copilot-sdk
        await directTo({ connectorId: CLI_CONNECTOR_UUID });
        expect(pending).toHaveLength(1);
        expect(pending[0]!.text).not.toContain("web search");
        expect(pending[0]!.text).toContain("the tools you have");
      });

      test("an EMPTY thread takes the pick — which really is applied", async () => {
        await directTo({ connectorId: CLI_CONNECTOR_UUID });
        expect(connectorStamps).toEqual([
          { threadId: THREAD, connectorId: CLI_CONNECTOR_UUID },
        ]);
        expect(pending[0]!.text).toContain("including web search");
      });

      test("an empty thread with a copilot pick claims no web search", async () => {
        await directTo({ connectorId: CONNECTOR_UUID });
        expect(pending[0]!.text).not.toContain("web search");
      });

      test("a thread pointing at a DELETED connector row falls back to the bot default", async () => {
        threadsById[THREAD]!.connectorId = UNKNOWN_UUID;
        await directTo();
        // The fabricated bot has no `connector` field ⇒ claude-cli ⇒ web tools,
        // which is also what connector resolution does at processing time.
        expect(pending[0]!.text).toContain("including web search");
      });
    });
  });

  // ── chatUrl's stamp-suppression flag is SCOPED ──────────────────────
  //
  // `&src=wiki` tells the chat page not to stamp its remembered sidebar connector
  // on the thread — necessary when the reader chose "(bot default)", which is
  // expressed as NO connector and is exactly what the `onlyIfEmpty` stamp fills
  // in. But it is only correct for a request that MADE that choice: flagging the
  // plain one-click escalation (which offers no picker and posts no connector
  // fields) silently costs it the sidebar preference it has always applied.
  //
  // The signal is the `connectorId` KEY's presence. The popover always sends it —
  // `""` meaning "(bot default)", a real decision — and the one-click path omits
  // it entirely.
  describe("&src=wiki scoping", () => {
    const chatUrlOf = async (body: unknown): Promise<string> => {
      const res = await post(body);
      expect(res.status).toBe(200);
      return ((await res.json()) as { chatUrl: string }).chatUrl;
    };

    test("a plain one-click escalation does NOT carry it", async () => {
      expect(await chatUrlOf(askBody())).not.toContain("src=wiki");
    });

    test('an explicit "(bot default)" pick DOES — an empty connectorId is a choice', async () => {
      // The whole regression this flag exists for: `connectorId: ""` is the reader
      // deliberately asking for no connector at all.
      expect(await chatUrlOf(askBody({ connectorId: "", forceNew: true }))).toContain("&src=wiki");
    });

    test("a named connector pick carries it too", async () => {
      const url = await chatUrlOf(askBody({ connectorId: CONNECTOR_UUID, forceNew: true }));
      expect(url).toContain("&src=wiki");
    });

    test("direct mode always carries it — it only ever comes from the popover", async () => {
      const url = await chatUrlOf(askBody({ answer: undefined, mode: "direct", forceNew: true }));
      expect(url).toContain("&src=wiki");
    });

    test("the threadExists 409 offers a chatUrl under the SAME scoping", async () => {
      // The client used to re-derive this link itself and hardcoded the flag onto
      // it, so even the plain path's "Open it →" suppressed the stamp.
      existingThreadNames = ["how does the gardener cluster summaries?"];
      const plain = await post(askBody());
      expect(plain.status).toBe(409);
      const plainBody = (await plain.json()) as { threadExists: boolean; chatUrl: string };
      expect(plainBody.threadExists).toBe(true);
      expect(plainBody.chatUrl).toBe("/chat?bot=jarviswiki&thread=existing-thread&user=user-1");

      const chosen = await post(askBody({ connectorId: "" }));
      expect(chosen.status).toBe(409);
      expect(((await chosen.json()) as { chatUrl: string }).chatUrl).toContain("&src=wiki");
    });
  });
});

/**
 * `resolveAskChatTarget` — the shared bot/user resolution behind BOTH
 * `POST /api/wiki/ask/chat` and `GET /api/wiki/chat-target`. Driven directly
 * (no HTTP), through fake deps, so the two endpoints can't drift.
 */
describe("resolveAskChatTarget", () => {
  const deps = (over: Partial<AskChatDeps> = {}): AskChatDeps =>
    ({
      discoverBots: () => [{ name: "jarvis" }, { name: "melosys" }] as unknown as BotConfig[],
      loadChatConfig: async () => ({ users: [{ id: "u1", name: "rune" }] }),
      getBotDefaultUser: async () => null,
      ...over,
    }) as AskChatDeps;

  const botEntry = { name: "jarvis", source: "bot" };
  const loneEntry = { name: "lonewiki", source: "extra" };
  const pinnedEntry = { name: "pinnedwiki", source: "extra", synthesisBot: "melosys" };

  test("an owner wiki resolves to its own bot", async () => {
    const out = await resolveAskChatTarget(botEntry, "", deps());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.botConfig.name).toBe("jarvis");
      expect(out.users.map((u) => u.id)).toEqual(["u1"]);
    }
  });

  test("a standalone wiki resolves to its synthesis-bot PIN", async () => {
    const out = await resolveAskChatTarget(pinnedEntry, "", deps());
    expect(out.ok && out.botConfig.name).toBe("melosys");
  });

  test("an explicit bot beats owner and pin alike", async () => {
    expect((await resolveAskChatTarget(botEntry, "melosys", deps())).ok && true).toBe(true);
    const out = await resolveAskChatTarget(pinnedEntry, "jarvis", deps());
    expect(out.ok && out.botConfig.name).toBe("jarvis");
  });

  test("the three failure reasons, each mapping to one of the POST's 400s", async () => {
    const unknown = await resolveAskChatTarget(botEntry, "ghost", deps());
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.reason).toBe("unknown_bot");

    const gone = await resolveAskChatTarget(botEntry, "", deps({
      discoverBots: () => [{ name: "melosys" }] as unknown as BotConfig[],
    }));
    expect(!gone.ok && gone.reason).toBe("bot_gone");

    const needs = await resolveAskChatTarget(loneEntry, "", deps());
    expect(!needs.ok && needs.reason).toBe("needs_bot");
    expect(!needs.ok && needs.bots.map((b) => b.name)).toEqual(["jarvis", "melosys"]);

    // A pin naming no discovered bot is ignored, not honored.
    const ghostPin = await resolveAskChatTarget(
      { name: "ghostpin", source: "extra", synthesisBot: "not-a-bot" }, "", deps(),
    );
    expect(!ghostPin.ok && ghostPin.reason).toBe("needs_bot");
  });

  test("the bot_default_user mapping is returned only when it names a MEMBER", async () => {
    const ok = await resolveAskChatTarget(botEntry, "", deps({
      loadChatConfig: async () => ({ users: [{ id: "u1", name: "a" }, { id: "u2", name: "b" }] }),
      getBotDefaultUser: async () => "u2",
    }));
    expect(ok.ok && ok.defaultUserId).toBe("u2");

    const stale = await resolveAskChatTarget(botEntry, "", deps({
      loadChatConfig: async () => ({ users: [{ id: "u1", name: "a" }, { id: "u2", name: "b" }] }),
      getBotDefaultUser: async () => "long-gone",
    }));
    expect(stale.ok && stale.defaultUserId).toBeNull();
  });

  test("a SINGLE-user bot with a foreign default mapping still resolves cleanly", async () => {
    // The helper resolves the mapping unconditionally (the POST used to query it
    // only when the bot had >1 user). The membership filter is what keeps that
    // from regressing the sole-user path into a needsUser 400.
    const out = await resolveAskChatTarget(botEntry, "", deps({
      loadChatConfig: async () => ({ users: [{ id: "u1", name: "rune" }] }),
      getBotDefaultUser: async () => "some-other-bots-user",
    }));
    expect(out.ok && out.defaultUserId).toBeNull();
    expect(out.ok && out.users.map((u) => u.id)).toEqual(["u1"]);
  });
});

/**
 * `GET /api/wiki/chat-target` — everything the reader's escalation popover
 * prefills from, in one fetch. Same deps fakes: no DB, no chat process.
 */
describe("GET /api/wiki/chat-target", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  let bots: { name: string; connector?: string }[];
  let users: { id: string; name: string }[];
  let defaultUser: string | null;
  let connectorRows: { id: string; name: string; connectorType: string }[];
  let listThrows: boolean;
  let defaultUserThrows: boolean;
  let preferredByUser: Record<string, string | null>;
  let preferenceCalls: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-chattarget-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `lonewiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setWikiRegistryForTest([
      { name: "jarviswiki", root, source: "bot" },
      { name: "lonewiki", root, source: "extra" },
    ]);
    bots = [{ name: "jarviswiki", connector: "claude-sdk" }, { name: "melosys", connector: "copilot-sdk" }];
    users = [{ id: "user-1", name: "rune" }, { id: "user-2", name: "other" }];
    defaultUser = "user-2";
    connectorRows = [
      { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Copilot", connectorType: "copilot-sdk" },
      { id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", name: "Sonnet CLI", connectorType: "claude-cli" },
    ];
    listThrows = false;
    preferredByUser = {};
    preferenceCalls = [];
    defaultUserThrows = false;

    // Spread the shared throwing factory, never a hand-picked subset: a seam added
    // to `AskChatDeps` later must fail loudly here, not fall through to a live DB.
    __setAskChatDepsForTest({
      ...throwingAskChatDeps(),
      discoverBots: () => bots as unknown as BotConfig[],
      loadChatConfig: async () => ({ users }),
      getBotDefaultUser: async () => {
        if (defaultUserThrows) throw new Error("bot_default_user table is gone");
        return defaultUser;
      },
      listConnectors: async () => {
        if (listThrows) throw new Error("connectors table is gone");
        return connectorRows as never;
      },
      getPreferredConnector: async (userId: string, botName: string) => {
        preferenceCalls.push(userId + ":" + botName);
        return preferredByUser[userId] ?? null;
      },
    });

    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setAskChatDepsForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  type TargetBody = {
    botName: string | null;
    reason?: string;
    error?: string;
    bots?: { name: string }[];
    users?: { id: string; name: string }[];
    defaultUserId?: string | null;
    preferredForUserId?: string | null;
    preferredConnectorId?: string | null;
    connectors?: { id: string; name: string; connectorType: string; supportsWebTools: boolean }[];
    connectorsError?: string;
    botDefault?: { connectorType: string; supportsWebTools: boolean } | null;
  };

  test("an owner wiki resolves bot, users, default user and capability-flagged connectors", async () => {
    const res = await app.request("/api/wiki/chat-target?wiki=jarviswiki");
    expect(res.status).toBe(200);
    const data = (await res.json()) as TargetBody;
    expect(data.botName).toBe("jarviswiki");
    expect(data.users!.map((u) => u.id)).toEqual(["user-1", "user-2"]);
    expect(data.defaultUserId).toBe("user-2");
    // Capability is decided HERE — the browser cannot run connectorCapabilities.
    expect(data.connectors).toEqual([
      { id: connectorRows[0]!.id, name: "Copilot", connectorType: "copilot-sdk", supportsWebTools: false },
      { id: connectorRows[1]!.id, name: "Sonnet CLI", connectorType: "claude-cli", supportsWebTools: true },
    ]);
    // "(bot default)" is flagged too — it is a real choice, not an unknown.
    expect(data.botDefault).toMatchObject({ connectorType: "claude-sdk", supportsWebTools: true });
  });

  test("?bot= re-targets everything bot-keyed", async () => {
    const res = await app.request("/api/wiki/chat-target?wiki=jarviswiki&bot=melosys");
    const data = (await res.json()) as TargetBody;
    expect(data.botName).toBe("melosys");
    // melosys is a copilot bot ⇒ its default has no web tools.
    expect(data.botDefault!.supportsWebTools).toBe(false);
  });

  test("an ownerless wiki asks for a bot and offers the list", async () => {
    const res = await app.request("/api/wiki/chat-target?wiki=lonewiki");
    expect(res.status).toBe(200);
    const data = (await res.json()) as TargetBody;
    expect(data.botName).toBeNull();
    // `reason` is the ONLY branch key — the `needsBot` boolean it duplicated is
    // gone, as are the four dummy filler fields the failure branch used to ship.
    expect(data.reason).toBe("needs_bot");
    expect(data.bots!.map((b) => b.name)).toEqual(["jarviswiki", "melosys"]);
    expect(data.users).toBeUndefined();
    expect(data.connectors).toBeUndefined();
    expect(data.botDefault).toBeUndefined();
    expect(data.defaultUserId).toBeUndefined();
  });

  test("unknown_bot and bot_gone surface as reasons with the POST's messages", async () => {
    const unknown = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki&bot=ghost")
    ).json()) as TargetBody;
    expect(unknown.reason).toBe("unknown_bot");
    expect(unknown.error).toContain("Unknown bot");

    bots = [{ name: "melosys" }];
    const gone = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki")
    ).json()) as TargetBody;
    expect(gone.reason).toBe("bot_gone");
    expect(gone.error).toContain("no longer configured");
  });

  test("404 for an unknown wiki", async () => {
    expect((await app.request("/api/wiki/chat-target?wiki=nope")).status).toBe(404);
  });

  test("a dead connectors table costs the picker its rows, not the popover", async () => {
    listThrows = true;
    const res = await app.request("/api/wiki/chat-target?wiki=jarviswiki");
    expect(res.status).toBe(200);
    const data = (await res.json()) as TargetBody;
    expect(data.connectors).toEqual([]);
    expect(data.connectorsError).toContain("connectors table is gone");
    // "(bot default)" alone is still a complete, working choice.
    expect(data.botDefault).not.toBeNull();
  });

  test("the ok path ships the bot list too — the advanced bot override renders from it", async () => {
    const data = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki")
    ).json()) as TargetBody;
    expect(data.bots!.map((b) => b.name)).toEqual(["jarviswiki", "melosys"]);
  });

  test("isJiraBot flags exactly the Jira composer's pinned bot", async () => {
    // Pinned explicitly: `jiraBotName()` reads ambient JIRA_BOT, which is not in
    // the ambient-env preload list — without the pin this test is green on CI
    // (no .env) and red on any host that pins a different Jira bot.
    const prev = process.env.JIRA_BOT;
    process.env.JIRA_BOT = "melosys";
    try {
      const owner = (await (
        await app.request("/api/wiki/chat-target?wiki=jarviswiki")
      ).json()) as TargetBody & { isJiraBot?: boolean };
      expect(owner.isJiraBot).toBe(false);
      const jira = (await (
        await app.request("/api/wiki/chat-target?wiki=jarviswiki&bot=melosys")
      ).json()) as TargetBody & { isJiraBot?: boolean };
      expect(jira.isJiraBot).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.JIRA_BOT;
      else process.env.JIRA_BOT = prev;
    }
  });

  test("the default user's connector preference is folded in, stamped with its user", async () => {
    // The popover used to make a SECOND round-trip for this immediately after the
    // one it already made. It is per user+bot, so the response says which user it
    // belongs to — a client landing on a remembered OTHER user must still refetch.
    preferredByUser["user-2"] = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const data = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki")
    ).json()) as TargetBody;
    expect(data.preferredForUserId).toBe("user-2");
    expect(data.preferredConnectorId).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    expect(preferenceCalls).toEqual(["user-2:jarviswiki"]);
  });

  test("a SOLE user gets the fold-in too, even with no bot_default_user mapping", async () => {
    users = [{ id: "only-user", name: "rune" }];
    defaultUser = null;
    preferredByUser["only-user"] = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const data = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki")
    ).json()) as TargetBody;
    expect(data.preferredForUserId).toBe("only-user");
    expect(data.preferredConnectorId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  test("several users and no mapping ⇒ no fold-in (there is no user to fold for)", async () => {
    defaultUser = null;
    const data = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki")
    ).json()) as TargetBody;
    expect(data.preferredForUserId).toBeNull();
    expect(data.preferredConnectorId).toBeNull();
    expect(preferenceCalls).toEqual([]);
  });

  test("a failing bot_default_user lookup DEGRADES — it must never 500 the popover", async () => {
    // The lookup became unconditional when the GET was added (the POST used to run
    // it only for a multi-user bot), which handed every request — and every
    // sole-user escalation — a brand new way to fail on a query neither needs.
    defaultUserThrows = true;
    const res = await app.request("/api/wiki/chat-target?wiki=jarviswiki");
    expect(res.status).toBe(200);
    const data = (await res.json()) as TargetBody;
    expect(data.botName).toBe("jarviswiki");
    expect(data.defaultUserId).toBeNull();
    expect(data.users!.map((u) => u.id)).toEqual(["user-1", "user-2"]);
  });

  test("a sole-user ESCALATION survives the same failure", async () => {
    defaultUserThrows = true;
    const out = await resolveAskChatTarget({ name: "jarviswiki", source: "bot" }, "", {
      ...throwingAskChatDeps(),
      discoverBots: () => bots as unknown as BotConfig[],
      loadChatConfig: async () => ({ users: [{ id: "only", name: "rune" }] }),
      getBotDefaultUser: async () => {
        throw new Error("bot_default_user table is gone");
      },
    } as unknown as AskChatDeps);
    expect(out.ok).toBe(true);
    expect(out.ok && out.defaultUserId).toBeNull();
    expect(out.ok && out.users.map((u) => u.id)).toEqual(["only"]);
  });

  test("the GET and the POST spell each failure message identically", async () => {
    // They were separately worded (the GET's needs_bot copy named the popover, the
    // POST's named the escalation) with tests pinning both spellings.
    const getBody = async (q: string): Promise<TargetBody> =>
      (await (await app.request("/api/wiki/chat-target" + q)).json()) as TargetBody;
    const postBody = async (body: unknown): Promise<{ error: string }> =>
      (await (
        await app.request("/api/wiki/ask/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { error: string };
    const q = { question: "why?", answer: "because" };

    expect((await getBody("?wiki=lonewiki")).error).toBe(
      (await postBody({ ...q, wiki: "lonewiki" })).error,
    );
    expect((await getBody("?wiki=jarviswiki&bot=ghost")).error).toBe(
      (await postBody({ ...q, wiki: "jarviswiki", bot: "ghost" })).error,
    );
    bots = [{ name: "melosys" }];
    expect((await getBody("?wiki=jarviswiki")).error).toBe(
      (await postBody({ ...q, wiki: "jarviswiki" })).error,
    );
  });
});

/**
 * The ➕ "add to article" route and the SUPERSEDE rule.
 *
 * The append route only ever replaced the sentinel region, so a page that had
 * been through ✎ Integrate kept its `<Fact n=…>` marks while the block under them
 * was rebuilt from a NEW run — and claim numbering is per-run, so a stale `n="2"`
 * chip then pointed at an unrelated `#fc-claim-2`. The route therefore strips
 * first and reports the count as `supersededNote`, exactly like the integrate
 * routes.
 *
 * The strip is UNCONDITIONAL, `.md` included: "a `.md` page never carries marks"
 * is an invariant of the write paths, not of the file — a hand-edit or a rename
 * from `.mdx` produces one, and that page would otherwise keep every chip dangling
 * off a rebuilt callout. A mark-free `.md` is pinned byte-for-byte below.
 */
describe("POST /api/wiki/factcheck/append — supersedes stale marks", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  const FENCE = "```";
  const ANSWER = "### ✅ Claim 1/1 — Units\n\nThe figure is current.";

  /** Write a page, invalidate the reader cache so the index sees it, and return
   *  the baseHash the route CASes against. */
  async function writePage(rel: string, body: string): Promise<string> {
    await Bun.write(path.join(root, rel), body);
    __resetWikiCacheForTest();
    return createHash("sha256").update(body).digest("hex");
  }

  interface AppendResponse {
    written?: boolean;
    page?: string;
    error?: string;
    stale?: boolean;
    supersededNote?: string;
  }

  async function append(
    page: string,
    baseHash: string,
    answer = ANSWER,
  ): Promise<{ status: number; body: AppendResponse }> {
    const res = await app.request("/api/wiki/factcheck/append?wiki=appendwiki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, baseHash, answer }),
    });
    return { status: res.status, body: (await res.json()) as AppendResponse };
  }

  const read = (rel: string): Promise<string> => Bun.file(path.join(root, rel)).text();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-append-sup-"));
    await Bun.write(path.join(root, "index.md"), "# Index\n");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `appendwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("strips prior marks, keeps a fenced <Fact> as documentation, reports the count", async () => {
    // Two live marks in prose, a THIRD `<Fact>` inside a code fence
    // (documentation — must survive), and a prior appendix whose per-run claim
    // numbering this run replaces.
    const baseHash = await writePage(
      "Widgets.mdx",
      [
        "---",
        "type: source",
        "title: Widgets",
        "---",
        "",
        "# Widgets",
        "",
        'The device <Fact n="1" v="bad">ships 4M units</Fact> a year.',
        "",
        'Its shell is <Fact n="2" v="bad">machined from a single billet</Fact>.',
        "",
        "How the markup is spelled:",
        "",
        `${FENCE}mdx`,
        '<Fact n="9" v="ok">documented example</Fact>',
        FENCE,
        "",
        FACTCHECK_SENTINEL_START,
        '<FactCheck date="2026-08-01" bad="2">',
        "",
        "### ❌ Claim 1/2 — Units",
        "",
        "Old evidence.",
        "",
        "### ❌ Claim 2/2 — Shell",
        "",
        "Older evidence.",
        "</FactCheck>",
        FACTCHECK_SENTINEL_END,
        "",
      ].join("\n"),
    );
    const { status, body } = await append("Widgets", baseHash);
    expect(status).toBe(200);
    expect(body.written).toBe(true);

    const written = await read("Widgets.mdx");
    // Not one live wrapper survives — and the wrapped PROSE is byte-preserved.
    expect(countFactWrappers(written)).toBe(0);
    expect(written).toContain("The device ships 4M units a year.");
    expect(written).toContain("Its shell is machined from a single billet.");
    // The documented tag inside the fence is the ONLY `<Fact>` pair left.
    expect(written).toContain('<Fact n="9" v="ok">documented example</Fact>');
    expect(written.split("</Fact>").length - 1).toBe(1);
    // The new appendix landed in the sentinel region.
    expect(written).toContain("Claim 1/1 — Units");
    expect(written).not.toContain("Old evidence.");
    // …and the run says what it superseded, in the integrate routes' wording.
    expect(body.supersededNote).toContain("2 marks");
    expect(body.supersededNote).toContain("superseded");
    // The page lost marks nobody asked about, so log.md says so — a line reading
    // only "fact-check block added" would be the whole record of that deletion.
    expect(await read("log.md")).toContain(
      "fact-check block added via the wiki reader; 2 prior marks superseded",
    );
  });

  test("one mark reads '1 mark', not '1 marks'", async () => {
    const baseHash = await writePage(
      "Solo.mdx",
      [
        "---",
        "type: source",
        "title: Solo",
        "---",
        "",
        "# Solo",
        "",
        'It <Fact n="1" v="warn">weighs 3 kg</Fact> dry.',
        "",
      ].join("\n"),
    );
    const { body } = await append("Solo", baseHash);
    expect(body.supersededNote).toContain("1 mark from a previous check superseded");
    expect(body.supersededNote).not.toContain("1 marks");
    expect(await read("log.md")).toContain("; 1 prior mark superseded");
  });

  test("a mark-free .mdx page omits supersededNote entirely (no '0 superseded')", async () => {
    const baseHash = await writePage(
      "Clean.mdx",
      "---\ntype: source\ntitle: Clean\n---\n\n# Clean\n\nNothing marked here.\n",
    );
    const { status, body } = await append("Clean", baseHash);
    expect(status).toBe(200);
    expect(body.written).toBe(true);
    // The FIELD is absent, not an empty string — the client renders the plain
    // confirmation only when there is nothing to say.
    expect("supersededNote" in body).toBe(false);
    expect(await read("log.md")).not.toContain("superseded");
  });

  test("a <Fact> quoted inside the OLD appendix IS counted — the strip removes it too", async () => {
    // The note reports what THIS WRITE REMOVED, and the strip runs over the whole
    // body: a mark quoted on a `Was:` line inside the sentinel region comes off
    // with the prose marks. Reporting 2 here (a region-stripped count) would name
    // a number that matches neither the file nor the strip.
    const baseHash = await writePage(
      "Quoted.mdx",
      [
        "---",
        "type: source",
        "title: Quoted",
        "---",
        "",
        "# Quoted",
        "",
        'It <Fact n="1" v="bad">ships 4M units</Fact> a year.',
        "",
        'Its shell is <Fact n="2" v="warn">one billet</Fact>.',
        "",
        FACTCHECK_SENTINEL_START,
        '<FactCheck date="2026-08-01" bad="1">',
        "",
        "### ❌ Claim 1/1 — Mass",
        "",
        'Was: it <Fact n="3" v="bad">weighs 9 kg</Fact> dry.',
        "</FactCheck>",
        FACTCHECK_SENTINEL_END,
        "",
      ].join("\n"),
    );
    const { status, body } = await append("Quoted", baseHash);
    expect(status).toBe(200);
    expect(body.supersededNote).toContain("3 marks from a previous check superseded");
    // …and the written file really does carry none.
    expect(countFactWrappers(await read("Quoted.mdx"))).toBe(0);
    expect(await read("log.md")).toContain("; 3 prior marks superseded");
  });

  test("an unclosed fence in the OLD appendix: the note reports 0, because the strip removed 0", async () => {
    // The defect this pins. `buildFactcheckAppendix` does not balance fences, so a
    // `Was:` line can quote an unterminated ``` — which, per CommonMark, runs to
    // EOF and makes every mark BELOW the sentinel region documentation. The strip
    // therefore removes nothing. A count taken over the region-stripped body sees
    // no fence at all and answers 2, and the note, the log.md line and the commit
    // subject then all claim a deletion the file disproves.
    const baseHash = await writePage(
      "Fenced.mdx",
      [
        "---",
        "type: source",
        "title: Fenced",
        "---",
        "",
        "# Fenced",
        "",
        "Intro prose, unmarked.",
        "",
        FACTCHECK_SENTINEL_START,
        '<FactCheck date="2026-08-01" bad="1">',
        "",
        "### ❌ Claim 1/1 — Snippet",
        "",
        "Was:",
        "",
        `${FENCE}bash`,
        "curl https://example.com",
        "</FactCheck>",
        FACTCHECK_SENTINEL_END,
        "",
        'Later prose <Fact n="1" v="bad">claims 4M units</Fact>.',
        "",
        'And <Fact n="2" v="warn">3 kg dry</Fact>.',
        "",
      ].join("\n"),
    );
    const { status, body } = await append("Fenced", baseHash);
    expect(status).toBe(200);
    expect(body.written).toBe(true);
    expect("supersededNote" in body).toBe(false);
    expect(await read("log.md")).not.toContain("superseded");
    // The marks are still on the page — which is exactly why nothing may claim
    // they were superseded.
    const written = await read("Fenced.mdx");
    expect(written).toContain('<Fact n="1" v="bad">claims 4M units</Fact>');
    expect(written).toContain('<Fact n="2" v="warn">3 kg dry</Fact>');
  });

  test("frontmatter and inline-backtick <Fact tags survive the ROUTE and are not counted", async () => {
    const baseHash = await writePage(
      "Docs.mdx",
      [
        "---",
        "type: source",
        "title: Docs",
        'note: \'<Fact n="1" v="ok">frontmatter example</Fact>\'',
        "---",
        "",
        "# Docs",
        "",
        "Write `<Fact n=\"4\" v=\"bad\">passage</Fact>` to mark a passage.",
        "",
      ].join("\n"),
    );
    const { status, body } = await append("Docs", baseHash);
    expect(status).toBe(200);
    expect("supersededNote" in body).toBe(false);
    const written = await read("Docs.mdx");
    expect(written).toContain('note: \'<Fact n="1" v="ok">frontmatter example</Fact>\'');
    expect(written).toContain("Write `<Fact n=\"4\" v=\"bad\">passage</Fact>` to mark a passage.");
  });

  test("a stale baseHash writes nothing, logs nothing and carries no note", async () => {
    const original = [
      "---",
      "type: source",
      "title: Stale",
      "---",
      "",
      "# Stale",
      "",
      'It <Fact n="1" v="bad">ships 4M units</Fact> a year.',
      "",
    ].join("\n");
    await writePage("Stale.mdx", original);
    const { status, body } = await append("Stale", "deadbeef");
    expect(status).toBe(409);
    expect(body.stale).toBe(true);
    expect("supersededNote" in body).toBe(false);
    // Byte-for-byte untouched — the mark is still there, no log entry exists.
    expect(await read("Stale.mdx")).toBe(original);
    expect(await Bun.file(path.join(root, "log.md")).exists()).toBe(false);
  });

  // ── .md pages ──────────────────────────────────────────────────────────────
  test("a mark-free .md page is written byte-identically to the pre-hook splice", async () => {
    const original = "# Gadget\n\nA plain markdown page.\n\n## Sources\n\n- https://example.com\n";
    const baseHash = await writePage("Gadget.md", original);
    const { status, body } = await append("Gadget", baseHash);
    expect(status).toBe(200);
    expect("supersededNote" in body).toBe(false);
    // The hook is unconditional now, so this pins that it contributed NOTHING:
    // the bytes are exactly the splice of the blockquote form over the original.
    const expected = withTrailingNewline(
      spliceSentinelBlock(original, buildFactcheckBlock(ANSWER, todayOslo(Date.now()))),
    );
    expect(await read("Gadget.md")).toBe(expected);
    expect(await read("log.md")).not.toContain("superseded");
  });

  test("a .md page that DOES carry marks gets them stripped and reported", async () => {
    // The extension gate encoded an invariant nothing enforced on the file — a
    // rename from `.mdx`, or a hand-edit, lands marks on a `.md`. Left in place
    // they dangle off a callout rebuilt from a different run's claims.
    const baseHash = await writePage(
      "Legacy.md",
      [
        "# Legacy",
        "",
        'It <Fact n="1" v="bad">ships 4M units</Fact> a year.',
        "",
        'Its shell is <Fact n="2" v="warn">one billet</Fact>.',
        "",
      ].join("\n"),
    );
    const { status, body } = await append("Legacy", baseHash);
    expect(status).toBe(200);
    const written = await read("Legacy.md");
    expect(countFactWrappers(written)).toBe(0);
    expect(written).toContain("It ships 4M units a year.");
    expect(written).toContain("Its shell is one billet.");
    // The `.md` form is still the blockquote callout, not the appendix component.
    expect(written).toContain("> [!factcheck]");
    expect(written).not.toContain("<FactCheck ");
    expect(body.supersededNote).toContain("2 marks from a previous check superseded");
    expect(await read("log.md")).toContain("; 2 prior marks superseded");
  });
});

/**
 * The Project facet's two wire halves on `/api/wiki/pages`: `project` per page
 * (which must survive `toListing` — it is a LISTING facet, so a strip there
 * would leave the facet with nothing to filter on) and the `projects` count map
 * beside `types`/`folderLabels`.
 *
 * Invented names throughout — muninn learns a wiki's project structure from the
 * wiki's own `.wiki-reader.json` declaration and must never know one by name.
 */
describe("project + projects map on /api/wiki/pages", () => {
  let root: string;
  let app: Hono;
  let prevWikiDir: string | undefined;

  const mount = async () => {
    prevWikiDir = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    __resetWikiCacheForTest();
    __resetWikiRegistryForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-project-route-"));
    for (const d of ["areas/pomme-core", "units", "misc"]) {
      await mkdir(path.join(root, d), { recursive: true });
    }
  });

  afterEach(async () => {
    if (prevWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevWikiDir;
    __resetWikiCacheForTest();
    __resetWikiRegistryForTest();
    await rm(root, { recursive: true, force: true });
  });

  type ProjectListing = { name: string; project?: string };
  type PagesBody = { pages: ProjectListing[]; projects: Record<string, number> };

  const write = (relPath: string, fmLines: string[]) =>
    Bun.write(path.join(root, relPath), ["---", ...fmLines, "---", "", "Body."].join("\n"));

  test("each page carries its project and the map counts them", async () => {
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({
        project: { pathFolders: ["areas"], pageFolder: "units", tagFallback: true },
      }),
    );
    await write("units/pomme-core.md", ["title: Pomme Core"]);
    await write("areas/pomme-core/setup.md", ["title: Setup"]);
    await write("areas/pomme-core/notes.md", ["title: Notes"]);
    await write("misc/orphan.md", ["title: Orphan", "tags: [misc]"]);
    await mount();

    const res = await app.request("/api/wiki/pages");
    expect(res.status).toBe(200);
    const data = (await res.json()) as PagesBody;
    const project = (name: string) => data.pages.find((p) => p.name === name)!.project;
    expect(project("pomme-core")).toBe("pomme-core");
    expect(project("setup")).toBe("pomme-core");
    // A page no rule matched carries no project at all — not "", not a bucket.
    expect(project("orphan")).toBeUndefined();
    // The map counts the same rows the listing ships, so the facet's numbers can
    // never disagree with what filtering on them returns.
    expect(data.projects).toEqual({ "pomme-core": 3 });
  });

  test("a wiki declaring no project rule ships an empty map and no project field", async () => {
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ typeLabels: { plan: "Plans" } }),
    );
    await write("units/pomme-core.md", ["title: Pomme Core"]);
    await write("areas/pomme-core/setup.md", ["title: Setup", "tags: [pomme]"]);
    await mount();

    const res = await app.request("/api/wiki/pages");
    const data = (await res.json()) as PagesBody;
    expect(data.pages.length).toBe(2);
    expect(data.pages.every((p) => p.project === undefined)).toBe(true);
    // `{}` is how the client knows to render no Project facet at all.
    expect(data.projects).toEqual({});
  });

  test("project survives toListing on the single-page meta too", async () => {
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ project: { pathFolders: ["areas"] } }),
    );
    await write("areas/pomme-core/setup.md", ["title: Setup"]);
    await mount();

    const res = await app.request("/api/wiki/page?name=setup");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { meta: ProjectListing };
    expect(data.meta.project).toBe("pomme-core");
  });
});

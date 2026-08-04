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
} from "../../wiki/factcheck-context.ts";

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
});

/**
 * `POST /api/wiki/ask/chat` — the Ask tab's "Continue in chat →" escalation.
 * Every side-effecting seam (bot discovery, chat config, threads, chat state, the
 * pending-message store) is injected via `__setAskChatDepsForTest`, so these run
 * with no DB and no chat process: what's under test is the resolution chain
 * (owning bot → user → thread name → 409/forceNew) and the seeded message.
 */
describe("POST /api/wiki/ask/chat", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  // Captured seam traffic.
  let created: { userId: string; botName: string; name: string; description?: string }[];
  let pending: { threadId: string; text: string }[];
  let existingThreadNames: string[];
  let users: { id: string; name: string }[];
  let bots: string[];
  let defaultUser: string | null;
  // Connector / existing-thread / pending-store seam state.
  let connectorRows: { id: string; name: string; connectorType: string }[];
  let threadsById: Record<string, { id: string; userId: string; botName: string; connectorId?: string }>;
  let livePending: string[];
  let connectorStamps: { threadId: string; connectorId: string | null }[];
  let createdConnectorIds: (string | undefined)[];

  /** Every non-DB seam, so no test can reach the live database. Shared by the
   *  suite's two `__setAskChatDepsForTest` blocks. */
  const fakeDeps = () => ({
    discoverBots: () => bots.map((name) => ({ name }) as unknown as BotConfig),
    loadChatConfig: async () => ({ users }),
    getBotDefaultUser: async () => defaultUser,
    findThreadByName: async (_userId: string, _botName: string, name: string) =>
      existingThreadNames.includes(name) ? { id: "existing-thread", name } : null,
    hasPendingMessage: (threadId: string) => livePending.includes(threadId),
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
  const CONNECTOR_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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
    ]);

    created = [];
    pending = [];
    existingThreadNames = [];
    users = [{ id: "user-1", name: "rune" }];
    bots = ["jarviswiki", "melosys"];
    defaultUser = null;
    connectorRows = [
      { id: CONNECTOR_UUID, name: "Copilot", connectorType: "copilot-sdk" },
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
    expect(data.chatUrl).toBe("/chat?bot=jarviswiki&thread=thread-1&user=user-1&src=wiki");

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
  });

  // ── chatUrl carries the stamp-suppression flag ──────────────────────
  test("the chatUrl tells the chat page not to stamp its remembered connector", async () => {
    // "(bot default)" is expressed as NO connector on the thread, which is exactly
    // what the chat page's `onlyIfEmpty` stamp would fill in from the sidebar.
    const res = await post(askBody());
    expect(((await res.json()) as { chatUrl: string }).chatUrl).toContain("&src=wiki");
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

    __setAskChatDepsForTest({
      discoverBots: () => bots as unknown as BotConfig[],
      loadChatConfig: async () => ({ users }),
      getBotDefaultUser: async () => defaultUser,
      listConnectors: async () => {
        if (listThrows) throw new Error("connectors table is gone");
        return connectorRows as never;
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
    needsBot: boolean;
    bots: { name: string }[];
    users: { id: string; name: string }[];
    defaultUserId: string | null;
    connectors: { id: string; name: string; connectorType: string; supportsWebTools: boolean }[];
    connectorsError?: string;
    botDefault: { connectorType: string; supportsWebTools: boolean } | null;
  };

  test("an owner wiki resolves bot, users, default user and capability-flagged connectors", async () => {
    const res = await app.request("/api/wiki/chat-target?wiki=jarviswiki");
    expect(res.status).toBe(200);
    const data = (await res.json()) as TargetBody;
    expect(data.botName).toBe("jarviswiki");
    expect(data.needsBot).toBe(false);
    expect(data.users.map((u) => u.id)).toEqual(["user-1", "user-2"]);
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
    expect(data.reason).toBe("needs_bot");
    expect(data.needsBot).toBe(true);
    expect(data.bots.map((b) => b.name)).toEqual(["jarviswiki", "melosys"]);
  });

  test("unknown_bot and bot_gone surface as reasons with the POST's messages", async () => {
    const unknown = (await (
      await app.request("/api/wiki/chat-target?wiki=jarviswiki&bot=ghost")
    ).json()) as TargetBody;
    expect(unknown.reason).toBe("unknown_bot");
    expect(unknown.needsBot).toBe(false);
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
});

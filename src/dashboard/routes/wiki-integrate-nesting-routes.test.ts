import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";

/**
 * The two `[[wikilink]]` containment seams that live in the ROUTE rather than in the
 * pure engine, driven over real HTTP against a real temp wiki.
 *
 * 1. **The propose route's non-annotatable branch.** `annotateEdits` runs on `.mdx`
 *    only, and the `.md` branch handed the model's corrections straight through — so
 *    a `[[Old Name]]` → `[[New Name]]` rewrite applied unchecked on exactly the pages
 *    nothing else looks at. Only the route can prove the branch is wired: the engine
 *    test proves the function, and the function was there all along on the other
 *    branch.
 * 2. **The apply route's post-splice repair.** `repairNestedFactWrappers` is called
 *    from inside `writeWikiPage`'s transform, and reverting `editedBody` back to
 *    `applyResult.body` in both return paths left the whole suite green. The
 *    observable is the FILE.
 *
 * `mock.module` invalidates its target for the whole `bun test` process graph, so
 * this file gets its OWN `bun test` link in package.json's chain (the
 * `data-routes-bot-scope.test.ts` rule). The model one-shot is the only thing mocked
 * — the wiki, the write queue, the CAS and the disk are real.
 *
 * Every fixture is invented. muninn is a PUBLIC repo — no wiki content.
 */

/** What the stubbed editor one-shot answers with on the next propose. */
let nextEdits: unknown[] = [];

mock.module("../../wiki/integrate-oneshot.ts", () => ({
  INTEGRATE_TIMEOUT_MS: 90_000,
  runIntegrateOneShot: async () => ({ result: JSON.stringify({ edits: nextEdits }) }),
}));

const { registerWikiRoutes } = await import("./wiki-routes.ts");
const { __resetWikiRegistryForTest } = await import("../../wiki/registry-memo.ts");
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");
const { __resetWikiWriteQueueForTest } = await import("../../wiki/queue.ts");

describe("integrate routes — wikilink containment", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  const MD_PAGE = "# Router\n\nRoute [[Old Name]] to the slow queue every night.\n";
  const ANSWER = "### ❌ Claim 1/1 — The router name\n\nThe name is wrong.\n\nSources: https://example.com/a\n";

  const post = (path_: string, body: unknown) =>
    app.request(path_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const onDisk = (rel: string) => Bun.file(path.join(root, rel)).text();
  const hashOf = async (rel: string) =>
    createHash("sha256").update(await Bun.file(path.join(root, rel)).text()).digest("hex");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-nesting-"));
    await Bun.write(path.join(root, "router.md"), MD_PAGE);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `nestwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiWriteQueueForTest();
    nextEdits = [];
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("REPRO: propose on a `.md` page drops a correction that rewrites a link TARGET", async () => {
    nextEdits = [
      { claimIndex: 1, verdict: "❌", old: "Old Name", new: "New Name", reason: "renamed" },
    ];
    const res = await post("/api/wiki/factcheck/integrate?wiki=nestwiki", {
      relPath: "router.md",
      answer: ANSWER,
      baseHash: await hashOf("router.md"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      annotatable: boolean;
      edits: unknown[];
      dropped: { reason: string }[];
    };
    // The premise: a `.md` page takes no marks, so this is the branch that had no
    // guard at all.
    expect(body.annotatable).toBe(false);
    expect(body.edits).toHaveLength(0);
    expect(body.dropped.map((d) => d.reason).join(" ")).toContain("rewrite the link target");
  });

  test("propose on a `.md` page still offers a correction that touches no link", async () => {
    nextEdits = [
      { claimIndex: 1, verdict: "❌", old: "slow queue", new: "fast queue", reason: "wrong queue" },
    ];
    const res = await post("/api/wiki/factcheck/integrate?wiki=nestwiki", {
      relPath: "router.md",
      answer: ANSWER,
      baseHash: await hashOf("router.md"),
    });
    const body = (await res.json()) as { edits: { new: string }[]; dropped: unknown[] };
    expect(body.edits).toHaveLength(1);
    expect(body.edits[0]!.new).toBe("fast queue");
    expect(body.dropped).toHaveLength(0);
  });

  test("REPRO: apply RE-NESTS a client-echoed mark that landed inside a link", async () => {
    // The apply route splices what the client echoes, which no engine tier
    // constrains — this shape is only reachable from there, and the file is the
    // only observable.
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=nestwiki", {
      relPath: "router.md",
      baseHash: await hashOf("router.md"),
      edits: [
        {
          claimIndex: 1,
          verdict: "❌",
          old: "[[Old Name]]",
          new: '[[<Fact n="1" v="bad">Old Name</Fact>]]',
          reason: "marks the name",
        },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { applied: number }).toMatchObject({ applied: 1 });
    const written = await onDisk("router.md");
    // The mark is OUTSIDE the brackets and the link target is byte-intact.
    expect(written).toContain('<Fact n="1" v="bad">[[Old Name]]</Fact>');
    expect(written).not.toContain("[[<Fact");
  });

  test("apply leaves a page DOCUMENTING the broken shape in backticks alone", async () => {
    await Bun.write(
      path.join(root, "doc.md"),
      "# Doc\n\nThe broken shape is `[[<Fact n=\"4\" v=\"ok\">A Page</Fact>]]` — never ship it.\n",
    );
    __resetWikiCacheForTest();
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=nestwiki", {
      relPath: "doc.md",
      baseHash: await hashOf("doc.md"),
      edits: [{ claimIndex: 0, verdict: "", old: "never ship it", new: "do not ship it", reason: "x" }],
    });
    expect(res.status).toBe(200);
    const written = await onDisk("doc.md");
    expect(written).toContain('`[[<Fact n="4" v="ok">A Page</Fact>]]`');
    expect(written).toContain("do not ship it");
  });
});

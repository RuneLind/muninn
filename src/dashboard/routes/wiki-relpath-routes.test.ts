import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import {
  __resetWikiRegistryForTest,
} from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";

/**
 * **Page ACTIONS must target the page the reader is looking at.**
 *
 * `index.resolve(name)` is first-registration-wins on the lowercased filename
 * stem, so on any wiki holding two same-stem pages a name-keyed action resolves
 * to whichever one sorted first. Measured on mimir before this fix: open
 * `projects/yggdrasil/architecture.md`, press fact-check, press ➕, and the
 * callout is WRITTEN INTO `projects/claude-hivemind/architecture.md`.
 *
 * Every route here therefore takes `relPath` (preferred) with the `page` name as
 * a fallback — the fallback matters because the client's copy of a path goes
 * stale the moment a page is renamed, and a 404 on a page that is plainly there
 * is worse than a stem resolution.
 *
 * The fixture is two same-stem pages in a fixed registration order: `a/dup.md`
 * sorts (and so registers) first, `b/dup.md` second. Every assertion points
 * `relPath` at the SECOND one — the one a name lookup can never reach.
 */
describe("wiki routes resolve by relPath, name as fallback", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  const FIRST = "# Dup A\n\nThe A page.\n";
  const SECOND = "# Dup B\n\nThe B page.\n";
  // A page whose stem is UNIQUE — the only shape a stale relPath may fall back to
  // by name (see the two stale-relPath tests below).
  const SOLO = "# Solo\n\nThe only page with this stem.\n";

  const post = (path_: string, body?: unknown) =>
    app.request(path_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const onDisk = (rel: string) => Bun.file(path.join(root, rel)).text();
  const hashOf = async (rel: string) =>
    createHash("sha256").update(await Bun.file(path.join(root, rel)).text()).digest("hex");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-relpath-"));
    await mkdir(path.join(root, "a"), { recursive: true });
    await mkdir(path.join(root, "b"), { recursive: true });
    await Bun.write(path.join(root, "a/dup.md"), FIRST);
    await Bun.write(path.join(root, "b/dup.md"), SECOND);
    await Bun.write(path.join(root, "solo.md"), SOLO);
    prevExtra = process.env.WIKI_EXTRA;
    // A collection is declared so the Explain/Similar preflights reach their PAGE
    // check — both stop at "no collection connected" before it otherwise, and a
    // test that never reaches the resolution proves nothing about it. Huginn is
    // unreachable here, which Similar degrades to `{similar: []}` by contract.
    process.env.WIKI_EXTRA = `dupwiki=${root}=dupcoll`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiWriteQueueForTest();
    app = new Hono();
    // A 500 here means the route reached something a test has no business
    // reaching (a DB call, a model call) — the convention the sibling suites use.
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

  test("PREMISE: the bare name resolves to the FIRST registration, never the second", async () => {
    // If this ever stops holding, every assertion below stops testing anything.
    const res = await app.request("/api/wiki/page?wiki=dupwiki&name=dup");
    const body = (await res.json()) as { meta: { relPath: string } };
    expect(body.meta.relPath).toBe("a/dup.md");
  });

  // ---- the WRITE, which is the serious one --------------------------------

  test("factcheck/append writes into the relPath page, not the first-stem match", async () => {
    const res = await post("/api/wiki/factcheck/append?wiki=dupwiki", {
      page: "dup",
      relPath: "b/dup.md",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("b/dup.md"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: boolean; page: string };
    expect(body.written).toBe(true);
    expect(body.page).toBe("b/dup.md");
    // The observable that matters: B grew the callout, A is byte-untouched.
    expect(await onDisk("b/dup.md")).toContain("[!factcheck]");
    expect(await onDisk("a/dup.md")).toBe(FIRST);
  });

  test("factcheck/append still accepts a bare name (a stale relPath must not 404)", async () => {
    // The name must resolve UNAMBIGUOUSLY for the fallback to run — `solo` does.
    const res = await post("/api/wiki/factcheck/append?wiki=dupwiki", {
      page: "solo",
      relPath: "renamed-away.md", // what an open tab holds after a rename
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("solo.md"),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { page: string }).page).toBe("solo.md");
  });

  test("a stale relPath does NOT fall back onto a COLLIDING stem — it 404s", async () => {
    // The whole point of the relPath is that `dup` cannot say which page is meant.
    // `explain`/`share`/`claim` have no CAS, so falling back here reads (and, for a
    // reader acting on the answer, eventually WRITES to) a page nobody opened.
    const res = await post("/api/wiki/factcheck/append?wiki=dupwiki", {
      page: "dup",
      relPath: "b/renamed-away.md",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("a/dup.md"),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("b/renamed-away.md");
    // Neither same-stem page was touched.
    expect(await onDisk("a/dup.md")).toBe(FIRST);
    expect(await onDisk("b/dup.md")).toBe(SECOND);
  });

  test("factcheck/append CAS is measured against the relPath page", async () => {
    // Sending B's relPath with A's hash must be a 409, not a write — proof the
    // CAS reads the resolved page's bytes rather than the name's.
    const res = await post("/api/wiki/factcheck/append?wiki=dupwiki", {
      page: "dup",
      relPath: "b/dup.md",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("a/dup.md"),
    });
    expect(res.status).toBe(409);
    expect(await onDisk("b/dup.md")).toBe(SECOND);
    expect(await onDisk("a/dup.md")).toBe(FIRST);
  });

  // ---- the read/egress routes ---------------------------------------------

  test("factcheck/integrate reaches the relPath page (its CAS is the observable)", async () => {
    // A CORRECT hash for B proves the route resolved B: the CAS runs before any
    // model call, and the zero-claims early return then answers 200 without one.
    const ok = await post("/api/wiki/factcheck/integrate?wiki=dupwiki", {
      page: "dup",
      relPath: "b/dup.md",
      answer: "No claim headings here at all.",
      baseHash: await hashOf("b/dup.md"),
    });
    expect(ok.status).toBe(200);
    // …and A's hash against B's relPath is stale, i.e. it really did read B.
    const stale = await post("/api/wiki/factcheck/integrate?wiki=dupwiki", {
      page: "dup",
      relPath: "b/dup.md",
      answer: "No claim headings here at all.",
      baseHash: await hashOf("a/dup.md"),
    });
    expect(stale.status).toBe(409);
  });

  test("factcheck/integrate/apply edits the relPath page with NO name beside it", async () => {
    // relPath ONLY — the reader holds a path for the open page and the name is
    // just a stem; a route that still demanded `page` refused the one reference
    // that is collision-proof.
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=dupwiki", {
      relPath: "b/dup.md",
      baseHash: await hashOf("b/dup.md"),
      edits: [{ old: "The B page.", new: "The B page, corrected." }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; page: string };
    expect(body.applied).toBe(1);
    expect(body.page).toBe("b/dup.md");
    expect(await onDisk("b/dup.md")).toContain("The B page, corrected.");
    expect(await onDisk("a/dup.md")).toBe(FIRST);
  });

  test("factcheck/integrate accepts a relPath with no name", async () => {
    const res = await post("/api/wiki/factcheck/integrate?wiki=dupwiki", {
      relPath: "b/dup.md",
      answer: "No claim headings here at all.",
      baseHash: await hashOf("b/dup.md"),
    });
    expect(res.status).toBe(200);
  });

  test("every unresolvable-page 404 uses the ONE shared sentence", async () => {
    // Three spellings used to exist: `noPageMessage`, a lowercase period-less
    // variant on the integrate routes, and a hand-rolled copy in ask/chat.
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=dupwiki", {
      page: "dup", // ambiguous stem ⇒ no rename fallback, so this really 404s
      relPath: "b/nope.md",
      baseHash: "0".repeat(64),
      edits: [{ old: "x", new: "y" }],
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'No wiki page for relPath "b/nope.md" or name "dup".',
    );
  });

  test("similar resolves the relPath page (404 quotes the reference actually sent)", async () => {
    // A resolvable relPath gets past resolution and degrades on the unreachable
    // huginn (the route's contract); an unresolvable one 404s naming THAT path.
    const good = await app.request("/api/wiki/similar?wiki=dupwiki&relPath=b/dup.md");
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ similar: [] });
    const bad = await app.request("/api/wiki/similar?wiki=dupwiki&relPath=b/nope.md");
    expect(bad.status).toBe(404);
    expect(await bad.text()).toContain("b/nope.md");
  });

  test("explain names the relPath page in its preflight, not the first-stem one", async () => {
    // SSE, so the page problem arrives as an `app_error` on a committed 200. A
    // relPath nothing resolves must name THAT path — if the route fell back to
    // the stem it would resolve `a/dup.md` and preflight clean.
    const res = await app.request(
      "/api/wiki/explain?wiki=dupwiki&relPath=b/nope.md&sel=the%20A%20page",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("b/nope.md");
  });

  test("factcheck names the relPath page in its preflight", async () => {
    const res = await app.request(
      "/api/wiki/factcheck?wiki=dupwiki&relPath=b/nope.md&mode=article",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("b/nope.md");
  });

  test("factcheck/claim names the relPath page in its preflight", async () => {
    const res = await app.request(
      "/api/wiki/factcheck/claim?wiki=dupwiki&relPath=b/nope.md&mode=article&index=1&total=1&title=T",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("b/nope.md");
  });

  test("share resolves the relPath page", async () => {
    // Preset validation runs after the WIKI and the PAGE resolve, so an
    // unresolvable relPath must not sail through on the stem.
    // relPath ONLY, and one nothing resolves: with the name beside it the
    // fallback would resolve `a/dup.md` and the route would spend a real
    // model call, which is not a thing a unit test may do.
    const res = await post("/api/wiki/share?wiki=dupwiki", {
      relPath: "b/nope.md",
      preset: "email",
      lang: "en",
    });
    expect(res.status).toBe(200); // SSE — page problems are app_error, not 400
    // Read only the FIRST chunk: this scaffold holds the stream open on a
    // heartbeat, so `res.text()` never settles.
    expect(await firstChunk(res)).toContain("b/nope.md");
  });
});

/** The first chunk of an SSE body — enough for a preflight `app_error`, and it
 *  does not wait for a stream whose contract is to stay open. */
async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value ?? new Uint8Array());
  } finally {
    await reader.cancel();
  }
}

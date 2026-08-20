import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";
import {
  __resetWikiRegistryForTest,
  __setWikiRegistryForTest,
  getWikiRegistry,
} from "../../wiki/registry-memo.ts";
import type { WikiProposal } from "../../db/wiki-proposals.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";
import {
  __setReadonlyWikiRootsForTest,
  __setWikiReadonlyForTest,
  WIKI_READONLY_REASON,
} from "../../wiki/readonly.ts";
import { agentStatus } from "../../observability/agent-status.ts";
import {
  isBlockedByReadonly,
  wikiBlockedMessageFor,
  wikiBlockedSelectorFor,
  wikiReadonlyWikiFlag,
  wikiReadonlyKeyActivates,
  WIKI_READONLY_ASK_HINT,
  WIKI_READONLY_BANNER_TEXT,
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_CLIENT_MESSAGE,
  WIKI_READONLY_DISABLED_INPUTS,
  WIKI_READONLY_EGRESS_SELECTOR,
  WIKI_READONLY_GUARDED_EVENTS,
  WIKI_READONLY_INPUT_PLACEHOLDER,
  WIKI_READONLY_WIKI_MESSAGE,
} from "../views/components/wiki-readonly-client.ts";

/**
 * `WIKI_READONLY_ROOTS` at the ROUTE level — the per-wiki guard on a
 * WRITE-OWNING instance (`MUNINN_WIKI_READONLY` is off throughout, which is what
 * separates this suite from `wiki-readonly.test.ts`).
 *
 * Two families:
 *   1. the WRITE routes, refused by the root-keyed seam guard with the file
 *      byte-unchanged;
 *   2. the EGRESS routes — everything that would spend a model call, reach the
 *      live web, or seed a chat thread on this wiki's content. Registration buys
 *      that surface too, and `DASHBOARD_HOST=127.0.0.1` does not bound it.
 *
 * Every case has a CONTROL on a second, writable wiki asserting a CONCRETE
 * non-403 status. "not 403" alone would be satisfied by a route that had stopped
 * existing — and the whole failure mode this guards against is a guard that
 * reads correctly and never runs, or one that runs everywhere.
 *
 * The controls are deliberately chosen to stop for a CHEAP reason (unknown
 * preset, no collections, stale hash, no bot): `discoverAllBots()` sees the real
 * `bots/` folder in a test run, so a control that ran to completion would spend
 * a real model call.
 */
describe("WIKI_READONLY_ROOTS — routes", () => {
  let ro: string;
  let rw: string;
  let app: Hono;
  let prevExtra: string | undefined;
  const PAGE = "# Widgets\n\nThe device ships 4M units.\n";

  const post = (path_: string, body?: unknown) =>
    app.request(path_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const roPageOnDisk = () => Bun.file(path.join(ro, "Widgets.md")).text();
  const hashOf = async (root: string, rel: string) =>
    createHash("sha256").update(await Bun.file(path.join(root, rel)).text()).digest("hex");

  beforeEach(async () => {
    ro = await mkdtemp(path.join(tmpdir(), "wiki-ro-root-"));
    rw = await mkdtemp(path.join(tmpdir(), "wiki-rw-root-"));
    await Bun.write(path.join(ro, "Widgets.md"), PAGE);
    await Bun.write(path.join(rw, "Widgets.md"), PAGE);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `rowiki=${ro},rwwiki=${rw}`;
    __setWikiReadonlyForTest(false); // the instance OWNS writes — that is the point
    __setReadonlyWikiRootsForTest([ro]);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiWriteQueueForTest();
    app = new Hono();
    // A 500 here means "no guard ran and the route reached a DB call" — the same
    // convention `wiki-readonly.test.ts` uses.
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    registerWikiGardenerRoutes(app);
  });

  afterEach(async () => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(ro, { recursive: true, force: true });
    await rm(rw, { recursive: true, force: true });
  });

  test("the registry stamps `readonly` on the listed wiki only", () => {
    const reg = getWikiRegistry();
    expect(reg.find((e) => e.name === "rowiki")?.readonly).toBe(true);
    expect(reg.find((e) => e.name === "rwwiki")?.readonly).toBeUndefined();
  });

  // ---- writes -------------------------------------------------------------

  test("factcheck/append 403s on a WELL-FORMED body and the page is byte-unchanged", async () => {
    // Well-formed on purpose: `page`/`answer`/`baseHash` missing returns 400
    // BEFORE the wiki is resolved, and a 400 leaves the file byte-identical too —
    // so a bare POST would record a pass while the seam never ran.
    const res = await post("/api/wiki/factcheck/append?wiki=rowiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf(ro, "Widgets.md"),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; readonly: boolean };
    expect(body.readonly).toBe(true);
    // NOT the instance sentence — this host writes wikis, just not this one.
    expect(body.error).not.toBe(WIKI_READONLY_REASON);
    expect(body.error).toContain("WIKI_READONLY_ROOTS");
    expect(await roPageOnDisk()).toBe(PAGE);
    expect(await Bun.file(path.join(ro, "log.md")).exists()).toBe(false);
  });

  test("CONTROL: the same well-formed append on the writable wiki WRITES", async () => {
    const res = await post("/api/wiki/factcheck/append?wiki=rwwiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf(rw, "Widgets.md"),
    });
    expect(res.status).toBe(200);
    expect(await Bun.file(path.join(rw, "Widgets.md")).text()).not.toBe(PAGE);
  });

  test("factcheck/integrate/apply 403s on its OWN well-formed payload", async () => {
    // This route has six more pre-`writeWikiPage` 400 gates than append (edit
    // shape, edit count, per-edit char cap, the `<Fact`-wrapper rule, the body
    // cap, the reserved-basename refusal), every one of which also leaves the
    // file byte-identical. One small edit whose `new` does not open with `<Fact`.
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=rowiki", {
      page: "Widgets",
      baseHash: await hashOf(ro, "Widgets.md"),
      edits: [
        { claimIndex: 1, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units", reason: "filing" },
      ],
    });
    expect(res.status).toBe(403);
    expect(await roPageOnDisk()).toBe(PAGE);
  });

  // ---- egress -------------------------------------------------------------

  test("every egress route 403s on the read-only wiki", async () => {
    const baseHash = await hashOf(ro, "Widgets.md");
    const cases: [string, unknown?][] = [
      ["GET /api/wiki/digest?wiki=rowiki"],
      ["GET /api/wiki/ask?wiki=rowiki&q=what%20is%20this"],
      ["GET /api/wiki/explain?wiki=rowiki&page=Widgets&sel=ships%204M"],
      ["GET /api/wiki/factcheck?wiki=rowiki&page=Widgets&mode=article"],
      [
        "GET /api/wiki/factcheck/claim?wiki=rowiki&page=Widgets&mode=article&title=Claim&index=1&total=1",
      ],
      ["POST /api/wiki/share?wiki=rowiki", { page: "Widgets", preset: "neutral", lang: "en" }],
      ["POST /api/wiki/remember?wiki=rowiki", { question: "q", answer: "a" }],
      ["POST /api/wiki/ask/chat?wiki=rowiki", { question: "q", answer: "a" }],
      [
        "POST /api/wiki/factcheck/integrate?wiki=rowiki",
        { page: "Widgets", answer: "### ❌ Claim 1/1 — Wrong\n\nNope.", baseHash },
      ],
      [
        "POST /api/wiki/atlas/draft-synthesis?wiki=rowiki",
        { members: ["Widgets"], label: "Widgets" },
      ],
    ];
    const runsBefore = agentStatus.getAll().length;
    for (const [spec, body] of cases) {
      const [method, url] = spec.split(" ") as [string, string];
      const res = method === "GET" ? await app.request(url) : await post(url, body);
      expect(`${spec} → ${res.status}`).toBe(`${spec} → 403`);
      await res.text();
    }
    // Refused BEFORE the run is registered — the observable that separates
    // "refused" from "refused after paying for it".
    expect(agentStatus.getAll().length).toBe(runsBefore);
  });

  test("CONTROL: the same routes on the writable wiki stop for their OWN reason", async () => {
    // Each concrete status is a post-resolution refusal that costs no model call,
    // which is exactly what proves the prologue is per-wiki rather than global.
    const digest = await app.request("/api/wiki/digest?wiki=rwwiki");
    expect(digest.status).toBe(200); // no log.md ⇒ {digest: null}
    expect(((await digest.json()) as { digest: unknown }).digest).toBeNull();

    const share = await post("/api/wiki/share?wiki=rwwiki", {
      page: "Widgets",
      preset: "no-such-preset-id",
      lang: "en",
    });
    expect(share.status).toBe(400); // unknown preset — resolved AFTER the wiki
    expect(await share.text()).toContain("preset");

    const chat = await post("/api/wiki/ask/chat?wiki=rwwiki", { question: "q", answer: "a" });
    expect(chat.status).toBe(400); // standalone wiki, no owner and no pin
    expect(((await chat.json()) as { needsBot?: boolean }).needsBot).toBe(true);

    const integrate = await post("/api/wiki/factcheck/integrate?wiki=rwwiki", {
      page: "Widgets",
      answer: "### ❌ Claim 1/1 — Wrong\n\nNope.",
      baseHash: "deadbeef",
    });
    expect(integrate.status).toBe(409); // stale CAS — reached, and refused there
    expect(((await integrate.json()) as { stale?: boolean }).stale).toBe(true);

    const atlas = await post("/api/wiki/atlas/draft-synthesis?wiki=rwwiki", {
      members: ["Widgets"],
      label: "Widgets",
    });
    expect(atlas.status).toBe(400); // no collections connected
    expect(await atlas.text()).toContain("collection");
  });

  test("an egress refusal is logged, naming the wiki AND the route", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      const res = await post("/api/wiki/share?wiki=rowiki", { page: "Widgets", preset: "neutral", lang: "en" });
      expect(res.status).toBe(403);
      const hit = records
        .filter((r) => r.level === "info")
        .find((r) => r.message.join("").includes("Read-only wiki"));
      expect(hit).toBeDefined();
      const props = JSON.stringify(hit!.properties);
      expect(props).toContain("rowiki");
      expect(props).toContain("/api/wiki/share");
    } finally {
      await reset();
    }
  });

  test("all THREE ask/chat modes 403 — not only the one the plan named", async () => {
    // `escalate` quotes an answer built over these pages; `direct` seeds a bot
    // told to search this wiki first; `article` quotes the page outright. The
    // route's body-shape checks differ per mode, so each is posted well-formed
    // for ITS mode — a shared payload would 400 two of them before the guard.
    const cases: [string, unknown][] = [
      ["escalate", { question: "q", answer: "a" }],
      ["direct", { question: "q", mode: "direct" }],
      ["article", { question: "q", mode: "article", page: "Widgets" }],
    ];
    for (const [mode, body] of cases) {
      const res = await post("/api/wiki/ask/chat?wiki=rowiki", body);
      expect(`${mode} → ${res.status}`).toBe(`${mode} → 403`);
      expect(`${mode} → ${((await res.json()) as { readonly?: boolean }).readonly}`).toBe(
        `${mode} → true`,
      );
    }
  });

  test("reindex 403s — it ships page BODIES to huginn's embedder", async () => {
    const res = await post("/api/wiki/reindex?wiki=rowiki");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { readonly?: boolean }).readonly).toBe(true);
    // CONTROL: the writable wiki reaches its own collection-less answer (200).
    const ok = await post("/api/wiki/reindex?wiki=rwwiki");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("collection");
  });

  test("the reader page injects the per-wiki flag for that wiki only", async () => {
    const roHtml = await (await app.request("/wiki?wiki=rowiki")).text();
    expect(roHtml).toContain("window.__WIKI_READONLY_WIKI__ = true");
    // The INSTANCE flag stays off — the two are independent.
    expect(roHtml).toContain("window.__WIKI_READONLY__ = false");
    const rwHtml = await (await app.request("/wiki?wiki=rwwiki")).text();
    expect(rwHtml).toContain("window.__WIKI_READONLY_WIKI__ = false");
  });

  test("the read-only page disables the Ask box and shows the banner", async () => {
    // The placeholder string is ALSO inside the bundled client script (the
    // follow-up bar renders it), so a whole-document `toContain` proves nothing
    // about the Ask box — assert on the rendered element.
    const askBox = (html: string) => html.match(/<textarea[^>]*id="wikiAskInput"[^>]*>/)![0];

    const roHtml = await (await app.request("/wiki?wiki=rowiki")).text();
    expect(roHtml).toContain(WIKI_READONLY_BANNER_TEXT);
    expect(askBox(roHtml)).toContain(" disabled");
    expect(askBox(roHtml)).toContain(WIKI_READONLY_INPUT_PLACEHOLDER);
    expect(roHtml).toContain(WIKI_READONLY_ASK_HINT);
    expect(roHtml).not.toContain("Ask a question and this wiki answers");
    // The "Answered by <bot> … research-bot fallback" line describes a call this
    // wiki can never make.
    expect(roHtml).not.toContain("Answered by");

    const rwHtml = await (await app.request("/wiki?wiki=rwwiki")).text();
    expect(rwHtml).toContain("Ask a question and this wiki answers");
    expect(askBox(rwHtml)).not.toContain(" disabled");
    expect(askBox(rwHtml)).toContain("Ask this wiki");
  });
});

describe("WIKI_READONLY_ROOTS — the WIKI_DIR env-override shape", () => {
  // `resolveWikiRequest` returns NO entry for a bare `/wiki` on an instance that
  // sets `WIKI_DIR`, and the routes then serve `resolveWikiRoot(undefined)`. A
  // guard keyed on the ENTRY therefore failed OPEN on exactly the root an
  // operator pointed the env var at.
  let ro: string;
  let prevWikiDir: string | undefined;
  let prevExtra: string | undefined;
  let app: Hono;

  beforeEach(async () => {
    ro = await mkdtemp(path.join(tmpdir(), "wiki-envoverride-"));
    await Bun.write(path.join(ro, "Widgets.md"), "# Widgets\n\nBody.\n");
    prevWikiDir = process.env.WIKI_DIR;
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_DIR = ro;
    delete process.env.WIKI_EXTRA;
    __setWikiReadonlyForTest(false);
    __setReadonlyWikiRootsForTest([ro]);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    if (prevWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevWikiDir;
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(ro, { recursive: true, force: true });
  });

  test("an egress route with NO ?wiki= still refuses on the resolved root", async () => {
    const res = await app.request("/api/wiki/ask?q=what%20is%20this");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; readonly?: boolean };
    expect(body.readonly).toBe(true);
    // No entry ⇒ no name to quote; the sentence must not read `the "" wiki`.
    expect(body.error).not.toContain('""');
    expect(body.error).toContain("WIKI_READONLY_ROOTS");
  });

  test("the reader page injects the per-wiki flag from the same resolved root", async () => {
    const html = await (await app.request("/wiki")).text();
    expect(html).toContain("window.__WIKI_READONLY_WIKI__ = true");
  });

  test("CONTROL: an unlisted WIKI_DIR root is untouched", async () => {
    __setReadonlyWikiRootsForTest([]);
    const res = await app.request("/api/wiki/ask?q=what%20is%20this");
    expect(res.status).not.toBe(403);
    await res.text();
  });
});

describe("WIKI_READONLY_ROOTS — gardener approve + backlog", () => {
  let ro: string;
  let prevExtra: string | undefined;
  let app: Hono;
  /** Set by the fake CAS when the route claims the row — the whole point. */
  let approved: string[];

  const fakeProposal = (over: Partial<WikiProposal> = {}): WikiProposal =>
    ({
      id: "p1",
      botName: "jarvis",
      wikiName: "rowiki",
      topicKey: "widgets",
      kind: "synthesis",
      mode: "create",
      targetPath: "blogs/Widgets.md",
      draft: "---\ntitle: Widgets\ntype: blog\n---\n\nBody.\n",
      status: "draft",
      ...over,
    }) as unknown as WikiProposal;

  const deps = (proposal: WikiProposal | null) =>
    ({
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => null,
      getSnapshot: async () => null,
      setSnapshot: async () => {},
      listProposals: async () => [],
      getProposalById: async () => proposal,
      approveProposal: async (id: string) => {
        approved.push(id);
        return proposal ? ({ ...proposal, status: "approved" } as WikiProposal) : null;
      },
    }) as unknown as Parameters<typeof registerWikiGardenerRoutes>[1];

  beforeEach(async () => {
    approved = [];
    ro = await mkdtemp(path.join(tmpdir(), "wiki-ro-approve-"));
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `rowiki=${ro}`;
    __setWikiReadonlyForTest(false);
    __setReadonlyWikiRootsForTest([ro]);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
  });

  afterEach(async () => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(ro, { recursive: true, force: true });
  });

  test("approve 403s BEFORE the draft→approved CAS — the row stays reviewable", async () => {
    // Measured before the fix: the CAS ran, `applyWikiProposal`'s root guard then
    // answered 403, and the row was left in `approved` — where the gate offers no
    // verb at all (reject 409s "not reviewable"). Stuck forever on a refusal that
    // changed nothing.
    registerWikiGardenerRoutes(app, deps(fakeProposal()));
    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; readonly?: boolean };
    expect(body.readonly).toBe(true);
    expect(body.error).toContain("WIKI_READONLY_ROOTS");
    // The observable that separates this fix from the pre-existing seam guard.
    expect(approved).toEqual([]);
  });

  test("CONTROL: the same approve on a WRITABLE wiki reaches the CAS", async () => {
    __setReadonlyWikiRootsForTest([]);
    registerWikiGardenerRoutes(app, deps(fakeProposal()));
    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    // It fails later (no such wiki root content / apply error) — what matters is
    // that the row WAS claimed, i.e. the guard is per-wiki and not global.
    expect(res.status).not.toBe(403);
    expect(approved).toEqual(["p1"]);
    await res.text();
  });

  test("resolveBacklogBot refuses a read-only BOT wiki", async () => {
    // The `source !== "bot"` check covers a standalone read-only wiki; it does
    // NOT cover a bot whose own `wikiDir` is listed. Every drafting POST in that
    // file funnels through this one prologue.
    __setWikiRegistryForTest([{ name: "robot", root: ro, source: "bot", readonly: true }]);
    registerWikiGardenerRoutes(app, deps(null));
    const res = await app.request("/api/wiki/gardener/backlog-run?wiki=robot", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("WIKI_READONLY_ROOTS");
  });

  test("CONTROL: a writable BOT wiki gets its own 404, not the refusal", async () => {
    __setReadonlyWikiRootsForTest([]);
    __setWikiRegistryForTest([{ name: "robot", root: ro, source: "bot" }]);
    registerWikiGardenerRoutes(app, deps(null));
    const res = await app.request("/api/wiki/gardener/backlog-run?wiki=robot", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no wiki bot resolved");
  });
});

describe("WIKI_READONLY_ROOTS — client guard", () => {
  test("the egress selector covers every affordance whose route now 403s", () => {
    for (const sel of [
      "#wikiShareBtn",
      "#wikiFactcheckBtn",
      "#wikiFactcheckArticleBtn",
      "#wikiExplainBtn",
      "#wikiDiscussBtn",
      "#wikiAskBtn",
      "#wikiNewChatBtn",
      "#wikiFollowupBtn",
      "#wikiRememberBtn",
      "#wikiChatEscBtn",
      "#wikiChatDeclineBtn",
      "[data-claim-retry-btn]",
      "#wikiClaimRetryAll",
    ]) {
      expect(WIKI_READONLY_EGRESS_SELECTOR).toContain(sel);
    }
  });

  test("a read-only WIKI blocks writes AND egress; a read-only INSTANCE blocks writes only", () => {
    // Adding the egress ids to the shared write list would dim 📤 Share and 🔎
    // Fact check on the mini too, where the server serves both happily.
    const wikiSel = wikiBlockedSelectorFor(false, true);
    expect(wikiSel).toContain("#wikiShareBtn");
    expect(wikiSel).toContain("#wikiFactcheckAppendBtn");

    const instanceSel = wikiBlockedSelectorFor(true, false);
    expect(instanceSel).toBe(WIKI_READONLY_BLOCKED_SELECTOR);
    expect(instanceSel).not.toContain("#wikiShareBtn");

    // Neither flag ⇒ no selector at all, so no listener is installed.
    expect(wikiBlockedSelectorFor(false, false)).toBe("");
    expect(isBlockedByReadonly(null, "")).toBe(false);
  });

  test("the per-wiki sentence wins where both apply", () => {
    expect(wikiBlockedMessageFor(false, true)).toBe(WIKI_READONLY_WIKI_MESSAGE);
    expect(wikiBlockedMessageFor(true, true)).toBe(WIKI_READONLY_WIKI_MESSAGE);
    expect(wikiBlockedMessageFor(true, false)).toBe(WIKI_READONLY_CLIENT_MESSAGE);
    expect(wikiBlockedMessageFor(false, false)).toBe("");
    // It must not claim MUNINN_WIKI_READONLY on a write-owning host.
    expect(WIKI_READONLY_WIKI_MESSAGE).not.toContain("MUNINN_WIKI_READONLY");
    expect(WIKI_READONLY_WIKI_MESSAGE).toContain("WIKI_READONLY_ROOTS");
  });

  test("the per-wiki flag is read off the injected global, strict true only", () => {
    expect(wikiReadonlyWikiFlag({})).toBe(false);
    expect(wikiReadonlyWikiFlag({ __WIKI_READONLY_WIKI__: "true" })).toBe(false);
    expect(wikiReadonlyWikiFlag({ __WIKI_READONLY_WIKI__: true })).toBe(true);
  });

  test("the guard listens on mousedown and keydown, not click alone", () => {
    // Three egress buttons are activated from a `mousedown` delegate (Explain +
    // both fact-check buttons — mousedown so `preventDefault` keeps the text
    // selection alive), which fires BEFORE click and had already spent the call
    // by the time a click-only listener ran. Two more are reachable by keyboard
    // with no pointer event at all.
    expect(WIKI_READONLY_GUARDED_EVENTS).toContain("mousedown");
    expect(WIKI_READONLY_GUARDED_EVENTS).toContain("keydown");
    expect(WIKI_READONLY_GUARDED_EVENTS).toContain("click");
  });

  test("only ACTIVATING keys are cancelled — Tab and typing are not", () => {
    expect(wikiReadonlyKeyActivates("Enter")).toBe(true);
    expect(wikiReadonlyKeyActivates(" ")).toBe(true);
    expect(wikiReadonlyKeyActivates("Spacebar")).toBe(true);
    // Cancelling Tab would trap focus; cancelling characters buys nothing —
    // the activation is what spends the model call.
    expect(wikiReadonlyKeyActivates("Tab")).toBe(false);
    expect(wikiReadonlyKeyActivates("a")).toBe(false);
    expect(wikiReadonlyKeyActivates("Escape")).toBe(false);
  });

  test("the two Enter-submitting inputs are in the selector AND the disable list", () => {
    // The selector is what survives the follow-up bar's re-render; `disabled` is
    // what makes the box look like what it is. Both halves, both inputs.
    for (const id of WIKI_READONLY_DISABLED_INPUTS) {
      expect(WIKI_READONLY_EGRESS_SELECTOR).toContain(id);
    }
    expect(WIKI_READONLY_DISABLED_INPUTS).toEqual(["#wikiAskInput", "#wikiFollowupInput"]);
    // And they are NOT on the instance list — the mini serves Ask happily.
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain("#wikiAskInput");
  });

  test("the banner and the ask-hint state BOTH halves of the guarantee", () => {
    expect(WIKI_READONLY_BANNER_TEXT).toMatch(/never written/i);
    expect(WIKI_READONLY_BANNER_TEXT).toMatch(/never sent to a model/i);
    expect(WIKI_READONLY_ASK_HINT).toMatch(/model|web/);
    // Neither may claim the INSTANCE flag on a write-owning host.
    expect(WIKI_READONLY_BANNER_TEXT).not.toContain("MUNINN_WIKI_READONLY");
    expect(WIKI_READONLY_ASK_HINT).not.toContain("MUNINN_WIKI_READONLY");
  });
});

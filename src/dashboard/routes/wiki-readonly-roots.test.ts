import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";
import { __resetWikiRegistryForTest, getWikiRegistry } from "../../wiki/registry-memo.ts";
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
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_CLIENT_MESSAGE,
  WIKI_READONLY_EGRESS_SELECTOR,
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

  test("the reader page injects the per-wiki flag for that wiki only", async () => {
    const roHtml = await (await app.request("/wiki?wiki=rowiki")).text();
    expect(roHtml).toContain("window.__WIKI_READONLY_WIKI__ = true");
    // The INSTANCE flag stays off — the two are independent.
    expect(roHtml).toContain("window.__WIKI_READONLY__ = false");
    const rwHtml = await (await app.request("/wiki?wiki=rwwiki")).text();
    expect(rwHtml).toContain("window.__WIKI_READONLY_WIKI__ = false");
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
});

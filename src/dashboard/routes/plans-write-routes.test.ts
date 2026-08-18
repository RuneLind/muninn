/**
 * `POST /api/plans/priority` and `POST /api/plans/order`.
 *
 * These drive the REAL write path — `writeWikiPage` and `writePlanQueue`,
 * including the per-wiki queue and both CAS branches — against a mkdtemp wiki
 * root, so a mock cannot make a broken write look green. Only the wiki ROOT is
 * injected (through the already-injectable `loadSource`); nothing else is faked.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerPlansRoutes, type PlanBoardDeps } from "./plans-routes.ts";
import type { Config } from "../../config.ts";
import { loadPlanSource, QUEUE_REL_PATH } from "../../plans/source.ts";
import { serializeQueue } from "../../plans/queue.ts";
import { __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";
import { sha256 } from "../../gardener/util.ts";

const CONFIG = { claudeUsageUrl: null } as unknown as Config;

const plan = (slug: string, status = "proposed") =>
  `---\ntitle: ${slug}\nplan_status: ${status}\n---\n\n# ${slug}\n\nBody.\n`;

const roots: string[] = [];

async function makeWiki(slugs = ["alpha-plan", "beta-plan"]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-plans-write-"));
  roots.push(root);
  await mkdir(path.join(root, "plans"), { recursive: true });
  for (const slug of slugs) {
    await writeFile(path.join(root, "plans", `${slug}.mdx`), plan(slug));
  }
  return root;
}

function app(root: string | null, over: Partial<PlanBoardDeps> = {}): Hono {
  __resetWikiWriteQueueForTest();
  const a = new Hono();
  registerPlansRoutes(a, CONFIG, {
    loadSource: () => (root === null
      ? Promise.resolve({ root: null, plans: [], queue: { order: {}, hash: "" }, warnings: [] })
      : loadPlanSource({ root })),
    ledger: {
      urlConfigured: false,
      baseUrl: "http://127.0.0.1:8799",
      fetchPlans: async () => {
        throw new Error("not used by the write routes");
      },
    },
    ...over,
  });
  return a;
}

async function post(a: Hono, url: string, body: unknown): Promise<Response> {
  return await a.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function hashOf(root: string, slug: string): Promise<string> {
  const source = await loadPlanSource({ root });
  return source.plans.find((p) => p.slug === slug)!.hash;
}

const pageText = (root: string, slug: string) =>
  Bun.file(path.join(root, "plans", `${slug}.mdx`)).text();

afterEach(() => __setWikiReadonlyForTest());
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("POST /api/plans/priority", () => {
  test("sets a priority, returns the NEW hash, writes no log.md", async () => {
    const root = await makeWiki();
    const a = app(root);
    const res = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p1",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ slug: "alpha-plan", priority: "p1", written: true });

    const after = await pageText(root, "alpha-plan");
    expect(after).toBe(`---\ntitle: alpha-plan\nplan_status: proposed\npriority: p1\n---\n\n# alpha-plan\n\nBody.\n`);
    expect(body.hash).toBe(sha256(after));
    // A priority flip is metadata: no curated log line, and the sibling plan is
    // byte-untouched.
    expect(await Bun.file(path.join(root, "log.md")).exists()).toBe(false);
    expect(await pageText(root, "beta-plan")).toBe(plan("beta-plan"));
  });

  test("two edits in a row, each on the previous response's hash", async () => {
    const root = await makeWiki();
    const a = app(root);
    const first = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p2",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    const firstHash = (await first.json()).hash;
    const second = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p0",
      baseHash: firstHash,
    });
    expect(second.status).toBe(200);
    expect(await pageText(root, "alpha-plan")).toContain("priority: p0");
    // …and the PRE-first hash is now stale.
    const stale = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p3",
      baseHash: sha256(plan("alpha-plan")),
    });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody.stale).toBe(true);
    // The refusal names THIS plan, not the fact-check wording `writeWikiPage`
    // was extracted from — it is the whole explanation a reader gets.
    expect(staleBody.error).toBe("plans/alpha-plan.mdx changed since the board was loaded");
  });

  test('"clear" removes the line; clearing twice is a 200 noop echoing the hash', async () => {
    const root = await makeWiki();
    const a = app(root);
    const set = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p1",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    const cleared = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "clear",
      baseHash: (await set.json()).hash,
    });
    expect(cleared.status).toBe(200);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));

    const clearedBody = await cleared.json();
    const again = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "clear",
      baseHash: clearedBody.hash,
    });
    const againBody = await again.json();
    expect(again.status).toBe(200);
    expect(againBody.written).toBe(false);
    // The noop's hash is still a usable base for the next edit.
    expect(againBody.hash).toBe(clearedBody.hash);
    const next = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p3",
      baseHash: againBody.hash,
    });
    expect(next.status).toBe(200);
  });

  test.each([
    ["an unknown value", { slug: "alpha-plan", priority: "p9", baseHash: "h" }],
    ["null", { slug: "alpha-plan", priority: null, baseHash: "h" }],
    ["an omitted field", { slug: "alpha-plan", baseHash: "h" }],
    ["an empty string", { slug: "alpha-plan", priority: "", baseHash: "h" }],
    ["a missing baseHash", { slug: "alpha-plan", priority: "p1" }],
    ["a missing slug", { priority: "p1", baseHash: "h" }],
  ])("400s on %s, writing nothing", async (_label, body) => {
    const root = await makeWiki();
    const res = await post(app(root), "/api/plans/priority", body);
    expect(res.status).toBe(400);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));
  });

  test("404s on an unknown slug and on an unregistered wiki", async () => {
    const root = await makeWiki();
    const unknown = await post(app(root), "/api/plans/priority", {
      slug: "no-such-plan",
      priority: "p1",
      baseHash: "h",
    });
    expect(unknown.status).toBe(404);
    const unregistered = await post(app(null), "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p1",
      baseHash: "h",
    });
    expect(unregistered.status).toBe(404);
  });

  test("403s on a readonly instance, leaving the tree untouched", async () => {
    const root = await makeWiki();
    const a = app(root);
    const baseHash = await hashOf(root, "alpha-plan");
    __setWikiReadonlyForTest(true);
    const res = await post(a, "/api/plans/priority", { slug: "alpha-plan", priority: "p1", baseHash });
    expect(res.status).toBe(403);
    expect((await res.json()).readonly).toBe(true);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));
  });
});

describe("POST /api/plans/order", () => {
  const queueText = (root: string) => Bun.file(path.join(root, QUEUE_REL_PATH)).text();

  test("bootstrap, reorder, then a stale base", async () => {
    const root = await makeWiki();
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan", "beta-plan"] },
      baseHash: "",
    });
    expect(created.status).toBe(200);
    const firstHash = (await created.json()).hash;
    expect(await queueText(root)).toBe("proposed:\n  - alpha-plan\n  - beta-plan\n");
    expect(firstHash).toBe(sha256(await queueText(root)));

    let hash = firstHash;
    for (const order of [
      { proposed: ["beta-plan", "alpha-plan"] },
      { proposed: ["beta-plan"], ready: ["alpha-plan"] },
      { ready: ["alpha-plan", "beta-plan"] },
    ]) {
      const res = await post(a, "/api/plans/order", { order, baseHash: hash });
      expect(res.status).toBe(200);
      hash = (await res.json()).hash;
      expect(hash).toBe(sha256(await queueText(root)));
    }
    expect(await queueText(root)).toBe("ready:\n  - alpha-plan\n  - beta-plan\n");

    const stale = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: firstHash,
    });
    expect(stale.status).toBe(409);
  });

  test('bootstrap with a wrong base 409s; a "" base against an existing file 409s', async () => {
    const root = await makeWiki();
    const a = app(root);
    const wrongBase = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: sha256("nothing like it"),
    });
    expect(wrongBase.status).toBe(409);
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);

    await post(a, "/api/plans/order", { order: { proposed: ["alpha-plan"] }, baseHash: "" });
    const emptyBase = await post(a, "/api/plans/order", {
      order: { proposed: ["beta-plan"] },
      baseHash: "",
    });
    expect(emptyBase.status).toBe(409);
    expect(await queueText(root)).toBe("proposed:\n  - alpha-plan\n");
  });

  test("an unreadable queue.yaml refuses instead of clobbering it", async () => {
    const root = await makeWiki();
    await mkdir(path.join(root, QUEUE_REL_PATH), { recursive: true });
    const res = await post(app(root), "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: "",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("could not be read");
  });

  test("an empty order deletes the file", async () => {
    const root = await makeWiki();
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: "",
    });
    const res = await post(a, "/api/plans/order", { order: {}, baseHash: (await created.json()).hash });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ hash: "", deleted: true });
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });

  test.each([
    ["an unknown column", { order: { done: ["alpha-plan"] }, baseHash: "" }],
    ["a non-array column", { order: { proposed: "alpha-plan" }, baseHash: "" }],
    ["a non-object order", { order: ["alpha-plan"], baseHash: "" }],
    ["a non-string baseHash", { order: { proposed: ["alpha-plan"] } }],
    ["an off-grammar slug", { order: { proposed: ["2026-plan"] }, baseHash: "" }],
    ["a slug ranked twice", { order: { proposed: ["alpha-plan"], ready: ["alpha-plan"] }, baseHash: "" }],
    ["a slug naming no plan", { order: { proposed: ["retired-plan"] }, baseHash: "" }],
  ])("400s on %s, writing nothing", async (_label, body) => {
    const root = await makeWiki();
    const res = await post(app(root), "/api/plans/order", body);
    expect(res.status).toBe(400);
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });

  test("an off-grammar slug that EXISTS on disk is still refused, not quoted", async () => {
    // `serializeQueue` throws rather than emitting `- "2026-plan"` — bytes
    // mimir's strict parser rejects wholesale, costing every column its order.
    const root = await makeWiki(["2026-plan"]);
    const res = await post(app(root), "/api/plans/order", {
      order: { proposed: ["2026-plan"] },
      baseHash: "",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a valid slug");
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });

  test("403s on a readonly instance, leaving the tree untouched", async () => {
    const root = await makeWiki();
    const a = app(root);
    __setWikiReadonlyForTest(true);
    const res = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: "",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).readonly).toBe(true);
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });

  test("404s on an unregistered wiki", async () => {
    const res = await post(app(null), "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: "",
    });
    expect(res.status).toBe(404);
  });

  test("the bytes it writes are the ones serializeQueue emits", async () => {
    const root = await makeWiki(["alpha-plan", "beta-plan", "gamma-plan"]);
    await post(app(root), "/api/plans/order", {
      order: { blocked: ["gamma-plan"], proposed: ["beta-plan", "alpha-plan"] },
      baseHash: "",
    });
    expect(await queueText(root)).toBe(
      serializeQueue({ proposed: ["beta-plan", "alpha-plan"], blocked: ["gamma-plan"] }),
    );
  });
});

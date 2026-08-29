/**
 * `POST /api/plans/priority` and `POST /api/plans/order`.
 *
 * These drive the REAL write path — `writeWikiPage` and `writePlanQueue`,
 * including the per-wiki queue and both CAS branches — against a mkdtemp wiki
 * root, so a mock cannot make a broken write look green. Only the wiki ROOT is
 * injected (through the already-injectable `loadSource`); nothing else is faked.
 */

import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
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

  test("a 200 never claims a priority the file does not carry", async () => {
    // A loose closing fence (`--- `) is frontmatter to the READER, so the board
    // renders this file as a card. A writer that draws the fence differently
    // either edits body bytes or declines — and a decline that answers 200 with
    // the REQUESTED priority tells the board a value is on disk that is not.
    const root = await makeWiki([]);
    await writeFile(
      path.join(root, "plans", "loose-plan.mdx"),
      `--- \ntitle: loose\nplan_status: ready\n---\n\n# loose\n`,
    );
    const a = app(root);
    const res = await post(a, "/api/plans/priority", {
      slug: "loose-plan",
      priority: "p1",
      baseHash: await hashOf(root, "loose-plan"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const onDisk = (await loadPlanSource({ root })).plans.find((p) => p.slug === "loose-plan")!;
    expect(body.priority).toBe(onDisk.priority ?? null);
    expect(body.hash).toBe(onDisk.hash);
  });

  test("503s (naming the reason) when the source read fails", async () => {
    const a = app(await makeWiki(), {
      loadSource: () => Promise.reject(new Error("mimir went missing")),
    });
    const res = await post(a, "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p1",
      baseHash: "h",
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("mimir went missing");
  });

  test("400s on a null JSON body instead of 500ing", async () => {
    const res = await post(app(await makeWiki()), "/api/plans/priority", null);
    expect(res.status).toBe(400);
  });

  test("413s on an oversized body, writing nothing", async () => {
    const root = await makeWiki();
    const res = await post(app(root), "/api/plans/priority", {
      slug: "alpha-plan",
      priority: "p1",
      baseHash: "x".repeat(300_000),
    });
    expect(res.status).toBe(413);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));
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

  test("a posted column REPLACES that column and preserves every absent one", async () => {
    const root = await makeWiki(["alpha-plan", "beta-plan", "gamma-plan"]);
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan"], blocked: ["beta-plan", "gamma-plan"] },
      baseHash: "",
    });
    const hash = (await created.json()).hash;

    const res = await post(a, "/api/plans/order", { order: { ready: ["alpha-plan"] }, baseHash: hash });
    expect(res.status).toBe(200);
    // `blocked` was not posted, so it is still on disk — and in the response.
    expect(await queueText(root)).toBe(
      serializeQueue({ ready: ["alpha-plan"], blocked: ["beta-plan", "gamma-plan"] }),
    );
    const body = await res.json();
    expect(body.order).toEqual({ ready: ["alpha-plan"], blocked: ["beta-plan", "gamma-plan"] });
    expect(body.hash).toBe(sha256(await queueText(root)));
  });

  test("an explicitly posted empty array un-ranks exactly that column", async () => {
    const root = await makeWiki(["alpha-plan", "beta-plan"]);
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan"], blocked: ["beta-plan"] },
      baseHash: "",
    });
    const res = await post(a, "/api/plans/order", {
      order: { ready: [] },
      baseHash: (await created.json()).hash,
    });
    expect(res.status).toBe(200);
    expect(await queueText(root)).toBe(serializeQueue({ blocked: ["beta-plan"] }));
  });

  test("a slug moved into a posted column is not left ranked in a preserved one", async () => {
    const root = await makeWiki(["alpha-plan", "beta-plan"]);
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan"], blocked: ["beta-plan"] },
      baseHash: "",
    });
    const res = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan", "beta-plan"] },
      baseHash: (await created.json()).hash,
    });
    expect(res.status).toBe(200);
    // `blocked` was preserved, but its only slug now ranks in `ready` — a file
    // ranking one slug twice round-trips through `parseQueueYaml` as a DIFFERENT
    // file, so the preserved copy loses.
    expect(await queueText(root)).toBe(serializeQueue({ ready: ["alpha-plan", "beta-plan"] }));
  });

  test("an order posting no columns at all is a 400, never a delete", async () => {
    const root = await makeWiki();
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan"] },
      baseHash: "",
    });
    const hash = (await created.json()).hash;
    // `{}` is the shape that used to reduce to "no columns ranked" and delete
    // every column's ordering. The second body is the prototype-pollution
    // shape: `JSON.parse` makes `__proto__` an OWN property, so it reaches the
    // loop and takes the UNKNOWN-COLUMN branch (a different 400 message, same
    // refusal) rather than being silently walked past.
    for (const order of [{}, JSON.parse(String.raw`{"__proto__": ["alpha-plan"]}`)]) {
      const res = await post(a, "/api/plans/order", { order, baseHash: hash });
      expect(res.status).toBe(400);
      expect(await queueText(root)).toBe("ready:\n  - alpha-plan\n");
    }
  });

  test("400s on a null JSON body, and 413s on an oversized one", async () => {
    const root = await makeWiki();
    expect((await post(app(root), "/api/plans/order", null)).status).toBe(400);
    const big = await post(app(root), "/api/plans/order", {
      baseHash: "x".repeat(300_000),
      order: { ready: ["alpha-plan"] },
    });
    expect(big.status).toBe(413);
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });

  test("503s (naming the reason) when the source read fails", async () => {
    const a = app(await makeWiki(), {
      loadSource: () => Promise.reject(new Error("mimir went missing")),
    });
    const res = await post(a, "/api/plans/order", {
      order: { ready: ["alpha-plan"] },
      baseHash: "",
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("mimir went missing");
  });

  test("un-ranking the last ranked column deletes the file", async () => {
    const root = await makeWiki();
    const a = app(root);
    const created = await post(a, "/api/plans/order", {
      order: { proposed: ["alpha-plan"] },
      baseHash: "",
    });
    const res = await post(a, "/api/plans/order", {
      order: { proposed: [] },
      baseHash: (await created.json()).hash,
    });
    expect(res.status).toBe(200);
    // One truthful shape: `written` is "bytes were written", `deleted` is "the
    // file is gone". A state change is `written || deleted`, never both true.
    expect(await res.json()).toMatchObject({ hash: "", deleted: true, written: false });
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

  test("an UNPARSEABLE queue.yaml is refused, and its bytes are untouched", async () => {
    // A hand-edited file with a YAML syntax error parses to `{order:{}}` — so a
    // merge that trusts that read treats every column as unranked and writes the
    // human's lines away. Proven live: an `- [ unclosed` line in one column
    // erased the OTHER column's ranking on a 200.
    const root = await makeWiki(["alpha-plan", "beta-plan"]);
    const broken = "ready:\n  - [ unclosed\nblocked:\n  - beta-plan\n";
    await writeFile(path.join(root, QUEUE_REL_PATH), broken);
    const res = await post(app(root), "/api/plans/order", {
      order: { ready: ["alpha-plan"] },
      baseHash: sha256(broken),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("unparseable");
    expect(await queueText(root)).toBe(broken);
  });

  test("a per-entry drop still merges — and the response NAMES what it dropped", async () => {
    // The read-time GC (off-grammar slug) stays mergeable, but a merge WRITE
    // makes the drop durable, so it rides out on `warnings` rather than
    // happening silently.
    const root = await makeWiki(["alpha-plan", "beta-plan"]);
    const current = "ready:\n  - alpha-plan\n  - 2026-plan\n";
    await writeFile(path.join(root, QUEUE_REL_PATH), current);
    const res = await post(app(root), "/api/plans/order", {
      order: { blocked: ["beta-plan"] },
      baseHash: sha256(current),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await queueText(root)).toBe(
      serializeQueue({ ready: ["alpha-plan"], blocked: ["beta-plan"] }),
    );
    expect(body.warnings).toEqual([
      'queue.yaml: "2026-plan" is not a valid slug — dropped',
    ]);
  });

  test("a retired slug in an OMITTED column is dropped exactly as the board reads it", async () => {
    // The board parses with the corpus slug set and omits the retired entry; a
    // merge parsing WITHOUT it preserved the entry into the file and into the
    // response's `order`, so the client would hold a rank for a card it never
    // renders.
    const root = await makeWiki(["alpha-plan", "beta-plan"]);
    const current = "ready:\n  - alpha-plan\n  - retired-plan\n";
    await writeFile(path.join(root, QUEUE_REL_PATH), current);
    const res = await post(app(root), "/api/plans/order", {
      order: { blocked: ["beta-plan"] },
      baseHash: sha256(current),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await queueText(root)).not.toContain("retired-plan");
    expect(body.order).toEqual({ ready: ["alpha-plan"], blocked: ["beta-plan"] });
    expect(body.warnings).toEqual([
      'queue.yaml: "retired-plan" names no plan on disk — dropped',
    ]);
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

describe("POST /api/plans/status", () => {
  test("archives a plan: writes plan_status + a stamped status_date, returns the NEW hash, no log.md", async () => {
    const root = await makeWiki();
    const a = app(root);
    const res = await post(a, "/api/plans/status", {
      slug: "alpha-plan",
      status: "abandoned",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ slug: "alpha-plan", status: "abandoned", written: true });
    expect(body.statusDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const after = await pageText(root, "alpha-plan");
    expect(after).toBe(
      `---\ntitle: alpha-plan\nplan_status: abandoned\nstatus_date: ${body.statusDate}\n---\n\n# alpha-plan\n\nBody.\n`,
    );
    expect(body.hash).toBe(sha256(after));
    expect(await Bun.file(path.join(root, "log.md")).exists()).toBe(false);
    expect(await pageText(root, "beta-plan")).toBe(plan("beta-plan"));
  });

  test("restore works off the archive's returned hash; re-archiving the same status is a noop echoing disk", async () => {
    const root = await makeWiki();
    const a = app(root);
    const archived = await post(a, "/api/plans/status", {
      slug: "alpha-plan",
      status: "superseded",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    const archivedBody = await archived.json();
    // Same status again: a 200 noop that does NOT restamp status_date.
    const again = await post(a, "/api/plans/status", {
      slug: "alpha-plan",
      status: "superseded",
      baseHash: archivedBody.hash,
    });
    const againBody = await again.json();
    expect(againBody.written).toBe(false);
    expect(againBody.hash).toBe(archivedBody.hash);
    expect(againBody.status).toBe("superseded");
    // The noop reports the date ON DISK — the archive's stamp, never "today
    // recomputed": the board adopts this value, and a fresh date on a noop
    // would show a transition that never happened.
    expect(againBody.statusDate).toBe(archivedBody.statusDate);
    expect(againBody.relPath).toBe("plans/alpha-plan.mdx");
    // Restore on the noop's hash.
    const restored = await post(a, "/api/plans/status", {
      slug: "alpha-plan",
      status: "proposed",
      baseHash: againBody.hash,
    });
    expect(restored.status).toBe(200);
    expect(await pageText(root, "alpha-plan")).toContain("plan_status: proposed");
    // …and the ORIGINAL hash is stale now.
    const stale = await post(a, "/api/plans/status", {
      slug: "alpha-plan",
      status: "abandoned",
      baseHash: sha256(plan("alpha-plan")),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).stale).toBe(true);
  });

  test("status_date is the operator's Oslo day, never the host clock's", async () => {
    // 22:30 UTC on the 29th is 00:30 CEST on the 30th — the docker/nais images
    // run UTC, so a host-local (or UTC-slice) stamp writes yesterday for every
    // late-evening archive. This is the one test that fails if `todayOslo` is
    // ever reverted to a bare date slice.
    const root = await makeWiki();
    const baseHash = await hashOf(root, "alpha-plan");
    setSystemTime(new Date("2026-08-29T22:30:00Z"));
    try {
      const res = await post(app(root), "/api/plans/status", {
        slug: "alpha-plan",
        status: "abandoned",
        baseHash,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.written).toBe(true);
      expect(body.statusDate).toBe("2026-08-30");
      expect(await pageText(root, "alpha-plan")).toContain("status_date: 2026-08-30");
    } finally {
      setSystemTime();
    }
  });

  test("a noop echoes the HISTORICAL date on disk, never today's", async () => {
    // The same-day noop above cannot distinguish "echoed disk" from "recomputed
    // today" — the two coincide. A plan archived on a PAST date can: the
    // mutation `statusDate: statusDate` (always today) survived the suite until
    // this test existed.
    const root = await makeWiki();
    const old = `---\ntitle: alpha-plan\nplan_status: superseded\nstatus_date: 2020-01-01\n---\n\n# alpha-plan\n\nBody.\n`;
    await writeFile(path.join(root, "plans", "alpha-plan.mdx"), old);
    const res = await post(app(root), "/api/plans/status", {
      slug: "alpha-plan",
      status: "superseded",
      baseHash: sha256(old),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(false);
    expect(body.statusDate).toBe("2020-01-01");
    expect(body.status).toBe("superseded");
    expect(await pageText(root, "alpha-plan")).toBe(old);
  });

  test.each([
    ["an unknown value", { slug: "alpha-plan", status: "deleted", baseHash: "h" }],
    ["an omitted status", { slug: "alpha-plan", baseHash: "h" }],
    ["a missing baseHash", { slug: "alpha-plan", status: "abandoned" }],
    ["a missing slug", { status: "abandoned", baseHash: "h" }],
  ])("400s on %s, writing nothing", async (_label, body) => {
    const root = await makeWiki();
    const res = await post(app(root), "/api/plans/status", body);
    expect(res.status).toBe(400);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));
  });

  test("404s on an unknown slug and on an unregistered wiki", async () => {
    const root = await makeWiki();
    expect(
      (await post(app(root), "/api/plans/status", { slug: "no-such-plan", status: "abandoned", baseHash: "h" }))
        .status,
    ).toBe(404);
    expect(
      (await post(app(null), "/api/plans/status", { slug: "alpha-plan", status: "abandoned", baseHash: "h" }))
        .status,
    ).toBe(404);
  });

  test("403 on a readonly instance, writing nothing", async () => {
    const root = await makeWiki();
    __setWikiReadonlyForTest(true);
    const res = await post(app(root), "/api/plans/status", {
      slug: "alpha-plan",
      status: "abandoned",
      baseHash: await hashOf(root, "alpha-plan"),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).readonly).toBe(true);
    expect(await pageText(root, "alpha-plan")).toBe(plan("alpha-plan"));
  });
});

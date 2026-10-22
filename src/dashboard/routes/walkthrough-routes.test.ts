/**
 * Acceptance for «Walk me through» (`POST /api/wiki/walkthrough`).
 *
 * What only this file can see: the route behind the SAME origin and zone
 * middlewares `src/index.ts` mounts (a cross-origin POST refused, role `user`
 * refused by default-deny), the read-only-wiki refusal, every pre-commit JSON
 * answer, and the committed stream's three outcomes — a `done` carrying only
 * quote-checked items, a parse failure and an all-dropped reply as `app_error`.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
 * `test:unit` chains): it `mock.module`s `db/traces.ts`, which a large share of
 * the suite imports — `share-routes.test.ts`'s reason.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { testTempDir } from "../../test/temp-dir.ts";
import { sha256 } from "../../gardener/util.ts";

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

const { registerWikiRoutes, __setWalkthroughOneShotForTest } = await import("./wiki-routes.ts");
const { __resetWalkthroughFlightsForTest, acquireWalkthroughFlight, walkthroughFlightKey, WALKTHROUGH_MAX_INFLIGHT_PER_PAGE } =
  await import("./walkthrough-sse.ts");
const { __resetWikiRegistryForTest, __setWikiRegistryForTest } = await import("../../wiki/registry-memo.ts");
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");
const { __setReadonlyWikiRootsForTest } = await import("../../wiki/readonly.ts");
const { createOriginMiddleware } = await import("../../auth/origin.ts");
const { createZoneMiddleware } = await import("../../auth/zone-middleware.ts");
const { resolveAuthConfig } = await import("../../auth/mode.ts");

const config = { tracingEnabled: false, tracingCaptureToolOutputs: false, claudeModel: "sonnet" } as never;

const PAGE = [
  "---",
  "title: Gardener",
  "type: concept",
  "---",
  "# Gardener",
  "",
  "## How it works",
  "",
  "The gardener clusters **summaries** into wiki-page proposals every week.",
  "",
  "Each proposal waits at the review gate until a human approves it.",
  "",
  "## How it works",
  "",
  "A second section with the same heading, about the linter instead.",
  "",
].join("\n");

type SseEvent = { event: string; data: Record<string, unknown> };
function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

function reply(obj: unknown) {
  return (async () => ({
    result: typeof obj === "string" ? obj : JSON.stringify(obj),
    inputTokens: 1,
    outputTokens: 1,
    numTurns: 1,
    durationMs: 1,
  })) as never;
}

const GOOD = {
  steps: [
    { title: "Clustering", text: "It groups summaries.", quote: "The gardener clusters summaries into wiki-page proposals every week." },
    { title: "Invented", text: "Not in the page.", quote: "The gardener deletes stale pages on Fridays." },
  ],
  quiz: [
    {
      question: "Who approves a proposal?",
      choices: ["The gardener", "A human"],
      answer: 1,
      quote: "Each proposal waits at the review gate until a human approves it.",
    },
  ],
};

let root: string;
let app: Hono;
const ok = { relPath: "Gardener.md", heading: "How it works", ordinal: 0, count: 2 };
const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.request("/api/wiki/walkthrough?wiki=wtwiki", { method: "POST", headers, body: JSON.stringify(body) });

beforeEach(async () => {
  root = await testTempDir(path.join(tmpdir(), "wiki-walkthrough-route-"));
  await Bun.write(path.join(root, "Gardener.md"), PAGE);
  await Bun.write(path.join(root, "Empty.md"), "---\ntitle: Empty\n---\n\n## Nothing here\n");
  await Bun.write(path.join(root, "Explainer.html"), "<html><body><h2>X</h2></body></html>");
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  __resetWalkthroughFlightsForTest();
  __setWikiRegistryForTest([{ name: "wtwiki", root, source: "extra", synthesisBot: "jarvis" }]);
  app = new Hono();
  registerWikiRoutes(app, config);
});

afterEach(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  __resetWalkthroughFlightsForTest();
  __setWalkthroughOneShotForTest();
  __setReadonlyWikiRootsForTest();
  await rm(root, { recursive: true, force: true });
});

describe("POST /api/wiki/walkthrough — guards", () => {
  const LOCAL = resolveAuthConfig({
    MUNINN_AUTH: "local",
    MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
    MUNINN_LOCAL_USER: "rune",
    MUNINN_ADMIN_IDENTS: "A123456",
    MUNINN_ALLOWED_ORIGINS: "http://localhost:3010",
  });

  /** The route behind the origin + zone middlewares, with the role pinned. */
  function guarded(role: "admin" | "user"): Hono {
    const outer = new Hono();
    outer.use("*", async (c, next) => {
      c.set("role" as never, role as never);
      c.set("identity" as never, { userId: "u", displayName: "u", navIdent: null, oid: null, provider: "local", expiresAt: null } as never);
      await next();
    });
    outer.use("*", createOriginMiddleware(LOCAL.allowedOrigins, 3010));
    outer.use("*", createZoneMiddleware(LOCAL));
    registerWikiRoutes(outer, config);
    return outer;
  }
  const req = (a: Hono, origin: string, body: unknown = { relPath: "Gardener.md", heading: "", ordinal: 0, count: 1 }) =>
    a.request("http://localhost:3010/api/wiki/walkthrough?wiki=wtwiki", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "localhost:3010" },
      body: JSON.stringify(body),
    });

  test("a cross-origin POST is refused by the origin guard before the handler runs", async () => {
    let ran = false;
    __setWalkthroughOneShotForTest((async () => { ran = true; return { result: "{}" }; }) as never);
    const res = await req(guarded("admin"), "https://evil.example", ok);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe("cross-origin request");
    expect(ran).toBe(false);
  });

  test("role user is refused by the zone (default-deny) on a same-origin POST", async () => {
    const res = await req(guarded("user"), "http://localhost:3010", ok);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("heading");
  });

  test("an admin on a same-origin POST reaches the handler", async () => {
    const res = await req(guarded("admin"), "http://localhost:3010");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("heading is required");
  });

  test("a non-JSON POST is a 415", async () => {
    const res = await post(ok, { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  test("a read-only wiki refuses before any model call", async () => {
    let ran = false;
    __setWalkthroughOneShotForTest((async () => { ran = true; return { result: "{}" }; }) as never);
    __setReadonlyWikiRootsForTest([root]);
    const res = await post(ok);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { readonly?: boolean }).readonly).toBe(true);
    expect(ran).toBe(false);
  });

  // Fix round 1 batch 4, finding 1: the refusal comes BEFORE the page is read,
  // the section located and a slot taken. Each body below would stop at one of
  // those later checks with its own status, so a refusal moved after it answers
  // that status instead of 403.
  test("a read-only wiki refuses before the page read, the section lookup and the slot", async () => {
    __setReadonlyWikiRootsForTest([root]);
    for (let i = 0; i < WALKTHROUGH_MAX_INFLIGHT_PER_PAGE; i++) {
      expect(acquireWalkthroughFlight(walkthroughFlightKey("wtwiki", "Gardener.md")).ok).toBe(true);
    }
    const cases = [
      ["page missing (404 once read)", { ...ok, relPath: "Missing.md" }],
      ["explainer (400 once read)", { ...ok, relPath: "Explainer.html", heading: "X", count: 1 }],
      ["stale hash (409 once read)", { ...ok, hash: "deadbeef" }],
      ["heading not on the page (404 once located)", { ...ok, heading: "Nope", count: 1 }],
      ["count mismatch (409 once located)", { ...ok, count: 1 }],
      ["empty section (422 once located)", { relPath: "Empty.md", heading: "Nothing here", ordinal: 0, count: 1 }],
      ["every slot taken (409 once a slot is asked for)", ok],
    ] as const;
    const got: string[] = [];
    for (const [label, body] of cases) {
      const res = await post(body);
      const json = (await res.json()) as { readonly?: boolean };
      got.push(`${label} → ${res.status}${json.readonly ? " readonly" : ""}`);
    }
    expect(got).toEqual(cases.map(([label]) => `${label} → 403 readonly`));
  });
});

describe("POST /api/wiki/walkthrough — pre-commit answers", () => {
  test("body shape: missing fields and bad ordinals are 400s", async () => {
    for (const body of [
      { heading: "How it works", ordinal: 0, count: 1 },
      { relPath: "Gardener.md", ordinal: 0, count: 1 },
      { ...ok, ordinal: 2 },
      { ...ok, ordinal: -1 },
      { ...ok, count: 0 },
      { ...ok, ordinal: "0" },
      { ...ok, heading: 5 },
      { ...ok, heading: "x".repeat(301) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
  });

  test("an unknown heading is a 404; an unknown page a 404; an explainer a 400", async () => {
    expect((await post({ ...ok, heading: "Nope", count: 1 })).status).toBe(404);
    expect((await post({ ...ok, relPath: "Missing.md" })).status).toBe(404);
    expect((await post({ ...ok, relPath: "Explainer.html", heading: "X", count: 1 })).status).toBe(400);
  });

  test("a count the page no longer has, or a stale hash, is a 409 stale", async () => {
    const res = await post({ ...ok, count: 1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { stale?: boolean }).stale).toBe(true);
    expect((await post({ ...ok, hash: "deadbeef" })).status).toBe(409);
  });

  // Fix round 1 batch 3, finding 1: under a matching hash a heading the server
  // cannot place is a client/server disagreement, and «the page changed» sent
  // the reader into a reload loop that sends the same identity again.
  test("under a matching hash, a count or heading the server cannot place is a non-stale 422", async () => {
    const hash = sha256(PAGE);
    for (const body of [{ ...ok, count: 1, hash }, { ...ok, heading: "Nope", count: 1, hash }]) {
      const res = await post(body);
      expect(res.status).toBe(422);
      const json = (await res.json()) as { stale?: boolean; code?: string; error?: string };
      expect(json.stale).toBeUndefined();
      expect(json.code).toBe("heading_mismatch");
      expect(json.error).toContain("reloading doesn't help");
    }
    // A stale hash stays the stale 409 even when the identity also disagrees.
    const res = await post({ ...ok, count: 1, hash: "deadbeef" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { stale?: boolean }).stale).toBe(true);
  });

  test("a section with no text is a 422", async () => {
    const res = await post({ relPath: "Empty.md", heading: "Nothing here", ordinal: 0, count: 1 });
    expect(res.status).toBe(422);
  });

  test("a page whose walkthrough slots are all taken answers 409 running", async () => {
    for (let i = 0; i < WALKTHROUGH_MAX_INFLIGHT_PER_PAGE; i++) {
      expect(acquireWalkthroughFlight(walkthroughFlightKey("wtwiki", "Gardener.md")).ok).toBe(true);
    }
    const res = await post(ok);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { state?: string }).state).toBe("running");
  });
});

describe("POST /api/wiki/walkthrough — the stream", () => {
  test("done carries only the quote-checked items; the prompt holds the plain-text section", async () => {
    let sawPrompt = "";
    let sawOpts: Record<string, unknown> = {};
    __setWalkthroughOneShotForTest((async (prompt: string, _c: unknown, _b: unknown, opts: Record<string, unknown>) => {
      sawPrompt = prompt;
      sawOpts = opts;
      return { result: JSON.stringify(GOOD), inputTokens: 1, outputTokens: 1, numTurns: 1, durationMs: 1 };
    }) as never);
    const res = await post(ok);
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const done = events.find((e) => e.event === "done")!.data as {
      heading: string;
      steps: { title: string }[];
      quiz: unknown[];
      dropped: { kind: string; reason: string }[];
    };
    expect(done.heading).toBe("How it works");
    expect(done.steps.map((s) => s.title)).toEqual(["Clustering"]);
    expect(done.quiz.length).toBe(1);
    expect(done.dropped).toEqual([{ kind: "step", reason: "quote_not_in_section" }]);
    expect(events.at(-1)!.event).toBe("end");
    // The section as plain text — the markdown is rendered away — and only the FIRST of the two.
    expect(sawPrompt).toContain("The gardener clusters summaries into wiki-page proposals every week.");
    expect(sawPrompt).not.toContain("**summaries**");
    expect(sawPrompt).not.toContain("about the linter");
    // No tools: the fenced runner's tool-less surface.
    expect(sawOpts.toolSurface).toBe("none");
    // The slot is released.
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < WALKTHROUGH_MAX_INFLIGHT_PER_PAGE; i++) {
      expect(acquireWalkthroughFlight(walkthroughFlightKey("wtwiki", "Gardener.md")).ok).toBe(true);
    }
  });

  test("the ordinal picks the second same-named section", async () => {
    let sawPrompt = "";
    __setWalkthroughOneShotForTest((async (prompt: string) => {
      sawPrompt = prompt;
      return { result: "nope", inputTokens: 1, outputTokens: 1, numTurns: 1, durationMs: 1 };
    }) as never);
    await (await post({ ...ok, ordinal: 1 })).text();
    expect(sawPrompt).toContain("about the linter");
    expect(sawPrompt).not.toContain("clusters summaries");
  });

  test("a reply that is not the JSON shape is an app_error and no done", async () => {
    __setWalkthroughOneShotForTest(reply("Sorry, here is prose instead."));
    const events = parseSse(await (await post(ok)).text());
    const err = events.find((e) => e.event === "app_error")!.data;
    expect(err.code).toBe("parse_failed");
    expect(events.some((e) => e.event === "done")).toBe(false);
  });

  test("every step dropped is an app_error with its own code, and no done", async () => {
    __setWalkthroughOneShotForTest(
      reply({ steps: [{ title: "x", text: "y", quote: "Nothing like this is in the section at all." }], quiz: GOOD.quiz }),
    );
    const events = parseSse(await (await post(ok)).text());
    expect(events.find((e) => e.event === "app_error")!.data.code).toBe("all_dropped");
    expect(events.some((e) => e.event === "done")).toBe(false);
  });

  test("a model failure is an app_error naming it", async () => {
    __setWalkthroughOneShotForTest((async () => { throw new Error("timed out after 120000ms"); }) as never);
    const events = parseSse(await (await post(ok)).text());
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain("timed out");
  });
});

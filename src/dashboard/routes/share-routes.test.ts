/**
 * Acceptance for the share endpoint (`POST /api/wiki/share`) and its SSE runner.
 *
 * What only this file can see:
 *
 *   1. **The pre-commit ordering.** This is the first POST+SSE route in the wiki
 *      family, and every body check has to land BEFORE `streamSSE` commits a 200 —
 *      otherwise a missing field, an over-cap prompt or an unknown preset id
 *      reaches the reader as an `app_error` inside a successful response, where
 *      nothing distinguishes it from a model failure. Each of those is pinned here
 *      as a JSON 400.
 *   2. **`page` is a NAME.** The route resolves it with `index.resolve(page)`, so a
 *      page in a subdirectory must resolve from its title alone — asserted through
 *      the single-flight key (which is built from the RESOLVED relPath), i.e.
 *      without spending a model call.
 *   3. **The 409's body is readable.** The client consumes this route with `fetch`
 *      + a ReadableStream precisely because an EventSource exposes neither status
 *      nor body, and the "try again in…" copy needs `expiresAtMs`.
 *   4. **The `done` payload is exactly the three tab strings** — `{markdown, slack,
 *      mailHtml}`. Telegram is out of v1; a fourth key would be a contract nothing
 *      renders.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains, like `factcheck-retry-sse.test.ts`) — and it MUST stay that way.
 * `mock.module` invalidates the target module for the whole process graph, and
 * `db/traces.ts` is transitively imported by a large share of the suite.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

const {
  streamShareSSE,
  acquireShareFlight,
  shareFlightKey,
  renderSharePayload,
  __resetShareFlightsForTest,
  SHARE_TIMEOUT_MS,
  SHARE_SLOT_SLACK_MS,
} = await import("./share-sse.ts");
const { registerWikiRoutes } = await import("./wiki-routes.ts");
const { SHARE_EXTRA_MAX, SHARE_PROMPT_OVERRIDE_MAX } = await import("../../share/wire.ts");
const { __resetWikiRegistryForTest, __setWikiRegistryForTest } = await import(
  "../../wiki/registry-memo.ts"
);
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");

const SLOT_MS = SHARE_TIMEOUT_MS + SHARE_SLOT_SLACK_MS;

type SseEvent = { event: string; data: Record<string, unknown> };

function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    try {
      out.push({ event: ev, data: JSON.parse(data) });
    } catch {
      out.push({ event: ev, data: {} });
    }
  }
  return out;
}

const config = { tracingEnabled: false, tracingCaptureToolOutputs: false, claudeModel: "sonnet" } as never;
const botConfig = { name: "testbot", dir: "/tmp/testbot", connector: "claude-sdk" } as never;

/** A fake `executeOneShot` that streams the post in two deltas, then returns it. */
function scriptedPost(post: string) {
  return async (
    _prompt: string,
    _config: unknown,
    _bot: unknown,
    opts?: { onProgress?: (e: never) => void },
  ) => {
    const half = Math.ceil(post.length / 2);
    opts?.onProgress?.({ type: "text_delta", text: post.slice(0, half) } as never);
    opts?.onProgress?.({ type: "text_delta", text: post.slice(half) } as never);
    return { result: post, inputTokens: 900, outputTokens: 120, numTurns: 1, durationMs: 5 };
  };
}

async function runShare(
  oneShot: unknown,
  over: Record<string, unknown> = {},
): Promise<SseEvent[]> {
  const app = new Hono();
  app.post("/share", (c) =>
    streamShareSSE(c, {
      config,
      botConfig,
      systemPrompt: "sys",
      userPrompt: "user",
      runName: "Share: A Concept",
      oneShot: oneShot as never,
      ...over,
    } as never),
  );
  const res = await app.request("/share", { method: "POST" });
  const events = parseSse(await res.text());
  await new Promise((r) => setTimeout(r, 20));
  return events;
}

const POST = ["# Gardener", "", "It clusters **summaries** into proposals.", "", "- one", "- two"].join(
  "\n",
);

describe("share SSE — the success path", () => {
  test("streams deltas, then ONE done, then the terminal end", async () => {
    const events = await runShare(scriptedPost(POST));
    const names = events.map((e) => e.event).filter((n) => n !== "heartbeat");
    expect(names.filter((n) => n === "delta").length).toBe(2);
    expect(names.filter((n) => n === "done").length).toBe(1);
    expect(names).not.toContain("app_error");
    expect(names.indexOf("done")).toBeGreaterThan(names.lastIndexOf("delta"));
    expect(names[names.length - 1]).toBe("end");
  });

  test("the done payload is EXACTLY {markdown, slack, mailHtml}", async () => {
    const events = await runShare(scriptedPost(POST));
    const done = events.find((e) => e.event === "done")!.data;
    // Telegram is deliberately out of v1 — a fourth key would be a contract
    // nothing renders.
    expect(Object.keys(done).sort()).toEqual(["mailHtml", "markdown", "slack"]);
    expect(done.markdown).toBe(POST);
    // Server-rendered, by the same renderers Slack/email delivery uses.
    expect(String(done.slack)).toContain("*summaries*");
    expect(String(done.mailHtml)).toContain("<strong");
  });

  test("a whole-post code fence — which every preset forbids — is undone", async () => {
    // Left in place it is one code block in all three renderings: a monospaced
    // blob with the markdown syntax showing.
    const events = await runShare(scriptedPost("```\n" + POST + "\n```"));
    expect(events.find((e) => e.event === "done")!.data.markdown).toBe(POST);
  });

  test("renderSharePayload is the one place the tab set is decided", () => {
    expect(Object.keys(renderSharePayload("hi")).sort()).toEqual([
      "mailHtml",
      "markdown",
      "slack",
    ]);
  });
});

describe("share SSE — failures never fake a post", () => {
  test("an empty result is an app_error with NO done", async () => {
    const events = await runShare(scriptedPost("   "));
    const names = events.map((e) => e.event);
    expect(names).not.toContain("done");
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "no post",
    );
    expect(names[names.length - 1]).toBe("end");
  });

  test("a connector throw is reported as an app_error, and the stream still ends", async () => {
    const events = await runShare(async () => {
      throw new Error("Claude Agent SDK timed out after 120000ms");
    });
    expect(events.map((e) => e.event)).not.toContain("done");
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "timed out",
    );
    expect(events[events.length - 1]!.event).toBe("end");
  });

  test("a preflight error runs no model call", async () => {
    let called = false;
    const events = await runShare(
      async () => {
        called = true;
        return {} as never;
      },
      { preflightError: 'No wiki page named "Nope".' },
    );
    expect(called).toBe(false);
    expect(events.find((e) => e.event === "app_error")!.data.message).toBe(
      'No wiki page named "Nope".',
    );
  });

  test("a bot-less wiki is refused by the scaffold, not by the connector", async () => {
    const events = await runShare(scriptedPost(POST), { botConfig: null });
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "No bots configured",
    );
  });

  test("the slot is released on EVERY terminal path", async () => {
    const key = shareFlightKey("w", "p.md");
    for (const oneShot of [
      scriptedPost(POST),
      scriptedPost(""),
      async () => {
        throw new Error("boom");
      },
    ]) {
      __resetShareFlightsForTest();
      const acquired = acquireShareFlight(key);
      if (!acquired.ok) throw new Error("unreachable");
      await runShare(oneShot, { onSettled: acquired.release });
      expect(acquireShareFlight(key).ok).toBe(true);
    }
  });
});

describe("per-page single-flight registry", () => {
  beforeEach(() => __resetShareFlightsForTest());

  test("a second share on the same page is refused with the holder's deadline", () => {
    const key = shareFlightKey("mimir", "plans/x.mdx");
    expect(acquireShareFlight(key, 1_000).ok).toBe(true);
    const second = acquireShareFlight(key, 2_000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.expiresAtMs).toBe(1_000 + SLOT_MS);
  });

  test("another page — and another wiki holding the same relPath — is unaffected", () => {
    acquireShareFlight(shareFlightKey("mimir", "plans/x.mdx"), 1_000);
    expect(acquireShareFlight(shareFlightKey("mimir", "plans/y.mdx"), 1_000).ok).toBe(true);
    expect(acquireShareFlight(shareFlightKey("jarvis", "plans/x.mdx"), 1_000).ok).toBe(true);
  });

  test("the slot outlives the run's own budget by the teardown slack", () => {
    const key = shareFlightKey("mimir", "plans/x.mdx");
    acquireShareFlight(key, 1_000);
    expect(acquireShareFlight(key, 1_000 + SHARE_TIMEOUT_MS).ok).toBe(false);
  });

  test("an EXPIRED holder counts as free — a wedged slot heals without a sweeper", () => {
    const key = shareFlightKey("mimir", "plans/x.mdx");
    acquireShareFlight(key, 1_000);
    expect(acquireShareFlight(key, 1_000 + SLOT_MS - 1).ok).toBe(false);
    expect(acquireShareFlight(key, 1_000 + SLOT_MS).ok).toBe(true);
  });

  test("release is identity-checked — a late release can't free a NEWER holder", () => {
    const key = shareFlightKey("mimir", "plans/x.mdx");
    const stale = acquireShareFlight(key, 1_000);
    if (!stale.ok) throw new Error("unreachable");
    expect(acquireShareFlight(key, 1_000 + SLOT_MS).ok).toBe(true);
    stale.release();
    expect(acquireShareFlight(key, 1_000 + SLOT_MS).ok).toBe(false);
  });
});

/**
 * The REAL route. Nothing here spends a model call: every 400 and the 409 return
 * before the stream is opened, and the two committed-200 cases fail preflight.
 * The standalone wiki is pinned to the checked-in `jarvis` so a synthesis bot
 * resolves deterministically (share needs no particular connector).
 */
describe("POST /api/wiki/share — pre-commit guards", () => {
  let root: string;
  let app: Hono;
  const PAGE = "A Concept";
  const NESTED = "Nested Concept";

  const post = (body: unknown) =>
    app.request("/api/wiki/share?wiki=sharewiki", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = { page: PAGE, preset: "email", lang: "en" };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-share-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\n---\n\nBody prose here.");
    await mkdir(path.join(root, "deep", "deeper"), { recursive: true });
    await Bun.write(
      path.join(root, "deep", "deeper", "Nested Concept.mdx"),
      "---\ntitle: Nested Concept\ntype: concept\n---\n\nNested prose.",
    );
    await Bun.write(path.join(root, "Empty.md"), "---\ntype: concept\n---\n");
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setWikiRegistryForTest([{ name: "sharewiki", root, source: "extra", synthesisBot: "jarvis" }]);
    __resetShareFlightsForTest();
    app = new Hono();
    registerWikiRoutes(app, config);
  });

  afterEach(async () => {
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetShareFlightsForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("a missing page or preset is a JSON 400, not an app_error on a 200", async () => {
    for (const body of [
      { preset: "email", lang: "en" },
      { page: PAGE, lang: "en" },
      { page: "   ", preset: "email", lang: "en" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("an unknown or missing lang is a 400 naming the accepted values", async () => {
    for (const lang of [undefined, "", "sv", 3]) {
      const res = await post({ page: PAGE, preset: "email", lang });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as { error: string }).error)).toContain("lang must be");
    }
  });

  test("BOTH text fields 400 over their cap — never a silent truncation", async () => {
    const overPrompt = await post({ ...ok, promptOverride: "x".repeat(SHARE_PROMPT_OVERRIDE_MAX + 1) });
    expect(overPrompt.status).toBe(400);
    expect(String(((await overPrompt.json()) as { error: string }).error)).toContain(
      String(SHARE_PROMPT_OVERRIDE_MAX),
    );
    const overExtra = await post({ ...ok, extra: "x".repeat(SHARE_EXTRA_MAX + 1) });
    expect(overExtra.status).toBe(400);
    expect(String(((await overExtra.json()) as { error: string }).error)).toContain(
      String(SHARE_EXTRA_MAX),
    );
    // Exactly at the cap is fine. Asserted against a HELD slot so the proof that
    // it passed validation is a 409 rather than a committed stream — this suite
    // must never reach a real model call.
    acquireShareFlight(shareFlightKey("sharewiki", "A Concept.md"));
    const atCap = await post({ ...ok, extra: "x".repeat(SHARE_EXTRA_MAX) });
    expect(atCap.status).toBe(409);
  });

  test("an UNKNOWN preset id is a 400 — never a quiet fall back to the default", async () => {
    const res = await post({ ...ok, preset: "no-such-preset" });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("no-such-preset");
    // …and it claimed no slot.
    expect(acquireShareFlight(shareFlightKey("sharewiki", "A Concept.md")).ok).toBe(true);
  });

  test("a second share while one is in flight 409s with a READABLE {state, expiresAtMs}", async () => {
    const held = acquireShareFlight(shareFlightKey("sharewiki", "A Concept.md"));
    expect(held.ok).toBe(true);
    const res = await post(ok);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state: string; expiresAtMs: number };
    expect(body.state).toBe("running");
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
  });

  test("`page` is a NAME: a nested page resolves through index.resolve", async () => {
    // Proven without a model call: holding the slot for the RESOLVED relPath makes
    // the request 409. A route that treated `page` as a relPath (or failed to
    // resolve the title) would take a different key — or fail preflight and
    // commit a 200 app_error instead.
    const held = acquireShareFlight(
      shareFlightKey("sharewiki", "deep/deeper/Nested Concept.mdx"),
    );
    expect(held.ok).toBe(true);
    const res = await post({ page: NESTED, preset: "email", lang: "en" });
    expect(res.status).toBe(409);
  });

  test("an unknown wiki / unknown page is an app_error on a committed 200 with a terminal end", async () => {
    const unknownWiki = await app.request("/api/wiki/share?wiki=nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ok),
    });
    expect(unknownWiki.status).toBe(200);
    const events = parseSse(await unknownWiki.text());
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "No wiki configured",
    );
    expect(events[events.length - 1]!.event).toBe("end");

    const unknownPage = await post({ ...ok, page: "Nowhere" });
    expect(unknownPage.status).toBe(200);
    const pageEvents = parseSse(await unknownPage.text());
    expect(String(pageEvents.find((e) => e.event === "app_error")!.data.message)).toContain(
      "No wiki page named",
    );
    // A failed preflight claims NO slot — an unknown page can't wedge the wiki.
    expect(acquireShareFlight(shareFlightKey("sharewiki", "Nowhere")).ok).toBe(true);
  });

  test("a page with no prose is refused before the slot is taken", async () => {
    const res = await post({ page: "Empty", preset: "email", lang: "en" });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "no text to summarize",
    );
    expect(acquireShareFlight(shareFlightKey("sharewiki", "Empty.md")).ok).toBe(true);
  });
});

describe("GET /api/wiki/share/presets", () => {
  let root: string;
  let app: Hono;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-share-presets-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\n---\n\nBody.");
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setWikiRegistryForTest([{ name: "sharewiki", root, source: "extra", synthesisBot: "jarvis" }]);
    app = new Hono();
    registerWikiRoutes(app, config);
  });

  afterEach(async () => {
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("serves the merged preset list with its content, plus the language list", async () => {
    const res = await app.request("/api/wiki/share/presets?wiki=sharewiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bot: string | null;
      presets: { id: string; label: string; content: string }[];
      langs: { id: string }[];
    };
    expect(body.presets.map((p) => p.id)).toContain("slack-dev-security");
    // The dialog SHOWS the prompt and lets the reader edit it — the body has to
    // ride along or every picker change is a round-trip.
    expect(body.presets.every((p) => p.content.length > 0)).toBe(true);
    expect(body.langs.map((l) => l.id)).toEqual(["en", "nb"]);
  });

  test("an unknown wiki is a 404", async () => {
    expect((await app.request("/api/wiki/share/presets?wiki=nope")).status).toBe(404);
  });
});

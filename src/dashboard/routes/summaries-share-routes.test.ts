/**
 * Acceptance for the /summaries share adapter (`POST /api/summaries/share` and
 * its preset list).
 *
 * What only this file can see — the four things the adapter ADDS on top of the
 * share layer the wiki route already pins (`share-routes.test.ts`):
 *
 *   1. **`source` → collection through the registry FIELD.** The two names
 *      diverge (`x-article` → `x-articles`), so a route that derived the
 *      collection from the id would query a collection that does not exist —
 *      invisible from the client, which never sends a collection at all.
 *   2. **Unknown `source` is a pre-commit 400**, and it outranks a bad preset:
 *      the source is what the reader actually got wrong.
 *   3. **The canonical strip runs SERVER-side.** The two client copies disagree
 *      with each other (`openSummaryDoc` strips breadcrumb + `tags:`,
 *      `openDocPanel` only the breadcrumb), so the post must not depend on which
 *      viewer opened the document. Asserted on the prompt the model is handed.
 *   4. **The single flight is per DOCUMENT**, namespaced away from the wiki
 *      surface's slots (one process-wide registry backs both).
 *
 * No model call and no huginn: both side-effecting seams are injected.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains, like `share-routes.test.ts`) — and it MUST stay that way. `mock.module`
 * invalidates the target module for the whole process graph, and `db/traces.ts`
 * is transitively imported by a large share of the suite.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

const { registerSummariesShareRoutes, summaryShareFlightKey, summaryDocTitle } = await import(
  "./summaries-share.ts"
);
type SummaryShareDoc = import("./summaries-share.ts").SummaryShareDoc;
const { acquireShareFlight, __resetShareFlightsForTest } = await import("./share-sse.ts");
const { SHARE_EXTRA_MAX, SHARE_PROMPT_OVERRIDE_MAX } = await import("../../share/wire.ts");
const { SUMMARY_SOURCES } = await import("../../summaries/sources.ts");

const config = {
  tracingEnabled: false,
  tracingCaptureToolOutputs: false,
  claudeModel: "sonnet",
  knowledgeApiUrl: "http://127.0.0.1:1",
} as never;

type SseEvent = { event: string; data: Record<string, unknown> };

function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    try {
      out.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      out.push({ event: ev, data: {} });
    }
  }
  return out;
}

const DOC_ID = "ai/claude-code/Some Title.md";
/** A real capture doc's shape: the bracketed breadcrumb owns line 1, and huginn's
 *  tagger injects the tags as YAML frontmatter. Both must be gone from the
 *  prompt; the body's own "tags:" mention must NOT be. */
const DOC_TEXT = [
  "[youtube > ai/claude-code > Some Title]",
  "---",
  "tags: [agents, cli]",
  "title: Some Title",
  "---",
  "",
  "Real body prose, which mentions tags: in a sentence.",
  "",
].join("\n");

const POST_MD = "## Some Title\n\nIt does **things**.";

/** What the injected seams saw on the last request. */
interface Seen {
  fetched: { collection: string; docId: string }[];
  prompt: string;
  systemPrompt: string;
  ran: number;
}

function makeApp(
  over: { doc?: SummaryShareDoc | null; throwOnFetch?: boolean } = {},
): { app: Hono; seen: Seen } {
  const seen: Seen = { fetched: [], prompt: "", systemPrompt: "", ran: 0 };
  const app = new Hono();
  registerSummariesShareRoutes(app, config, {
    fetchDoc: async (collection, docId) => {
      seen.fetched.push({ collection, docId });
      if (over.throwOnFetch) throw new Error("Knowledge API unreachable");
      if (over.doc !== undefined) return over.doc;
      return { text: DOC_TEXT };
    },
    oneShot: (async (
      prompt: string,
      _config: unknown,
      _bot: unknown,
      opts?: { systemPrompt?: string; onProgress?: (e: never) => void },
    ) => {
      seen.ran++;
      seen.prompt = prompt;
      seen.systemPrompt = opts?.systemPrompt ?? "";
      opts?.onProgress?.({ type: "text_delta", text: POST_MD } as never);
      return { result: POST_MD, inputTokens: 10, outputTokens: 5, numTurns: 1, durationMs: 1 };
    }) as never,
  });
  return { app, seen };
}

const ok = { source: "youtube", docId: DOC_ID, preset: "email", lang: "en" };

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/api/summaries/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => __resetShareFlightsForTest());

describe("POST /api/summaries/share — pre-commit guards", () => {
  test("missing source / docId / preset is a JSON 400, not an app_error on a 200", async () => {
    const { app } = makeApp();
    for (const body of [
      { docId: DOC_ID, preset: "email", lang: "en" },
      { source: "youtube", preset: "email", lang: "en" },
      { source: "youtube", docId: DOC_ID, lang: "en" },
      { ...ok, docId: "  " },
    ]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("an unknown SOURCE is a pre-commit 400 — it is client-validatable", async () => {
    const { app, seen } = makeApp();
    const res = await post(app, { ...ok, source: "myspace" });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("myspace");
    // …and nothing was fetched or generated on the way to saying so.
    expect(seen.fetched).toHaveLength(0);
    expect(seen.ran).toBe(0);
  });

  test("an unknown source OUTRANKS an unknown preset", async () => {
    const { app } = makeApp();
    const res = await post(app, { ...ok, source: "myspace", preset: "no-such-preset" });
    expect(res.status).toBe(400);
    const msg = String(((await res.json()) as { error: string }).error);
    expect(msg).toContain("myspace");
    expect(msg).not.toContain("preset");
  });

  test("an unknown PRESET id is a 400 — never a quiet fall back to the default", async () => {
    const { app, seen } = makeApp();
    const res = await post(app, { ...ok, preset: "no-such-preset" });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("no-such-preset");
    expect(seen.ran).toBe(0);
  });

  test("an unknown or missing lang is a 400 naming the accepted values", async () => {
    const { app } = makeApp();
    for (const lang of [undefined, "", "sv", 3]) {
      const res = await post(app, { ...ok, lang });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as { error: string }).error)).toContain("lang must be");
    }
  });

  test("BOTH text fields 400 over their cap — never a silent truncation", async () => {
    const { app } = makeApp();
    const overPrompt = await post(app, {
      ...ok,
      promptOverride: "x".repeat(SHARE_PROMPT_OVERRIDE_MAX + 1),
    });
    expect(overPrompt.status).toBe(400);
    expect(String(((await overPrompt.json()) as { error: string }).error)).toContain(
      String(SHARE_PROMPT_OVERRIDE_MAX),
    );
    const overExtra = await post(app, { ...ok, extra: "x".repeat(SHARE_EXTRA_MAX + 1) });
    expect(overExtra.status).toBe(400);
    expect(String(((await overExtra.json()) as { error: string }).error)).toContain(
      String(SHARE_EXTRA_MAX),
    );
    // Exactly at the cap passes validation — proven against a HELD slot, so the
    // proof is a 409 rather than a committed stream.
    acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID));
    expect((await post(app, { ...ok, extra: "x".repeat(SHARE_EXTRA_MAX) })).status).toBe(409);
  });

  test("a PRESENT but blank promptOverride is a 400 — it must not run the preset", async () => {
    const { app } = makeApp();
    for (const blank of ["", "   ", "\n\t"]) {
      const res = await post(app, { ...ok, promptOverride: blank });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as { error: string }).error)).toContain("empty");
    }
  });

  test("a non-string field is a 400, not a 500 out of a later `.trim()`", async () => {
    const { app } = makeApp();
    for (const over of [
      { source: 3 },
      { docId: [] },
      { preset: {} },
      { promptOverride: 1 },
      { extra: false },
    ]) {
      const res = await post(app, { ...ok, ...over });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as { error: string }).error)).toContain("must be a string");
    }
  });
});

describe("source → collection mapping", () => {
  test("every registered source maps through the registry's `collection` FIELD", async () => {
    // The id and the collection DIVERGE (`x-article` → `x-articles`), so this
    // walks the whole registry rather than spot-checking one.
    for (const source of SUMMARY_SOURCES) {
      const { app, seen } = makeApp();
      const res = await post(app, { ...ok, source: source.id });
      expect(res.status).toBe(200);
      await res.text();
      expect(seen.fetched).toEqual([{ collection: source.collection, docId: DOC_ID }]);
    }
  });

  test("x-article specifically fetches `x-articles`, not `x-article`", async () => {
    const { app, seen } = makeApp();
    await (await post(app, { ...ok, source: "x-article" })).text();
    expect(seen.fetched[0]?.collection).toBe("x-articles");
  });
});

describe("the canonical strip is the SERVER's", () => {
  test("breadcrumb and frontmatter tags are gone from the prompt; body prose is not", async () => {
    const { app, seen } = makeApp();
    await (await post(app, { ...ok, extra: "lead with the risk" })).text();
    expect(seen.ran).toBe(1);
    expect(seen.prompt).toContain("Real body prose");
    expect(seen.prompt).not.toContain("[youtube > ");
    expect(seen.prompt).not.toContain("tags: [agents, cli]");
    // The body's own mention of the word survives — the `tags:` strip is
    // head-anchored, not a document-wide line delete.
    expect(seen.prompt).toContain("mentions tags: in a sentence");
    // …and the rest of the assembled prompt is the share layer's: preset
    // instruction → language rider → the reader's steer → the fenced source.
    expect(seen.prompt).toContain("LANGUAGE: write the post in English");
    expect(seen.prompt).toContain("lead with the risk");
    expect(seen.prompt.indexOf("LANGUAGE:")).toBeLessThan(seen.prompt.indexOf("SOURCE:"));
    // No wiki in the framing — this document came from a capture archive.
    expect(seen.systemPrompt).not.toContain("wiki");
  });

  test("a bare head `tags:` line (no frontmatter) is stripped too", async () => {
    const { app, seen } = makeApp({
      doc: { text: "[youtube > ai > T]\ntags: one, two\n\nBare-tags body.\n" },
    });
    await (await post(app, ok)).text();
    expect(seen.prompt).toContain("Bare-tags body.");
    expect(seen.prompt).not.toContain("tags: one, two");
  });

  test("an EDITED prompt replaces the preset instruction verbatim", async () => {
    const { app, seen } = makeApp();
    await (
      await post(app, { ...ok, promptOverride: "Write exactly two bullets.", lang: "nb" })
    ).text();
    expect(seen.prompt.startsWith("Write exactly two bullets.")).toBe(true);
    expect(seen.prompt).toContain("Norwegian (bokmål)");
  });
});

describe("the stream", () => {
  test("the happy path streams a delta, ONE done with the three tab strings, then end", async () => {
    const { app } = makeApp();
    const res = await post(app, ok);
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const names = events.map((e) => e.event).filter((n) => n !== "heartbeat");
    expect(names).toContain("delta");
    expect(names.filter((n) => n === "done")).toHaveLength(1);
    expect(names[names.length - 1]).toBe("end");
    const done = events.find((e) => e.event === "done")!.data;
    expect(Object.keys(done).sort()).toEqual(["mailHtml", "markdown", "slack"]);
    expect(done.markdown).toBe(POST_MD);
    // …and the document is free again.
    await new Promise((r) => setTimeout(r, 20));
    expect(acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID)).ok).toBe(true);
  });

  test("a document huginn cannot serve is an app_error on a committed 200, with a terminal end", async () => {
    // Not client-validatable (only huginn knows), so it cannot be a 400.
    for (const over of [{ doc: null }, { throwOnFetch: true }]) {
      const { app, seen } = makeApp(over);
      const res = await post(app, ok);
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
        "Could not read",
      );
      expect(events.map((e) => e.event)).not.toContain("done");
      expect(events[events.length - 1]!.event).toBe("end");
      expect(seen.ran).toBe(0);
      // …and it claimed no slot: an unreachable huginn can't wedge the document.
      expect(acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID)).ok).toBe(true);
      __resetShareFlightsForTest();
    }
  });

  test("a document with no prose is refused before the slot is taken", async () => {
    const { app, seen } = makeApp({ doc: { text: "[youtube > ai > T]\n---\ntags: x\n---\n" } });
    const res = await post(app, ok);
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "no text to summarize",
    );
    expect(seen.ran).toBe(0);
    expect(acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID)).ok).toBe(true);
  });
});

describe("per-document single-flight", () => {
  test("a second share of the same document 409s with a READABLE {state, expiresAtMs}", async () => {
    const { app } = makeApp();
    const held = acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID));
    expect(held.ok).toBe(true);
    const res = await post(app, ok);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state: string; expiresAtMs: number; error?: string };
    expect(body.state).toBe("running");
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
    // The sentence rides ALONGSIDE the machine-readable pair, for a caller that
    // is not the dialog. It names the DOCUMENT — the wiki surface's twin says
    // "page", and the two must not be able to drift into each other's copy.
    expect(body.error).toBe("A share is already running for this document.");
  });

  test("another document — and the same id in another collection — is unaffected", async () => {
    const { app } = makeApp();
    acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID));
    expect((await post(app, { ...ok, docId: "ai/other.md" })).status).toBe(200);
    expect((await post(app, { ...ok, source: "x-article" })).status).toBe(200);
  });

  test("a pre-commit 400 leaves the document FREE — the slot is claimed after them", async () => {
    // The slot is now taken BEFORE the huginn fetch (so a double-click costs one
    // round-trip, not two), which puts it one line away from the validation
    // 400s. Taken one line too early, a typo'd preset would reserve the document
    // for the full expiry and the reader's corrected retry would 409 at them.
    const { app, seen } = makeApp();
    expect((await post(app, { ...ok, preset: "no-such-preset" })).status).toBe(400);
    // Proven by the ROUTE, not by peeking at the registry: the next POST runs.
    const res = await post(app, ok);
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.ran).toBe(1);
  });

  test("a fetchDoc throw releases the slot — an unreachable huginn can't wedge the document", async () => {
    // Same window, other end: the slot is held across the fetch, so a throw in
    // it (or in the prep) must free the document rather than leave it reserved
    // by a request that produced nothing.
    const { app } = makeApp({ throwOnFetch: true });
    await (await post(app, ok)).text();
    const { app: healthy, seen } = makeApp();
    const res = await post(healthy, ok);
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.ran).toBe(1);
  });

  test("a throw AFTER the fetch releases the slot — the rethrowing catch, not the early release", async () => {
    // The `throwOnFetch` case above never reaches `catch { release?.(); throw }`:
    // the route's own fetch catch absorbs it (`doc = null`) and the slot is freed
    // by the `!userPrompt` early release. So this drives the other half of the
    // window — the prep — with a document whose body read throws, and proves both
    // halves: the slot IS held at the moment of the throw (probed from inside the
    // getter; a failed acquire claims nothing, so the probe is non-mutating), and
    // it is free again afterwards.
    let heldAtThrow = false;
    const { app } = makeApp({
      doc: {
        title: "Some Title",
        get text(): string {
          heldAtThrow = !acquireShareFlight(summaryShareFlightKey("youtube-summaries", DOC_ID)).ok;
          throw new Error("prep exploded");
        },
      },
    });
    const res = await post(app, ok);
    // The outer wrapper turns it into JSON — never an unhandled rejection.
    expect(res.status).toBe(500);
    expect(heldAtThrow).toBe(true);
    // …and the document is free: the next POST runs instead of 409ing.
    const { app: healthy, seen } = makeApp();
    const next = await post(healthy, ok);
    expect(next.status).toBe(200);
    await next.text();
    expect(seen.ran).toBe(1);
  });

  test("the key is namespaced away from the wiki surface's slots", () => {
    // One process-wide registry backs both surfaces. Without the namespace a
    // wiki whose registered name equalled a collection name would share slots
    // with that collection's documents — a 409 nothing could explain.
    const key = summaryShareFlightKey("youtube-summaries", DOC_ID);
    expect(key.startsWith("summaries:")).toBe(true);
  });
});

describe("summaryDocTitle", () => {
  test("prefers huginn's title, else the id's basename without the extension", () => {
    expect(summaryDocTitle(DOC_ID, { title: "Real Title" })).toBe("Real Title");
    expect(summaryDocTitle(DOC_ID, { title: "  " })).toBe("Some Title");
    expect(summaryDocTitle(DOC_ID, null)).toBe("Some Title");
    expect(summaryDocTitle("bare", null)).toBe("bare");
  });
});

describe("GET /api/summaries/share/presets", () => {
  test("serves the merged preset list with its content, plus the language list", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/summaries/share/presets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bot: string | null;
      presets: { id: string; content: string }[];
      langs: { id: string }[];
    };
    expect(body.presets.map((p) => p.id)).toContain("slack-dev-security");
    // The dialog SHOWS the prompt and lets the reader edit it — the body has to
    // ride along or every picker change is a round-trip.
    expect(body.presets.every((p) => p.content.length > 0)).toBe(true);
    expect(body.langs.map((l) => l.id)).toEqual(["en", "nb"]);
  });

  test("it is `no-store` — a heuristically cached list 400s the POST unclearably", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/summaries/share/presets");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

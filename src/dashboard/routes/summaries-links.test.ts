/**
 * `/api/summaries/links{,/options,/candidates,/search}` — every seam injected:
 * the raw read and the ingest are one in-memory "huginn" writing files the way
 * `write_summary` does (frontmatter re-quoted, a blank line, the summary
 * string), the candidates call and the web agent are canned answers, and the
 * page fetch is a map of invented pages.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSummariesLinksRoutes, type SummariesLinksDeps } from "./summaries-links.ts";
import { SummarySaveClaims } from "../../summaries/summary-save.ts";
import { checkedSha256OfRaw } from "../../summaries/factcheck-body.ts";
import { linksBaseHash } from "../../summaries/find-links.ts";
import type { SafePage } from "../../summaries/safe-fetch.ts";

const config = { knowledgeApiUrl: "http://huginn.invalid" } as never;
const webBot = { name: "summarizer", dir: "/tmp/summarizer", connector: "claude-sdk" } as never;
const noWebBot = { name: "summarizer", dir: "/tmp/summarizer", connector: "openai-compat" } as never;

const DOC = "ai/claude/Effort talk.md";
const URL_ = "https://www.youtube.com/watch?v=invented01";
const LINKS = [
  "## Links",
  "",
  "- 📄 [Spending your effort](https://claude.example/blog/spending-your-effort) — Anthropic · from description",
  "",
  "_7 creator and social links in the description are not listed._",
].join("\n");
const SUMMARY = "Lydia Hallie's article on Claude Code effort levels is the reference.\n\n> 💬 **Takeaway:** Pick the level per task.";
// Legacy UNQUOTED date, the 682-document shape.
const RAW = `---\ndate: 2026-03-22\nurl: "${URL_}"\n---\n\n${SUMMARY}\n\n${LINKS}\n\n## Transcript\n\n### [00:00:00]\n\nWords.\n`;

const HALLIE_URL = "https://claude.example/resources/articles/effort";
const PAGES: Record<string, SafePage> = {
  [HALLIE_URL]: {
    finalUrl: HALLIE_URL,
    contentType: "text/html",
    text: '<title>Claude Code effort level and model selection</title><meta property="og:site_name" content="Anthropic"><p>By Lydia Hallie.</p>',
  },
};

let files: Map<string, string>;
let ingests: Record<string, unknown>[];
let claims: SummarySaveClaims;
let candidatesAnswer: string;
let agentAnswers: Record<string, string>;
let bot: unknown;

function app(over: Partial<SummariesLinksDeps> = {}): Hono {
  const deps: SummariesLinksDeps = {
    readRaw: async (_c, docId) => files.get(docId) ?? null,
    bots: () => [bot as never],
    candidatesCall: async () => candidatesAnswer,
    agent: async (c) => agentAnswers[c.topic] ?? "{}",
    fetchPage: async (url) => PAGES[url] ?? null,
    claims,
    ingest: async ({ body }) => {
      ingests.push(body);
      const path = `${body.category}/${body.title}.md`;
      files.set(path, `---\ndate: ${JSON.stringify(body.date)}\nurl: ${JSON.stringify(body.url)}\n---\n\n${body.summary}`);
      return { ok: true, status: 200, data: { file_path: path, similar: [] } };
    },
    ...over,
  };
  const a = new Hono();
  registerSummariesLinksRoutes(a, config, deps);
  return a;
}

const post = (a: Hono, path: string, body: unknown, contentType = "application/json") =>
  a.request(path, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });
const ref = { source: "youtube", docId: DOC };

beforeEach(() => {
  files = new Map([[DOC, RAW]]);
  ingests = [];
  claims = new SummarySaveClaims();
  bot = webBot;
  candidatesAnswer = JSON.stringify([
    { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" },
    { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" },
    { title: null, author: null, topic: "an internal benchmark nobody published", kind: "doc" },
  ]);
  agentAnswers = {
    "Lydia Hallie's article on Claude Code effort levels": JSON.stringify({ results: [{ url: HALLIE_URL, title: "x", quote: "" }] }),
    "an internal benchmark nobody published": JSON.stringify({ results: [{ url: "https://invented.example/nothing", title: "x", quote: "q" }] }),
  };
});

describe("GET /api/summaries/links/options", () => {
  test("a savable document is available, with its hash", async () => {
    const res = await app().request(`/api/summaries/links/options?source=youtube&docId=${encodeURIComponent(DOC)}`);
    expect(await res.json()).toEqual({ available: true, linksBaseHash: linksBaseHash(RAW) });
  });
  test("a document with no url is not (no_url): no button", async () => {
    files.set(DOC, "---\ndate: 2026-03-22\n---\n\nPasted text.\n");
    const res = await app().request(`/api/summaries/links/options?source=article&docId=${encodeURIComponent(DOC)}`);
    expect(await res.json()).toMatchObject({ available: false, code: "no_url" });
  });
});

describe("POST /api/summaries/links/candidates", () => {
  test("415 without application/json", async () => {
    expect((await post(app(), "/api/summaries/links/candidates", ref, "text/plain")).status).toBe(415);
  });
  test("drops a candidate the section already lists, returns the rest and the hash", async () => {
    const res = await post(app(), "/api/summaries/links/candidates", ref);
    const body = (await res.json()) as { candidates: { topic: string }[]; listed: number; linksBaseHash: string };
    expect(body.candidates.map((c) => c.topic)).toEqual([
      "Lydia Hallie's article on Claude Code effort levels",
      "an internal benchmark nobody published",
    ]);
    expect(body.listed).toBe(1);
    expect(body.linksBaseHash).toBe(linksBaseHash(RAW));
  });
  test("an answer with no list is a 502, not an empty panel", async () => {
    candidatesAnswer = "I could not find anything.";
    expect((await post(app(), "/api/summaries/links/candidates", ref)).status).toBe(502);
  });
});

/** The SSE body as `event` → parsed `data` pairs. */
async function events(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => ({
      event: /^event: (.*)$/m.exec(frame)?.[1] ?? "",
      data: /^data: (.*)$/m.exec(frame)?.[1] ?? "",
    }))
    .filter((f) => f.event && f.data)
    .map((f) => ({ event: f.event, data: JSON.parse(f.data) as Record<string, unknown> }));
}

describe("POST /api/summaries/links/search", () => {
  const two = [
    { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" },
    { title: null, author: null, topic: "an internal benchmark nobody published", kind: "doc" },
  ];
  test("one matched, one not found; states before results; done last", async () => {
    const res = await post(app(), "/api/summaries/links/search", { ...ref, candidates: two });
    const evs = await events(res);
    expect(evs[0]!.event).toBe("start");
    expect(evs.at(-1)!.event).toBe("done");
    const results = evs.filter((e) => e.event === "result").map((e) => e.data);
    expect(results.find((r) => r.index === 0)).toMatchObject({
      outcome: "found",
      results: [{ url: HALLIE_URL, label: "matched", title: "Claude Code effort level and model selection", detail: "Anthropic, Lydia Hallie" }],
    });
    expect(results.find((r) => r.index === 1)).toMatchObject({ outcome: "not_found", results: [] });
    expect(evs.filter((e) => e.event === "state").map((e) => e.data.state)).toContain("checking");
  });
  test("a bot without web tools is a JSON 503 before the stream", async () => {
    bot = noWebBot;
    const res = await post(app(), "/api/summaries/links/search", { ...ref, candidates: two });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "no_web_tools" });
  });
  test("bounds: an empty list, too many, a topic-less item", async () => {
    const a = app();
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [] })).status).toBe(400);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: Array(7).fill(two[0]) })).status).toBe(400);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [{ author: "x" }] })).status).toBe(400);
  });
});

describe("POST /api/summaries/links", () => {
  const found = { url: HALLIE_URL, title: "Claude Code effort level and model selection", detail: "Anthropic, Lydia Hallie" };

  test("saves a found-by-search line, keeps the fact-check hash, returns the hash read back; a second accept with it saves too", async () => {
    const a = app();
    const checked = checkedSha256OfRaw(RAW);
    const r1 = await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [found] });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { added: number; linksBaseHash: string };
    expect(b1.added).toBe(1);
    const written = files.get(DOC)!;
    expect(written).toContain(`- 🔎 [Claude Code effort level and model selection](${HALLIE_URL}) — Anthropic, Lydia Hallie · found by search\n\n_7 creator`);
    expect(written).toContain('date: "2026-03-22"');
    expect(written).toMatch(/\n\n## Transcript\n\n### \[00:00:00\]/);
    expect(checkedSha256OfRaw(written)).toBe(checked);
    expect(b1.linksBaseHash).toBe(linksBaseHash(written));
    // YouTube's ingest takes no tags.
    expect(ingests[0]).not.toHaveProperty("tags");

    const r2 = await post(a, "/api/summaries/links", {
      ...ref,
      baseHash: b1.linksBaseHash,
      add: [{ url: "https://b.example/paper", title: "Second", detail: "" }],
    });
    expect(r2.status).toBe(200);
    expect(files.get(DOC)!).toMatch(/found by search\n- 🔎 \[Second\]\(https:\/\/b\.example\/paper\) · found by search\n\n_7/);
  });

  test("a URL already in the section is skipped and nothing is written", async () => {
    const res = await post(app(), "/api/summaries/links", {
      ...ref,
      baseHash: linksBaseHash(RAW),
      add: [{ url: "https://www.claude.example/blog/spending-your-effort/?utm_source=x", title: "Dup", detail: "" }],
    });
    expect(await res.json()).toMatchObject({ ok: true, added: 0, skipped: 1 });
    expect(ingests).toHaveLength(0);
  });

  test("an accept after an outside write answers 409 links_changed and writes nothing", async () => {
    const base = linksBaseHash(RAW);
    files.set(DOC, RAW.replace("is the reference.", "is the reference, re-run."));
    const res = await post(app(), "/api/summaries/links", { ...ref, baseHash: base, add: [found] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "links_changed" });
    expect(ingests).toHaveLength(0);
  });

  test("a held claim answers 409 in_flight", async () => {
    claims.claim("youtube", DOC, 60_000);
    const res = await post(app(), "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [found] });
    expect(await res.json()).toMatchObject({ code: "in_flight" });
  });

  test("a document with no section and no transcript gets one", async () => {
    const raw = `---\ndate: 2026-03-22\nurl: "${URL_}"\n---\n\nJust a summary.\n`;
    files.set(DOC, raw);
    const res = await post(app(), "/api/summaries/links", { ...ref, baseHash: linksBaseHash(raw), add: [found] });
    expect(res.status).toBe(200);
    expect(files.get(DOC)!).toBe(
      `---\ndate: "2026-03-22"\nurl: "${URL_}"\n---\n\nJust a summary.\n\n## Links\n\n- 🔎 [Claude Code effort level and model selection](${HALLIE_URL}) — Anthropic, Lydia Hallie · found by search\n`,
    );
  });

  test("bounds: a non-http url, a missing title, a bad hash", async () => {
    const a = app();
    const base = linksBaseHash(RAW);
    expect((await post(a, "/api/summaries/links", { ...ref, baseHash: base, add: [{ ...found, url: "javascript:alert(1)" }] })).status).toBe(400);
    expect((await post(a, "/api/summaries/links", { ...ref, baseHash: base, add: [{ ...found, title: " " }] })).status).toBe(400);
    expect((await post(a, "/api/summaries/links", { ...ref, baseHash: "nope", add: [found] })).status).toBe(400);
  });
});

/**
 * `/api/summaries/links{,/options,/candidates,/search}` — every seam injected:
 * the raw read and the ingest are one in-memory "huginn" writing files the way
 * `write_summary` does (frontmatter re-quoted, trailing spaces on a line
 * normalized away, a blank line, the summary string), the candidates call and
 * the web agent are canned or held answers, and the page fetch is a map of
 * invented pages.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { defaultSummariesLinksDeps, registerSummariesLinksRoutes, type FindLinksTracer, type SummariesLinksDeps } from "./summaries-links.ts";
import { SummarySaveClaims } from "../../summaries/summary-save.ts";
import { checkedSha256OfRaw } from "../../summaries/factcheck-body.ts";
import { linksBaseHash, type LinkCandidate } from "../../summaries/find-links.ts";
import type { SafePage } from "../../summaries/safe-fetch.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";

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
// The trailing double space is what the fake huginn normalizes away on write.
const SUMMARY = "Lydia Hallie's article on Claude Code effort levels is the reference.  \nIt also cites [the caching guide](https://claude.example/docs/prompt-caching-guide).\n\n> 💬 **Takeaway:** Pick the level per task.";
// Legacy UNQUOTED date, the 682-document shape.
const RAW = `---\ndate: 2026-03-22\nurl: "${URL_}"\n---\n\n${SUMMARY}\n\n${LINKS}\n\n## Transcript\n\n### [00:00:00]\n\nWords.\n`;

const HALLIE_URL = "https://claude.example/resources/articles/effort";
const PDF_URL = "https://papers.example/effort.pdf";
const filler = (s: string) => `<p>${(s + " ").repeat(40)}</p>`;
const PAGES: Record<string, SafePage> = {
  [HALLIE_URL]: {
    finalUrl: HALLIE_URL,
    contentType: "text/html",
    text: `<title>Claude Code effort level and model selection</title><meta property="og:site_name" content="Anthropic">${filler("By Lydia Hallie.")}`,
  },
  [PDF_URL]: { finalUrl: PDF_URL, contentType: "application/pdf", text: null },
  "https://hostile.example/x": { finalUrl: "https://hostile.example/x", contentType: "text/html", text: "<title>&#99999999; &#xFFFFFFF;</title>" },
};

const C_HALLIE: LinkCandidate = { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" };
const C_NONE: LinkCandidate = { title: null, author: null, topic: "an internal benchmark nobody published", kind: "doc" };
const C_PDF: LinkCandidate = { title: "The effort paper", author: null, topic: "the effort paper", kind: "paper" };

let files: Map<string, string>;
let ingests: Record<string, unknown>[];
let claims: SummarySaveClaims;
let candidatesAnswer: string;
let agentAnswers: Record<string, string>;
let bot: unknown;
let spans: string[];

const fakeTracer = (): FindLinksTracer =>
  ({
    start: (label: string) => spans.push(`start:${label}`),
    end: (label: string) => spans.push(`end:${label}`),
    finish: (status = "ok") => spans.push(`finish:${status}`),
    spanStartedAt: () => Date.now(),
  }) as unknown as FindLinksTracer;

function deps(over: Partial<SummariesLinksDeps> = {}): SummariesLinksDeps {
  return {
    readRaw: async (_c, docId) => files.get(docId) ?? null,
    bots: () => [bot as never],
    candidatesCall: async () => candidatesAnswer,
    agent: async (c) => agentAnswers[c.topic] ?? "{}",
    fetchPage: async (url) => PAGES[url] ?? null,
    tracer: () => fakeTracer(),
    claims,
    ingest: async ({ body }) => {
      ingests.push(body);
      const path = `${body.category}/${body.title}.md`;
      const summary = String(body.summary).replace(/ +\n/g, "\n");
      files.set(path, `---\ndate: ${JSON.stringify(body.date)}\nurl: ${JSON.stringify(body.url)}\n---\n\n${summary}`);
      return { ok: true, status: 200, data: { file_path: path, similar: [] } };
    },
    ...over,
  };
}

function app(over: Partial<SummariesLinksDeps> = {}): Hono {
  const a = new Hono();
  registerSummariesLinksRoutes(a, config, deps(over));
  return a;
}

const post = (a: Hono, path: string, body: unknown, contentType = "application/json") =>
  a.request(path, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });
const ref = { source: "youtube", docId: DOC };
const manifest = (url: string, quote = "") => JSON.stringify({ results: [{ url, title: "x", quote }] });

/** The SSE body as `event` → parsed `data` pairs. */
async function events(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  return (await res.text())
    .split("\n\n")
    .map((frame) => ({ event: /^event: (.*)$/m.exec(frame)?.[1] ?? "", data: /^data: (.*)$/m.exec(frame)?.[1] ?? "" }))
    .filter((f) => f.event && f.data)
    .map((f) => ({ event: f.event, data: JSON.parse(f.data) as Record<string, unknown> }));
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  files = new Map([[DOC, RAW]]);
  ingests = [];
  claims = new SummarySaveClaims();
  bot = webBot;
  spans = [];
  candidatesAnswer = JSON.stringify([
    C_HALLIE,
    { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" },
    { title: "Prompt caching guide", author: null, topic: "the prompt caching guide", kind: "doc" },
    C_NONE,
  ]);
  agentAnswers = {
    [C_HALLIE.topic]: manifest(HALLIE_URL),
    [C_NONE.topic]: manifest("https://invented.example/nothing", "a quote nobody wrote anywhere"),
    [C_PDF.topic]: manifest(PDF_URL),
  };
});

describe("GET /api/summaries/links/options", () => {
  const opts = (a: Hono, source = "youtube") => a.request(`/api/summaries/links/options?source=${source}&docId=${encodeURIComponent(DOC)}`);
  test("a savable document is available, and carries no hash (the baseline is the candidates call's)", async () => {
    expect(await (await opts(app())).json()).toEqual({ available: true });
  });
  test("a document with no url is not (no_url): no button", async () => {
    files.set(DOC, "---\ndate: 2026-03-22\n---\n\nPasted text.\n");
    expect(await (await opts(app(), "article")).json()).toMatchObject({ available: false, code: "no_url" });
  });
  test.each([
    ["both readers open", "Summary.\n\n```python\nprint(1)\n"],
    ["walker-only open (a 4-space fence marked reads as indented code)", "Summary.\n\n    ```python\nprint(1)\n"],
  ])("R3: a summary ending inside an unclosed fence (%s) gets no button", async (_name, body) => {
    files.set(DOC, `---\nurl: "${URL_}"\n---\n\n${body}`);
    expect(await (await opts(app())).json()).toMatchObject({ available: false, code: "open_fence" });
  });
});

describe("POST /api/summaries/links/candidates", () => {
  test("415 without application/json", async () => {
    expect((await post(app(), "/api/summaries/links/candidates", ref, "text/plain")).status).toBe(415);
  });
  test("drops a candidate the section lists and one the body links; returns the rest, the hash and the cap; traced", async () => {
    const res = await post(app(), "/api/summaries/links/candidates", ref);
    const body = (await res.json()) as { candidates: LinkCandidate[]; listed: number; linked: number; maxSelected: number; linksBaseHash: string };
    expect(body.candidates.map((c) => c.topic)).toEqual([C_HALLIE.topic, C_NONE.topic]);
    expect(body).toMatchObject({ listed: 1, linked: 1, maxSelected: 6, linksBaseHash: linksBaseHash(RAW) });
    expect(spans).toEqual(["start:candidates", "end:candidates", "finish:ok"]);
  });
  test("an answer with no list is a 502, not an empty panel", async () => {
    candidatesAnswer = "I could not find anything.";
    expect((await post(app(), "/api/summaries/links/candidates", ref)).status).toBe(502);
  });
  test("a bot without web tools is refused before the model call", async () => {
    bot = noWebBot;
    let called = false;
    const res = await post(app({ candidatesCall: async () => ((called = true), "[]") }), "/api/summaries/links/candidates", ref);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "no_web_tools" });
    expect(called).toBe(false);
  });
  test("R3: an unclosed fence is refused before the model call", async () => {
    files.set(DOC, `---\nurl: "${URL_}"\n---\n\nSummary.\n\n\`\`\`\ncode\n`);
    const res = await post(app({ candidatesCall: async () => { throw new Error("must not run"); } }), "/api/summaries/links/candidates", ref);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "open_fence" });
  });
});

describe("POST /api/summaries/links/search", () => {
  test("415 without application/json", async () => {
    expect((await post(app(), "/api/summaries/links/search", { ...ref, candidates: [C_HALLIE] }, "text/plain")).status).toBe(415);
  });

  test("one matched, one not found, one PDF; states before results; done last", async () => {
    const res = await post(app(), "/api/summaries/links/search", { ...ref, candidates: [C_HALLIE, C_NONE, C_PDF] });
    const evs = await events(res);
    expect(evs[0]!.event).toBe("start");
    expect(evs.at(-1)!.event).toBe("done");
    const results = evs.filter((e) => e.event === "result").map((e) => e.data);
    expect(results.find((r) => r.index === 0)).toMatchObject({
      outcome: "found",
      results: [{ url: HALLIE_URL, label: "matched", title: "Claude Code effort level and model selection", detail: "Anthropic, Lydia Hallie" }],
    });
    expect(results.find((r) => r.index === 1)).toMatchObject({ outcome: "not_found", results: [] });
    expect(results.find((r) => r.index === 2)).toMatchObject({ outcome: "found", results: [{ url: PDF_URL, label: "unread", title: C_PDF.title }] });
    expect(evs.filter((e) => e.event === "state").map((e) => e.data.state)).toContain("checking");
  });

  describe("D19 9: a result the summary already carries is dropped by URL", () => {
    /** A page that matches whatever candidate asks for it: the title is the candidate's. */
    const pageFor = (url: string, title: string): SafePage => ({ finalUrl: url, contentType: "text/html", text: `<title>${title}</title>${filler("Body text.")}` });
    async function run(body: string, cases: { c: LinkCandidate; url: string; finalUrl?: string; title: string }[]) {
      files.set(DOC, `---\ndate: "2026-03-22"\nurl: "${URL_}"\n---\n\n${body}\n`);
      const fetched: string[] = [];
      // The quote is on every page, so a result that is not dropped is at least reachable.
      for (const k of cases) agentAnswers[k.c.topic] = manifest(k.url, "Body text. Body text. Body text.");
      const a = app({
        fetchPage: async (url) => {
          fetched.push(url);
          const k = cases.find((x) => x.url === url);
          return k ? pageFor(k.finalUrl ?? url, k.title) : null;
        },
      });
      const evs = await events(await post(a, "/api/summaries/links/search", { ...ref, candidates: cases.map((k) => k.c) }));
      return { results: evs.filter((e) => e.event === "result").map((e) => e.data), fetched };
    }
    const repo = (name: string): LinkCandidate => ({ title: name, author: null, topic: `the ${name} repo`, kind: "repo" });

    test("a Links section whose lines show URL titles: every listed URL the agents return is dropped, unfetched", async () => {
      const body = [
        "REA is the MCP server the guide is built on.",
        "",
        "## Links",
        "",
        "- 📦 [github.com/morluto/rea](https://github.com/morluto/rea) · from text",
        "- 📄 [anthropic.com/claude-opus-5-5](https://www.anthropic.com/claude-opus-5-5) · from text",
      ].join("\n");
      const { results, fetched } = await run(body, [
        { c: { title: "REA", author: null, topic: "REA (Reverse Engineer Anything), the MCP server", kind: "tool" }, url: "https://github.com/morluto/rea", title: "rea" },
        { c: { title: "Claude Opus 5.5", author: null, topic: "Anthropic's Claude Opus 5.5 page", kind: "doc" }, url: "https://anthropic.com/claude-opus-5-5/", title: "Claude Opus 5.5" },
        { c: { title: null, author: null, topic: "the REA repo by morluto", kind: "repo" }, url: "https://github.com/Morluto/REA", title: "rea" },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(["not_found", "not_found", "not_found"]);
      expect(fetched).toEqual([]);
    });

    test("inline markdown links and bare URLs in the body: those results are dropped", async () => {
      const { results } = await run("See [nanoGPT](https://github.com/karpathy/nanoGPT) and https://github.com/openai/evals for the code.", [
        { c: repo("karpathy/nanoGPT"), url: "https://github.com/karpathy/nanoGPT", title: "karpathy/nanoGPT" },
        { c: repo("openai/evals"), url: "https://github.com/openai/evals/", title: "openai/evals" },
        { c: repo("openai/whisper"), url: "https://github.com/openai/whisper", title: "openai/whisper" },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(["not_found", "not_found", "found"]);
    });

    test("a page that lands on a carried URL is dropped after the fetch; another URL is kept", async () => {
      const { results } = await run("Run it on [Ollama](https://ollama.com/) and compare with [the BERT paper](https://arxiv.org/abs/1810.04805).", [
        {
          c: { title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", author: null, topic: "the BERT paper", kind: "paper" },
          url: "https://short.example/bert",
          finalUrl: "https://arxiv.org/abs/1810.04805",
          title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        },
        {
          c: { title: "Attention Is All You Need", author: null, topic: "the transformer paper", kind: "paper" },
          url: "https://arxiv.org/abs/1706.03762",
          title: "Attention Is All You Need",
        },
      ]);
      expect(results.map((r) => r.outcome)).toEqual(["not_found", "found"]);
    });
  });

  test("a bot without web tools is a JSON 503 before the stream", async () => {
    bot = noWebBot;
    const res = await post(app(), "/api/summaries/links/search", { ...ref, candidates: [C_HALLIE] });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "no_web_tools" });
  });

  test("bounds: an empty list, too many, a topic-less item", async () => {
    const a = app();
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [] })).status).toBe(400);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: Array(7).fill(C_HALLIE) })).status).toBe(400);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [{ author: "x" }] })).status).toBe(400);
  });

  test("a hostile entity on a page, or a throwing fetch, fails that page only; the run finishes", async () => {
    agentAnswers[C_NONE.topic] = manifest("https://hostile.example/x", "q");
    const a = app({
      fetchPage: async (url) => {
        if (url === HALLIE_URL) throw new Error("boom");
        return PAGES[url] ?? null;
      },
    });
    const evs = await events(await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_HALLIE, C_NONE] }));
    expect(evs.filter((e) => e.event === "result").map((e) => e.data.outcome).sort()).toEqual(["not_found", "not_found"]);
    expect(evs.at(-1)!.event).toBe("done");
  });

  test("at most 3 agents at once, each handed at most 60 s", async () => {
    let live = 0;
    let peak = 0;
    const budgets: number[] = [];
    const a = app({
      agent: async (_c, _i, timeoutMs) => {
        budgets.push(timeoutMs);
        peak = Math.max(peak, ++live);
        await tick(15);
        live--;
        return "{}";
      },
    });
    const six = Array.from({ length: 6 }, (_, i) => ({ ...C_NONE, topic: `t${i}` }));
    await events(await post(a, "/api/summaries/links/search", { ...ref, candidates: six }));
    expect(peak).toBe(3);
    expect(budgets).toHaveLength(6);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(60_000);
    expect(Math.min(...budgets)).toBeGreaterThan(59_000);
  });

  test("409 running while a search on the document is out; a client disconnect launches nothing more; the lock holds until launched agents settle", async () => {
    const gates: (() => void)[] = [];
    let launched = 0;
    const a = app({
      run: { concurrency: 2 },
      agent: () => {
        launched++;
        return new Promise<string>((resolve) => gates.push(() => resolve("{}")));
      },
    });
    const five = Array.from({ length: 5 }, (_, i) => ({ ...C_NONE, topic: `t${i}` }));
    const res = await post(a, "/api/summaries/links/search", { ...ref, candidates: five });
    const reader = res.body!.getReader();
    await reader.read();
    await tick();
    expect(launched).toBe(2);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] })).status).toBe(409);
    await reader.cancel();
    await tick();
    gates.splice(0).forEach((g) => g());
    await tick(30);
    // The reader left: the two running agents finished, no third launched.
    expect(launched).toBe(2);
    await tick(30);
    const after = await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] });
    expect(after.status).toBe(200);
    gates.splice(0).forEach((g) => g());
    await after.text();
  });

  test("an agent past its time: the stream says timeout and ends, the lock waits for the agent to settle", async () => {
    let release: (() => void) | null = null;
    const a = app({
      run: { agentTimeoutMs: 40, runTimeoutMs: 60_000, minAgentMs: 0 },
      agent: () => new Promise<string>((resolve) => (release = () => resolve("{}"))),
    });
    const evs = await events(await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] }));
    expect(evs.find((e) => e.event === "result")!.data).toMatchObject({ outcome: "timeout" });
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] })).status).toBe(409);
    release!();
    await tick();
    const again = await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] });
    expect(again.status).toBe(200);
    release!();
    await again.text();
  });

  test("a client that holds the stream open and never reads: the backstop still releases the lock", async () => {
    const a = app({ run: { runTimeoutMs: 40, lockBackstopMs: 40, minAgentMs: 0 }, agent: async () => "{}" });
    // The body is never read, so no SSE write settles and the stream's `finally` never runs.
    const held = await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] });
    expect(held.status).toBe(200);
    expect((await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] })).status).toBe(409);
    await tick(150);
    const after = await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE] });
    expect(after.status).toBe(200);
    await after.body?.cancel();
    await held.body?.cancel();
  });

  test("past the run's deadline nothing more launches (skipped)", async () => {
    let t = 0;
    const a = app({ now: () => t, run: { concurrency: 1, runTimeoutMs: 1_000, minAgentMs: 500 }, agent: async () => ((t += 600), "{}") });
    const evs = await events(await post(a, "/api/summaries/links/search", { ...ref, candidates: [C_NONE, { ...C_NONE, topic: "t2" }] }));
    expect(evs.filter((e) => e.event === "result").map((e) => e.data.outcome)).toEqual(["not_found", "skipped"]);
  });
});

describe("the default agent", () => {
  test("runs on the { web: true } surface with the agent budget (D6)", async () => {
    const seen: Record<string, unknown>[] = [];
    const oneShot = (async (_prompt: string, _config: unknown, _bot: unknown, opts: Record<string, unknown>) => {
      seen.push(opts);
      return { result: "{}" };
    }) as unknown as typeof executeOneShot;
    const d = defaultSummariesLinksDeps(config, oneShot);
    await d.agent(C_HALLIE, 0, 60_000, webBot, fakeTracer(), "Effort talk");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolSurface).toEqual({ web: true });
    expect(seen[0]!.timeoutMs).toBe(60_000);
    expect(spans).toEqual(["start:claude:link-1", "end:claude:link-1"]);
  });
});

describe("POST /api/summaries/links", () => {
  /** Run one search so the server holds the verified results, then hand back the app. */
  async function searched(over: Partial<SummariesLinksDeps> = {}, candidates = [C_HALLIE, C_PDF]): Promise<Hono> {
    const a = app(over);
    await events(await post(a, "/api/summaries/links/search", { ...ref, candidates }));
    return a;
  }

  test("415 without application/json", async () => {
    expect((await post(app(), "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [{ url: HALLIE_URL }] }, "text/plain")).status).toBe(415);
  });

  test("R4: a URL no search verified is refused, whatever title the client sends", async () => {
    const a = await searched();
    const res = await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [{ url: "https://evil.example/x", title: "Trust me" }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "not_verified" });
    expect(ingests).toHaveLength(0);
  });

  test("saves the server's verified line, keeps the fact-check hash, returns the hash of the RE-READ file; a second accept with it saves too", async () => {
    const a = await searched();
    const checked = checkedSha256OfRaw(RAW);
    const r1 = await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [{ url: HALLIE_URL, title: "client title ignored" }] });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { added: number; linksBaseHash: string };
    expect(b1.added).toBe(1);
    const written = files.get(DOC)!;
    expect(written).toContain(`- 🔎 [Claude Code effort level and model selection](${HALLIE_URL}) — Anthropic, Lydia Hallie · found by search\n\n_7 creator`);
    expect(written).toContain('date: "2026-03-22"');
    expect(written).toMatch(/\n\n## Transcript\n\n### \[00:00:00\]/);
    expect(checkedSha256OfRaw(written.replace("reference.\n", "reference.  \n"))).toBe(checked);
    // huginn normalized the body on write, so only a hash read back from the
    // written file can be the next accept's base.
    expect(b1.linksBaseHash).toBe(linksBaseHash(written));
    expect(b1.linksBaseHash).not.toBe(linksBaseHash(RAW));
    // YouTube's ingest takes no tags.
    expect(ingests[0]).not.toHaveProperty("tags");

    const r2 = await post(a, "/api/summaries/links", { ...ref, baseHash: b1.linksBaseHash, add: [{ url: PDF_URL }] });
    expect(r2.status).toBe(200);
    expect(files.get(DOC)!).toMatch(/found by search\n- 🔎 \[The effort paper\]\(https:\/\/papers\.example\/effort\.pdf\) · found by search\n\n_7/);
  });

  test("D19 9: a URL already in the section is never verified, so a save of it is refused and nothing is written", async () => {
    const listedUrl = "https://www.claude.example/blog/spending-your-effort/?utm_source=x";
    agentAnswers.listed = manifest(listedUrl);
    const b = await searched({ fetchPage: async (url) => (url === listedUrl ? { finalUrl: url, contentType: "application/pdf", text: null } : null) }, [
      { ...C_PDF, topic: "listed" },
    ]);
    const res = await post(b, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [{ url: listedUrl }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "not_verified" });
    expect(ingests).toHaveLength(0);
  });

  test("an accept after an outside write answers 409 links_changed and writes nothing", async () => {
    const a = await searched();
    const base = linksBaseHash(RAW);
    files.set(DOC, RAW.replace("is the reference.", "is the reference, re-run."));
    const res = await post(a, "/api/summaries/links", { ...ref, baseHash: base, add: [{ url: HALLIE_URL }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "links_changed" });
    expect(ingests).toHaveLength(0);
    // Nothing written: the claim was abandoned, so the next writer gets it.
    expect(claims.claim("youtube", DOC, 1_000)).not.toBeNull();
  });

  test("a held claim answers 409 in_flight", async () => {
    const a = await searched();
    claims.claim("youtube", DOC, 60_000);
    const res = await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [{ url: HALLIE_URL }] });
    expect(await res.json()).toMatchObject({ code: "in_flight" });
  });

  test("a document with no section and no transcript gets one", async () => {
    const raw = `---\ndate: 2026-03-22\nurl: "${URL_}"\n---\n\nJust a summary.\n`;
    files.set(DOC, raw);
    const a = await searched();
    const res = await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(raw), add: [{ url: HALLIE_URL }] });
    expect(res.status).toBe(200);
    expect(files.get(DOC)!).toBe(
      `---\ndate: "2026-03-22"\nurl: "${URL_}"\n---\n\nJust a summary.\n\n## Links\n\n- 🔎 [Claude Code effort level and model selection](${HALLIE_URL}) — Anthropic, Lydia Hallie · found by search\n`,
    );
  });

  test("bounds: an empty add, a bad hash", async () => {
    const a = app();
    expect((await post(a, "/api/summaries/links", { ...ref, baseHash: linksBaseHash(RAW), add: [] })).status).toBe(400);
    expect((await post(a, "/api/summaries/links", { ...ref, baseHash: "nope", add: [{ url: HALLIE_URL }] })).status).toBe(400);
  });
});

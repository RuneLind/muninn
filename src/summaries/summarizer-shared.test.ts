import { test, expect } from "bun:test";
import { buildSummarySystemPrompt, ingestSummary } from "./summarizer-shared.ts";
import type { SimilarArticle } from "./job-store.ts";

// --- buildSummarySystemPrompt ---

test("buildSummarySystemPrompt reproduces the youtube/x-article scaffold byte-for-byte", () => {
  const cats = ["ai/general", "tech", "science"];
  const built = buildSummarySystemPrompt(
    "You are a video content analyst. Summarize the following YouTube video transcript.",
    cats,
  );
  const expected = `You are a video content analyst. Summarize the following YouTube video transcript.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${cats.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Keep it concise but comprehensive`;
  expect(built).toBe(expected);
});

test("buildSummarySystemPrompt honors a custom structure-bullet list (anthropic variant)", () => {
  const cats = ["ai/general", "ai/claude"];
  const built = buildSummarySystemPrompt(
    "You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf.",
    cats,
    [
      "- ### Section headers for key topics",
      "- Bullet points with emoji prefixes",
      "- **Bold** for key terms and takeaways",
      "- Lead with what changed and why it matters; keep it concise but comprehensive",
    ],
  );
  const expected = `You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${cats.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Lead with what changed and why it matters; keep it concise but comprehensive`;
  expect(built).toBe(expected);
});

// --- ingestSummary ---

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("ingestSummary POSTs the body and passes returned similar articles to onSimilar", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const restore = stubFetch((input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ similar: [{ title: "S", url: "https://s" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const seen: SimilarArticle[] = [];
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: { title: "T", url: "u", summary: "sum", category: "ai/general" },
      onSimilar: (s) => seen.push(...s),
    });
  } finally {
    restore();
  }
  expect(capturedUrl).toBe("http://kb.test/api/youtube/ingest");
  expect(JSON.parse(capturedBody)).toEqual({ title: "T", url: "u", summary: "sum", category: "ai/general" });
  expect(seen).toEqual([{ title: "S", url: "https://s" }]);
});

test("ingestSummary does not call onSimilar when there are no similar articles", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
  let called = false;
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: {},
      onSimilar: () => {
        called = true;
      },
    });
  } finally {
    restore();
  }
  expect(called).toBe(false);
});

test("ingestSummary is best-effort: a non-ok response neither throws nor enriches", async () => {
  const restore = stubFetch(() => new Response("nope", { status: 500 }));
  let called = false;
  try {
    await expect(
      ingestSummary({
        knowledgeApiUrl: "http://kb.test",
        ingestPath: "/api/youtube/ingest",
        body: {},
        onSimilar: () => {
          called = true;
        },
      }),
    ).resolves.toBeUndefined();
  } finally {
    restore();
  }
  expect(called).toBe(false);
});

test("ingestSummary is best-effort: a fetch rejection is swallowed", async () => {
  const restore = stubFetch(() => {
    throw new Error("network down");
  });
  try {
    await expect(
      ingestSummary({
        knowledgeApiUrl: "http://kb.test",
        ingestPath: "/api/youtube/ingest",
        body: {},
        onSimilar: () => {},
      }),
    ).resolves.toBeUndefined();
  } finally {
    restore();
  }
});

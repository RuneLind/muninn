/**
 * The shared summary save path: the transcript-less shapes, the stored
 * `summary_kind`, the claim it requires, and what huginn's answer turns into.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSummarySaveBody,
  preflightSummarySave,
  readStoredCapture,
  requireSaveDescriptor,
  saveSummaryBody,
  SummarySaveClaims,
  type SummaryIngest,
  type SummaryIngestResponse,
} from "./summary-save.ts";

function doc(front: string[], body: string): string {
  return ["---", ...front, "---", "", body].join("\n");
}

const ARTICLE = doc(
  ['date: "2026-08-05"', 'url: "https://example.com/post"', 'author: "Someone"', 'category: "ai/general"', 'tags: "ai, general"'],
  "## Key takeaways\n\n- One.\n",
);
const ANTHROPIC = doc(
  ['date: "2026-06-28"', 'url: "https://docs.example.com/x"', 'category: "ai/claude"', 'tags: "ai, claude, release"'],
  "A release summary.",
);
const X_POST = doc(
  ['date: "2026-08-05"', 'url: "https://x.com/someone/status/1"', 'author: "@someone"', 'category: "ai/general"', 'tags: "ai, general"'],
  "An X post summary.",
);

function bodyFor(sourceId: string, raw: string, docId: string, summaryKind?: string): Record<string, unknown> {
  const stored = readStoredCapture(raw);
  const pre = preflightSummarySave(stored, docId);
  if (!pre.ok) throw new Error(pre.code);
  return buildSummarySaveBody({
    descriptor: requireSaveDescriptor(sourceId),
    stored,
    title: pre.title,
    category: pre.category,
    summary: stored.body,
    ...(summaryKind !== undefined ? { summaryKind } : {}),
  }).body;
}

describe("transcript-less shapes", () => {
  for (const [sourceId, raw, docId] of [
    ["article", ARTICLE, "ai/general/A post.md"],
    ["anthropic", ANTHROPIC, "ai/claude/A release.md"],
    ["x-article", X_POST, "ai/general/An X post.md"],
  ] as const) {
    test(`${sourceId}: no ## Transcript is added, and the body round-trips byte for byte`, () => {
      const body = bodyFor(sourceId, raw, docId);
      expect(String(body.summary)).not.toContain("## Transcript");
      expect(body).not.toHaveProperty("transcript_markdown");
      // The stored body exactly, trailing whitespace included.
      expect(String(body.summary)).toBe(raw.slice(raw.indexOf("---\n\n") + 5));
    });
  }

  test("anthropic sends no author, article and X send theirs", () => {
    expect(bodyFor("anthropic", ANTHROPIC, "ai/claude/A release.md")).not.toHaveProperty("author");
    expect(bodyFor("article", ARTICLE, "ai/general/A post.md").author).toBe("Someone");
    expect(bodyFor("x-article", X_POST, "ai/general/An X post.md").author).toBe("@someone");
  });

  test("hand-added tags are re-sent minus the category parts", () => {
    expect(bodyFor("anthropic", ANTHROPIC, "ai/claude/A release.md").tags).toEqual(["release"]);
    expect(bodyFor("article", ARTICLE, "ai/general/A post.md")).not.toHaveProperty("tags");
  });
});

describe("summary_kind", () => {
  test("a document without one gets no key", () => {
    const raw = doc(['date: "2026-09-01"', 'url: "https://www.youtube.com/watch?v=abcdefghijk"', 'category: "ai/general"'], "Body.");
    expect(bodyFor("youtube", raw, "ai/general/T.md")).not.toHaveProperty("summary_kind");
  });

  test("a stored one is re-sent as it is", () => {
    const raw = doc(
      ['date: "2026-09-01"', 'url: "https://www.youtube.com/watch?v=abcdefghijk"', 'summary_kind: "deep"', 'category: "ai/general"'],
      "Body.",
    );
    expect(bodyFor("youtube", raw, "ai/general/T.md").summary_kind).toBe("deep");
  });

  test("the caller's kind wins (re-run's new kind)", () => {
    const raw = doc(
      ['date: "2026-09-01"', 'url: "https://www.youtube.com/watch?v=abcdefghijk"', 'summary_kind: "deep"', 'category: "ai/general"'],
      "Body.",
    );
    expect(bodyFor("youtube", raw, "ai/general/T.md", "standard").summary_kind).toBe("standard");
  });
});

describe("the preflight", () => {
  const base = (url: string) =>
    readStoredCapture(doc([`url: ${JSON.stringify(url)}`, 'category: "ai/general"'], "Body."));

  test("refuses an empty url and a url that is not http(s)", () => {
    for (const url of ["", "Some article text, pasted where the url goes.", "ftp://example.com/x", "/relative"]) {
      const pre = preflightSummarySave(base(url), "ai/general/T.md");
      expect(pre.ok ? "ok" : pre.code).toBe("no_url");
    }
  });

  test("refuses an id with no category, and a title that does not round-trip", () => {
    const stored = base("https://example.com/x");
    const noCat = preflightSummarySave(stored, "T.md");
    expect(noCat.ok ? "ok" : [noCat.code, noCat.status]).toEqual(["no_category", 400]);
    const badTitle = preflightSummarySave(stored, "ai/general/Two  spaces.md");
    expect(badTitle.ok ? "ok" : [badTitle.code, badTitle.status]).toEqual(["title_not_round_trippable", 409]);
  });
});

describe("saveSummaryBody", () => {
  const DOC_ID = "ai/general/A post.md";
  function harness(answer: SummaryIngestResponse) {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const ingest: SummaryIngest = async (o) => {
      calls.push({ path: o.ingestPath, body: o.body });
      return answer;
    };
    const claims = new SummarySaveClaims();
    return { calls, ingest, claims };
  }
  const input = (h: ReturnType<typeof harness>, claim = h.claims.claim("article", DOC_ID, 1_000)!) => ({
    descriptor: requireSaveDescriptor("article"),
    stored: readStoredCapture(ARTICLE),
    docId: DOC_ID,
    summary: readStoredCapture(ARTICLE).body,
    claim,
    claims: h.claims,
    knowledgeApiUrl: "http://127.0.0.1:1",
    ingest: h.ingest,
  });

  test("writes to the document's own path", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID, similar: [{ title: "x", url: "u" }] } });
    const res = await saveSummaryBody(input(h));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.similar).toHaveLength(1);
    expect(h.calls[0]!.path).toBe("/api/articles/ingest");
  });

  test("requires a held claim and never claims itself", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID } });
    const claim = h.claims.claim("article", DOC_ID, 1_000)!;
    h.claims.release(claim);
    const res = await saveSummaryBody(input(h, claim));
    expect(res.ok ? "ok" : res.code).toBe("in_flight");
    expect(h.calls).toHaveLength(0);
    // And the save took no claim of its own.
    expect(h.claims.isHeld("article", DOC_ID)).toBe(false);
  });

  test("a claim on a different document does not authorize this one", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID } });
    const other = h.claims.claim("article", "ai/general/Other.md", 1_000)!;
    const res = await saveSummaryBody(input(h, other));
    expect(res.ok ? "ok" : res.code).toBe("in_flight");
    expect(h.calls).toHaveLength(0);
  });

  test("a non-OK answer is write_failed", async () => {
    const h = harness({ ok: false, status: 422, error: "Ingest returned 422" });
    const res = await saveSummaryBody(input(h));
    expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_failed", 502]);
  });

  test("an answer with no file_path is write_failed", async () => {
    const h = harness({ ok: true, status: 200, data: {} });
    const res = await saveSummaryBody(input(h));
    expect(res.ok ? "ok" : res.code).toBe("write_failed");
  });

  test("a different file_path is forked and names the sibling", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: "ai/general/A post (2).md" } });
    const res = await saveSummaryBody(input(h));
    expect(res.ok ? "ok" : [res.code, res.siblingDocId]).toEqual(["forked", "ai/general/A post (2).md"]);
  });

  test("a URL-less document is refused, not written", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID } });
    const raw = ARTICLE.replace('url: "https://example.com/post"\n', 'url: ""\n');
    const res = await saveSummaryBody({ ...input(h), stored: readStoredCapture(raw) });
    expect(res.ok ? "ok" : res.code).toBe("no_url");
    expect(h.calls).toHaveLength(0);
  });
});

describe("the claim registry", () => {
  test("one holder per document; release frees it; a stale token releases nothing", async () => {
    const claims = new SummarySaveClaims();
    const a = claims.claim("tiktok", "x/y.md", 20)!;
    expect(claims.claim("tiktok", "x/y.md", 20)).toBeNull();
    expect(claims.claim("tiktok", "x/z.md", 20)).not.toBeNull();
    await Bun.sleep(40); // a expires
    const b = claims.claim("tiktok", "x/y.md", 1_000)!;
    claims.release(a);
    expect(claims.holds(b)).toBe(true);
    claims.release(b);
    expect(claims.isHeld("tiktok", "x/y.md")).toBe(false);
    claims.clear();
  });
});

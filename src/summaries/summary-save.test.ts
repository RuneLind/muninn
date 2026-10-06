/**
 * The shared summary save path: the transcript-less shapes, the stored
 * `summary_kind`, the claim it requires, and what huginn's answer turns into.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_SOURCES } from "./sources.ts";
import {
  SUMMARY_SAVE_DESCRIPTORS,
  buildSummarySaveBody,
  preflightSummarySave,
  readStoredCapture,
  requireSaveDescriptor,
  saveSummaryBody,
  SummarySaveClaims,
} from "./summary-save.ts";
import { postSummaryIngest, type SummaryIngest, type SummaryIngestResponse } from "./summarizer-shared.ts";

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

  test("an EMPTY ## Transcript section round-trips byte for byte, heading included", () => {
    // `transcript` is null for it (re-run refuses it as no_transcript), but a
    // save that changes nothing must not drop the heading from the file.
    for (const tail of ["Body.\n\n## Transcript\n\n", "Body.\n\n## Transcript\n", "Body.\n\n## Transcript"]) {
      const raw = doc(
        ['date: "2026-08-05"', 'url: "https://x.com/someone/status/1"', 'author: "@someone"', 'category: "ai/general"'],
        tail,
      );
      const stored = readStoredCapture(raw);
      expect(stored.transcript).toBeNull();
      expect(stored.body).toBe("Body.");
      expect(String(bodyFor("x-article", raw, "ai/general/An X post.md").summary)).toBe(tail);
    }
  });

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
    const h = harness({ ok: false, status: 422, error: "Ingest returned 422", mayHaveWritten: false });
    const res = await saveSummaryBody(input(h));
    expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_failed", 502]);
  });

  test("a 2xx with no usable file_path is write_unknown: the request landed", async () => {
    for (const data of [{}, null, { file_path: 7 }, "ingested"]) {
      const h = harness({ ok: true, status: 200, data } as SummaryIngestResponse);
      const res = await saveSummaryBody(input(h));
      expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_unknown", 502]);
      if (!res.ok) expect(res.error).toContain("Reload");
    }
  });

  test("a different file_path is forked and names the sibling", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: "ai/general/A post (2).md" } });
    const res = await saveSummaryBody(input(h));
    expect(res.ok ? "ok" : [res.code, res.siblingDocId]).toEqual(["forked", "ai/general/A post (2).md"]);
  });

  test("an upper-case .MD id answered with huginn's lower-case .md is the same document", async () => {
    const upper = "ai/general/A post.MD";
    const h = harness({ ok: true, status: 200, data: { file_path: "ai/general/A post.md" } });
    const res = await saveSummaryBody({ ...input(h, h.claims.claim("article", upper, 1_000)!), docId: upper });
    expect(res.ok ? "ok" : res.code).toBe("ok");
    // The stem still has to match exactly: a case change there is another file.
    const other = harness({ ok: true, status: 200, data: { file_path: "ai/general/A Post.md" } });
    const forked = await saveSummaryBody({ ...input(other, other.claims.claim("article", upper, 1_000)!), docId: upper });
    expect(forked.ok ? "ok" : forked.code).toBe("forked");
  });

  test("an empty or whitespace-only summary is refused before any POST", async () => {
    // huginn's YouTube ingest reads an empty `summary` as "summarize it
    // yourself": it fetches the transcript, runs its own model and overwrites
    // the document.
    for (const summary of ["", "   \n\t\n"]) {
      const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID } });
      const res = await saveSummaryBody({ ...input(h), summary });
      expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["empty_summary", 400]);
      expect(h.calls).toHaveLength(0);
    }
  });

  test("a URL-less document is refused, not written", async () => {
    const h = harness({ ok: true, status: 200, data: { file_path: DOC_ID } });
    const raw = ARTICLE.replace('url: "https://example.com/post"\n', 'url: ""\n');
    const res = await saveSummaryBody({ ...input(h), stored: readStoredCapture(raw) });
    expect(res.ok ? "ok" : res.code).toBe("no_url");
    expect(h.calls).toHaveLength(0);
  });
});

describe("the claim carries its issuing registry", () => {
  test("a claim from a private registry authorizes the save with no registry passed beside it", async () => {
    // The save used to check `input.claims ?? summarySaveClaims`: a claim from a
    // test's own registry, or any registry but the default, read as not held.
    const own = new SummarySaveClaims();
    const docId = "ai/general/A post.md";
    const claim = own.claim("article", docId, 1_000)!;
    const calls: string[] = [];
    const res = await saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId,
      summary: readStoredCapture(ARTICLE).body,
      claim,
      knowledgeApiUrl: "http://127.0.0.1:1",
      ingest: async (o) => {
        calls.push(o.ingestPath);
        return { ok: true, status: 200, data: { file_path: docId } };
      },
    });
    expect(res.ok ? "ok" : res.code).toBe("ok");
    expect(calls).toEqual(["/api/articles/ingest"]);
    own.clear();
  });
});

describe("a claim that outlived its budget", () => {
  const DOC_ID = "ai/general/A post.md";
  const saveWith = (claim: ReturnType<SummarySaveClaims["claim"]>, ingest: SummaryIngest) =>
    saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: readStoredCapture(ARTICLE).body,
      claim: claim!,
      knowledgeApiUrl: "http://127.0.0.1:1",
      ingest,
    });
  const okIngest = (calls: string[]): SummaryIngest => async (o) => {
    calls.push(o.ingestPath);
    return { ok: true, status: 200, data: { file_path: DOC_ID } };
  };

  test("lapsed with NO rival: the save re-takes the key and writes", async () => {
    // A run that stayed inside its own timeouts can still outlive the budget
    // (the takeaway check, a connector's retry loop). Nobody else wrote, so
    // refusing would throw away a finished summary for nothing.
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 20);
    await Bun.sleep(40);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    const calls: string[] = [];
    const res = await saveWith(claim, okIngest(calls));
    expect(res.ok ? "ok" : res.code).toBe("ok");
    expect(calls).toHaveLength(1);
    claims.clear();
  });

  test("lapsed and a rival holds the key: in_flight, nothing posted", async () => {
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 20);
    await Bun.sleep(40);
    const rival = claims.claim("article", DOC_ID, 1_000)!;
    const calls: string[] = [];
    const res = await saveWith(claim, okIngest(calls));
    expect(res.ok ? "ok" : res.code).toBe("in_flight");
    expect(calls).toHaveLength(0);
    expect(claims.holds(rival)).toBe(true);
    claims.clear();
  });

  test("the claim cannot expire while the ingest is in flight", async () => {
    // Checked once before a blocking POST whose timer kept running, the claim
    // lapsed mid-ingest, a second writer claimed, and the first POST landed
    // over that writer's file.
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 30);
    let rivalDuringIngest: ReturnType<SummarySaveClaims["claim"]> | "unset" = "unset";
    const ingest: SummaryIngest = async () => {
      await Bun.sleep(60); // past the 30 ms budget
      rivalDuringIngest = claims.claim("article", DOC_ID, 1_000);
      await Bun.sleep(10);
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    };
    const res = await saveWith(claim, ingest);
    expect(res.ok ? "ok" : res.code).toBe("ok");
    expect(rivalDuringIngest).toBeNull();
    // The budget ran out during the POST, so the key frees the moment the
    // write ends: the deadline is the claim's, not reset by the write.
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.release(claim!);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
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

describe("an ingest whose answer never arrived", () => {
  // A local huginn stand-in that answers only after the caller gave up: the
  // POST was sent and read, so the document may well be on disk.
  const slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.text();
      await Bun.sleep(300);
      return Response.json({ file_path: "ai/general/A post.md" });
    },
  });
  afterAll(() => slow.stop(true));
  const DOC_ID = "ai/general/A post.md";

  test("a timeout after the request was sent is write_unknown and says to reload first", async () => {
    const claims = new SummarySaveClaims();
    const res = await saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: "A new summary.",
      claim: claims.claim("article", DOC_ID, 1_000)!,
      knowledgeApiUrl: `http://127.0.0.1:${slow.port}`,
      ingest: (o) => postSummaryIngest({ ...o, timeoutMs: 40 }),
    });
    expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_unknown", 502]);
    if (!res.ok) {
      expect(res.error).toContain("may have been written");
      expect(res.error).toContain("Reload");
    }
    claims.clear();
  });

  test("a refused connection is still a plain write_failed: nothing was sent", async () => {
    const claims = new SummarySaveClaims();
    const res = await saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: "A new summary.",
      claim: claims.claim("article", DOC_ID, 1_000)!,
      knowledgeApiUrl: "http://127.0.0.1:1",
      ingest: (o) => postSummaryIngest({ ...o, timeoutMs: 2_000 }),
    });
    expect(res.ok ? "ok" : res.code).toBe("write_failed");
    claims.clear();
  });
});

describe("the descriptor table", () => {
  test("names exactly the summary sources", () => {
    const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();
    expect(ids(SUMMARY_SAVE_DESCRIPTORS)).toEqual(ids(SUMMARY_SOURCES));
  });

  // Each vertical's CAPTURE posts to a literal of its own; the descriptor states
  // the path again. A file whose ingest paths are not exactly the descriptor's
  // is a save that writes to a different collection than the capture did.
  const CAPTURE_FILES: Record<string, string[]> = {
    youtube: ["src/youtube/summarizer.ts"],
    vimeo: ["src/vimeo/summarizer.ts"],
    tiktok: ["src/tiktok/summarizer.ts"],
    "x-article": ["src/x-article/summarizer.ts", "src/x-article/video.ts"],
    anthropic: ["src/anthropic/summarizer.ts"],
    article: ["src/article/summarizer.ts"],
  };
  const repoRoot = join(import.meta.dir, "..", "..");

  test("every source has a capture file to pin against", () => {
    expect(Object.keys(CAPTURE_FILES).sort()).toEqual(SUMMARY_SAVE_DESCRIPTORS.map((d) => d.id).sort());
  });

  for (const d of SUMMARY_SAVE_DESCRIPTORS) {
    test(`${d.id}: the capture posts to the descriptor's ingest path and no other`, () => {
      for (const file of CAPTURE_FILES[d.id] ?? []) {
        const paths = new Set(readFileSync(join(repoRoot, file), "utf8").match(/\/api\/[a-z-]+\/ingest\b/g) ?? []);
        expect({ file, paths: [...paths] }).toEqual({ file, paths: [d.ingestPath] });
      }
    });
  }
});

describe("a lapsed claim after a whole rival write", () => {
  const DOC_ID = "ai/general/A post.md";
  test("claim → lapse → rival claims, saves and releases → the stale save is refused, disk unchanged", async () => {
    // The key is free again when the stale writer comes back, but its body was
    // built from a read that predates the rival's write: posting it would
    // overwrite the rival's summary with an older one.
    const claims = new SummarySaveClaims();
    const disk: string[] = [];
    const ingest: SummaryIngest = async (o) => {
      disk.push(String(o.body.summary));
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    };
    const save = (claim: ReturnType<SummarySaveClaims["claim"]>, summary: string) =>
      saveSummaryBody({
        descriptor: requireSaveDescriptor("article"),
        stored: readStoredCapture(ARTICLE),
        docId: DOC_ID,
        summary,
        claim: claim!,
        knowledgeApiUrl: "http://127.0.0.1:1",
        ingest,
      });
    const a = claims.claim("article", DOC_ID, 20);
    await Bun.sleep(40);
    const b = claims.claim("article", DOC_ID, 1_000);
    expect(b).not.toBeNull();
    expect((await save(b, "B's summary")).ok).toBe(true);
    claims.release(b!);
    const stale = await save(a, "A's stale summary");
    expect(stale.ok ? "ok" : stale.code).toBe("in_flight");
    expect(disk.map((d) => d.trim())).toEqual(["B's summary"]);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
  });

  test("a lapsed claim the caller released does not save", async () => {
    const claims = new SummarySaveClaims();
    const calls: string[] = [];
    const a = claims.claim("article", DOC_ID, 20)!;
    await Bun.sleep(40);
    claims.release(a);
    const res = await saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: "Late.",
      claim: a,
      knowledgeApiUrl: "http://127.0.0.1:1",
      ingest: async (o) => {
        calls.push(o.ingestPath);
        return { ok: true, status: 200, data: { file_path: DOC_ID } };
      },
    });
    expect(res.ok ? "ok" : res.code).toBe("in_flight");
    expect(calls).toHaveLength(0);
    claims.clear();
  });
});

describe("the claim's budget is fixed at claim time", () => {
  const DOC_ID = "ai/general/A post.md";
  const save = (claim: ReturnType<SummarySaveClaims["claim"]>, ingest: SummaryIngest) =>
    saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: "A summary.",
      claim: claim!,
      knowledgeApiUrl: "http://127.0.0.1:1",
      ingest,
    });
  const quick: SummaryIngest = async () => ({ ok: true, status: 200, data: { file_path: DOC_ID } });

  test("a POST does not hand the claim a fresh budget", async () => {
    // 200 ms budget, a 150 ms POST right away: the key frees at ~200 ms, not
    // 200 ms after the POST ended (~350 ms).
    const claims = new SummarySaveClaims();
    const t0 = Date.now();
    const claim = claims.claim("article", DOC_ID, 200);
    const res = await save(claim, async () => {
      await Bun.sleep(150);
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    });
    expect(res.ok).toBe(true);
    expect(claims.holds(claim!)).toBe(true);
    await Bun.sleep(Math.max(0, 270 - (Date.now() - t0)));
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
  });

  test("repeated saves on one never-released claim do not keep it held", async () => {
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 60);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(40);
      await save(claim, quick);
    }
    // 160 ms in, past the 60 ms budget.
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
  });

  test("an unreleased claim frees after a save, and after a POST that threw", async () => {
    const claims = new SummarySaveClaims();
    const a = claims.claim("article", DOC_ID, 50);
    expect((await save(a, quick)).ok).toBe(true);
    expect(claims.isHeld("article", DOC_ID)).toBe(true);
    await Bun.sleep(90);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);

    const b = claims.claim("article", DOC_ID, 50);
    await expect(
      save(b, async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
    expect(claims.isHeld("article", DOC_ID)).toBe(true);
    await Bun.sleep(90);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
  });

  test("a second save on the same claim while the first POST is in flight is refused", async () => {
    // Refused rather than queued: the second body would overwrite the first
    // one's write, and while the first POST is in flight the claim is pinned.
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 1_000);
    const posted: string[] = [];
    const first = save(claim, async () => {
      posted.push("first");
      await Bun.sleep(60);
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    });
    await Bun.sleep(10);
    const second = await save(claim, async () => {
      posted.push("second");
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    });
    expect(second.ok ? "ok" : second.code).toBe("in_flight");
    if (!second.ok) expect(second.error).toContain("already in flight");
    expect((await first).ok).toBe(true);
    expect(posted).toEqual(["first"]);
    claims.clear();
  });

  test("a second pin after an unpin is not undone by a timer the first unpin armed", async () => {
    // pin → unpin arms the timer; a second unpin must not arm another, or the
    // orphan fires during the next pinned write and frees the key mid-POST.
    const claims = new SummarySaveClaims();
    const claim = claims.claim("article", DOC_ID, 50)!;
    claims.pinForWrite(claim);
    claims.unpinAfterWrite(claim);
    claims.unpinAfterWrite(claim);
    claims.pinForWrite(claim);
    await Bun.sleep(100);
    expect(claims.isHeld("article", DOC_ID)).toBe(true);
    claims.unpinAfterWrite(claim);
    expect(claims.isHeld("article", DOC_ID)).toBe(false);
    claims.clear();
  });
});

describe("what huginn's answer says about the write", () => {
  // A huginn stand-in, one path per answer shape. A real socket, so Bun's own
  // body handling (an empty body reads as `null` through `res.json()`) is what
  // the classification sees.
  const huginn = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.text();
      const p = new URL(req.url).pathname;
      if (p === "/500") return Response.json({ detail: "YouTube ingest failed: similarity boom" }, { status: 500 });
      if (p === "/503") return Response.json({ detail: "not configured" }, { status: 503 });
      if (p === "/422") return Response.json({ detail: "validation" }, { status: 422 });
      if (p === "/400") return Response.json({ detail: "Invalid category" }, { status: 400 });
      if (p === "/204") return new Response(null, { status: 204 });
      if (p === "/empty") return new Response("", { status: 200 });
      if (p === "/null") return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/html") return new Response("<html>ok</html>", { status: 200 });
      if (p === "/stall") {
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode('{"file_path":'));
            await Bun.sleep(300);
            c.enqueue(new TextEncoder().encode('"ai/general/A post.md"}'));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }
      return Response.json({ file_path: "ai/general/A post.md", similar: [] });
    },
  });
  afterAll(() => huginn.stop(true));
  const DOC_ID = "ai/general/A post.md";
  const saveVia = async (path: string) => {
    const claims = new SummarySaveClaims();
    const res = await saveSummaryBody({
      descriptor: requireSaveDescriptor("article"),
      stored: readStoredCapture(ARTICLE),
      docId: DOC_ID,
      summary: "A new summary.",
      claim: claims.claim("article", DOC_ID, 5_000)!,
      knowledgeApiUrl: `http://127.0.0.1:${huginn.port}`,
      ingest: (o) => postSummaryIngest({ ...o, ingestPath: path, timeoutMs: 100 }),
    });
    claims.clear();
    return res;
  };

  // huginn answers 500 AFTER the write when the similarity search or the
  // reindex enqueue throws (`_ingest_errors` wraps write → similar → enqueue).
  for (const path of ["/500", "/503"]) {
    test(`a ${path.slice(1)} is write_unknown`, async () => {
      const res = await saveVia(path);
      expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_unknown", 502]);
      if (!res.ok) expect(res.error).toContain("Reload");
    });
  }

  // Every 4xx huginn sends is raised before `write_categorized_markdown`.
  for (const path of ["/422", "/400"]) {
    test(`a ${path.slice(1)} is write_failed`, async () => {
      const res = await saveVia(path);
      expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_failed", 502]);
    });
  }

  for (const path of ["/204", "/empty", "/null", "/html"]) {
    test(`a 2xx answer with no usable file_path (${path.slice(1)}) is write_unknown`, async () => {
      const res = await saveVia(path);
      expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_unknown", 502]);
    });
  }

  test("a body read that times out is write_unknown and says the BODY read timed out", async () => {
    const res = await saveVia("/stall");
    expect(res.ok ? "ok" : [res.code, res.status]).toEqual(["write_unknown", 502]);
    if (!res.ok) {
      expect(res.error).toContain("timed out");
      expect(res.error).toContain("response body");
      expect(res.error).not.toContain("not JSON");
    }
  });

  test("a good answer still writes", async () => {
    const res = await saveVia("/ok");
    expect(res.ok ? "ok" : res.code).toBe("ok");
  });
});

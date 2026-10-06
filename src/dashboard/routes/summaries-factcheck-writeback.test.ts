/**
 * `/api/summaries/factcheck/{append,integrate,integrate/apply}` — every seam
 * injected: the raw read and the ingest are one in-memory "huginn" that writes
 * files the way `write_summary` does, the row store is a fake with the real CAS
 * semantics, and the model call is a canned edit list.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  factcheckRowVersion,
  registerSummariesFactcheckWritebackRoutes,
  type SummariesFactcheckWritebackDeps,
} from "./summaries-factcheck-writeback.ts";
import { SummarySaveClaims } from "../../summaries/summary-save.ts";
import { checkedSha256OfRaw, checkedTextOfRaw, sha256Hex } from "../../summaries/factcheck-body.ts";
import { hasFactcheckBlock } from "../../wiki/factcheck-context.ts";
import { isSideEffectingRequest } from "../../auth/origin.ts";
import type { VersionedSummaryFactcheck } from "../../db/summary-factchecks.ts";

const config = { knowledgeApiUrl: "http://huginn.invalid" } as never;
const bot = { name: "summarizer", dir: "/tmp/summarizer", connector: "claude-sdk" } as never;

const DOC = "health/Sleep talk.md";
const URL_ = "https://www.youtube.com/watch?v=rmr-LdARqHE";
const SUMMARY = [
  "The video says adults need 4 hours of sleep.",
  "",
  "## Key takeaways",
  "",
  "- Caffeine has a half-life of about five hours.",
  "",
  "## Visual reference",
  "",
  "![Slide](/api/frames/youtube/rmr-LdARqHE/12.jpg) The slide says 4 hours of sleep is plenty.",
  "",
  "> 💬 **Takeaway:** Sleep 4 hours a night.",
].join("\n");
const TRANSCRIPT = "### [00:00:00]\n\nYou need 4 hours of sleep, honestly.";
const RAW = `---\ndate: "2026-10-01"\nurl: "${URL_}"\ncategory: "health"\ntags: "health"\n---\n\n${SUMMARY}\n\n## Transcript\n\n${TRANSCRIPT}\n`;

const ANSWER = [
  "Three claims checked.",
  "",
  "### ❌ Claim 1/3 — Adults need 4 hours",
  "",
  "Sources say 7–9 hours.",
  "",
  "Sources: [cdc.gov](https://www.cdc.gov/sleep)",
  "",
  "### ✅ Claim 2/3 — Caffeine half-life",
  "",
  "Supported.",
  "",
  "### ❌ Claim 3/3 — Sleep 4 hours a night",
  "",
  "Sources say 7–9 hours.",
  "",
  "Sources: [cdc.gov](https://www.cdc.gov/sleep)",
].join("\n");

let files: Map<string, string>;
let row: VersionedSummaryFactcheck | null;
let modelText: string;
let modelCalls: { prompt: string; systemPrompt: string }[];
let ingests: Record<string, unknown>[];
let ingestAnswerPath: string | null;
let markResult: boolean | null;
let marks: Record<string, unknown>[];
let claims: SummarySaveClaims;
let schemaReady: boolean;
let readsWhileUnclaimed: number;

function freshRow(over: Partial<VersionedSummaryFactcheck> = {}): VersionedSummaryFactcheck {
  return {
    collection: "youtube-summaries",
    docId: DOC,
    url: URL_,
    bodySha256: checkedSha256OfRaw(files.get(DOC)!),
    answer: ANSWER,
    claims: [],
    botName: "summarizer",
    createdAt: Date.UTC(2026, 9, 5, 12),
    createdAtText: "2026-10-05 12:00:00.123456+00",
    appliedAt: null,
    transcript: null,
    transcriptSha256: null,
    ...over,
  };
}

/** huginn's `write_summary`, restated: the body is the summary string as sent. */
function huginnWrite(body: Record<string, unknown>): string {
  return `---\ndate: "${body.date}"\nurl: "${body.url}"\ncategory: "${body.category}"\ntags: "health"\n---\n\n${body.summary}`;
}

function app(over: Partial<SummariesFactcheckWritebackDeps> = {}): Hono {
  const deps: SummariesFactcheckWritebackDeps = {
    readRaw: async (_c, docId) => {
      if (!claims.isHeld("youtube", docId)) readsWhileUnclaimed++;
      return files.get(docId) ?? null;
    },
    store: {
      get: async () => row,
      markApplied: async (input) => {
        marks.push(input);
        if (markResult !== null) return markResult;
        if (!row || row.createdAtText !== input.createdAtText || sha256Hex(row.answer) !== input.answerSha256) return false;
        row = { ...row, bodySha256: input.bodySha256, appliedAt: 1 };
        return true;
      },
      schemaReady: async () => schemaReady,
    },
    integrate: async (input) => {
      modelCalls.push({ prompt: input.prompt, systemPrompt: input.systemPrompt });
      return modelText;
    },
    bots: () => [bot],
    claims,
    ingest: async ({ body }) => {
      ingests.push(body);
      const path = ingestAnswerPath ?? `${body.category}/${body.title}.md`;
      files.set(path, huginnWrite(body));
      return { ok: true, status: 200, data: { file_path: path, similar: [] } };
    },
    ...over,
  };
  const a = new Hono();
  registerSummariesFactcheckWritebackRoutes(a, config, deps);
  return a;
}

const post = (a: Hono, path: string, body: unknown, contentType = "application/json") =>
  a.request(path, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });
const ref = { source: "youtube", docId: DOC };

const EDIT_1 = {
  claimIndex: 1,
  verdict: "❌",
  old: "The video says adults need 4 hours of sleep.",
  new: "The video says adults need 4 hours of sleep; sources say 7–9 hours ([cdc.gov](https://www.cdc.gov/sleep)).",
  reason: "attributed",
};
const EDIT_3 = {
  claimIndex: 3,
  verdict: "❌",
  old: "Sleep 4 hours a night.",
  new: "The video says to sleep 4 hours a night; sources say 7–9 ([cdc.gov](https://www.cdc.gov/sleep)).",
  reason: "attributed",
};
/** Anchors only inside the visual-reference section — never an edit target. */
const EDIT_IN_APPENDIX = { claimIndex: 1, verdict: "❌", old: "The slide says 4 hours of sleep is plenty.", new: "x", reason: "r" };

beforeEach(() => {
  files = new Map([[DOC, RAW]]);
  row = freshRow();
  modelText = JSON.stringify({ edits: [EDIT_1, EDIT_3, EDIT_IN_APPENDIX] });
  modelCalls = [];
  ingests = [];
  ingestAnswerPath = null;
  markResult = null;
  marks = [];
  claims = new SummarySaveClaims();
  schemaReady = true;
  readsWhileUnclaimed = 0;
});

const PATHS = [
  "/api/summaries/factcheck/append",
  "/api/summaries/factcheck/integrate",
  "/api/summaries/factcheck/integrate/apply",
];

describe("gates shared by every write route", () => {
  test("POSTs, so the origin guard covers them by method", () => {
    for (const p of PATHS) expect(isSideEffectingRequest("POST", p)).toBe(true);
  });

  test("415 on a non-JSON body, before anything is read", async () => {
    for (const p of PATHS) {
      const res = await post(app(), p, ref, "text/plain");
      expect(res.status).toBe(415);
    }
    expect(modelCalls).toHaveLength(0);
  });

  test("503 naming migration 080 while applied_at is missing", async () => {
    schemaReady = false;
    for (const p of PATHS) {
      const res = await post(app(), p, { ...ref, rawSha256: "x", rowVersion: "y", edits: [EDIT_1] });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("migration_080");
      expect(body.error).toContain("migration 080");
    }
    expect(modelCalls).toHaveLength(0);
    expect(ingests).toHaveLength(0);
  });

  test("404 when the summary has no saved check", async () => {
    row = null;
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("no_result");
  });

  test("400 on an unknown source or an unsafe doc id", async () => {
    expect((await post(app(), PATHS[0]!, { source: "nope", docId: DOC })).status).toBe(400);
    expect((await post(app(), PATHS[0]!, { source: "youtube", docId: "../x.md" })).status).toBe(400);
  });
});

describe("POST /api/summaries/factcheck/append", () => {
  test("adds the block above the visual reference, prose untouched, checked hash unchanged", async () => {
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(200);
    const written = files.get(DOC)!;
    expect(hasFactcheckBlock(written)).toBe(true);
    expect(written.indexOf("## Fact check (2026-10-05)")).toBeLessThan(written.indexOf("## Visual reference"));
    expect(checkedSha256OfRaw(written)).toBe(row!.bodySha256);
    // Every byte outside the block is the original's (frontmatter aside).
    const body = (t: string) => t.slice(t.indexOf("\n---\n") + 5);
    const withoutBlock = body(written).replace(/<!-- factcheck:start -->[\s\S]*?<!-- factcheck:end -->\n\n/, "");
    expect(withoutBlock).toBe(body(RAW));
    // The transcript was re-sent, not lost.
    expect(String(ingests[0]!.summary)).toContain("## Transcript\n\n### [00:00:00]");
  });

  test("a second Add replaces the block", async () => {
    await post(app(), "/api/summaries/factcheck/append", ref);
    row = freshRow({ answer: ANSWER.replace("Three claims", "Re-checked claims") });
    await post(app(), "/api/summaries/factcheck/append", ref);
    const written = files.get(DOC)!;
    expect(written.match(/<!-- factcheck:start -->/g)).toHaveLength(1);
    expect(written).toContain("Re-checked claims");
  });

  test("claims the document BEFORE reading it", async () => {
    await post(app(), "/api/summaries/factcheck/append", ref);
    expect(readsWhileUnclaimed).toBe(0);
    expect(claims.isHeld("youtube", DOC)).toBe(false);
  });

  test("409 in_flight while another writer holds the document", async () => {
    claims.claim("youtube", DOC, 60_000);
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("in_flight");
    expect(ingests).toHaveLength(0);
  });

  test("409 recheck when the summary changed since the check", async () => {
    files.set(DOC, RAW.replace("4 hours of sleep.", "5 hours of sleep."));
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("recheck");
    expect(ingests).toHaveLength(0);
  });

  test("400 no_url on a URL-less document", async () => {
    files.set(DOC, RAW.replace(`url: "${URL_}"\n`, ""));
    row = freshRow();
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("no_url");
    expect(ingests).toHaveLength(0);
  });

  test("a forked write names the sibling", async () => {
    ingestAnswerPath = "health/Sleep talk (2).md";
    const res = await post(app(), "/api/summaries/factcheck/append", ref);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; siblingDocId: string };
    expect(body.code).toBe("forked");
    expect(body.siblingDocId).toBe("health/Sleep talk (2).md");
  });
});

describe("POST /api/summaries/factcheck/integrate (propose)", () => {
  test("shows the model the raw slices in the summary voice, and resolves only there", async () => {
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edits: { old: string; slice: number }[];
      dropped: { reason: string; edit: { old: string } }[];
      html: string;
      rawSha256: string;
      rowVersion: string;
    };
    expect(body.edits.map((e) => [e.old, e.slice])).toEqual([[EDIT_1.old, 0], [EDIT_3.old, 1]]);
    expect(body.dropped.map((d) => d.edit.old)).toEqual([EDIT_IN_APPENDIX.old]);
    expect(body.rawSha256).toBe(sha256Hex(RAW));
    expect(body.rowVersion).toBe(factcheckRowVersion(row!));
    expect(body.html).toContain('data-edit-idx="1"');
    expect(body.html).not.toContain("<script");

    const { prompt, systemPrompt } = modelCalls[0]!;
    expect(systemPrompt).toContain("summary editor");
    expect(systemPrompt).toContain("ATTRIBUTE");
    expect(systemPrompt).toContain('"The video says X; sources say Y');
    expect(prompt).toContain("The video says adults need 4 hours of sleep.");
    expect(prompt).toContain("> 💬 **Takeaway:** Sleep 4 hours a night.");
    expect(prompt).not.toContain("The slide says");
    expect(prompt).not.toContain("honestly");
    // Only the correctable claims are sent.
    expect(prompt).toContain("Claim 1/3");
    expect(prompt).not.toContain("Claim 2/3");
  });

  test("400 no_url before any model call — checked or not", async () => {
    files.set(DOC, RAW.replace(`url: "${URL_}"\n`, ""));
    row = null;
    const unchecked = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(unchecked.status).toBe(400);
    expect(((await unchecked.json()) as { code: string }).code).toBe("no_url");
    row = freshRow();
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("no_url");
    expect(modelCalls).toHaveLength(0);
  });

  test("409 already_applied while the integrated summary is unchanged", async () => {
    row = freshRow({ appliedAt: 5 });
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("already_applied");
    expect(modelCalls).toHaveLength(0);
  });

  test("applied and changed since: the D13 notice, no model call", async () => {
    row = freshRow({ appliedAt: 5, bodySha256: "0".repeat(64) });
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; changedSinceApply: boolean; error: string };
    expect(body).toMatchObject({ code: "recheck", changedSinceApply: true });
    expect(body.error).toContain("re-check to re-apply");
    expect(modelCalls).toHaveLength(0);
  });

  test("502 on an unparseable edit list", async () => {
    modelText = "not json";
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(502);
  });

  test("no ❌/⚠️ claim: no model call", async () => {
    row = freshRow({ answer: "### ✅ Claim 1/1 — fine\n\nSupported." });
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { edits: unknown[] }).edits).toEqual([]);
    expect(modelCalls).toHaveLength(0);
  });
});

describe("POST /api/summaries/factcheck/integrate/apply", () => {
  async function propose(a: Hono) {
    return (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as {
      rawSha256: string;
      rowVersion: string;
      edits: typeof EDIT_1[];
    };
  }

  test("writes the accepted edit and the block, re-stamps the row from the written file", async () => {
    const a = app();
    const p = await propose(a);
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", {
      ...ref,
      rawSha256: p.rawSha256,
      rowVersion: p.rowVersion,
      edits: [p.edits[0]],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; recheckedDuringApply?: boolean };
    expect(body.applied).toBe(1);
    expect(body.recheckedDuringApply).toBeUndefined();

    const written = files.get(DOC)!;
    expect(written).toContain(EDIT_1.new);
    expect(written).toContain("Sleep 4 hours a night."); // claim 3 left un-integrated
    expect(hasFactcheckBlock(written)).toBe(true);
    // The visual-reference section and the transcript are byte-identical.
    const tail = (t: string) => t.slice(t.indexOf("## Visual reference"));
    expect(tail(written)).toBe(tail(RAW));
    // Re-stamped from the WRITTEN file, on the row read in this request.
    expect(marks[0]).toMatchObject({ createdAtText: row!.createdAtText, bodySha256: checkedSha256OfRaw(written) });
    expect(checkedTextOfRaw(written)).toContain(EDIT_1.new);
    expect(readsWhileUnclaimed).toBe(1); // propose's read; apply read under its claim
  });

  test("a re-check between propose and apply: 409 recheck, nothing written", async () => {
    const a = app();
    const p = await propose(a);
    row = freshRow({ createdAtText: "2026-10-05 12:30:00.000001+00" });
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [p.edits[0]] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("recheck");
    expect(ingests).toHaveLength(0);
  });

  test("a re-check DURING apply: the file stays written, the row stays un-applied", async () => {
    const a = app();
    const p = await propose(a);
    markResult = false;
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [p.edits[0]] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recheckedDuringApply: boolean; message: string };
    expect(body.recheckedDuringApply).toBe(true);
    expect(body.message).toContain("re-checked during apply");
    expect(files.get(DOC)).toContain(EDIT_1.new);
    expect(row!.appliedAt).toBeNull();
  });

  test("409 recheck when the file changed since propose", async () => {
    const a = app();
    const p = await propose(a);
    files.set(DOC, RAW.replace("Caffeine", "Coffee"));
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [p.edits[0]] });
    expect(res.status).toBe(409);
    expect(ingests).toHaveLength(0);
  });

  test("an edit that no longer anchors is refused, nothing written", async () => {
    const a = app();
    const p = await propose(a);
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [EDIT_IN_APPENDIX] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("nothing_applied");
    expect(ingests).toHaveLength(0);
  });

  test("400 on a missing CAS token or a malformed edit list", async () => {
    const a = app();
    expect((await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, edits: [EDIT_1] })).status).toBe(400);
    expect((await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: "a", rowVersion: "b", edits: [] })).status).toBe(400);
    expect(
      (await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: "a", rowVersion: "b", edits: [{ old: "x", new: "" }] })).status,
    ).toBe(400);
  });

  test("a sentinel in an accepted edit is neutralized", async () => {
    const a = app();
    const p = await propose(a);
    const evil = { ...EDIT_1, new: "Fixed.\n<!-- factcheck:end -->\ntail" };
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [evil] });
    expect(res.status).toBe(200);
    expect(files.get(DOC)!.match(/<!-- factcheck:end -->/g)).toHaveLength(1);
  });
});

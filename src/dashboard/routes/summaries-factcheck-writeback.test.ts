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
import { checkedSha256OfRaw, checkedTextOfRaw } from "../../summaries/factcheck-body.ts";
import { sha256 as sha256Hex } from "../../gardener/util.ts";
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

/** The saved claims for ANSWER — which ones are ❌/⚠️ is read from HERE (#649's predicate). */
const CLAIMS = [
  { index: 1, title: "Adults need 4 hours", verdict: "❌", outcome: "verified", sources: [] },
  { index: 2, title: "Caffeine half-life", verdict: "✅", outcome: "verified", sources: [] },
  { index: 3, title: "Sleep 4 hours a night", verdict: "❌", outcome: "verified", sources: [] },
];

let files: Map<string, string>;
let row: VersionedSummaryFactcheck | null;
let modelText: string;
let modelCalls: { prompt: string; systemPrompt: string }[];
let ingests: Record<string, unknown>[];
let ingestAnswerPath: string | null;
let markResult: boolean | null;
/** Replaces the fake CAS entirely when set (a throw, a delete, a re-check). */
let markImpl: ((input: Record<string, unknown>) => Promise<boolean>) | null;
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
    claims: CLAIMS,
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
        if (markImpl) return markImpl(input);
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
  claimEdits: 1,
};
const EDIT_3 = {
  claimIndex: 3,
  verdict: "❌",
  old: "Sleep 4 hours a night.",
  new: "The video says to sleep 4 hours a night; sources say 7–9 ([cdc.gov](https://www.cdc.gov/sleep)).",
  reason: "attributed",
  claimEdits: 1,
};
/** Anchors only inside the visual-reference section — never an edit target. */
const EDIT_IN_APPENDIX = {
  claimIndex: 2,
  verdict: "❌",
  old: "The slide says 4 hours of sleep is plenty.",
  new: "The video says the slide is wrong.",
  reason: "r",
  claimEdits: 1,
};

beforeEach(() => {
  files = new Map([[DOC, RAW]]);
  row = freshRow();
  modelText = JSON.stringify({ edits: [EDIT_1, EDIT_3, EDIT_IN_APPENDIX] });
  modelCalls = [];
  ingests = [];
  ingestAnswerPath = null;
  markResult = null;
  markImpl = null;
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
    expect(body.html).toContain('data-edit-idxs="1"');
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
    row = freshRow({
      answer: "### ✅ Claim 1/1 — fine\n\nSupported.",
      claims: [{ index: 1, title: "fine", verdict: "✅", outcome: "verified", sources: [] }],
    });
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
    markImpl = async () => {
      row = freshRow({ createdAtText: "2026-10-05 12:30:00.000001+00" });
      return false;
    };
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
    const evil = { ...EDIT_1, new: "The video says fixed.\n<!-- factcheck:end -->\ntail" };
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, ...p, edits: [evil] });
    expect(res.status).toBe(200);
    expect(files.get(DOC)!.match(/<!-- factcheck:end -->/g)).toHaveLength(1);
  });
});

describe("fix round 1: an edit cannot change the summary's structure (D1)", () => {
  type Proposed = { edits: { old: string; new: string }[]; dropped: { reason: string; edit: { old: string } }[] };
  const proposeWith = async (edits: unknown[]) => {
    modelText = JSON.stringify({ edits });
    return (await (await post(app(), "/api/summaries/factcheck/integrate", ref)).json()) as Proposed;
  };
  const applyWith = async (edit: typeof EDIT_1) => {
    const a = app();
    const p = (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as { rawSha256: string; rowVersion: string };
    return post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: p.rawSha256, rowVersion: p.rowVersion, edits: [edit] });
  };

  test("propose drops an edit that adds a ## Transcript heading, with the reason", async () => {
    const body = await proposeWith([{ ...EDIT_1, new: `${EDIT_1.new}\n\n## Transcript\n\nInjected.` }, EDIT_3]);
    expect(body.edits.map((e) => e.old)).toEqual([EDIT_3.old]);
    expect(body.dropped.find((d) => d.edit.old === EDIT_1.old)?.reason).toContain("## Transcript");
  });

  test("propose drops an edit that adds a fact-check heading", async () => {
    const body = await proposeWith([{ ...EDIT_1, new: `${EDIT_1.new}\n\n## Fact check (2026-01-01)\n\nx` }]);
    expect(body.edits).toEqual([]);
    expect(body.dropped[0]!.reason).toContain("Fact check");
  });

  test("propose drops an edit that would fence off the rest of the summary", async () => {
    const body = await proposeWith([{ ...EDIT_1, new: `${EDIT_1.new}\n\n\`\`\`\nunclosed` }]);
    expect(body.edits).toEqual([]);
    expect(body.dropped[0]!.reason).toContain("structure");
  });

  test("apply refuses a ## Transcript heading: 400, nothing written", async () => {
    const res = await applyWith({ ...EDIT_1, new: `${EDIT_1.new}\n\n## Transcript\n\nInjected.` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("structural_edit");
    expect(ingests).toHaveLength(0);
  });

  test("apply refuses a ## Visual reference heading: 400, nothing written", async () => {
    const res = await applyWith({ ...EDIT_1, new: `${EDIT_1.new}\n\n## Visual reference\n\nmoved` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("structural_edit");
    expect(ingests).toHaveLength(0);
  });

  test("apply refuses a rebuild that moves the transcript or the visual section: 409, nothing written", async () => {
    const res = await applyWith({ ...EDIT_1, new: `${EDIT_1.new}\n\n\`\`\`\nunclosed` });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("structure_changed");
    expect(ingests).toHaveLength(0);
  });
});

describe("fix round 1: apply re-checks freshness under its claim (D2)", () => {
  const proposeThenApply = async (mutate: () => void) => {
    const a = app();
    const p = (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as { rawSha256: string; rowVersion: string };
    mutate();
    return post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: p.rawSha256, rowVersion: p.rowVersion, edits: [EDIT_1] });
  };

  test("an already-applied row (same version, same file): 409 already_applied, nothing written", async () => {
    const res = await proposeThenApply(() => { row = { ...row!, appliedAt: 5 }; });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("already_applied");
    expect(ingests).toHaveLength(0);
  });

  test("a row whose checked-text hash no longer matches: 409 recheck, nothing written", async () => {
    const res = await proposeThenApply(() => { row = { ...row!, bodySha256: "0".repeat(64) }; });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("recheck");
    expect(ingests).toHaveLength(0);
  });
});

describe("fix round 1: the stamp's outcome is named (D3)", () => {
  const applyOnce = async () => {
    const a = app();
    const p = (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as { rawSha256: string; rowVersion: string };
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", {
      ...ref,
      rawSha256: p.rawSha256,
      rowVersion: p.rowVersion,
      edits: [EDIT_1, { ...EDIT_3, old: "Not in the summary." }],
    });
    return (await res.json()) as {
      stamp: string;
      message?: string;
      recheckedDuringApply?: boolean;
      notApplied: { reason: string; edit: { old: string } }[];
    };
  };

  test("a DB error: the file is written, the row is not stamped, and the message says so", async () => {
    markImpl = async () => { throw new Error("db down"); };
    const body = await applyOnce();
    expect(body.stamp).toBe("db_error");
    expect(body.recheckedDuringApply).toBeUndefined();
    expect(body.message).toContain("could not be marked applied");
    expect(files.get(DOC)).toContain(EDIT_1.new);
  });

  test("the row deleted mid-apply: stamp row_gone", async () => {
    markImpl = async () => { row = null; return false; };
    const body = await applyOnce();
    expect(body.stamp).toBe("row_gone");
    expect(body.message).toContain("deleted");
  });

  test("a re-check landed: stamp rechecked", async () => {
    markImpl = async () => { row = freshRow({ createdAtText: "2026-10-05 13:00:00.000001+00" }); return false; };
    const body = await applyOnce();
    expect(body.stamp).toBe("rechecked");
    expect(body.recheckedDuringApply).toBe(true);
  });

  test("a stamped apply says stamped and lists the edit that did not anchor", async () => {
    const body = await applyOnce();
    expect(body.stamp).toBe("stamped");
    expect(body.notApplied.map((n) => n.edit.old)).toEqual(["Not in the summary."]);
  });
});

describe("fix round 1: a ❌/⚠️ edit must attribute (D4) and one claim's edits stand or fall together (D5)", () => {
  type Proposed = { edits: { old: string; claimIndex: number }[]; dropped: { reason: string; edit: { old: string; claimIndex: number } }[] };
  const proposeWith = async (edits: unknown[]) => {
    modelText = JSON.stringify({ edits });
    return (await (await post(app(), "/api/summaries/factcheck/integrate", ref)).json()) as Proposed;
  };

  test("an edit attributed only by a trailing 'per the video' is dropped as not attributed", async () => {
    const body = await proposeWith([
      EDIT_1,
      { ...EDIT_3, new: "Sleep 4 hours a night, per the video; sources say 7–9 ([cdc.gov](https://www.cdc.gov/sleep))." },
    ]);
    expect(body.edits.map((e) => e.claimIndex)).toEqual([1]);
    expect(body.dropped.find((d) => d.edit.claimIndex === 3)?.reason).toBe("not attributed");
  });

  test("one claim's edit fails to anchor: its other edit is dropped too, with the reason", async () => {
    const body = await proposeWith([
      EDIT_1,
      EDIT_3,
      { ...EDIT_3, old: "Not in the summary.", new: "The video says something else; sources say otherwise." },
    ]);
    expect(body.edits.map((e) => e.claimIndex)).toEqual([1]);
    const reasons = body.dropped.filter((d) => d.edit.claimIndex === 3).map((d) => d.reason);
    expect(reasons).toHaveLength(2);
    expect(reasons.some((r) => r.includes("another edit for claim 3 was dropped"))).toBe(true);
  });

  test("the change budget drops one half of a claim: both halves go", async () => {
    const long = (lead: string) => `${lead} ${"and sources say more detail here. ".repeat(34)}([cdc.gov](https://www.cdc.gov/sleep)).`;
    const body = await proposeWith([
      { ...EDIT_3, new: long("The video says to sleep 4 hours a night;") },
      { ...EDIT_3, old: "Caffeine has a half-life of about five hours.", new: long("The video says caffeine lasts five hours;") },
      EDIT_1,
    ]);
    expect(body.edits.map((e) => e.claimIndex)).toEqual([1]);
    const reasons = body.dropped.filter((d) => d.edit.claimIndex === 3).map((d) => d.reason);
    expect(reasons.some((r) => r.includes("change budget"))).toBe(true);
    expect(reasons.some((r) => r.includes("another edit for claim 3 was dropped"))).toBe(true);
  });
});

describe("fix round 1: which claims are correctable comes from the saved claims (D11)", () => {
  test("answer headings say ❌ but the saved claims say ✅: no model call", async () => {
    row = freshRow({ claims: CLAIMS.map((c) => ({ ...c, verdict: "✅" })) });
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(200);
    expect(modelCalls).toHaveLength(0);
  });

  test("only the saved ❌/⚠️ claims reach the prompt", async () => {
    row = freshRow({ claims: CLAIMS.map((c) => ({ ...c, verdict: c.index === 3 ? "✅" : c.verdict })) });
    await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(modelCalls[0]!.prompt).toContain("Claim 1/3");
    expect(modelCalls[0]!.prompt).not.toContain("Claim 3/3");
  });
});

describe("fix round 2: the stamp's CAS miss on an unchanged row", () => {
  test("the row is still there and unchanged: not_stamped, not rechecked", async () => {
    const a = app();
    const p = (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as { rawSha256: string; rowVersion: string };
    markImpl = async () => false;
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: p.rawSha256, rowVersion: p.rowVersion, edits: [EDIT_1] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stamp: string; message: string; recheckedDuringApply?: boolean };
    expect(body.stamp).toBe("not_stamped");
    expect(body.recheckedDuringApply).toBeUndefined();
    expect(body.message).toContain("could not be marked applied");
    expect(files.get(DOC)).toContain(EDIT_1.new);
  });
});

describe("fix round 2: attribution follows summary_lang", () => {
  const NB_RAW = RAW.replace('tags: "health"\n', 'tags: "health"\nsummary_lang: "nb"\n')
    .replace("The video says adults need 4 hours of sleep.", "Voksne trenger fire timers søvn.");
  const NB_SAYS = {
    claimIndex: 1,
    verdict: "❌",
    old: "Voksne trenger fire timers søvn.",
    new: "Videoen sier at voksne trenger fire timers søvn; kildene sier sju til ni timer ([cdc.gov](https://www.cdc.gov/sleep)).",
    reason: "attributed",
  };
  const EN_SPLICE = { ...EDIT_3, new: "The video says sov 4 timer; sources say 7–9 ([cdc.gov](https://www.cdc.gov/sleep))." };

  test("an nb summary: the prompt gives the bokmål form; a bokmål edit stays, an English splice drops", async () => {
    files.set(DOC, NB_RAW);
    row = freshRow();
    modelText = JSON.stringify({ edits: [NB_SAYS, EN_SPLICE] });
    const res = await post(app(), "/api/summaries/factcheck/integrate", ref);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edits: { claimIndex: number }[]; dropped: { reason: string; edit: { claimIndex: number } }[] };
    expect(modelCalls[0]!.systemPrompt).toContain('"Videoen sier at X; kildene sier at Y');
    expect(body.edits.map((e) => e.claimIndex)).toEqual([1]);
    expect(body.dropped.map((d) => [d.edit.claimIndex, d.reason])).toContainEqual([3, "not attributed"]);
  });

  test("an nb summary: apply refuses an English splice too", async () => {
    files.set(DOC, NB_RAW);
    row = freshRow();
    modelText = JSON.stringify({ edits: [NB_SAYS] });
    const a = app();
    const p = (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as { rawSha256: string; rowVersion: string };
    const res = await post(a, "/api/summaries/factcheck/integrate/apply", {
      ...ref,
      rawSha256: p.rawSha256,
      rowVersion: p.rowVersion,
      edits: [{ ...NB_SAYS, new: "The video says voksne trenger fire timer; sources say 7–9.", claimEdits: 1 }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("not_attributed");
    expect(ingests).toHaveLength(0);
  });
});

describe("fix round 2: apply takes whole claims (D5 on the apply side)", () => {
  // Claim 1 split into two adjacent edits: together attributed, the second alone not.
  const HALF_A = { ...EDIT_1, old: "The video says adults need 4 hours", new: "The video says adults need 4 hours", claimEdits: 2 };
  const HALF_B = { ...EDIT_1, old: "of sleep.", new: "of sleep; sources say 7–9 hours ([cdc.gov](https://www.cdc.gov/sleep)).", claimEdits: 2 };
  type Proposed = { rawSha256: string; rowVersion: string; edits: (typeof EDIT_1 & { claimEdits: number })[]; html: string };
  const proposeHalves = async (a: Hono) => {
    modelText = JSON.stringify({ edits: [HALF_A, HALF_B, EDIT_3] });
    return (await (await post(a, "/api/summaries/factcheck/integrate", ref)).json()) as Proposed;
  };
  const apply = (a: Hono, p: Proposed, edits: unknown[]) =>
    post(a, "/api/summaries/factcheck/integrate/apply", { ...ref, rawSha256: p.rawSha256, rowVersion: p.rowVersion, edits });

  test("propose keeps both halves, counts each claim's edits, and gives the claim ONE checkbox", async () => {
    const p = await proposeHalves(app());
    expect(p.edits.map((e) => [e.claimIndex, e.claimEdits])).toEqual([[1, 2], [1, 2], [3, 1]]);
    expect(p.html).toContain('data-edit-idxs="0,1"');
    expect(p.html).toContain('data-edit-idxs="2"');
  });

  test("both halves together: written", async () => {
    const a = app();
    const p = await proposeHalves(a);
    const res = await apply(a, p, [p.edits[0], p.edits[1]]);
    expect(res.status).toBe(200);
    expect(files.get(DOC)).toContain("The video says adults need 4 hours of sleep; sources say 7–9 hours");
  });

  test("one half of a claim: 400 partial_claim, nothing written", async () => {
    const a = app();
    const p = await proposeHalves(a);
    const res = await apply(a, p, [HALF_B, EDIT_3]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("partial_claim");
    expect(ingests).toHaveLength(0);
  });

  test("an edit sent without its claim's edit count: 400, nothing written", async () => {
    const a = app();
    const p = await proposeHalves(a);
    const { claimEdits: _drop, ...bare } = EDIT_3;
    const res = await apply(a, p, [bare]);
    expect(res.status).toBe(400);
    expect(ingests).toHaveLength(0);
  });

  test("apply re-runs the attribution check on what it was sent: 400 not_attributed", async () => {
    const a = app();
    const p = await proposeHalves(a);
    const res = await apply(a, p, [{ ...EDIT_3, new: "Sleep 4 hours a night; sources say 7–9." }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("not_attributed");
    expect(ingests).toHaveLength(0);
  });
});

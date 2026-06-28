import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  upsertCandidate,
  listCandidates,
  getCandidateById,
  getCandidateBySourceUrl,
  setCandidateStatus,
} from "./summary-candidates.ts";

setupTestDb();

const base = {
  source: "anthropic",
  url: "https://platform.claude.com/docs/en/agents/tool-use.md",
  title: "Tool use",
  candidateSrc: "Docs (llms.txt)",
  score: 0.72,
  why: "relevant to agent work",
  botName: "jarvis",
};

describe("summary-candidates", () => {
  test("upsertCandidate inserts a new candidate with status 'new'", async () => {
    await upsertCandidate(base);
    const rows = await listCandidates({ source: "anthropic" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(base.url);
    expect(rows[0]!.status).toBe("new");
    expect(rows[0]!.score).toBeCloseTo(0.72, 5);
    expect(rows[0]!.why).toBe("relevant to agent work");
    expect(rows[0]!.botName).toBe("jarvis");
  });

  test("upsert dedups by (source,url) and keeps the higher score", async () => {
    await upsertCandidate({ ...base, score: 0.6 });
    await upsertCandidate({ ...base, score: 0.9, why: "now a headliner" });
    const rows = await listCandidates({ source: "anthropic" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBeCloseTo(0.9, 5);
    expect(rows[0]!.why).toBe("now a headliner");
  });

  test("upsert keeps the existing higher score AND its paired why/title", async () => {
    await upsertCandidate({ ...base, score: 0.9, why: "headliner", title: "Big" });
    await upsertCandidate({ ...base, score: 0.5, why: "minor churn", title: "Small" });
    const [row] = await listCandidates({ source: "anthropic" });
    expect(row!.score).toBeCloseTo(0.9, 5);
    // why/title must stay paired with the winning (higher) score, not adopt the lower capture's.
    expect(row!.why).toBe("headliner");
    expect(row!.title).toBe("Big");
  });

  test("upsert does NOT resurrect a dismissed candidate", async () => {
    await upsertCandidate(base);
    const [row] = await listCandidates({ source: "anthropic" });
    await setCandidateStatus(row!.id, "dismissed");
    // A later capture of the same url must be a no-op (stays dismissed).
    await upsertCandidate({ ...base, score: 0.95 });
    const after = await getCandidateById(row!.id);
    expect(after!.status).toBe("dismissed");
    expect(after!.score).toBeCloseTo(0.72, 5);
  });

  test("listCandidates filters by status and orders by score desc", async () => {
    await upsertCandidate({ ...base, url: "https://a/1", score: 0.55 });
    await upsertCandidate({ ...base, url: "https://a/2", score: 0.95 });
    await upsertCandidate({ ...base, url: "https://a/3", score: 0.75 });
    const newOnes = await listCandidates({ status: "new" });
    expect(newOnes.map((c) => c.score)).toEqual([0.95, 0.75, 0.55]);

    const second = newOnes[1]!;
    await setCandidateStatus(second.id, "summarized", "anthropic-summaries/ai/claude/Doc.md");
    expect(await listCandidates({ status: "new" })).toHaveLength(2);

    const done = await listCandidates({ status: "summarized" });
    expect(done).toHaveLength(1);
    expect(done[0]!.docId).toBe("anthropic-summaries/ai/claude/Doc.md");
  });

  test("listCandidates accepts a status array and filters by botName", async () => {
    await upsertCandidate({ ...base, url: "https://a/j", botName: "jarvis", score: 0.6 });
    await upsertCandidate({ ...base, url: "https://a/m", botName: "melosys", score: 0.6 });
    expect(await listCandidates({ botName: "jarvis" })).toHaveLength(1);
    expect(await listCandidates({ status: ["new", "summarizing"] })).toHaveLength(2);
  });

  test("getCandidateBySourceUrl resolves a row by its (source,url) identity, with current status", async () => {
    expect(await getCandidateBySourceUrl("anthropic", base.url)).toBeNull();
    await upsertCandidate(base);
    const row = await getCandidateBySourceUrl("anthropic", base.url);
    expect(row).not.toBeNull();
    expect(row!.url).toBe(base.url);
    expect(row!.status).toBe("new");
    // Reflects the live status (the auto-promote dedup gate reads this).
    await setCandidateStatus(row!.id, "summarizing");
    expect((await getCandidateBySourceUrl("anthropic", base.url))!.status).toBe("summarizing");
    // Scoped by source — a different source with the same url path doesn't collide.
    expect(await getCandidateBySourceUrl("youtube", base.url)).toBeNull();
  });

  test("setCandidateStatus with null docId leaves an existing doc_id untouched", async () => {
    await upsertCandidate(base);
    const [row] = await listCandidates({ source: "anthropic" });
    await setCandidateStatus(row!.id, "summarized", "doc-1");
    await setCandidateStatus(row!.id, "error"); // no docId passed
    const after = await getCandidateById(row!.id);
    expect(after!.status).toBe("error");
    expect(after!.docId).toBe("doc-1");
  });
});

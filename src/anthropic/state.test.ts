import { test, expect } from "bun:test";
import {
  createJob,
  getJob,
  getRecentJobs,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  setDocId,
  completeJob,
  failJob,
  subscribe,
} from "./state.ts";

// Each test creates fresh jobs via createJob (unique UUIDs), so no global reset needed.

test("createJob returns a UUID and stores the job", () => {
  const id = createJob("cand-1", "feat: add subscriptions", "https://github.com/x/y/commit/abc");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const job = getJob(id);
  expect(job).toBeDefined();
  expect(job!.candidateId).toBe("cand-1");
  expect(job!.title).toBe("feat: add subscriptions");
  expect(job!.url).toBe("https://github.com/x/y/commit/abc");
  expect(job!.status).toBe("pending");
  expect(job!.text).toBe("");
});

test("getJob returns undefined for nonexistent job", () => {
  expect(getJob("nonexistent-id")).toBeUndefined();
});

test("getRecentJobs returns jobs in reverse creation order", () => {
  const id1 = createJob("c1", "First", "url1");
  const job1 = getJob(id1)!;
  job1.createdAt -= 1000; // nudge so sort is deterministic
  const id2 = createJob("c2", "Second", "url2");

  const recent = getRecentJobs(10);
  const ids = recent.map((j) => j.id);
  expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
});

test("getRecentJobs respects limit", () => {
  createJob("lim1", "A", "u");
  createJob("lim2", "B", "u");
  createJob("lim3", "C", "u");
  expect(getRecentJobs(2).length).toBeLessThanOrEqual(2);
});

test("updateStatus changes job status and publishes event", () => {
  const id = createJob("st1", "Status Test", "u");
  const events: string[] = [];
  subscribe(id, (e) => { if (e.type === "status") events.push(e.status); });

  updateStatus(id, "summarizing");
  expect(getJob(id)!.status).toBe("summarizing");
  expect(events).toContain("summarizing");
});

test("appendText accumulates text and publishes deltas", () => {
  const id = createJob("tx1", "Text Test", "u");
  const deltas: string[] = [];
  subscribe(id, (e) => { if (e.type === "text_delta") deltas.push(e.text); });

  appendText(id, "Hello ");
  appendText(id, "world");

  expect(getJob(id)!.text).toBe("Hello world");
  expect(deltas).toEqual(["Hello ", "world"]);
});

test("setCategory updates category and publishes event", () => {
  const id = createJob("cat1", "Cat Test", "u");
  let received: string | undefined;
  subscribe(id, (e) => { if (e.type === "category") received = e.category; });

  setCategory(id, "ai/claude-code");
  expect(getJob(id)!.category).toBe("ai/claude-code");
  expect(received).toBe("ai/claude-code");
});

test("setSimilar updates similar articles and publishes event", () => {
  const id = createJob("sim1", "Similar Test", "u");
  const articles = [{ title: "Doc 1", url: "https://example.com" }];
  let received: typeof articles | undefined;
  subscribe(id, (e) => { if (e.type === "similar") received = e.articles; });

  setSimilar(id, articles);
  expect(getJob(id)!.similar).toEqual(articles);
  expect(received).toEqual(articles);
});

test("setDocId stores the resulting doc id (no event)", () => {
  const id = createJob("doc1", "Doc Test", "u");
  setDocId(id, "github.com-x-y-commit-abc-hash.md");
  expect(getJob(id)!.docId).toBe("github.com-x-y-commit-abc-hash.md");
});

test("completeJob sets final state and publishes complete event", () => {
  const id = createJob("cmp1", "Complete Test", "u");
  let completed = false;
  subscribe(id, (e) => { if (e.type === "complete") completed = true; });

  completeJob(id, "Summary text", "ai/general");

  const job = getJob(id)!;
  expect(job.status).toBe("complete");
  expect(job.summary).toBe("Summary text");
  expect(job.category).toBe("ai/general");
  expect(completed).toBe(true);
});

test("failJob sets error state and publishes error event", () => {
  const id = createJob("fail1", "Fail Test", "u");
  let errorMsg: string | undefined;
  subscribe(id, (e) => { if (e.type === "error") errorMsg = e.message; });

  failJob(id, "Something went wrong");

  const job = getJob(id)!;
  expect(job.status).toBe("error");
  expect(job.error).toBe("Something went wrong");
  expect(errorMsg).toBe("Something went wrong");
});

test("subscribe returns unsubscribe function that stops events", () => {
  const id = createJob("unsub1", "Unsub Test", "u");
  const events: string[] = [];
  const unsub = subscribe(id, (e) => { if (e.type === "text_delta") events.push(e.text); });

  appendText(id, "before");
  unsub();
  appendText(id, "after");

  expect(events).toEqual(["before"]);
  expect(getJob(id)!.text).toBe("beforeafter");
});

test("subscriber errors do not affect other subscribers", () => {
  const id = createJob("errsub1", "Error Sub Test", "u");
  const events: string[] = [];

  subscribe(id, () => { throw new Error("boom"); });
  subscribe(id, (e) => { if (e.type === "text_delta") events.push(e.text); });

  appendText(id, "hello");
  expect(events).toEqual(["hello"]);
});

test("operations on nonexistent job are no-ops", () => {
  updateStatus("ghost", "complete");
  appendText("ghost", "text");
  setCategory("ghost", "ai/general");
  setSimilar("ghost", []);
  setDocId("ghost", "doc");
  completeJob("ghost", "s", "c");
  failJob("ghost", "err");
});

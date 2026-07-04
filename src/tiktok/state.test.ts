import { test, expect } from "bun:test";
import {
  createJob,
  getJob,
  getRecentJobs,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
  subscribe,
} from "./state.ts";

// Each test creates fresh jobs via createJob (unique UUIDs), so no global reset needed.

test("createJob returns a UUID and stores the job", () => {
  const id = createJob("7523456789", "Test TikTok", "https://www.tiktok.com/@user/video/7523456789");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const job = getJob(id);
  expect(job).toBeDefined();
  expect(job!.videoId).toBe("7523456789");
  expect(job!.title).toBe("Test TikTok");
  expect(job!.url).toBe("https://www.tiktok.com/@user/video/7523456789");
  expect(job!.status).toBe("pending");
  expect(job!.text).toBe("");
});

test("getJob returns undefined for nonexistent job", () => {
  expect(getJob("nonexistent-id")).toBeUndefined();
});

test("getRecentJobs returns jobs in reverse creation order", () => {
  const id1 = createJob("v1", "First", "url1");
  // Nudge createdAt so sort is deterministic
  const job1 = getJob(id1)!;
  job1.createdAt -= 1000;

  const id2 = createJob("v2", "Second", "url2");

  const recent = getRecentJobs(10);
  const ids = recent.map((j) => j.id);
  // Most recent (id2) should come before older (id1)
  expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
});

test("getRecentJobs respects limit", () => {
  createJob("lim1", "A", "u");
  createJob("lim2", "B", "u");
  createJob("lim3", "C", "u");

  const limited = getRecentJobs(2);
  expect(limited.length).toBeLessThanOrEqual(2);
});

test("updateStatus changes job status and publishes event", () => {
  const id = createJob("st1", "Status Test", "u");
  const events: string[] = [];
  subscribe(id, (e) => { if (e.type === "status") events.push(e.status); });

  updateStatus(id, "downloading");
  expect(getJob(id)!.status).toBe("downloading");
  expect(events).toContain("downloading");

  updateStatus(id, "extracting_frames");
  expect(getJob(id)!.status).toBe("extracting_frames");
  expect(events).toContain("extracting_frames");
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

  setCategory(id, "ai/claude");
  expect(getJob(id)!.category).toBe("ai/claude");
  expect(received).toBe("ai/claude");
});

test("setSimilar updates similar articles and publishes event", () => {
  const id = createJob("sim1", "Similar Test", "u");
  const articles = [{ title: "Article 1", url: "https://example.com" }];
  let received: typeof articles | undefined;
  subscribe(id, (e) => { if (e.type === "similar") received = e.articles; });

  setSimilar(id, articles);
  expect(getJob(id)!.similar).toEqual(articles);
  expect(received).toEqual(articles);
});

test("completeJob sets final state, replaces text, and ships summary on the event", () => {
  const id = createJob("cmp1", "Complete Test", "u");
  // Simulate the multi-turn chatter that accumulated during summarization.
  appendText(id, "Let me look at frame 1...");
  let completedSummary: string | undefined;
  subscribe(id, (e) => { if (e.type === "complete") completedSummary = e.summary; });

  completeJob(id, "Summary text", "ai/general");

  const job = getJob(id)!;
  expect(job.status).toBe("complete");
  expect(job.summary).toBe("Summary text");
  expect(job.category).toBe("ai/general");
  // job.text is replaced with the clean summary so an SSE replay drops the chatter.
  expect(job.text).toBe("Summary text");
  // The complete event carries the parsed summary for a live browser to swap in.
  expect(completedSummary).toBe("Summary text");
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
  // Text still accumulated on job even after unsub
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
  // Should not throw
  updateStatus("ghost", "complete");
  appendText("ghost", "text");
  setCategory("ghost", "ai/general");
  setSimilar("ghost", []);
  completeJob("ghost", "s", "c");
  failJob("ghost", "err");
});

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

const URL = "https://vimeo.com/1223358361";

test("createJob returns a UUID and stores the job", () => {
  const id = createJob("1223358361", "Trust but verify", URL);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const job = getJob(id)!;
  expect(job.videoId).toBe("1223358361");
  expect(job.title).toBe("Trust but verify");
  expect(job.url).toBe(URL);
  expect(job.status).toBe("pending");
  expect(job.text).toBe("");
});

test("getJob returns undefined for a nonexistent job", () => {
  expect(getJob("nonexistent-id")).toBeUndefined();
});

test("getRecentJobs returns jobs in reverse creation order and respects the limit", () => {
  const older = createJob("v1", "First", URL);
  getJob(older)!.createdAt -= 1000;
  const newer = createJob("v2", "Second", URL);

  const recent = getRecentJobs(10).map((j) => j.id);
  expect(recent.indexOf(newer)).toBeLessThan(recent.indexOf(older));
  expect(getRecentJobs(1).length).toBe(1);
});

test("harvesting_captions is a real status this store publishes", () => {
  // The status the whole vertical is named for: the route hands metadata over,
  // so a job is never seen `fetching_metadata` and goes straight here.
  const id = createJob("st1", "Status", URL);
  const seen: string[] = [];
  subscribe(id, (e) => { if (e.type === "status") seen.push(e.status); });

  updateStatus(id, "harvesting_captions");
  expect(getJob(id)!.status).toBe("harvesting_captions");
  expect(seen).toContain("harvesting_captions");
});

test("appendText accumulates text and publishes deltas", () => {
  const id = createJob("tx1", "Text", URL);
  const deltas: string[] = [];
  subscribe(id, (e) => { if (e.type === "text_delta") deltas.push(e.text); });

  appendText(id, "Hello ");
  appendText(id, "world");

  expect(getJob(id)!.text).toBe("Hello world");
  expect(deltas).toEqual(["Hello ", "world"]);
});

test("setCategory and setSimilar update the job and publish", () => {
  const id = createJob("cat1", "Cat", URL);
  let category: string | undefined;
  let articles: unknown;
  subscribe(id, (e) => {
    if (e.type === "category") category = e.category;
    if (e.type === "similar") articles = e.articles;
  });

  setCategory(id, "ai/claude");
  setSimilar(id, [{ title: "A", url: "https://example.com" }]);

  expect(getJob(id)!.category).toBe("ai/claude");
  expect(category).toBe("ai/claude");
  expect(articles).toEqual([{ title: "A", url: "https://example.com" }]);
});

test("completeJob sets the final state and publishes complete", () => {
  const id = createJob("cmp1", "Complete", URL);
  let completed = false;
  subscribe(id, (e) => { if (e.type === "complete") completed = true; });

  completeJob(id, "Summary text", "ai/general");

  const job = getJob(id)!;
  expect(job.status).toBe("complete");
  expect(job.summary).toBe("Summary text");
  expect(job.category).toBe("ai/general");
  expect(completed).toBe(true);
});

test("failJob sets the error state and publishes error", () => {
  const id = createJob("fail1", "Fail", URL);
  let message: string | undefined;
  subscribe(id, (e) => { if (e.type === "error") message = e.message; });

  failJob(id, "no_captions");

  expect(getJob(id)!.status).toBe("error");
  expect(getJob(id)!.error).toBe("no_captions");
  expect(message).toBe("no_captions");
});

test("subscribe returns an unsubscribe that stops events without stopping the writes", () => {
  const id = createJob("unsub1", "Unsub", URL);
  const seen: string[] = [];
  const unsub = subscribe(id, (e) => { if (e.type === "text_delta") seen.push(e.text); });

  appendText(id, "before");
  unsub();
  appendText(id, "after");

  expect(seen).toEqual(["before"]);
  expect(getJob(id)!.text).toBe("beforeafter");
});

test("operations on a nonexistent job are no-ops", () => {
  updateStatus("ghost", "complete");
  appendText("ghost", "text");
  setCategory("ghost", "ai/general");
  setSimilar("ghost", []);
  completeJob("ghost", "s", "c");
  failJob("ghost", "err");
});

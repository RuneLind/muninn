import { test, expect } from "bun:test";
import { createJobStore, type JobEvent } from "./job-store.ts";

type Status = "pending" | "working" | "complete" | "error";

function makeStore(completeReplacesText = false) {
  return createJobStore<Status, { videoId: string }>({
    subsystem: "test",
    label: "Test",
    initialStatus: "pending",
    completeReplacesText,
  });
}

test("createJob stores base + vertical fields with defaults", () => {
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const job = store.getJob(id)!;
  expect(job.videoId).toBe("v1");
  expect(job.title).toBe("T");
  expect(job.url).toBe("u");
  expect(job.status).toBe("pending");
  expect(job.text).toBe("");
  expect(typeof job.createdAt).toBe("number");
});

test("getJob returns undefined for unknown id", () => {
  const store = makeStore();
  expect(store.getJob("nope")).toBeUndefined();
});

test("getRecentJobs sorts newest-first and respects limit", () => {
  const store = makeStore();
  const id1 = store.createJob({ videoId: "v1", title: "A", url: "u" });
  store.getJob(id1)!.createdAt -= 1000; // make id1 older
  const id2 = store.createJob({ videoId: "v2", title: "B", url: "u" });
  store.createJob({ videoId: "v3", title: "C", url: "u" });

  const recent = store.getRecentJobs(10);
  const ids = recent.map((j) => j.id);
  expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
  expect(store.getRecentJobs(2).length).toBe(2);
});

test("pub/sub delivers status/text/category/similar events", () => {
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  const events: JobEvent<Status>[] = [];
  store.subscribe(id, (e) => events.push(e));

  store.updateStatus(id, "working");
  store.appendText(id, "Hello ");
  store.appendText(id, "world");
  store.setCategory(id, "ai/general");
  store.setSimilar(id, [{ title: "S", url: "su" }]);

  expect(events).toEqual([
    { type: "status", status: "working" },
    { type: "text_delta", text: "Hello " },
    { type: "text_delta", text: "world" },
    { type: "category", category: "ai/general" },
    { type: "similar", articles: [{ title: "S", url: "su" }] },
  ]);
  const job = store.getJob(id)!;
  expect(job.text).toBe("Hello world");
  expect(job.category).toBe("ai/general");
  expect(job.similar).toEqual([{ title: "S", url: "su" }]);
});

test("subscribe replay semantics: job fields reflect state for late subscribers", () => {
  // The route layer replays getJob() fields to late subscribers, so verify the
  // job snapshot carries everything a replay needs after live mutation.
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  store.updateStatus(id, "working");
  store.appendText(id, "partial");
  store.setCategory(id, "ai/x");

  const job = store.getJob(id)!;
  expect(job.status).toBe("working");
  expect(job.text).toBe("partial");
  expect(job.category).toBe("ai/x");
});

test("unsubscribe stops delivery but text still accumulates", () => {
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  const got: string[] = [];
  const unsub = store.subscribe(id, (e) => {
    if (e.type === "text_delta") got.push(e.text);
  });

  store.appendText(id, "before");
  unsub();
  store.appendText(id, "after");

  expect(got).toEqual(["before"]);
  expect(store.getJob(id)!.text).toBe("beforeafter");
});

test("a throwing subscriber does not break others", () => {
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  const got: string[] = [];
  store.subscribe(id, () => { throw new Error("boom"); });
  store.subscribe(id, (e) => { if (e.type === "text_delta") got.push(e.text); });

  store.appendText(id, "hello");
  expect(got).toEqual(["hello"]);
});

test("completeJob (default): bare complete event, text untouched", () => {
  const store = makeStore(false);
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  store.appendText(id, "chatter");
  const events: JobEvent<Status>[] = [];
  store.subscribe(id, (e) => { if (e.type === "complete") events.push(e); });

  store.completeJob(id, "Final summary", "ai/general");

  const job = store.getJob(id)!;
  expect(job.status).toBe("complete");
  expect(job.summary).toBe("Final summary");
  expect(job.category).toBe("ai/general");
  // text left as-is; the complete event carries no summary key.
  expect(job.text).toBe("chatter");
  expect(events).toEqual([{ type: "complete" }]);
});

test("completeJob (completeReplacesText): overwrites text + ships summary", () => {
  const store = makeStore(true);
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  store.appendText(id, "let me read frame 1...");
  let shipped: string | undefined;
  store.subscribe(id, (e) => { if (e.type === "complete") shipped = e.summary; });

  store.completeJob(id, "Clean summary", "ai/general");

  const job = store.getJob(id)!;
  expect(job.status).toBe("complete");
  expect(job.text).toBe("Clean summary");
  expect(shipped).toBe("Clean summary");
});

test("failJob sets error state and publishes error event", () => {
  const store = makeStore();
  const id = store.createJob({ videoId: "v1", title: "T", url: "u" });
  let msg: string | undefined;
  store.subscribe(id, (e) => { if (e.type === "error") msg = e.message; });

  store.failJob(id, "kaboom");

  const job = store.getJob(id)!;
  expect(job.status).toBe("error");
  expect(job.error).toBe("kaboom");
  expect(msg).toBe("kaboom");
});

test("mutations on unknown job id are no-ops", () => {
  const store = makeStore();
  // none of these should throw
  store.updateStatus("ghost", "complete");
  store.appendText("ghost", "x");
  store.setCategory("ghost", "c");
  store.setSimilar("ghost", []);
  store.completeJob("ghost", "s", "c");
  store.failJob("ghost", "e");
  expect(store.getJob("ghost")).toBeUndefined();
});

test("TTL cleanup timer evicts expired jobs and keeps fresh ones", async () => {
  // Tiny TTL + interval (test-only override) so the real setInterval sweep runs.
  const store = createJobStore<Status, { videoId: string }>({
    subsystem: "test",
    label: "Test",
    initialStatus: "pending",
    ttlMs: 20,
    cleanupIntervalMs: 10,
  });

  const oldId = store.createJob({ videoId: "old", title: "T", url: "u" });
  store.getJob(oldId)!.createdAt -= 1000; // already well past the 20ms TTL

  // Wait for a couple of sweep intervals.
  await new Promise((r) => setTimeout(r, 60));

  expect(store.getJob(oldId)).toBeUndefined();

  // A freshly created job survives the next sweep.
  const freshId = store.createJob({ videoId: "fresh", title: "T", url: "u" });
  await new Promise((r) => setTimeout(r, 15));
  expect(store.getJob(freshId)).toBeDefined();
});

import { test, expect, describe, beforeEach } from "bun:test";
import { createJobStore, type JobEvent } from "./job-store.ts";
import { agentStatus } from "../observability/agent-status.ts";

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

  // A fresh job survives sweeps — generous TTL so slow CI can't cross the
  // eviction boundary while we wait for the sweep to run.
  const survivorStore = createJobStore<Status, { videoId: string }>({
    subsystem: "test",
    label: "Test",
    initialStatus: "pending",
    ttlMs: 10_000,
    cleanupIntervalMs: 10,
  });
  const freshId = survivorStore.createJob({ videoId: "fresh", title: "T", url: "u" });
  await new Promise((r) => setTimeout(r, 30));
  expect(survivorStore.getJob(freshId)).toBeDefined();
});

// ── AgentRun registry mirror (/agents dashboard) ─────────────────────────────
// One hook in the shared factory covers ALL the capture verticals — the tests
// below parametrize `label` to prove the same createJob→complete/fail lifecycle
// registers + settles a `kind:"capture"` run whatever the vertical is.

describe("createJobStore — AgentRun registry mirror", () => {
  beforeEach(() => agentStatus.clearRequest()); // reset the singleton between cases

  function labelledStore(label: string) {
    return createJobStore<Status, { videoId: string }>({
      subsystem: "test",
      label,
      initialStatus: "pending",
    });
  }

  function captureRuns() {
    return agentStatus.getAll().filter((r) => r.kind === "capture");
  }

  test("createJob registers a capture run named '<label>: <title>'", () => {
    const store = labelledStore("YouTube");
    store.createJob({ videoId: "v1", title: "Cool video", url: "https://y/1" });
    const runs = captureRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.name).toBe("YouTube: Cool video");
    expect(runs[0]!.completed).toBeFalsy();
    // Empty until the summarizer resolves the bot and calls attachRun — createJob
    // runs at route level, before the summarizer bot is known.
    expect(runs[0]!.botName).toBe("");
  });

  test("name falls back to the url when the job has no title", () => {
    const store = labelledStore("X");
    store.createJob({ videoId: "v1", title: "", url: "https://x.com/a/status/1" });
    expect(captureRuns()[0]!.name).toBe("X: https://x.com/a/status/1");
  });

  test("completeJob settles the run into the completed ring", () => {
    const store = labelledStore("TikTok");
    const id = store.createJob({ videoId: "v1", title: "Clip", url: "u" });
    expect(captureRuns()[0]!.completed).toBeFalsy();
    store.completeJob(id, "summary text", "cat");
    expect(captureRuns()[0]!.completed).toBe(true);
    const ring = agentStatus.getRecentCompleted().filter((r) => r.kind === "capture");
    expect(ring.some((r) => r.name === "TikTok: Clip")).toBe(true);
  });

  test("failJob also completes the run (error path)", () => {
    const store = labelledStore("Claude");
    const id = store.createJob({ videoId: "v1", title: "Doc", url: "u" });
    store.failJob(id, "boom");
    expect(captureRuns()[0]!.completed).toBe(true);
  });

  test("every vertical registers + settles via the SAME factory hook", () => {
    for (const label of ["YouTube", "X", "TikTok", "Claude"]) {
      const store = labelledStore(label);
      const id = store.createJob({ videoId: "v", title: "T", url: "u" });
      store.completeJob(id, "s", "c");
    }
    const ring = agentStatus.getRecentCompleted().filter((r) => r.kind === "capture");
    expect(ring.map((r) => r.name).sort()).toEqual(
      ["Claude: T", "TikTok: T", "X: T", "YouTube: T"],
    );
  });

  test("an abandoned job's run is completed by the TTL sweep (no leak)", async () => {
    const store = createJobStore<Status, { videoId: string }>({
      subsystem: "test",
      label: "YouTube",
      initialStatus: "pending",
      ttlMs: 5,
      cleanupIntervalMs: 5,
    });
    store.createJob({ videoId: "v1", title: "T", url: "u" }); // never completed
    expect(captureRuns()[0]!.completed).toBeFalsy();
    await new Promise((r) => setTimeout(r, 30));
    // The TTL cleanup dropped the job AND completed the dangling registry run.
    expect(captureRuns().every((r) => r.completed)).toBe(true);
  });
});

// ── attachRun: late-bound telemetry (bot / model / trace / tokens) ────────────
// The run starts at createJob, before the summarizer bot is resolved and before
// the model call — so everything worth showing on the card is bound afterwards.

describe("createJobStore — attachRun", () => {
  beforeEach(() => agentStatus.clearRequest());

  function store() {
    return createJobStore<Status, { videoId: string }>({
      subsystem: "test",
      label: "YouTube",
      initialStatus: "pending",
    });
  }

  function liveRun() {
    return agentStatus.getAll().filter((r) => r.kind === "capture")[0]!;
  }

  test("binds bot, connector and model onto the LIVE run", () => {
    const s = store();
    const id = s.createJob({ videoId: "v1", title: "T", url: "u" });
    s.attachRun(id, { botName: "jarvis", connectorLabel: "Claude SDK", model: "claude-sonnet-5" });

    const run = liveRun();
    expect(run.botName).toBe("jarvis");
    expect(run.connectorLabel).toBe("Claude SDK");
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.completed).toBeFalsy();
  });

  test("parks trace + tokens and hands them to completeRequest at the terminal transition", () => {
    const s = store();
    const id = s.createJob({ videoId: "v1", title: "T", url: "u" });
    s.attachRun(id, { botName: "jarvis", traceId: "trace-abc" });
    s.attachRun(id, { model: "claude-sonnet-5", inputTokens: 12_000, outputTokens: 900, numTurns: 1, toolCount: 3, costUsd: 0.042 });

    s.completeJob(id, "summary", "ai/general");

    // The ring snapshot is what /agents "Recently finished" renders.
    const ring = agentStatus.getRecentCompleted().filter((r) => r.kind === "capture");
    expect(ring).toHaveLength(1);
    expect(ring[0]!).toMatchObject({
      botName: "jarvis",
      model: "claude-sonnet-5",
      traceId: "trace-abc",
      inputTokens: 12_000,
      outputTokens: 900,
      toolCount: 3,
      costUsd: 0.042,
    });
  });

  test("telemetry bound before a FAILING job still lands on the ring row", () => {
    const s = store();
    const id = s.createJob({ videoId: "v1", title: "T", url: "u" });
    s.attachRun(id, { botName: "jarvis", traceId: "trace-err", inputTokens: 500 });
    s.failJob(id, "boom");

    const ring = agentStatus.getRecentCompleted().filter((r) => r.kind === "capture");
    expect(ring[0]!.traceId).toBe("trace-err");
    expect(ring[0]!.inputTokens).toBe(500);
  });

  test("unknown jobId is a silent no-op (never throws)", () => {
    const s = store();
    expect(() => s.attachRun("no-such-job", { botName: "jarvis" })).not.toThrow();
  });

  test("attachRun after the job settled does not resurrect the run", () => {
    const s = store();
    const id = s.createJob({ videoId: "v1", title: "T", url: "u" });
    s.completeJob(id, "summary", "cat");
    s.attachRun(id, { botName: "late", inputTokens: 999 });

    const ring = agentStatus.getRecentCompleted().filter((r) => r.kind === "capture");
    expect(ring[0]!.botName).toBe("");
    expect(ring[0]!.inputTokens).toBeUndefined();
  });
});

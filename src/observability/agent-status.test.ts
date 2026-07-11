import { describe, test, expect } from "bun:test";
import { agentStatus, type AgentPhase, type AgentStatus, type AgentRun, type RequestProgress } from "./agent-status.ts";

// The class is not exported, only the singleton. We'll test through the singleton
// but reset state between tests via clearRequest() and set("idle").

function resetTracker() {
  agentStatus.clearRequest();
  agentStatus.set("idle");
}

describe("AgentStatusTracker", () => {
  describe("set() and get()", () => {
    test("defaults to idle phase", () => {
      resetTracker();
      const status = agentStatus.get();
      expect(status.phase).toBe("idle");
      expect(status.startedAt).toBeUndefined();
    });

    test("sets phase with username and detail", () => {
      resetTracker();
      agentStatus.set("receiving", "alice", "processing message");
      const status = agentStatus.get();
      expect(status.phase).toBe("receiving");
      expect(status.username).toBe("alice");
      expect(status.detail).toBe("processing message");
      expect(status.startedAt).toBeNumber();
    });

    test("sets idle phase without startedAt", () => {
      resetTracker();
      agentStatus.set("receiving", "alice");
      agentStatus.set("idle");
      const status = agentStatus.get();
      expect(status.phase).toBe("idle");
      expect(status.startedAt).toBeUndefined();
    });
  });

  describe("subscribe()", () => {
    test("notifies subscriber on status change", () => {
      resetTracker();
      const received: AgentStatus[] = [];
      const unsub = agentStatus.subscribe((s) => received.push(s));

      agentStatus.set("calling_claude", "bob");
      agentStatus.set("idle");

      expect(received).toHaveLength(2);
      expect(received[0]!.phase).toBe("calling_claude");
      expect(received[0]!.username).toBe("bob");
      expect(received[1]!.phase).toBe("idle");

      unsub();
    });

    test("returns unsubscribe function that stops notifications", () => {
      resetTracker();
      const received: AgentStatus[] = [];
      const unsub = agentStatus.subscribe((s) => received.push(s));

      agentStatus.set("receiving", "alice");
      unsub();
      agentStatus.set("calling_claude", "alice");

      expect(received).toHaveLength(1);
      expect(received[0]!.phase).toBe("receiving");
    });
  });

  describe("startRequest()", () => {
    test("creates request with sequential IDs", () => {
      resetTracker();
      const id1 = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      expect(id1).toMatch(/^req_\d+$/);

      const id2 = agentStatus.startRequest("jarvis", "calling_claude", "bob");
      expect(id2).toMatch(/^req_\d+$/);
      expect(id2).not.toBe(id1);

      // IDs should be incrementing
      const num1 = parseInt(id1.replace("req_", ""));
      const num2 = parseInt(id2.replace("req_", ""));
      expect(num2).toBeGreaterThan(num1);
    });

    test("populates request progress fields", () => {
      resetTracker();
      agentStatus.startRequest("jarvis", "calling_claude", "alice");
      const progress = agentStatus.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.botName).toBe("jarvis");
      expect(progress!.phase).toBe("calling_claude");
      expect(progress!.username).toBe("alice");
      expect(progress!.startedAt).toBeNumber();
      expect(progress!.tools).toEqual([]);
      expect(progress!.completed).toBeUndefined();
    });
  });

  describe("toolStart() and toolEnd()", () => {
    test("tracks tool with start and end times", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "calling_claude");

      agentStatus.toolStart(id, "read_file", "Read File", "/src/index.ts");
      const progress1 = agentStatus.getProgress();
      expect(progress1!.tools).toHaveLength(1);
      expect(progress1!.tools[0]!.name).toBe("read_file");
      expect(progress1!.tools[0]!.displayName).toBe("Read File");
      expect(progress1!.tools[0]!.input).toBe("/src/index.ts");
      expect(progress1!.tools[0]!.startedAt).toBeNumber();
      expect(progress1!.tools[0]!.endedAt).toBeUndefined();

      agentStatus.toolEnd(id, "read_file", "Read File");
      const progress2 = agentStatus.getProgress();
      expect(progress2!.tools[0]!.endedAt).toBeNumber();
      expect(progress2!.tools[0]!.durationMs).toBeNumber();
      expect(progress2!.tools[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("does nothing for an unknown request id", () => {
      resetTracker();
      // Should not throw
      agentStatus.toolStart("req_missing", "read_file", "Read File");
      agentStatus.toolEnd("req_missing", "read_file", "Read File");
      expect(agentStatus.getProgress()).toBeNull();
    });

    test("ends the last matching unfinished tool", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "calling_claude");

      // Start same tool twice
      agentStatus.toolStart(id, "bash", "Bash");
      agentStatus.toolStart(id, "bash", "Bash");

      // End should close the second (last unfinished) one
      agentStatus.toolEnd(id, "bash", "Bash");
      const progress = agentStatus.getProgress();
      expect(progress!.tools).toHaveLength(2);
      expect(progress!.tools[0]!.endedAt).toBeUndefined();
      expect(progress!.tools[1]!.endedAt).toBeNumber();
    });
  });

  describe("completeRequest()", () => {
    test("marks request as completed with metadata", () => {
      resetTracker();
      const reqId = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      agentStatus.completeRequest(reqId, {
        traceId: "trace-123",
        inputTokens: 500,
        outputTokens: 200,
        numTurns: 3,
        toolCount: 2,
      });

      const progress = agentStatus.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.completed).toBe(true);
      expect(progress!.completedAt).toBeNumber();
      expect(progress!.traceId).toBe("trace-123");
      expect(progress!.inputTokens).toBe(500);
      expect(progress!.outputTokens).toBe(200);
      expect(progress!.numTurns).toBe(3);
      expect(progress!.toolCount).toBe(2);
    });

    test("does nothing if request ID does not match", () => {
      resetTracker();
      const reqId = agentStatus.startRequest("jarvis", "calling_claude");
      agentStatus.completeRequest("wrong_id", { traceId: "trace-123" });

      const progress = agentStatus.getProgress();
      expect(progress!.completed).toBeUndefined();
      expect(progress!.requestId).toBe(reqId);
    });
  });

  describe("clearRequest()", () => {
    test("resets active request to null", () => {
      resetTracker();
      agentStatus.startRequest("jarvis", "calling_claude");
      expect(agentStatus.getProgress()).not.toBeNull();

      agentStatus.clearRequest();
      expect(agentStatus.getProgress()).toBeNull();
    });
  });

  describe("subscribeProgress()", () => {
    test("notifies on progress changes", () => {
      resetTracker();
      const received: (RequestProgress | null)[] = [];
      const unsub = agentStatus.subscribeProgress((p) => received.push(p ? { ...p } : null));

      const id = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      agentStatus.toolStart(id, "read_file", "Read File");

      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received[0]!.botName).toBe("jarvis");

      unsub();
      const countBefore = received.length;
      agentStatus.toolEnd(id, "read_file", "Read File");
      expect(received.length).toBe(countBefore);
    });

    test("returns unsubscribe function", () => {
      resetTracker();
      const received: (RequestProgress | null)[] = [];
      const unsub = agentStatus.subscribeProgress((p) => received.push(p));
      unsub();

      agentStatus.startRequest("jarvis", "calling_claude");
      expect(received).toHaveLength(0);
    });
  });

  describe("updatePhase()", () => {
    test("updates phase on active request", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "calling_claude");
      agentStatus.updatePhase(id, "saving_response");

      const progress = agentStatus.getProgress();
      expect(progress!.phase).toBe("saving_response");
    });

    test("does nothing for an unknown request id", () => {
      resetTracker();
      // Should not throw
      agentStatus.updatePhase("req_missing", "saving_response");
      expect(agentStatus.getProgress()).toBeNull();
    });
  });

  describe("concurrent requests (Map isolation)", () => {
    test("getProgress() surfaces the most-recently-started request", () => {
      resetTracker();
      const a = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      const b = agentStatus.startRequest("jarvis", "running_watcher", "bob");

      expect(agentStatus.getProgress()!.requestId).toBe(b);

      // Removing the primary falls back to the previous request, not null
      agentStatus.clearRequest(b);
      expect(agentStatus.getProgress()!.requestId).toBe(a);
    });

    test("background kinds never become the waterfall primary", () => {
      resetTracker();
      // A completed chat turn is showing its terminal card…
      const chat = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      agentStatus.completeRequest(chat, { traceId: "t1" });
      expect(agentStatus.getProgress()!.requestId).toBe(chat);

      // …then the post-turn extractors (and other background kinds) register.
      // None of them may hijack the primary slot — pre-registry, nothing
      // tracked after the chat turn, so the card auto-dismissed cleanly.
      agentStatus.startRequest("jarvis", "calling_claude", undefined, { kind: "extractor", name: "Extractor: memory" });
      agentStatus.startRequest("jarvis", "searching", undefined, { kind: "research", name: "q" });
      agentStatus.startRequest("jarvis", "drafting", undefined, { kind: "gardener_drain", name: "Backlog drain" });
      agentStatus.startRequest("jarvis", "calling_claude", undefined, { kind: "capture", name: "YouTube: x" });
      expect(agentStatus.getProgress()!.requestId).toBe(chat);
      // The registry read side still sees everything.
      expect(agentStatus.getAll()).toHaveLength(5);

      // Waterfall kinds do take over as before.
      const watcher = agentStatus.startRequest("jarvis", "running_watcher", undefined, { kind: "watcher", name: "email" });
      expect(agentStatus.getProgress()!.requestId).toBe(watcher);
      resetTracker();
    });

    test("tools accumulate per-request without clobbering", () => {
      resetTracker();
      const a = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      const b = agentStatus.startRequest("jarvis", "running_watcher", "bob");

      // Interleave tool activity across both requests
      agentStatus.toolStart(a, "read_file", "Read File");
      agentStatus.toolStart(b, "web_search", "Web Search");
      agentStatus.toolStart(a, "bash", "Bash");

      // Primary is b — it must only carry its own single tool
      const primary = agentStatus.getProgress()!;
      expect(primary.requestId).toBe(b);
      expect(primary.tools).toHaveLength(1);
      expect(primary.tools[0]!.name).toBe("web_search");

      // Drop b → a becomes primary and still holds exactly its own two tools
      agentStatus.clearRequest(b);
      const remaining = agentStatus.getProgress()!;
      expect(remaining.requestId).toBe(a);
      expect(remaining.tools.map((t) => t.name)).toEqual(["read_file", "bash"]);
    });

    test("updatePhase targets only the named request", () => {
      resetTracker();
      const a = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      const b = agentStatus.startRequest("jarvis", "running_watcher", "bob");

      agentStatus.updatePhase(a, "saving_response");

      // b (primary) is untouched
      expect(agentStatus.getProgress()!.phase).toBe("running_watcher");
      // a carries the new phase
      agentStatus.clearRequest(b);
      expect(agentStatus.getProgress()!.phase).toBe("saving_response");
    });

    test("clearRequest() with no id clears every tracked request", () => {
      resetTracker();
      agentStatus.startRequest("jarvis", "calling_claude", "alice");
      agentStatus.startRequest("jarvis", "running_watcher", "bob");

      agentStatus.clearRequest();
      expect(agentStatus.getProgress()).toBeNull();
    });
  });

  // ── AgentRun registry (/agents dashboard) ──────────────────────────────────

  describe("kind tagging", () => {
    test("defaults kind to 'chat' when no opts given", () => {
      resetTracker();
      agentStatus.startRequest("jarvis", "receiving", "alice");
      expect(agentStatus.getProgress()!.kind).toBe("chat");
    });

    test("carries kind + name from opts", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "running_watcher", undefined, {
        kind: "watcher",
        name: "Email Watcher",
      });
      const run = agentStatus.getAll().find((r) => r.requestId === id)!;
      expect(run.kind).toBe("watcher");
      expect(run.name).toBe("Email Watcher");
    });
  });

  describe("request_progress regression pin (shape-additive)", () => {
    test("getProgress() keeps its existing keys; new keys are additive", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      agentStatus.completeRequest(id, { traceId: "t1", inputTokens: 10, outputTokens: 5, numTurns: 2, toolCount: 1 });
      const p = agentStatus.getProgress()!;
      // Existing keys unchanged.
      expect(p.requestId).toBe(id);
      expect(p.botName).toBe("jarvis");
      expect(p.username).toBe("alice");
      expect(p.phase).toBe("calling_claude");
      expect(p.startedAt).toBeNumber();
      expect(p.tools).toEqual([]);
      expect(p.completed).toBe(true);
      expect(p.traceId).toBe("t1");
      expect(p.inputTokens).toBe(10);
      expect(p.outputTokens).toBe(5);
      expect(p.numTurns).toBe(2);
      expect(p.toolCount).toBe(1);
      // New additive key present but does not replace anything.
      expect(p.kind).toBe("chat");
    });
  });

  describe("getAll()", () => {
    test("returns every tracked run, not just the primary", () => {
      resetTracker();
      const a = agentStatus.startRequest("jarvis", "calling_claude", "alice");
      const b = agentStatus.startRequest("jarvis", "running_watcher", undefined, { kind: "watcher" });
      const ids = agentStatus.getAll().map((r) => r.requestId).sort();
      expect(ids).toEqual([a, b].sort());
    });
  });

  describe("updateProgress()", () => {
    test("sets discrete n/m progress on a run", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "running_watcher", undefined, { kind: "gardener_drain" });
      agentStatus.updateProgress(id, { done: 2, total: 5, currentItem: "topic" });
      const run = agentStatus.getAll().find((r) => r.requestId === id)!;
      expect(run.progress).toEqual({ done: 2, total: 5, currentItem: "topic" });
    });

    test("is a no-op for an unknown id", () => {
      resetTracker();
      agentStatus.updateProgress("req_missing", { done: 1, total: 1 });
      expect(agentStatus.getAll()).toHaveLength(0);
    });
  });

  describe("completed-runs ring", () => {
    test("captures completed runs and survives clearRequest of the live entry", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "running_task", undefined, {
        kind: "scheduled_task",
        name: "Morning briefing",
      });
      agentStatus.completeRequest(id, { inputTokens: 100, outputTokens: 40 });
      // Removing the live entry must not drop the ring snapshot.
      agentStatus.clearRequest(id);
      expect(agentStatus.getAll()).toHaveLength(0);

      const ring = agentStatus.getRecentCompleted();
      expect(ring).toHaveLength(1);
      expect(ring[0]!.requestId).toBe(id);
      expect(ring[0]!.kind).toBe("scheduled_task");
      expect(ring[0]!.name).toBe("Morning briefing");
      expect(ring[0]!.completed).toBe(true);
    });

    test("caps at 50 completed runs (newest kept)", () => {
      resetTracker();
      for (let i = 0; i < 55; i++) {
        const id = agentStatus.startRequest("jarvis", "running_task", undefined, { kind: "scheduled_task", name: `t${i}` });
        agentStatus.completeRequest(id, {});
        agentStatus.clearRequest(id);
      }
      const ring = agentStatus.getRecentCompleted();
      expect(ring).toHaveLength(50);
      expect(ring[ring.length - 1]!.name).toBe("t54");
      expect(ring[0]!.name).toBe("t5"); // t0..t4 evicted
    });

    test("getRecentCompleted returns copies (mutation-safe)", () => {
      resetTracker();
      const id = agentStatus.startRequest("jarvis", "running_task", undefined, { kind: "scheduled_task" });
      agentStatus.completeRequest(id, {});
      const first = agentStatus.getRecentCompleted();
      first[0]!.name = "mutated";
      expect(agentStatus.getRecentCompleted()[0]!.name).not.toBe("mutated");
    });
  });

  describe("subscribeAll() + throttle", () => {
    test("emits a snapshot on the first mutation, then throttles rapid ones", () => {
      resetTracker();
      const snaps: AgentRun[][] = [];
      const unsub = agentStatus.subscribeAll((runs) => snaps.push(runs));

      // First mutation emits immediately (lastAllNotifyAt starts at 0).
      agentStatus.startRequest("jarvis", "calling_claude", "alice");
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!).toHaveLength(1);

      // A rapid second mutation is throttled (trailing timer, no sync emit).
      agentStatus.startRequest("jarvis", "running_watcher", undefined, { kind: "watcher" });
      expect(snaps).toHaveLength(1);

      unsub();
    });

    test("trailing emit flushes the final state with tools capped at 20", async () => {
      resetTracker();
      const snaps: AgentRun[][] = [];
      const unsub = agentStatus.subscribeAll((runs) => snaps.push(runs));

      const id = agentStatus.startRequest("jarvis", "calling_claude");
      for (let i = 0; i < 25; i++) agentStatus.toolStart(id, `tool_${i}`, `Tool ${i}`);

      // Wait past the throttle window for the trailing flush.
      await Bun.sleep(1100);
      const last = snaps[snaps.length - 1]!;
      const run = last.find((r) => r.requestId === id)!;
      expect(run.tools.length).toBe(20); // capped in the snapshot
      // getAll keeps the full, uncapped list.
      expect(agentStatus.getAll().find((r) => r.requestId === id)!.tools.length).toBe(25);

      unsub();
    });

    test("stops notifying after unsubscribe", () => {
      resetTracker();
      const snaps: AgentRun[][] = [];
      const unsub = agentStatus.subscribeAll((runs) => snaps.push(runs));
      unsub();
      agentStatus.startRequest("jarvis", "calling_claude");
      expect(snaps).toHaveLength(0);
    });
  });
});

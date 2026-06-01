import { describe, test, expect } from "bun:test";
import { agentStatus, type AgentPhase, type AgentStatus, type RequestProgress } from "./agent-status.ts";

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
});

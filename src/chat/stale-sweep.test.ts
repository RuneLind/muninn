import { test, expect, describe } from "bun:test";
import { sweepStaleHandoffs } from "./stale-sweep.ts";
import type { DevRun, DevRunHandoff } from "../db/dev-runs.ts";

function staleEntry(runId: string, handoffId: string): { run: DevRun; handoff: DevRunHandoff } {
  return {
    run: {
      id: runId, botName: "b", userId: "u", issueKey: "K-" + runId,
      status: "building", createdAt: 1, updatedAt: 2,
    },
    handoff: {
      id: handoffId, runId, peerName: "p", role: "build", status: "working",
      createdAt: 1, updatedAt: 2,
    },
  };
}

describe("sweepStaleHandoffs", () => {
  test("broadcasts each affected run exactly once (dedupes multiple stale handoffs)", async () => {
    const broadcast: string[] = [];
    const runIds = await sweepStaleHandoffs({
      // run-A has two stale handoffs, run-B one.
      list: async () => [staleEntry("run-A", "h1"), staleEntry("run-A", "h2"), staleEntry("run-B", "h3")],
      broadcast: async (id) => { broadcast.push(id); },
    });

    expect(runIds.sort()).toEqual(["run-A", "run-B"]);
    expect(broadcast.sort()).toEqual(["run-A", "run-B"]); // run-A only once
  });

  test("no stale handoffs → no broadcasts", async () => {
    const broadcast: string[] = [];
    const runIds = await sweepStaleHandoffs({
      list: async () => [],
      broadcast: async (id) => { broadcast.push(id); },
    });
    expect(runIds).toEqual([]);
    expect(broadcast).toEqual([]);
  });

  test("a per-run broadcast failure doesn't abort the sweep", async () => {
    const broadcast: string[] = [];
    const runIds = await sweepStaleHandoffs({
      list: async () => [staleEntry("run-A", "h1"), staleEntry("run-B", "h2")],
      broadcast: async (id) => {
        if (id === "run-A") throw new Error("boom");
        broadcast.push(id);
      },
    });
    // run-A failed but run-B still got broadcast; both are reported as attempted.
    expect(runIds.sort()).toEqual(["run-A", "run-B"]);
    expect(broadcast).toEqual(["run-B"]);
  });
});

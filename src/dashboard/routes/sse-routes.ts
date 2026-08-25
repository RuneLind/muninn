import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { activityLog } from "../../observability/activity-log.ts";
import { agentStatus } from "../../observability/agent-status.ts";

export function registerSSERoutes(app: Hono): void {
  app.get("/api/events", (c) => {
    /**
     * Who is watching this stream.
     *
     * Scopes exactly two of the four channels — `request_progress` (the
     * single-pane waterfall) and `agent_status` (the phase pill) — because those
     * two are the ones every chat page renders as ITS OWN. Omitting it keeps the
     * unfiltered operator stream the dashboard is built on.
     *
     * Deliberately NOT applied to `agent_runs` or `activity`: `agent_runs` IS
     * the operator's `/agents` feed and filtering it globally would empty that
     * page, and the activity replay is a separate cross-user channel with its
     * own answer (it needs owner scoping, not a viewer parameter). Client-
     * supplied for now — PR C is where the identity stops coming from the
     * client; scoping the render is what this one is for.
     */
    const viewer = c.req.query("viewer") || undefined;
    return streamSSE(c, async (stream) => {
      // Send recent history
      const recent = activityLog.getRecent(50);
      for (const event of recent) {
        await stream.writeSSE({ event: "activity", data: JSON.stringify(event) });
      }

      // Send current stats and agent status
      await stream.writeSSE({ event: "stats", data: JSON.stringify(activityLog.stats) });
      await stream.writeSSE({ event: "agent_status", data: JSON.stringify(agentStatus.get(viewer)) });
      await stream.writeSSE({ event: "request_progress", data: JSON.stringify(agentStatus.getProgress(viewer)) });
      // Initial full snapshot of all runs for the /agents dashboard. Uses the
      // same tools-capped snapshot as the live fan-out (subscribeAll below,
      // throttled ~1/s in the tracker) so the initial write isn't uncapped.
      await stream.writeSSE({ event: "agent_runs", data: JSON.stringify(agentStatus.snapshotAll()) });

      // Subscribe to live updates
      let alive = true;
      const unsubscribeProgress = agentStatus.subscribeProgress(async (progress) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "request_progress", data: JSON.stringify(progress) });
        } catch {
          alive = false;
        }
      }, viewer);
      const unsubscribeAllRuns = agentStatus.subscribeAll(async (runs) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "agent_runs", data: JSON.stringify(runs) });
        } catch {
          alive = false;
        }
      });
      const unsubscribeStatus = agentStatus.subscribe(async (status) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "agent_status", data: JSON.stringify(status) });
        } catch {
          alive = false;
        }
      }, viewer);
      const unsubscribe = activityLog.subscribe(async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "activity", data: JSON.stringify(event) });
          await stream.writeSSE({ event: "stats", data: JSON.stringify(activityLog.stats) });
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      // Wait until the stream is aborted
      stream.onAbort(() => {
        alive = false;
        unsubscribe();
        unsubscribeStatus();
        unsubscribeProgress();
        unsubscribeAllRuns();
        clearInterval(heartbeat);
      });

      // Keep the stream open (cleanup handled in onAbort)
      while (alive) {
        await Bun.sleep(1000);
      }
    });
  });
}

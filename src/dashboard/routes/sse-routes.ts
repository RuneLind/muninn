import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { activityLog } from "../../observability/activity-log.ts";
import { agentStatus } from "../../observability/agent-status.ts";
import { requireOwnUser, sessionRole } from "../../auth/guard.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "sse");

/** Warn-once: the client retries this every ~3s per tab, and a per-request line
 *  would bury the log it is meant to make legible. */
let warnedRoleDenial = false;
export function __resetSseWarningsForTest(): void {
  warnedRoleDenial = false;
}

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
     * own answer (it needs owner scoping, not a viewer parameter).
     *
     * `viewer` is a CLAIMED IDENTITY under a name the `:userId` greps do not
     * match, which is how it survived PR C's first cut: `?viewer=<colleague>`
     * yielded that person's live run metadata including its `traceId`, and
     * `GET /api/prompts/:traceId` expands a traceId into their whole assembled
     * prompt. It goes through the same guard as every other claimed id — the
     * param verbatim with auth off, the session id otherwise, 403 on a
     * present-and-differing claim — so the operator's unfiltered stream is
     * unchanged in the mode the dashboard actually runs in.
     */
    const own = requireOwnUser(c, c.req.query("viewer"));
    if (!own.ok) return own.response;
    const viewer = own.userId || undefined;

    /**
     * PR D denies this route to role `user` — directly, not through a zone entry.
     *
     * The `viewer` guard above scopes exactly TWO of the four channels. The other
     * two are the leak: `activity` replays 50 events carrying the **full message
     * text** of every turn on the instance, and `agent_runs` is
     * `agentStatus.snapshotAll()` — every run process-wide with `username`,
     * `traceId` and tool inputs. `EventSource` delivers all of them over the wire
     * whatever the page chooses to read, so "the chat page only registers two
     * handlers" was never a fix; the chat page now consumes `GET /chat/events`
     * instead, which serves those two channels and nothing else.
     *
     * A per-route check rather than a zone entry, because the zone model is
     * DEFERRED: "moves to the admin zone" would leave this route wide open to any
     * authenticated caller. `sessionRole` answers `null` with auth off — no
     * middleware is mounted — so today's operator dashboard is untouched.
     *
     * ⚠️ The consequence on an authenticating instance, stated because the
     * operator will meet it: `resolveRole` answers `user` for a `local` identity
     * unconditionally, so on `MUNINN_AUTH=local` this route is denied to
     * EVERYONE, and the dashboard's own activity feed, `/agents` live zone and
     * connection indicator stop updating. That is the deferred zone model's
     * shape arriving early, not a bug — the durable fix is the admin role, which
     * cannot exist in `local` mode without making this campaign's central
     * acceptance pass without the diff (see `role.ts`).
     *
     * **What the two consumers actually do, measured rather than reasoned about**
     * (`views/components/connection.ts` and `views/agents-page.ts`, the only two
     * `EventSource`/`sseClient` sites in `src/`): a 403 fails an `EventSource`
     * PERMANENTLY. Measured in Chromium against a canned 403 — `readyState` is
     * `2` (CLOSED) and exactly ONE request is made in nine seconds — because the
     * spec reconnects on a transport error but not on a non-200. So those pages
     * settle into "Disconnected" with every live element frozen; they do not
     * hammer, and `loadOverview()` still fills the static half.
     *
     * That is also why the WARN below matters: the operator gets a stalled page
     * and, without it, no log line at all. Warn-once anyway, the `middleware.ts`
     * / `origin.ts` discipline — one line per tab-open is still one line too
     * many across a working day.
     */
    if (sessionRole(c) === "user") {
      if (!warnedRoleDenial) {
        warnedRoleDenial = true;
        log.warn(
          "Refused GET /api/events for role `user` — the operator stream carries every user's message " +
          "text and a process-wide agent_runs snapshot. On MUNINN_AUTH=local EVERY identity is role " +
          "`user` (the loopback bypass included), so the dashboard's activity feed and /agents live " +
          "zone will show Disconnected and stop updating until the deferred zone model lands. The " +
          "chat page is unaffected: it uses /chat/events.",
        );
      }
      return c.json(
        { error: "forbidden", reason: "operator stream; use /chat/events for your own runs" },
        403,
      );
    }
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

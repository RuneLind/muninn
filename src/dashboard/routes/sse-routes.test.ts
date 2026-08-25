import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSSERoutes } from "./sse-routes.ts";
import { agentStatus } from "../../observability/agent-status.ts";

/**
 * The wiring half of PR A acceptance 1 + 2.
 *
 * `agent-status.test.ts` proves the tracker's reads are per-subscriber; this
 * proves the ONE route that fans them out actually passes the viewer through —
 * on all four writes (initial `agent_status`, initial `request_progress`, and
 * both live subscriptions), which is where a filter gets forgotten.
 *
 * It also pins the other half: `agent_runs` is NOT scoped. That event is the
 * operator's `/agents` feed, and a filter applied there would pass every
 * "A cannot see B" assertion in this repo while emptying that page.
 */

/** Read the stream's opening frames, then cancel — the route holds it open. */
async function openFrames(app: Hono, path: string): Promise<string> {
  const res = await app.request(path);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    // `agent_runs` is the LAST of the initial writes, so it is the stop signal.
    // The activity replay in front of it is up to 50 frames long and shared with
    // every other test in the chunk, so this cannot be a small fixed count —
    // that is exactly how this test passed alone and failed in the suite.
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: agent_runs") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

/** The JSON payload of the first `event: <name>` frame in an SSE chunk. */
function frame(text: string, name: string): unknown {
  const match = new RegExp(`event: ${name}\\ndata: (.*)\\n`).exec(text);
  if (!match) throw new Error(`no ${name} frame in:\n${text}`);
  return JSON.parse(match[1]!);
}

function appWithRoutes(): Hono {
  const app = new Hono();
  registerSSERoutes(app);
  return app;
}

describe("GET /api/events — the viewer parameter", () => {
  test("a viewer's stream opens on their own run, never a neighbour's", async () => {
    agentStatus.clearRequest();
    agentStatus.startRequest("jarvis", "calling_claude", "bob", { userId: "user-b" });
    const aRun = agentStatus.startRequest("jarvis", "calling_claude", "alice", { userId: "user-a" });
    agentStatus.set("calling_claude", "bob", "searching", { userId: "user-b" });

    const text = await openFrames(appWithRoutes(), "/api/events?viewer=user-a");

    expect((frame(text, "request_progress") as { requestId: string }).requestId).toBe(aRun);
    // Bob's phase is the most recent one set, so an unscoped read would show it.
    expect(frame(text, "agent_status")).toEqual({ phase: "idle" });

    agentStatus.clearRequest();
  });

  test("a viewer with nothing running gets an empty waterfall, not someone else's", async () => {
    agentStatus.clearRequest();
    agentStatus.startRequest("jarvis", "calling_claude", "bob", { userId: "user-b" });

    const text = await openFrames(appWithRoutes(), "/api/events?viewer=user-a");
    expect(frame(text, "request_progress")).toBeNull();

    agentStatus.clearRequest();
  });

  test("no viewer ⇒ the operator stream is unchanged", async () => {
    agentStatus.clearRequest();
    const bRun = agentStatus.startRequest("jarvis", "calling_claude", "bob", { userId: "user-b" });
    agentStatus.set("calling_claude", "bob", "searching", { userId: "user-b" });

    const text = await openFrames(appWithRoutes(), "/api/events");

    expect((frame(text, "request_progress") as { requestId: string }).requestId).toBe(bRun);
    expect((frame(text, "agent_status") as { phase: string }).phase).toBe("calling_claude");

    agentStatus.clearRequest();
  });

  test("agent_runs stays whole for a scoped viewer — /agents must not empty", async () => {
    agentStatus.clearRequest();
    agentStatus.startRequest("jarvis", "calling_claude", "bob", { userId: "user-b" });
    agentStatus.startRequest("jarvis", "calling_claude", "alice", { userId: "user-a" });
    agentStatus.startRequest("jarvis", "running_watcher", "email", { kind: "watcher" });

    const text = await openFrames(appWithRoutes(), "/api/events?viewer=user-a");
    expect(frame(text, "agent_runs")).toHaveLength(3);

    agentStatus.clearRequest();
  });

  test("an empty viewer param is treated as absent, not as a user named ''", async () => {
    agentStatus.clearRequest();
    const bRun = agentStatus.startRequest("jarvis", "calling_claude", "bob", { userId: "user-b" });

    const text = await openFrames(appWithRoutes(), "/api/events?viewer=");
    expect((frame(text, "request_progress") as { requestId: string }).requestId).toBe(bRun);

    agentStatus.clearRequest();
  });
});

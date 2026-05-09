import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Tracer } from "../tracing/index.ts";
import type { Platform } from "../types.ts";
import type { LogProps } from "./message-processor.ts";
import { handleProcessError, lastCompletedPhase } from "./process-error.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus } from "../dashboard/agent-status.ts";

interface TracerOpts {
  totalMs?: number;
  summary?: Record<string, number>;
}

function recordingTracer(opts: TracerOpts = {}) {
  const errored: unknown[] = [];
  const tracer: Pick<Tracer, "error" | "totalMs" | "summary"> = {
    error(err) { errored.push(err); },
    totalMs() { return opts.totalMs ?? 0; },
    summary() { return opts.summary ?? {}; },
  };
  return { tracer: tracer as Tracer, errored };
}

const baseProps = {
  botName: "testbot",
  userId: "U1",
  username: "alice",
  platform: "slack_dm",
} satisfies LogProps;

function callParams(over: Partial<Parameters<typeof handleProcessError>[0]> = {}) {
  return {
    error: new Error("boom"),
    tracer: recordingTracer().tracer,
    externalTracer: false,
    platform: "slack_dm" as Platform,
    say: mock(async (_: string) => {}),
    userId: "U1",
    username: "alice",
    botName: "testbot",
    logProps: baseProps,
    ...over,
  };
}

describe("handleProcessError", () => {
  let activitySpy: ReturnType<typeof spyOn>;
  let clearSpy: ReturnType<typeof spyOn>;
  let setSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    activitySpy = spyOn(activityLog, "push");
    clearSpy = spyOn(agentStatus, "clearRequest");
    setSpy = spyOn(agentStatus, "set");
  });

  afterEach(() => {
    activitySpy.mockRestore();
    clearSpy.mockRestore();
    setSpy.mockRestore();
  });

  test("clears the active request and resets agent status to idle", async () => {
    await handleProcessError(callParams());
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith("idle");
  });

  test("calls tracer.error with the original Error when externalTracer is false", async () => {
    const { tracer, errored } = recordingTracer();
    const err = new Error("boom");
    await handleProcessError(callParams({ error: err, tracer }));
    expect(errored).toEqual([err]);
  });

  test("stringifies non-Error throwables before passing to tracer.error", async () => {
    const { tracer, errored } = recordingTracer();
    await handleProcessError(callParams({ error: "plain string", tracer }));
    expect(errored).toEqual(["plain string"]);
  });

  test("skips tracer.error when caller owns the tracer lifecycle", async () => {
    const { tracer, errored } = recordingTracer();
    await handleProcessError(callParams({ tracer, externalTracer: true }));
    expect(errored).toEqual([]);
  });

  test("records the error in the activity feed with caller identity", async () => {
    await handleProcessError(callParams({ error: new Error("disk full") }));
    expect(activitySpy).toHaveBeenCalledTimes(1);
    expect(activitySpy).toHaveBeenCalledWith("error", "disk full", {
      userId: "U1",
      username: "alice",
      botName: "testbot",
    });
  });

  describe("user-facing error message", () => {
    test("HTML-escapes the error message on Telegram", async () => {
      const say = mock(async (_: string) => {});
      await handleProcessError(callParams({
        error: new Error("<script>oops"),
        platform: "telegram",
        say,
      }));
      expect(say).toHaveBeenCalledWith("Something went wrong: &lt;script&gt;oops");
    });

    test("passes raw text through on Slack (mrkdwn handles its own escaping)", async () => {
      const say = mock(async (_: string) => {});
      await handleProcessError(callParams({
        error: new Error("<script>oops"),
        platform: "slack_dm",
        say,
      }));
      expect(say).toHaveBeenCalledWith("Something went wrong: <script>oops");
    });

    test("coerces non-Error throwables via String() for the user message", async () => {
      const say = mock(async (_: string) => {});
      await handleProcessError(callParams({
        error: { code: 42 },
        platform: "slack_dm",
        say,
      }));
      expect(say).toHaveBeenCalledWith("Something went wrong: [object Object]");
    });

    test("swallows say() rejections so the cleanup path still resolves", async () => {
      const say = mock(async (_: string) => { throw new Error("send failed"); });
      await expect(
        handleProcessError(callParams({ platform: "telegram", say })),
      ).resolves.toBeUndefined();
    });
  });
});

describe("lastCompletedPhase", () => {
  test("returns 'unknown' for an empty summary", () => {
    expect(lastCompletedPhase({})).toBe("unknown");
  });

  test("returns 'unknown' when every entry is null/undefined", () => {
    expect(lastCompletedPhase({ a: undefined, b: undefined })).toBe("unknown");
  });

  test("returns the last key with a defined duration in insertion order", () => {
    const summary: Record<string, number | undefined> = {};
    summary.prompt_build = 12;
    summary.claude = 340;
    summary.db_save_response = 4;
    expect(lastCompletedPhase(summary)).toBe("db_save_response");
  });

  test("skips trailing undefined entries when finding the last completed phase", () => {
    const summary: Record<string, number | undefined> = {};
    summary.prompt_build = 12;
    summary.claude = 340;
    summary.db_save_response = undefined;
    summary.send = undefined;
    expect(lastCompletedPhase(summary)).toBe("claude");
  });

  test("treats 0ms as a completed phase (a phase that took ~0ms still ran)", () => {
    expect(lastCompletedPhase({ prompt_build: 12, db_save_response: 0 })).toBe("db_save_response");
  });
});

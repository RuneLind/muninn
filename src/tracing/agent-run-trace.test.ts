import { test, expect, describe } from "bun:test";
import { finishAgentRunTrace } from "./agent-run-trace.ts";

function recorder() {
  const finishes: Array<{ status: string; attrs?: Record<string, unknown> }> = [];
  return {
    finishes,
    tracer: { finish: (status: "ok" | "error" = "ok", attrs?: Record<string, unknown>) => void finishes.push({ status, attrs }) },
  };
}

describe("finishAgentRunTrace", () => {
  test("stamps the run's kind and name beside the caller's attributes", () => {
    const { tracer, finishes } = recorder();
    finishAgentRunTrace(tracer, { kind: "digest", name: "Wiki digest: w" }, "ok", { inputTokens: 3, wiki: "w" });
    expect(finishes).toEqual([
      { status: "ok", attrs: { inputTokens: 3, wiki: "w", agentKind: "digest", agentName: "Wiki digest: w" } },
    ]);
  });

  test("a caller's attributes cannot overwrite the stamp", () => {
    const { tracer, finishes } = recorder();
    finishAgentRunTrace(tracer, { kind: "capture", name: "real" }, "error", { agentKind: "chat", agentName: "wrong" });
    expect(finishes[0]!.attrs).toEqual({ agentKind: "capture", agentName: "real" });
  });

  test.each([[undefined], [null]])("with no run (%p) it is a plain finish, carrying no stamp", (run) => {
    const { tracer, finishes } = recorder();
    finishAgentRunTrace(tracer, run, "ok", { source: "youtube" });
    expect(finishes).toEqual([{ status: "ok", attrs: { source: "youtube" } }]);
  });
});

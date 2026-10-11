import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  AGENT_CLIENT_DEADLINE_MS,
  agentBodyHtml,
  agentCardUrl,
  agentCutText,
  agentLiveText,
  agentMetaText,
  fetchAgentCard,
} from "./wiki-agent-pane.ts";
import { PLAN_CARD_MAX_WAITING, PLAN_CARD_TIMEOUT_MS } from "../../../wiki/plan-card-bounds.ts";
import { RUN_PROC_KILL_GRACE_MS, RUN_PROC_POST_KILL_WAIT_MS } from "../../../utils/run-proc-bounds.ts";

describe("Agent pane, the pure half", () => {
  test("the route URL leaves blank inputs out", () => {
    expect(agentCardUrl("mimir", "plans/a b.mdx", "", " ")).toBe("/api/wiki/plan-card?wiki=mimir&relPath=plans%2Fa+b.mdx");
    expect(agentCardUrl("", "p.mdx", "2026-10-07", "D7")).toBe("/api/wiki/plan-card?relPath=p.mdx&since=2026-10-07&id=D7");
  });
  test("chars against the 12k cap", () => {
    expect(agentMetaText({ text: "", chars: 8321, cuts: [], ms: 1234 })).toBe("8,321 / 12,000 chars · 1.2 s");
    expect(agentMetaText({ text: "", chars: 12001, cuts: [], ms: 0 })).toBe("12,001 / 12,000 chars (over the cap) · 0.0 s");
  });
  test("a cut row names the section, the range and the pointer", () => {
    expect(agentCutText({ section: "brief", pointer: "Brief continues, sed -n 9,20p /w/p.mdx", start: 9, end: 20, file: "/w/p.mdx" })).toBe(
      "brief L9-20 p.mdx — Brief continues, sed -n 9,20p /w/p.mdx",
    );
    expect(agentCutText({ section: "sessions", pointer: "rerun with --full" })).toBe("sessions — rerun with --full");
    // plan-card's log cut and capped reference list: single lines, no range.
    expect(agentCutText({ section: "log", pointer: "3 more lines name D7", lines: [3464, 3476, 3484], file: "/w/log.md" })).toBe(
      "log L3464, L3476, L3484 log.md — 3 more lines name D7",
    );
  });
  test("the card's <pre> is left empty for textContent: the HTML parser drops a leading newline", () => {
    const html = agentBodyHtml({ kind: "ok", card: { text: "\n# T\n<Fold>", chars: 1, cuts: [], ms: 0 } });
    expect(html).toContain('<pre class="wiki-agent-text"></pre>');
    expect(html).not.toContain("Fold");
    expect(agentBodyHtml({ kind: "error", status: 501, message: "<b>" })).toContain("plan-card failed (501): &#60;b&#62;");
  });
  test("a language: no wiki gets Norwegian words", () => {
    expect(agentMetaText({ text: "", chars: 8321, cuts: [], ms: 1234 }, "no")).toBe(`${(8321).toLocaleString("nb-NO")} / ${(12000).toLocaleString("nb-NO")} tegn · 1,2 s`);
    expect(agentBodyHtml({ kind: "loading" }, "no")).toContain("Kjører plan-card…");
    expect(agentBodyHtml({ kind: "error", status: 0, message: "x" }, "no")).toContain("plan-card feilet (nettverk): x");
    expect(agentBodyHtml({ kind: "ok", card: { text: "t", chars: 1, cuts: [], ms: 0 } }, "no")).toContain("Ingen seksjon er kuttet.");
    expect(agentBodyHtml({ kind: "ok", card: { text: "t", chars: 1, cuts: [{ section: "a", pointer: "p" }, { section: "b", pointer: "q" }], ms: 0 } }, "no")).toContain("2 kuttede seksjoner");
  });
  test("the live line is one short sentence per state, never the card", () => {
    const card = { text: "# T\n" + "x".repeat(5000), chars: 8321, cuts: [], ms: 0 };
    expect(agentLiveText({ kind: "ok", card })).toBe("plan-card done: 8,321 chars");
    expect(agentLiveText({ kind: "loading" }, "no")).toBe("Kjører plan-card…");
    expect(agentLiveText({ kind: "error", status: 504, message: "slow" })).toBe("plan-card failed (504): slow");
    expect(agentLiveText({ kind: "idle" })).toBe("");
    // The body no longer announces itself: the error is said once, by the live line.
    expect(agentBodyHtml({ kind: "error", status: 504, message: "slow" })).not.toContain("role=");
  });
});

describe("Agent pane: the client deadline", () => {
  afterEach(() => jest.useRealTimers());

  /** A fetch that answers only when aborted, as a request queued on the server does. */
  const hanging: typeof fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;

  test("covers a request queued behind the most runs the route admits, then its own run", () => {
    const runMax = PLAN_CARD_TIMEOUT_MS + RUN_PROC_KILL_GRACE_MS + RUN_PROC_POST_KILL_WAIT_MS;
    expect(AGENT_CLIENT_DEADLINE_MS).toBeGreaterThan((PLAN_CARD_MAX_WAITING + 1) * runMax);
    // A run queued behind another argument set answered after 31 s on a real server.
    expect(AGENT_CLIENT_DEADLINE_MS).toBeGreaterThan(31_023);
  });

  test("no answer by the deadline aborts the request and ends in an error naming it", async () => {
    jest.useFakeTimers();
    const ctrl = new AbortController();
    let settled = false;
    const run = fetchAgentCard("/api/wiki/plan-card?relPath=p.mdx", ctrl, { fetchImpl: hanging }).then((s) => {
      settled = true;
      return s;
    });
    jest.advanceTimersByTime(AGENT_CLIENT_DEADLINE_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    // Settles within microtasks of the deadline; awaiting `run` outright would
    // hang (not fail) if the timer stopped aborting, since timers are fake.
    for (let i = 0; i < 20 && !settled; i++) await Promise.resolve();
    expect(settled).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    const state = await run;
    expect(state).toEqual({ kind: "error", status: 0, message: `no answer within ${Math.round(AGENT_CLIENT_DEADLINE_MS / 1000)} s` });
  });

  test("an abort from outside (a newer run, a navigation) ends in null, not an error", async () => {
    const ctrl = new AbortController();
    const run = fetchAgentCard("/x", ctrl, { fetchImpl: hanging });
    ctrl.abort();
    expect(await run).toBeNull();
  });
});


import { expect, test } from "bun:test";
import {
  PEEK_FILES_MAX,
  TRACE_POLL_MAX_FAILURES,
  TRACE_POLL_MAX_MS,
  TRACE_POLL_MS,
  TRACE_READ_PERMANENT_REASONS,
  TRACE_RUNNING_STATUS,
  keyPeekHtml,
  traceBodyHtml,
  tracePollStep,
  traceReadOf,
  traceReadTransient,
  traceStatusFrom,
  traceTimelineHtml,
  traceTurnHtml,
  traceTurnsFromThread,
  type TracePollStep,
  type TraceThreadMessage,
} from "./wiki-key-trace-model.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";

const body = (over: Partial<MentionsBody> = {}): MentionsBody => ({
  key: "MEL-77",
  kind: "case",
  files: Array.from({ length: 6 }, (_, i) => ({ relPath: `plans/p${i}.mdx`, title: i === 0 ? "Ferry <plan>" : null, lines: [{ n: i + 1, text: `MEL-77 line ${i}` }] })),
  commits: [
    { sha: "aaaaaaa1111", date: "2026-11-02T10:00:00Z", subject: "Older commit", files: ["plans/p1.mdx"] },
    { sha: "bbbbbbb2222", date: "2026-11-20T10:00:00Z", subject: "Newer commit", files: ["plans/p0.mdx"] },
  ].reverse(),
  log: [{ date: "2026-11-10", kind: "plan", line: "- MEL-77 filed", n: 9 }],
  prs: [
    { repo: "acme/acme-api", number: 3, state: "merged", mergedAt: "2026-11-15T08:00:00Z", url: "https://github.com/acme/acme-api/pull/3", stale: false },
    { repo: "acme/acme-web", number: 4, state: "not-checked", mergedAt: null, url: "https://github.com/acme/acme-web/pull/4", stale: false, reason: "sso" },
  ],
  totalLines: 40,
  totalFiles: 9,
  logTotalLines: 1,
  totalsAtLeast: true,
  truncated: true,
  ...over,
});

test("the peek reads the route's totals (not the listed lines), the last change, a few files, PR states with a reason, and «Trace»", () => {
  const html = keyPeekHtml(body(), { trace: true });
  expect(html).toContain("40+ lines in 9+ files · last changed 2026-11-20 · 1 log.md line");
  expect(html).toContain("Ferry &lt;plan&gt;");
  expect(html.match(/<li>/g)!.length).toBe(PEEK_FILES_MAX);
  expect(html).toContain("and 5+ more");
  expect(html).toContain('<span data-pr-state="merged">acme-api#3 merged</span>');
  expect(html).toContain("acme-web#4 not checked (sso)");
  expect(html).toContain('data-key-trace="MEL-77"');
  expect(keyPeekHtml(body({ files: [], totalFiles: 0, totalLines: 0, totalsAtLeast: false }), { trace: false })).toContain("Named in no tracked file.");
});

test("the timeline: commits, log lines and merged PRs, newest first", () => {
  const html = traceTimelineHtml(body());
  const kinds = [...html.matchAll(/data-trace-ev="(\w+)"><span class="wiki-sel-d">([\d-]+)/g)].map((m) => `${m[2]} ${m[1]}`);
  expect(kinds).toEqual(["2026-11-20 commit", "2026-11-15 pr", "2026-11-10 log", "2026-11-02 commit"]);
  expect(traceTimelineHtml(body({ commits: [], log: [], prs: [] }))).toContain("No commit, log.md line or merged PR");
});

test("the Trace body: mentions and timeline at once; the discussion controls only with an agent", () => {
  const opts = { currentRelPath: "plans/p0.mdx", hrefFor: (r: string) => `/wiki?relPath=${r}` };
  const on = traceBodyHtml(body(), { ...opts, agent: true });
  expect(on).toContain('data-trace-sec="mentions"');
  expect(on).toContain('data-trace-sec="timeline"');
  expect(on).toContain("data-trace-summarize");
  expect(on).toContain("data-trace-continue");
  // PR rows are under the timeline only.
  expect(on.split("wiki-sel-prs").length - 1).toBe(1);
  const off = traceBodyHtml(body(), { ...opts, agent: false });
  expect(off).not.toContain("data-trace-summarize");
});

test("a turn: the question escaped, a status while it runs, an error as an alert", () => {
  expect(traceTurnHtml({ question: "<q>", answerHtml: "", state: "running", status: "Working: mentions", turnId: null })).toContain("&lt;q&gt;");
  expect(traceTurnHtml({ question: "q", answerHtml: "", state: "running", status: "Working: mentions" })).toContain("Working: mentions");
  expect(traceTurnHtml({ question: "q", answerHtml: "nope", state: "error", turnId: "t1" })).toContain('role="alert">nope');
});

// Fix round 1 K2, K3: the read-back builds turns from their ledger rows.
const row = (id: string, seq: number, endState: string, o: { answer?: string; error?: string | null; assistantMessageId?: string | null } = {}) => ({
  id,
  seq,
  question: `Q${seq}`,
  answer: o.answer ?? "",
  endState,
  error: o.error ?? null,
  assistantMessageId: o.assistantMessageId ?? null,
});
const msg = (id: string, role: string, content: string, turn: TraceThreadMessage["turn"] = null): TraceThreadMessage => ({ id, role, content, turn });

test("read-back turns: each row's endState, its answer by the assistant message id, a running turn with no answer, none matched by position", () => {
  const messages = [
    // Turn 1's answer message was never stored: the row's own answer.
    msg("u1", "user", "Q1", row("t1", 1, "done", { answer: "A1 from the row" })),
    msg("u2", "user", "Q2", row("t2", 2, "error", { answer: "partial", error: "connector broke", assistantMessageId: "a2" })),
    msg("a2", "assistant", "partial\n\n(unfinished)"),
    msg("u3", "user", "Q3", row("t3", 3, "timeout", { assistantMessageId: "a3" })),
    msg("a3", "assistant", "(unfinished)"),
    msg("u4", "user", "Q4", row("t4", 4, "done", { answer: "A4 row", assistantMessageId: "a4" })),
    msg("a4", "assistant", "A4 stored"),
    msg("u5", "user", "Q5", row("t5", 5, "running")),
  ];
  expect(traceTurnsFromThread(messages)).toEqual([
    { question: "Q1", text: "A1 from the row", state: "done", turnId: "t1" },
    { question: "Q2", text: "The turn failed. connector broke", state: "error", turnId: "t2" },
    { question: "Q3", text: "The turn ran past its time limit and was stopped.", state: "error", turnId: "t3" },
    { question: "Q4", text: "A4 stored", state: "done", turnId: "t4" },
    { question: "Q5", text: "", state: "running", status: TRACE_RUNNING_STATUS, turnId: "t5" },
  ]);
});

test("read-back turns: in seq order whatever the message order, one per row, an abandoned row an error, a message with no row left out", () => {
  const messages = [
    msg("u2", "user", "Q2", row("t2", 2, "abandoned")),
    msg("x", "assistant", "stray answer with no row"),
    msg("u1", "user", "Q1", row("t1", 1, "done", { assistantMessageId: "a1" })),
    msg("a1", "assistant", "A1", row("t1", 1, "done", { assistantMessageId: "a1" })),
  ];
  expect(traceTurnsFromThread(messages).map((t) => `${t.turnId}:${t.state}:${t.text}`)).toEqual(["t1:done:A1", "t2:error:The turn was abandoned: its run stopped before it ended."]);
});

test("the poll's next step: a running turn reads again at the poll interval, an ended one stops (fix round 2 batch 4)", () => {
  expect(tracePollStep({ kind: "thread", running: true }, 3)).toEqual({ next: "again", delayMs: TRACE_POLL_MS, failures: 0 });
  expect(tracePollStep({ kind: "thread", running: false }, 3)).toEqual({ next: "stop" });
});

test("the poll's next step: a network failure, a 5xx, 408 or 429 reads again with a doubling wait, capped, and ends the turn past the bound", () => {
  const steps: TracePollStep[] = [];
  let failures = 0;
  for (let i = 0; i <= TRACE_POLL_MAX_FAILURES; i++) {
    const step = tracePollStep(i % 2 ? { kind: "refused", status: 503 } : { kind: "unreachable" }, failures);
    steps.push(step);
    if (step.next === "again") failures = step.failures;
  }
  const waits = steps.flatMap((s) => (s.next === "again" ? [s.delayMs] : []));
  expect(waits).toEqual([1500, 3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  expect(Math.max(...waits)).toBe(TRACE_POLL_MAX_MS);
  expect(steps.at(-1)).toEqual({ next: "failed", message: "The thread could not be read: the server did not answer, so the turn's end is not known." });
  for (const status of [500, 502, 408, 429]) expect(tracePollStep({ kind: "refused", status }, 0)).toEqual({ next: "again", delayMs: TRACE_POLL_MS, failures: 1 });
  expect(tracePollStep({ kind: "refused", status: 502 }, TRACE_POLL_MAX_FAILURES)).toEqual({ next: "failed", message: "The thread could not be read (502): the turn's end is not known." });
});

test("the poll's next step: a thread that is gone, a 404 or another refusal ends the poll at once, whatever failed before", () => {
  expect(tracePollStep({ kind: "gone" }, 2)).toEqual({ next: "gone" });
  expect(tracePollStep({ kind: "refused", status: 404, error: "trace-off" }, 0)).toEqual({ next: "failed", message: "trace-off (404)." });
  expect(tracePollStep({ kind: "refused", status: 422 }, 5)).toEqual({ next: "failed", message: "The thread could not be read (422)." });
});

// ── Class check C: the read's classification, row by row ────────────────────

/** [status, reason, read again?]: by the route's reason where it sends one it knows, else by status. */
const READ_CLASSES: [number, string | undefined, boolean][] = [
  [400, undefined, false],
  [403, undefined, false],
  [404, "trace-off", false],
  [404, undefined, false],
  [408, undefined, true],
  [409, undefined, false],
  [418, undefined, false],
  [422, "unknown-user", false],
  [422, "no-user", false],
  [429, undefined, true],
  [500, undefined, true],
  [502, undefined, true],
  [503, "no-bot", false],
  [503, undefined, true],
  [503, "draining", true],
  [504, undefined, true],
];

for (const [status, reason, again] of READ_CLASSES) {
  test(`class check C: a ${status}${reason ? ` ${reason}` : ""} read is ${again ? "read again" : "permanent"}`, () => {
    expect(traceReadTransient({ status, ...(reason ? { reason } : {}) })).toBe(again);
    const step = tracePollStep({ kind: "refused", status, error: "route says", ...(reason ? { reason } : {}) }, 5);
    expect(step).toEqual(again ? { next: "again", delayMs: 30000, failures: 6 } : { next: "failed", message: `route says (${status}).` });
  });
}

test("class check C: every reason the thread read sends is permanent, the 503 no-bot among them", () => {
  expect([...TRACE_READ_PERMANENT_REASONS].sort()).toEqual(["no-bot", "no-user", "trace-off", "unknown-user"]);
  expect(tracePollStep({ kind: "refused", status: 503, error: "no bot answers on this wiki here", reason: "no-bot" }, 0)).toEqual({ next: "failed", message: "no bot answers on this wiki here (503)." });
});

test("class check C: an answer that is no thread is read again, and past the bound says so; a transient refusal past it keeps the route's words", () => {
  expect(tracePollStep({ kind: "malformed" }, 0)).toEqual({ next: "again", delayMs: TRACE_POLL_MS, failures: 1 });
  expect(tracePollStep({ kind: "malformed" }, TRACE_POLL_MAX_FAILURES)).toEqual({ next: "failed", message: "The thread could not be read: the server's answer was not a thread, so the turn's end is not known." });
  expect(tracePollStep({ kind: "refused", status: 500, error: "could not read the thread" }, TRACE_POLL_MAX_FAILURES)).toEqual({ next: "failed", message: "could not read the thread (500): the turn's end is not known." });
  expect(tracePollStep({ kind: "refused", status: 500 }, TRACE_POLL_MAX_FAILURES - 1)).toEqual({ next: "again", delayMs: TRACE_POLL_MAX_MS, failures: TRACE_POLL_MAX_FAILURES });
});

test("class check C: a 200 answer is the thread, `thread: null` (gone), or no thread at all (malformed)", () => {
  const msgs: TraceThreadMessage[] = [];
  expect(traceReadOf({ thread: { id: "th" }, messages: msgs })).toEqual({ read: { kind: "thread", running: false }, thread: { id: "th", messages: msgs } });
  expect(traceReadOf({ thread: null, messages: [] })).toEqual({ read: { kind: "gone" }, thread: null });
  for (const bad of [undefined, null, "x", {}, { thread: { id: 5 }, messages: [] }, { thread: { id: "th" } }, { thread: { id: "th" }, messages: "no" }, { thread: "th", messages: [] }])
    expect([bad, traceReadOf(bad)]).toEqual([bad, { read: { kind: "malformed" }, thread: null }]);
});

test("a Trace turn's status line uses the pane's words for a phase, not «Working: <phase>»", () => {
  expect(traceStatusFrom({ phase: "mentions" }, undefined)).toBe("Reading the key's mentions…");
  expect(traceStatusFrom({ phase: "writing", text: "writing the answer" }, "x")).toBe("Writing the answer…");
  expect(traceStatusFrom({ text: "a line of its own" }, "x")).toBe("a line of its own");
  expect(traceStatusFrom({}, "kept")).toBe("kept");
});

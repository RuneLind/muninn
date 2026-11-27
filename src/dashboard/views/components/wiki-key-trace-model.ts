/**
 * The key peek and the Trace view's pure half (Discuss v2 PR 6, mimir plan
 * muninn-wiki-discuss-v2, D4 and D5): their markup from the mentions payload
 * (`GET /api/wiki/mentions`), and their styles. No model call reaches here
 * and no DOM global is read. The controller is `wiki-key-trace.ts`.
 *
 * Totals come from `totalLines`/`totalFiles`/`totalsAtLeast`, never from
 * counting `files[].lines` (the route lists a bounded part); a PR row's
 * `state` is the route's lower-case word, `not-checked` with its `reason`.
 */

import { escHtml as esc } from "./escape.ts";
import { prsHtml, whereElseHtml } from "./wiki-selection-menu-model.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";
import { KEY_MARK_CHIPPED_CLASS } from "../../../wiki/core/live-facts-chip.ts";

export const KEY_PEEK_ID = "wikiKeyPeek";
/** The question «Summarize» asks: the first turn of a key's trace thread. */
export const TRACE_SUMMARY_QUESTION =
  "Summarize this key's trace: what it is, where the wiki mentions it and what each place says about it, how it changed over time (commits, log.md lines) and the state of the PRs named.";
/** Files the peek lists before «and N more». */
export const PEEK_FILES_MAX = 4;
/** Timeline events the Trace view shows before «N more». */
export const TRACE_EVENTS_MAX = 60;

const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : "");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function totalsText(b: MentionsBody): string {
  const at = b.totalsAtLeast ? "+" : "";
  return `${b.totalLines}${at} line${b.totalLines === 1 ? "" : "s"} in ${b.totalFiles}${at} file${b.totalFiles === 1 ? "" : "s"}`;
}

const PR_WORDS: Record<string, string> = { open: "open", merged: "merged", closed: "closed", unknown: "not known yet", "not-a-pr": "not a PR", "not-checked": "not checked" };

/** The hover peek: the key, its kind, where and how often it is named, its
 *  last change, its PRs, and «Trace». `here`: the text of the item the page
 *  defines for the key (a CaseBoard row), with «Go to ↓» (fix round 1 J2:
 *  the key's peek stands in for the reference peek). */
export function keyPeekHtml(b: MentionsBody, opts: { trace: boolean; here?: string }): string {
  const last = b.commits[0];
  const files = b.files.slice(0, PEEK_FILES_MAX);
  const more = b.totalFiles - files.length;
  const prs = b.prs.slice(0, 6);
  return (
    `<div class="wiki-key-peek-head"><span class="wiki-key-peek-key">${esc(b.key)}</span>${b.kind ? ` <span class="wiki-key-peek-kind">${esc(b.kind)}</span>` : ""}</div>` +
    `<div class="wiki-key-peek-meta" data-peek-totals>${esc(totalsText(b))}${last ? ` · last changed ${esc(day(last.date))}` : ""}${b.log.length ? ` · ${b.log.length} log.md line${b.log.length === 1 ? "" : "s"}` : ""}</div>` +
    (files.length
      ? `<ul class="wiki-key-peek-files">${files.map((f) => `<li>${esc(f.title ?? f.relPath)}</li>`).join("")}${more > 0 ? `<li class="wiki-key-peek-more">and ${more}${b.totalsAtLeast ? "+" : ""} more</li>` : ""}</ul>`
      : `<div class="wiki-key-peek-meta">Named in no tracked file.</div>`) +
    (prs.length
      ? `<div class="wiki-key-peek-prs">${prs.map((p) => `<span data-pr-state="${esc(p.state)}">${esc(p.repo.split("/").pop() ?? p.repo)}#${p.number} ${esc(PR_WORDS[p.state] ?? p.state)}${p.reason ? ` (${esc(p.reason)})` : ""}</span>`).join(" · ")}</div>`
      : "") +
    (opts.here ? `<div class="wiki-key-peek-here"><span>${esc(cut(opts.here, 140))}</span> <button type="button" class="wiki-key-peek-goto" data-key-goto>Go to ↓</button></div>` : "") +
    (opts.trace ? `<button type="button" class="wiki-key-peek-trace" data-key-trace="${esc(b.key)}">🧭 Trace</button>` : "")
  );
}

/** The timeline: commits, log.md lines and PR merges, newest first. */
export function traceTimelineHtml(b: MentionsBody, max = TRACE_EVENTS_MAX): string {
  const events = [
    ...b.commits.map((c) => ({ date: day(c.date), kind: "commit", html: `${esc(cut(c.subject, 140))} <span class="wiki-sel-sha">${esc(c.sha.slice(0, 7))}</span>${c.files.length ? ` <span class="wiki-sel-path">${esc(c.files.slice(0, 3).join(", "))}${c.files.length > 3 ? ", …" : ""}</span>` : ""}` })),
    ...b.log.map((l) => ({ date: day(l.date), kind: "log", html: `<span class="wiki-sel-evk">log.md${l.kind ? ` ${esc(l.kind)}` : ""}</span> ${esc(cut(l.line.replace(/^[-*]\s+/, "").trim(), 160))}` })),
    ...b.prs.filter((p) => p.state === "merged" && p.mergedAt).map((p) => ({ date: day(p.mergedAt), kind: "pr", html: `<span class="wiki-sel-evk">PR merged</span> <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.repo)}#${p.number}</a>` })),
  ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  if (!events.length) return `<div class="wiki-sel-empty">No commit, log.md line or merged PR for «${esc(b.key)}».</div>`;
  const shown = events.slice(0, max);
  return (
    `<div class="wiki-sel-tl">` +
    shown.map((e) => `<div class="wiki-sel-ev" data-trace-ev="${e.kind}"><span class="wiki-sel-d">${esc(e.date || "—")}</span> ${e.html}</div>`).join("") +
    `</div>` +
    (events.length > shown.length || b.truncated ? `<div class="wiki-sel-meta">${events.length > shown.length ? `${events.length - shown.length} more` : "More"} not shown.</div>` : "")
  );
}

/** The Trace view's body: mentions and timeline at once (no model), then the
 *  key's thread: «Summarize» to start it, or its turns and a follow-up box. */
export function traceBodyHtml(b: MentionsBody, opts: { currentRelPath: string | null; hrefFor: (relPath: string) => string; agent: boolean }): string {
  return (
    `<div class="wiki-trace-cols">` +
    `<section class="wiki-trace-sec" data-trace-sec="mentions"><div class="wiki-trace-h">Mentions</div>${whereElseHtml({ ...b, prs: [] }, opts)}</section>` +
    `<section class="wiki-trace-sec" data-trace-sec="timeline"><div class="wiki-trace-h">Timeline</div>${traceTimelineHtml(b)}${prsHtml(b)}</section>` +
    `</div>` +
    (opts.agent
      ? `<section class="wiki-trace-sec" data-trace-sec="thread"><div class="wiki-trace-h">Discussion</div><div class="wiki-trace-turns"></div>` +
        `<div class="wiki-trace-actions"><button type="button" class="wiki-sel-card-btn" data-trace-summarize>✨ Summarize</button></div>` +
        `<form class="wiki-trace-follow" hidden><input type="text" class="wiki-trace-input" placeholder="Ask a follow-up about ${esc(b.key)}" aria-label="Follow-up question"><button type="submit" class="wiki-sel-card-btn" disabled>Send</button>` +
        `<button type="button" class="wiki-sel-card-btn" data-trace-continue title="A prompt that takes this discussion on to Claude Code (no page path)">Continue in Claude Code</button></form></section>`
      : "")
  );
}

/** One turn of the trace thread: the question, then the answer as markdown HTML. */
export function traceTurnHtml(t: { question: string; answerHtml: string; state: "running" | "done" | "error"; status?: string; turnId?: string | null }): string {
  const body =
    t.state === "error"
      ? `<div class="wiki-discuss-error" role="alert">${t.answerHtml}</div>`
      : t.answerHtml || `<div class="wiki-discuss-status"><span class="spinner"></span><span>${esc(t.status ?? "Reading the mentions…")}</span></div>`;
  return `<div class="wiki-trace-turn" data-trace-turn="${esc(t.turnId ?? "")}" data-trace-state="${t.state}"><div class="wiki-trace-q">${esc(t.question)}</div><div class="wiki-trace-a">${body}</div></div>`;
}

/** A trace thread message as `GET /api/wiki/discuss/thread?traceKey=` sends
 *  it: its ledger row on the first of the turn's messages only. */
export interface TraceThreadMessage {
  id: string;
  role: string;
  content: string;
  turn: { id: string; seq: number; question: string; answer: string; endState: string; error: string | null; assistantMessageId: string | null } | null;
}

export interface TraceTurnView {
  question: string;
  text: string;
  state: "running" | "done" | "error";
  status?: string;
  turnId: string;
}

/** How often a card showing a turn still running on the server reads the thread again. */
export const TRACE_POLL_MS = 1500;
/** The longest wait between reads after failed ones. */
export const TRACE_POLL_MAX_MS = 30_000;
/** Failed reads in a row (network, a transient status, an answer that is no thread) before the card stops reading. */
export const TRACE_POLL_MAX_FAILURES = 8;
/** The note on a card whose thread is gone (Start over, or deleted from /chat). */
export const TRACE_THREAD_GONE = "This key's trace thread is gone: it was started over or deleted. «Summarize» starts a new one.";

/** What one read of the key's thread (`GET /api/wiki/discuss/thread?traceKey=`) came back with. */
export type TraceThreadRead =
  | { kind: "thread"; running: boolean }
  | { kind: "gone" }
  | { kind: "refused"; status: number; error?: string; reason?: string }
  | { kind: "unreachable" }
  | { kind: "malformed" };

/** What the card does after a read: read again after `delayMs`, stop, show
 *  the thread gone, or end its running turns with `message`. */
export type TracePollStep =
  | { next: "again"; delayMs: number; failures: number }
  | { next: "stop" }
  | { next: "gone" }
  | { next: "failed"; message: string };

/**
 * The `reason`s the thread read refuses with (`traceThreadRead` in
 * `src/dashboard/routes/wiki-discuss.ts`, and the engine's `resolveUser`):
 * each names a setting of this instance that reading again cannot change.
 */
export const TRACE_READ_PERMANENT_REASONS: ReadonlySet<string> = new Set(["trace-off", "no-bot", "unknown-user", "no-user"]);

/**
 * Is a refused read worth reading again? By its `reason` where the route
 * sends one it knows (all permanent, the 503 `no-bot` among them), else by
 * status: 5xx, 408 and 429 are. A 503 with no reason did not come from the
 * route, whose only 503 on this read carries `no-bot`: it is the server or a
 * proxy in front of it being unavailable for now.
 */
export function traceReadTransient(read: { status: number; reason?: string }): boolean {
  if (read.reason !== undefined && TRACE_READ_PERMANENT_REASONS.has(read.reason)) return false;
  return read.status >= 500 || read.status === 408 || read.status === 429;
}

/**
 * The poll's next step (class check C): a running turn reads again at
 * {@link TRACE_POLL_MS}; a network failure, a transient refusal
 * ({@link traceReadTransient}) or an answer that is no thread again with a
 * doubling wait up to {@link TRACE_POLL_MAX_MS}, at most
 * {@link TRACE_POLL_MAX_FAILURES} in a row (`failures` counts since the last
 * read that worked or the last send); a thread that is gone or a permanent
 * refusal ends the poll with the route's own message, so a card never shows
 * «Still running» after its turn has ended.
 */
export function tracePollStep(read: TraceThreadRead, failures: number): TracePollStep {
  if (read.kind === "thread") return read.running ? { next: "again", delayMs: TRACE_POLL_MS, failures: 0 } : { next: "stop" };
  if (read.kind === "gone") return { next: "gone" };
  if (read.kind === "refused" && !traceReadTransient(read)) return { next: "failed", message: `${read.error ?? "The thread could not be read"} (${read.status}).` };
  const n = failures + 1;
  if (n > TRACE_POLL_MAX_FAILURES)
    return {
      next: "failed",
      message:
        read.kind === "refused"
          ? `${read.error ?? "The thread could not be read"} (${read.status}): the turn's end is not known.`
          : read.kind === "malformed"
            ? "The thread could not be read: the server's answer was not a thread, so the turn's end is not known."
            : "The thread could not be read: the server did not answer, so the turn's end is not known.",
    };
  return { next: "again", delayMs: Math.min(TRACE_POLL_MS * 2 ** (n - 1), TRACE_POLL_MAX_MS), failures: n };
}

/** A 200 answer of the thread read: the thread, `thread: null` (gone), or no thread at all. */
export function traceReadOf(body: unknown): { read: TraceThreadRead; thread: { id: string; messages: TraceThreadMessage[] } | null } {
  const b = body as { thread?: unknown; messages?: unknown } | null;
  if (b && typeof b === "object" && b.thread === null) return { read: { kind: "gone" }, thread: null };
  const t = b && typeof b === "object" ? (b.thread as { id?: unknown } | null | undefined) : undefined;
  if (t && typeof t === "object" && typeof t.id === "string" && Array.isArray(b!.messages))
    return { read: { kind: "thread", running: false }, thread: { id: t.id, messages: b!.messages as TraceThreadMessage[] } };
  return { read: { kind: "malformed" }, thread: null };
}

/** The status a read-back turn still running on the server shows. */
export const TRACE_RUNNING_STATUS = "Still running on the server…";
const TRACE_END_WORDS: Record<string, string> = {
  timeout: "The turn ran past its time limit and was stopped.",
  abandoned: "The turn was abandoned: its run stopped before it ended.",
};

/** The thread's turns from their ledger rows, in turn order (fix round 1
 *  K2, K3): each row's state is its `endState`, and its answer the message
 *  its `assistantMessageId` names (the row's own `answer` when that message
 *  was not stored), never a message matched by position. */
export function traceTurnsFromThread(messages: TraceThreadMessage[]): TraceTurnView[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const rows = new Map<string, NonNullable<TraceThreadMessage["turn"]>>();
  for (const m of messages) if (m.turn && !rows.has(m.turn.id)) rows.set(m.turn.id, m.turn);
  return [...rows.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((t): TraceTurnView => {
      if (t.endState === "running") return { question: t.question, text: "", state: "running", status: TRACE_RUNNING_STATUS, turnId: t.id };
      if (t.endState === "done") {
        const a = t.assistantMessageId ? byId.get(t.assistantMessageId) : undefined;
        return { question: t.question, text: a?.role === "assistant" ? a.content : t.answer, state: "done", turnId: t.id };
      }
      const words = TRACE_END_WORDS[t.endState] ?? "The turn failed.";
      return { question: t.question, text: t.error ? `${words} ${t.error}` : words, state: "error", turnId: t.id };
    });
}

export function keyTraceStyles(): string {
  return `
    .wiki-article .wiki-key:not(.${KEY_MARK_CHIPPED_CLASS}) { text-decoration: underline dotted color-mix(in srgb, var(--accent) 70%, transparent); text-underline-offset: 3px; cursor: help; }
    #${KEY_PEEK_ID} {
      position: fixed; z-index: 44; display: none; max-width: 340px; padding: 8px 10px;
      background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-secondary);
      border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22); font-size: 12.5px; line-height: 1.45;
    }
    .wiki-key-peek-head { display: flex; gap: 6px; align-items: baseline; margin-bottom: 2px; }
    .wiki-key-peek-key { font-weight: 600; font-family: var(--font-mono, monospace); }
    .wiki-key-peek-kind { font-size: 11px; color: var(--text-dim); }
    .wiki-key-peek-meta, .wiki-key-peek-prs { color: var(--text-secondary); }
    .wiki-key-peek-files { margin: 4px 0; padding-left: 16px; }
    .wiki-key-peek-more { color: var(--text-dim); list-style: none; margin-left: -16px; }
    .wiki-key-peek-here { margin-top: 4px; color: var(--text-secondary); }
    .wiki-key-peek-goto, .wiki-key-peek-trace {
      margin-top: 6px; background: transparent; border: 1px solid var(--border-primary); color: var(--accent-light);
      border-radius: 999px; padding: 2px 10px; font: inherit; cursor: pointer;
    }
    .wiki-trace-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .wiki-trace-sec { min-width: 0; }
    .wiki-trace-h { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0; }
    .wiki-trace-turn { border-top: 1px solid var(--border-secondary); padding: 6px 0; }
    .wiki-trace-q { font-weight: 600; font-size: 12.5px; margin-bottom: 4px; }
    .wiki-trace-actions, .wiki-trace-follow { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .wiki-trace-follow[hidden] { display: none; }
    /* The Discuss input's field look: --border-primary on --bg-primary barely
       showed on the card in dark mode, and the box read as plain text. */
    .wiki-trace-input { flex: 1 1 220px; min-width: 0; font: inherit; font-size: 13px; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary); }
    .wiki-trace-input:focus { outline: none; border-color: var(--accent); }
    .wiki-trace-input::placeholder { color: var(--text-dim); }
    .wiki-trace-follow .wiki-sel-card-btn:disabled { opacity: 0.5; cursor: default; }
  `;
}

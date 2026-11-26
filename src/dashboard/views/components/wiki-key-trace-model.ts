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
        `<form class="wiki-trace-follow" hidden><input type="text" class="wiki-trace-input" placeholder="Ask a follow-up about ${esc(b.key)}" aria-label="Follow-up question"><button type="submit" class="wiki-sel-card-btn">Send</button>` +
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
    .wiki-trace-input { flex: 1 1 220px; min-width: 0; font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border-primary); background: var(--bg-primary); color: var(--text-primary); }
  `;
}

/**
 * The Jira DRAFT CARD in the web chat — PURE half.
 *
 * `POST /api/jira/draft/from-thread` already runs the draft as a real turn in the
 * thread (`jira-thread-run.ts` → `processChatMessage`), so the text streams into
 * whatever tab is open. What the chat shows is the model's RAW reply, though, and
 * what `/jira` showed was `finalizeJiraDraft`'s output — fence stripped, `[n]`
 * markers repaired, `## Referanser` appended. The two surfaces disagreed, and the
 * 🧾 button's answer to that was a hand-off to a second page polling the same
 * work.
 *
 * The finalized text is delivered HERE instead, as a card appended under the
 * bubble the draft came from.
 *
 * **The message is never rewritten**, and that is the whole design. Patching
 * `messages.text` would mean: the row stored in one encoding and displayed in
 * another; `## Referanser` polluting the model's own context on the next turn;
 * `seedThreadCitations`' cited-first signal reading the server's appended link
 * list as evidence the conversation used those sources; and a first write path
 * that mutates a stored turn. A card costs one extra read and none of that.
 *
 * **Everything this module imports must be dependency-free** — it is bundled into
 * the chat page (`jira-card-browser.ts` → `jira-card-client.ts`), the
 * `jira-entry-pure.ts` pattern. `src/jira/wire.ts` is dependency-free on purpose
 * and `escape.ts` is a leaf.
 *
 * The card does NOT render the markdown itself: `jiraCardHtml` takes the body
 * HTML as a parameter, and the DOM half passes `sanitizeHtml(formatWebHtml(md),
 * true)` — the same pair the chat already uses for every bot bubble and the
 * composer's own preview. That is the cheapest faithful renderer available: it is
 * already in the page bundle, so no server round-trip and no second markdown
 * pipeline to drift. **Kopier markdown copies the RAW markdown**, byte for byte,
 * because that is what the Jira editor converts on paste.
 */

import { escHtml as esc } from "../../../dashboard/views/components/escape.ts";
import {
  JIRA_DEPTHS,
  type JiraDraftStatus,
  type JiraDraftView,
  type JiraKeyVerdict,
  type JiraMarkdownFlag,
} from "../../../jira/wire.ts";

// ── Hooks ────────────────────────────────────────────────────────────────────
// ATTRIBUTES carrying the draft id, never ids: N cards can stand in one thread,
// so a document-unique id is not available and `#id` would resolve to whichever
// one the parser saw first — the `JE_BTN_ATTR` rule.

/** `data-jira-card="<draftId>"` on the card root. */
export const JCARD_ATTR = "data-jira-card";
/** `data-jc-copy="<draftId>"` on **Kopier markdown**. */
export const JCARD_COPY_ATTR = "data-jc-copy";
/** `data-jc-save="<draftId>"` on **Lagre**. */
export const JCARD_SAVE_ATTR = "data-jc-save";
/** The one thread-level notice for drafts no card can reach. A singleton. */
export const JCARD_NOTICE_ID = "jiraCardNotice";

// ── Reader-facing copy (bokmål, like every other string on this path) ────────

export const JCARD_TITLE = "Jira-utkast";
export const JCARD_COPY_LABEL = "Kopier markdown";
export const JCARD_SAVE_LABEL = "Lagre";
export const JCARD_SAVED_LABEL = "Lagret";
export const JCARD_ARCHIVE_LABEL = "Åpne i /jira";
export const JCARD_PENDING_MESSAGE = "Skriver utkastet …";
export const JCARD_COPIED_MESSAGE = "Markdown kopiert.";
export const JCARD_COPY_FAILED_MESSAGE =
  "Kunne ikke kopiere automatisk — merk teksten i utkastet og kopier den selv.";

/** The retry, said on a failed card: the 🧾 control is the only way back in. */
export const JCARD_RETRY_HINT = "Prøv igjen med «🧾 Lag Jira-sak» på en melding i samtalen.";

/**
 * The poller gave up.
 *
 * `JIRA_POLL_MAX_MS` is the server's own `Full` budget plus its slot slack, so a
 * row still `generating` then is a row nothing is working on. Saying so beats
 * polling a dead row forever, and the archive still has whatever landed.
 */
export const JCARD_GAVE_UP_MESSAGE = "Utkastet ble ikke ferdig — se arkivet.";

/** Said when the save POST is refused and carried no readable sentence. */
export function jiraCardSaveFailedMessage(status: number): string {
  if (status === 0) return "Fikk ikke kontakt med serveren — utkastet ble ikke lagret.";
  if (status === 404) return "Utkastet finnes ikke lenger.";
  return `Kunne ikke lagre utkastet (HTTP ${status}).`;
}

/** Where a draft is read outside the conversation. */
export function jiraCardArchiveUrl(draftId: string): string {
  return `/jira?draft=${encodeURIComponent(draftId)}`;
}

// ── The listing → what the client does with each row ─────────────────────────

/** One row of `GET /api/jira/drafts?thread=<id>`. */
export interface JiraCardListRow {
  draftId: string;
  messageId: string | null;
  status: JiraDraftStatus;
}

/**
 * Does this row still need POLLING?
 *
 * **Only the LOOP is gated on this — never the read.** Every listed row is read
 * once on adopt, because the listing carries the binding and nothing else: the
 * markdown, the verdicts, the flags and `savedAt` all live on the view. Gating
 * the READ on in-flight-ness is the bug that left a finished draft with nothing
 * to render after a reload — the row was `ready`, so nothing fetched it, so the
 * card had no content and never appeared.
 *
 * A null `messageId` keeps the loop alive even on a settled row: the stamp lands
 * just after the turn, so a row can be seen `generating` with no message and
 * `ready` with one a tick later.
 *
 * **`failed` is terminal whatever the `messageId` says.** A failed run stamps no
 * message and never will — nothing is running to stamp one — so polling it was
 * 2.5 s × 13 minutes of reads answering the same thing, restarted on every
 * thread load. The thread-level notice reports it on the FIRST read instead.
 */
export function jiraCardShouldPoll(row: { status: JiraDraftStatus; messageId: string | null }): boolean {
  if (row.status === "failed") return false;
  return row.status === "generating" || !row.messageId;
}

/** Has the poll loop for a draft outlived {@link JIRA_POLL_MAX_MS}? */
export function jiraCardPollExpired(startedAtMs: number, nowMs: number, maxMs: number): boolean {
  return nowMs - startedAtMs >= maxMs;
}

// ── Badges ───────────────────────────────────────────────────────────────────

export type JiraCardBadgeTone = "ok" | "warn" | "err";

export interface JiraCardBadge {
  label: string;
  tone: JiraCardBadgeTone;
  /** The `title=` — which keys, which constructs. */
  detail: string;
}

const FLAG_LABELS: Record<string, string> = {
  html: "rå HTML",
  "wiki-markup": "wiki-markup",
  "task-list": "avkryssingsliste",
  "emoji-shortcode": "emoji-kode",
};

/**
 * The one badge line: what key verification and the paste-subset check found.
 *
 * Counts rather than rows, because the card sits inside a chat bubble and the
 * per-key table belongs on `/jira`. The three key states keep their three
 * meanings — `verified` is grounded in a retrieved issue, `notes` is amber ("you
 * wrote it, retrieval never saw it") and `unknown` is the fabricated-key case —
 * so they are three badges, never one "N problems".
 *
 * A clean draft renders the `verified` badge alone; a draft that cites nothing
 * renders no key badge at all, which is honest: there is nothing to check.
 */
export function jiraCardBadges(view: {
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
}): JiraCardBadge[] {
  const badges: JiraCardBadge[] = [];
  const verdicts = Array.isArray(view.keyVerdicts) ? view.keyVerdicts : [];
  const byState = (s: string) => verdicts.filter((v) => v.state === s);

  const verified = byState("verified");
  if (verified.length > 0) {
    badges.push({
      label: `${verified.length} ${verified.length === 1 ? "nøkkel" : "nøkler"} bekreftet`,
      tone: "ok",
      detail: verified.map((v) => v.key).join(", "),
    });
  }
  const notesOnly = byState("notes");
  if (notesOnly.length > 0) {
    badges.push({
      label: `${notesOnly.length} kun fra samtalen`,
      tone: "warn",
      detail: `Nevnt i samtalen, men ikke hentet fra kildene: ${notesOnly.map((v) => v.key).join(", ")}`,
    });
  }
  const unknown = byState("unknown");
  if (unknown.length > 0) {
    badges.push({
      label: `${unknown.length} ukjent ${unknown.length === 1 ? "nøkkel" : "nøkler"}`,
      tone: "err",
      detail: `Verken hentet eller nevnt i samtalen — kontroller før du oppretter saken: ${unknown
        .map((v) => v.key)
        .join(", ")}`,
    });
  }

  const flags = Array.isArray(view.markdownFlags) ? view.markdownFlags : [];
  if (flags.length > 0) {
    const kinds = Array.from(new Set(flags.map((f) => FLAG_LABELS[f.kind] ?? f.kind)));
    badges.push({
      label: `${flags.length} ${flags.length === 1 ? "konstruksjon" : "konstruksjoner"} som ikke limes inn`,
      tone: "warn",
      detail: `Jira-editoren konverterer ikke disse ved innliming: ${kinds.join(", ")}. Linje ${flags
        .map((f) => f.line)
        .join(", ")}.`,
    });
  }

  return badges;
}

// ── Markup ───────────────────────────────────────────────────────────────────

/** What the card needs from the view. `JiraDraftView` satisfies it. */
export type JiraCardView = Pick<
  JiraDraftView,
  | "draftId"
  | "status"
  | "template"
  | "depth"
  | "markdown"
  | "keyVerdicts"
  | "markdownFlags"
  | "savedAt"
  | "error"
  /** Not rendered — it is part of {@link jiraCardSignature}, see there. */
  | "messageId"
>;

export interface JiraCardRenderOptions {
  /**
   * The body, ALREADY rendered to HTML by the caller — see the module header.
   * Ignored on a failed card, which has no markdown by construction.
   */
  bodyHtml?: string;
  /** An inline note under the buttons (copied / save refused / gave up). */
  message?: string;
  messageTone?: "ok" | "err";
  /** True once the poll loop hit `JIRA_POLL_MAX_MS` on a still-generating row. */
  gaveUp?: boolean;
}

function depthLabel(depth: string): string {
  return JIRA_DEPTHS.find((d) => d.id === depth)?.label ?? depth;
}

/**
 * One card.
 *
 * Three shapes, and the failed one is deliberately NOT a degraded ready card:
 * with no markdown there is nothing to copy and nothing to keep, so **Kopier**
 * and **Lagre** are absent rather than disabled, and the reader is told the retry
 * is another 🧾 click. The reader-facing `error` is rendered as the server wrote
 * it (`JIRA_UNFINISHED_MESSAGE` / `JIRA_EMPTY_RESULT_MESSAGE`) — it is generic by
 * design, because the row is read back through a CORS-open GET.
 */
export function jiraCardHtml(view: JiraCardView, opts: JiraCardRenderOptions = {}): string {
  const head =
    `<div class="jira-card-head">` +
    `<span class="jira-card-title">🧾 ${esc(JCARD_TITLE)}</span>` +
    `<span class="jira-card-kind">${esc(view.template)} · ${esc(depthLabel(view.depth))}</span>` +
    `<a class="jira-card-archive" href="${esc(jiraCardArchiveUrl(view.draftId))}" target="_blank" rel="noopener">` +
    `${esc(JCARD_ARCHIVE_LABEL)} →</a>` +
    `</div>`;

  const note = opts.message
    ? `<span class="jira-card-msg${opts.messageTone === "err" ? " jira-card-msg-err" : opts.messageTone === "ok" ? " jira-card-msg-ok" : ""}">${esc(opts.message)}</span>`
    : `<span class="jira-card-msg" hidden></span>`;

  if (view.status === "failed" || (view.status !== "generating" && !view.markdown)) {
    return (
      `<div class="jira-card jira-card-failed" ${JCARD_ATTR}="${esc(view.draftId)}">` +
      head +
      `<div class="jira-card-error">${esc(view.error || "Utkastet ble ikke skrevet ferdig.")}</div>` +
      `<div class="jira-card-foot"><span class="jira-card-hint">${esc(JCARD_RETRY_HINT)}</span>${note}</div>` +
      `</div>`
    );
  }

  if (view.status === "generating") {
    const pending = opts.gaveUp ? JCARD_GAVE_UP_MESSAGE : JCARD_PENDING_MESSAGE;
    return (
      `<div class="jira-card jira-card-pending" ${JCARD_ATTR}="${esc(view.draftId)}">` +
      head +
      `<div class="jira-card-hint">${esc(pending)}</div>` +
      `</div>`
    );
  }

  const badges = jiraCardBadges(view)
    .map(
      (b) =>
        `<span class="jira-card-badge jira-card-badge-${b.tone}" title="${esc(b.detail)}">${esc(b.label)}</span>`,
    )
    .join("");

  // The keep control is a BUTTON until it is pressed and a plain mark afterwards.
  // `savedAt` comes off the row, so the mark survives a reload — which is the
  // only reason the column exists.
  const saveControl = view.savedAt
    ? `<span class="jira-card-saved" title="Lagret ${esc(new Date(view.savedAt).toLocaleString("nb-NO"))}">✓ ${esc(JCARD_SAVED_LABEL)}</span>`
    : `<button type="button" class="jira-card-btn" ${JCARD_SAVE_ATTR}="${esc(view.draftId)}">${esc(JCARD_SAVE_LABEL)}</button>`;

  return (
    `<div class="jira-card" ${JCARD_ATTR}="${esc(view.draftId)}">` +
    head +
    `<div class="jira-card-body web-content">${opts.bodyHtml ?? ""}</div>` +
    (badges ? `<div class="jira-card-badges">${badges}</div>` : "") +
    `<div class="jira-card-foot">` +
    `<button type="button" class="jira-card-btn" ${JCARD_COPY_ATTR}="${esc(view.draftId)}">${esc(JCARD_COPY_LABEL)}</button>` +
    saveControl +
    note +
    `</div>` +
    `</div>`
  );
}

/** A draft the conversation cannot show, and why. */
export interface JiraCardOrphan {
  draftId: string;
  /** `unmapped` — no assistant message was ever recorded for it.
   *  `offscreen` — it names one, but that message is outside the replayed window. */
  reason: "unmapped" | "offscreen";
}

/**
 * The ONE thread-level notice for drafts no card can reach.
 *
 * Silence is the wrong answer here: a draft that exists, cost a full turn and
 * holds real text is not made less real by the chat being unable to hang it under
 * a bubble. Two ways that happens — a run that died before its turn produced a
 * message, and a message older than the replayed history window — and both are
 * answered the same way: name the draft and link the archive.
 */
export function jiraCardNoticeHtml(orphans: JiraCardOrphan[]): string {
  if (orphans.length === 0) return "";
  const items = orphans
    .map((o) => {
      const why =
        o.reason === "unmapped"
          ? "ingen melding ble skrevet"
          : "meldingen er utenfor historikken som vises";
      return (
        `<li><a href="${esc(jiraCardArchiveUrl(o.draftId))}" target="_blank" rel="noopener">` +
        `${esc(o.draftId.slice(0, 8))}…</a> — ${esc(why)}</li>`
      );
    })
    .join("");
  return (
    `<div class="jira-card-notice" id="${JCARD_NOTICE_ID}">` +
    `<span class="jira-card-notice-head">Jira-utkast fra denne samtalen som ikke kan vises her:</span>` +
    `<ul class="jira-card-notice-list">${items}</ul>` +
    `</div>`
  );
}

/**
 * The signature a rendered card is keyed on.
 *
 * A re-render is not free: it replaces the node, which throws away a standing
 * «Markdown kopiert.» and any focus inside the card. So a card is only redrawn
 * when something a reader can SEE has changed. `updatedAt` is deliberately not
 * part of it — the runner moves it on writes that change nothing visible.
 *
 * `messageId` IS part of it, though nothing renders it: a regenerate re-points
 * the row at the new turn's bubble, and WHERE the card stands is as visible as
 * what it says. Without it the redraw was skipped and the card stayed under the
 * old reply.
 */
export function jiraCardSignature(view: JiraCardView, gaveUp?: boolean): string {
  return [
    view.status,
    view.messageId ?? "",
    view.savedAt ? "saved" : "unsaved",
    view.markdown ? String(view.markdown.length) : "0",
    view.keyVerdicts?.length ?? 0,
    view.markdownFlags?.length ?? 0,
    view.error ?? "",
    gaveUp ? "gaveup" : "",
  ].join("|");
}

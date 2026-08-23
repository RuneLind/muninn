/**
 * `/jira` — the READ-ONLY ARCHIVE's pure half: ids, markup and every decision
 * worth testing without a browser.
 *
 * The composer that used to live here is gone. A Jira task is written in the
 * melosys chat now (🧾 → a draft card under the reply), and this page is where
 * the drafts are read afterwards: a saved-first list, and one read-only render
 * per draft with **Kopier markdown**. There is no editing, no regenerate, no
 * source toggles, no PUT and no SSE — the affordances all live in the
 * conversation that produced the draft.
 *
 * **The page is SERVER-RENDERED.** Unlike the composer, everything it shows is
 * already stored: rows, verdicts, flags and the markdown itself. So the markdown
 * goes through `formatWebHtml` on the server — the SAME function the chat
 * bundle re-exports, the wiki reader's `renderAskAnswerHtml` precedent — and the
 * client bundle is left with two jobs no server can do: switching between the
 * rendered and the raw view, and copying.
 *
 * **Everything it imports must be dependency-free.** `src/jira/wire.ts` is, on
 * purpose, and `escape.ts` is a leaf — the same rule the deleted
 * `jira-composer-pure.ts` lived by, since this module is bundled for the
 * browser too.
 */

import { escHtml as esc } from "./escape.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_UNREACHABLE_MESSAGE,
  depthLabel,
  jiraArchiveUrl,
  jiraDraftTitle,
  jiraDraftUrl,
  type JiraArchiveListState,
  type JiraCoverage,
  type JiraDraftListRow,
  type JiraDraftSource,
  type JiraDraftStatus,
  type JiraDraftView,
  type JiraKeyVerdict,
  type JiraMarkdownFlag,
} from "../../../jira/wire.ts";

// ── Ids and attribute hooks ──────────────────────────────────────────────────
// Shared by the render, the bundle's delegated listeners and the tests, so the
// three cannot drift apart the way three string literals would. Plain ids are
// safe here where the chat card needs attributes: one draft renders per page.

export const JA_ROOT_ID = "jaRoot";
export const JA_COPY_ID = "jaCopy";
/** The copy button's resting label. Exported because the bundle RESTORES it
 *  after «✓ Kopiert», and a second hand-written copy is one edit from drifting. */
export const JA_COPY_LABEL = "Kopier markdown";
/** The raw-markdown pane — a read-only `<textarea>`, which is also where the
 *  copy button reads the bytes it puts on the clipboard. */
export const JA_RAW_ID = "jaRaw";
export const JA_PREVIEW_ID = "jaPreview";
/** `data-ja-view="preview|markdown"` on the two view-switch buttons. */
export const JA_VIEW_ATTR = "data-ja-view";

export type JiraArchiveView = "preview" | "markdown";

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Is the all-attempts toggle on?
 *
 * `?all=1` is the linkable spelling the page renders, and a bare `?all` and
 * `?all=true` are what a human types. Anything else is OFF rather than a 400:
 * this is a read-only listing reached from a hand-edited URL, and the two states
 * differ by which rows are hidden, not by whether anything is destroyed.
 */
export function parseArchiveAll(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "1" || v === "true";
}

/**
 * The list state every link on this page carries.
 *
 * `jiraArchiveUrl`/`jiraDraftUrl` live in `src/jira/wire.ts` — ONE builder, since
 * the chat card builds the same `/jira?draft=` path and the archive only appends
 * the list state to it. Re-exported here so the page and its tests keep reading
 * their urls from the module that renders them.
 */
export { jiraArchiveUrl, jiraDraftUrl } from "../../../jira/wire.ts";
export type { JiraArchiveListState } from "../../../jira/wire.ts";

/**
 * The chat deep link for a thread — `handleDeepLink`'s own shape.
 *
 * **`user` rides along whenever the view served one.** This page DOES know who
 * owns the thread: `threads.user_id` is joined onto `GET /api/jira/draft/:id`
 * beside the name. Leaving it off meant the chat fell back to whichever user
 * that browser last used on this bot (`muninn-chat-user-<bot>` in
 * `localStorage`, then `bot_default_user`, then the sole user) — and on a
 * multi-user install `selectThread(<id>)` then looked for the thread in the
 * wrong user's list and found nothing.
 *
 * `undefined` when the bot or the thread is missing: a link that cannot be built
 * is not rendered, rather than rendered pointing at `/chat?bot=&thread=`. A
 * missing USER is not that case — the chat's own resolution is a reasonable
 * fallback for a single-user install and for a deleted thread row.
 */
export function jiraChatUrl(
  bot: string | undefined | null,
  threadId: string | undefined | null,
  userId?: string | undefined | null,
): string | undefined {
  if (!bot || !threadId) return undefined;
  const user = (userId ?? "").trim();
  return (
    `/chat?bot=${encodeURIComponent(bot)}` +
    (user ? `&user=${encodeURIComponent(user)}` : "") +
    `&thread=${encodeURIComponent(threadId)}`
  );
}

/**
 * Only `http(s)` survives as an href.
 *
 * The urls come from huginn documents and from `verify-keys`, neither of which
 * is reader-controlled — so this is a second gate, not the first. It is here
 * because the cost is one line and the failure mode (a `javascript:` url in a
 * link the reader is invited to click) is not one the escaping catches.
 */
export function safeExternalHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export function draftStatusLabel(status: JiraDraftStatus | string): string {
  switch (status) {
    case "generating":
      return "skrives";
    case "ready":
      return "klar";
    default:
      return "feilet";
  }
}

/** The depth's reader-facing name — wire's, shared with the chat card. */
export { depthLabel } from "../../../jira/wire.ts";

/** The name to call the conversation. Falls back to the thread id — a deleted
 *  thread row leaves `threadName` null, and "samtalen «»" says nothing. */
export function threadDraftLabel(threadName: string | null, threadId: string | null): string {
  return threadName || threadId || "samtalen";
}

/**
 * `YYYY-MM-DD HH:MM`, in the SERVER's local time.
 *
 * The page is server-rendered, so there is no viewer clock to read; a UTC slice
 * would report an evening draft as the next morning for half the year. The full
 * ISO instant rides the `title=` so the exact moment is still one hover away.
 */
export function formatArchiveTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * `datetime=`/`title=` for one timestamp — or NOTHING when it is not a date.
 *
 * The same guard `formatArchiveTime` has, for the same value: `new Date(NaN)
 * .toISOString()` throws a RangeError, and these calls sit inside a row render
 * that runs inside the page's try — so one unparseable `created_at` took the
 * whole archive to the fallback page rather than dropping one stamp.
 */
function timeAttrs(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const iso = esc(d.toISOString());
  return ` datetime="${iso}" title="${iso}"`;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export type JiraNoticeTone = "warn" | "bad";

export interface JiraCoverageNotice {
  tone: JiraNoticeTone;
  text: string;
}

/**
 * Which coverage sentence a draft shows — the PAIR, never the derived verdict
 * alone.
 *
 * `jiraCoverageMessage` on the server takes only the derived verdict, and a
 * derived `no_hits` has two causes that must not be told the same way:
 *
 *   · retrieval itself found nothing (`retrievalCoverage` is `no_hits`, or null
 *     on a row whose retrieval never landed) ⇒ the corpus-had-nothing copy;
 *   · retrieval found hits and the reader switched them all off
 *     (`retrievalCoverage` is `answer`/`low_confidence`) ⇒ say THAT, because
 *     telling someone who just unticked 24 rows that jira-issues covered nothing
 *     is a false statement about the corpus.
 *
 * `answer` shows nothing at all: a grounded draft needs no banner.
 *
 * `unreachable` is a FOURTH line and is checked before everything else: it is the
 * one state where nothing can be said about the corpus at all, and it is the one
 * state that is worth retrying unchanged. `effectiveCoverage` already passes it
 * through the derived verdict, so both halves of the pair carry it.
 *
 * Moved here from the deleted `jira-composer-pure.ts` with its logic unchanged.
 * The four sentences stay constants in `src/jira/wire.ts` — one spelling, and
 * the browser half never has to reach for `retrieval.ts`.
 */
export function jiraCoverageNotice(
  retrievalCoverage: JiraCoverage | null | undefined,
  coverage: JiraCoverage | null | undefined,
  source?: JiraDraftSource,
): JiraCoverageNotice | null {
  if (!coverage || coverage === "answer") return null;
  if (coverage === "unreachable" || retrievalCoverage === "unreachable") {
    return { tone: "bad", text: JIRA_UNREACHABLE_MESSAGE };
  }
  if (coverage === "low_confidence") return { tone: "warn", text: JIRA_LOW_CONFIDENCE_MESSAGE };
  // coverage === "no_hits"
  if (retrievalCoverage && retrievalCoverage !== "no_hits") {
    return { tone: "bad", text: JIRA_ALL_EXCLUDED_MESSAGE };
  }
  // **The corpus sentence is a NOTES-path statement**, and only that path can
  // make it: it names the three collections a `?q=` search covered and concludes
  // the draft came from the raw material alone. A thread draft runs no such
  // search — its hit set is whatever the conversation retrieved — so the line was
  // both wrong and redundant, stacked above the empty column's own thread-shaped
  // sentence. Every OTHER reading still speaks here: an all-excluded set, an
  // unreachable corpus and a weak one are the same facts on either path.
  if (source === "thread") return null;
  return { tone: "bad", text: JIRA_NO_HITS_MESSAGE };
}

function coverageNoticeHtml(
  retrievalCoverage: JiraCoverage | null | undefined,
  coverage: JiraCoverage | null | undefined,
  source: JiraDraftSource,
): string {
  const notice = jiraCoverageNotice(retrievalCoverage, coverage, source);
  return notice ? `<div class="ja-banner ja-banner-${notice.tone}">${esc(notice.text)}</div>` : "";
}

// ── Key verdicts ─────────────────────────────────────────────────────────────

export interface JiraKeyChip {
  key: string;
  cls: string;
  /** Rendered beside the key; empty for the ordinary verified case. */
  note: string;
  /** `title=` — the long form of the same verdict. */
  hint: string;
}

/**
 * How one Jira key renders.
 *
 * THREE states, deliberately, and the amber one carries the sentence the plan
 * wrote for it: a key present only in the notes (or in what the person typed in
 * the chat) is the reader's own claim, not something retrieval confirmed.
 * `resolved` is a SEPARATE axis — "does the issue exist" — and `undefined` means
 * the lookup was unavailable, which must never read as a fabrication verdict.
 */
export function keyVerdictChip(v: JiraKeyVerdict): JiraKeyChip {
  if (v.state === "verified") {
    return { key: v.key, cls: "ja-key ja-key-ok", note: "", hint: "Hentet i retrieval — saken finnes." };
  }
  if (v.state === "notes") {
    const exists =
      v.resolved === true
        ? " Nøkkelen finnes i jira-issues, men retrieval hentet den ikke."
        : v.resolved === false
          ? " Nøkkelen finnes ikke i jira-issues — sannsynligvis en skrivefeil."
          : " Oppslaget mot jira-issues var utilgjengelig.";
    return {
      key: v.key,
      cls: "ja-key ja-key-notes",
      note: "ikke bekreftet",
      hint: `Bare i råmaterialet, ikke i det som ble hentet.${exists}`,
    };
  }
  return {
    key: v.key,
    cls: "ja-key ja-key-unknown",
    note: "ukjent",
    hint: "Hverken hentet i retrieval eller nevnt i råmaterialet — kontroller den før du oppretter saken.",
  };
}

/** One line of the markdown-flag warn list. Flagged, never silently rewritten. */
export function markdownFlagLine(flag: JiraMarkdownFlag): string {
  const what: Record<string, string> = {
    html: "rå HTML",
    "wiki-markup": "wiki-markup",
    "task-list": "avkryssingsliste (- [ ])",
    "emoji-shortcode": "emoji-kode (:navn:)",
  };
  return `Linje ${flag.line}: ${what[flag.kind] ?? flag.kind} — «${flag.sample}». Jira konverterer ikke dette ved innliming.`;
}

// ── The list ─────────────────────────────────────────────────────────────────

/** The label a row goes by when its draft has no text to take a title from. */
export const JA_UNTITLED = "(uten tittel)";

/** One row of the archive list. The whole row is the link — a draft's only
 *  action here is "open it". */
export function jiraArchiveRowHtml(row: JiraDraftListRow, state?: JiraArchiveListState): string {
  const title = row.title || JA_UNTITLED;
  const chips: string[] = [];
  if (row.status !== "ready") {
    chips.push(
      `<span class="ja-chip ja-chip-${esc(row.status)}">${esc(draftStatusLabel(row.status))}</span>`,
    );
  }
  if (row.savedAt !== null) chips.push(`<span class="ja-chip ja-chip-saved">lagret</span>`);

  const origin =
    row.source === "thread"
      ? `fra samtalen «${esc(threadDraftLabel(row.threadName, row.threadId))}»`
      : "fra notater";

  const notice = jiraCoverageNotice(row.retrievalCoverage, row.coverage, row.source);
  const coverageChip = notice
    ? `<span class="ja-cov ja-cov-${notice.tone}" title="${esc(notice.text)}">${esc(
        coverageWord(row.coverage),
      )}</span>`
    : "";

  return `<a class="ja-row" href="${esc(jiraDraftUrl(row.draftId, state))}">
    <span class="ja-row-title">${esc(title)}</span>
    <span class="ja-row-meta">
      ${chips.join("")}${coverageChip}
      <span class="ja-meta-bit">${esc(origin)}</span>
      <span class="ja-meta-bit">${esc(row.template)} · ${esc(depthLabel(row.depth))}</span>
      <span class="ja-meta-bit">${esc(row.bot)}</span>
      <time class="ja-row-when"${timeAttrs(row.createdAt)}>${esc(formatArchiveTime(row.createdAt))}</time>
    </span>
  </a>`;
}

/** One word for a coverage reading, used as the row chip. The SENTENCE is the
 *  chip's `title=` — a row is a list entry, not a place to explain. */
function coverageWord(coverage: JiraCoverage | null | undefined): string {
  switch (coverage) {
    case "no_hits":
      return "ingen kilder";
    case "low_confidence":
      return "svak forankring";
    case "unreachable":
      return "kunnskaps-API nede";
    default:
      return "";
  }
}

export interface JiraArchiveListOptions {
  savedOnly: boolean;
  /** The limit actually used, for the count's «de nyeste N». */
  limit: number;
  /** `?limit=` as the reader typed it (clamped), else null — see
   *  {@link JiraArchiveListState}. Echoing the default back would pin it. */
  limitParam: number | null;
  /**
   * Was the list CUT? Told by the caller, from a row the DB read past the
   * limit — `rows.length >= limit` claims truncation on an exact fit, which is
   * the one page where the reader can count the rows and see it is wrong.
   */
  capped: boolean;
}

/** The list body: the saved/all switch, the rows, and the empty state. */
export function jiraArchiveListHtml(
  rows: JiraDraftListRow[],
  options: JiraArchiveListOptions,
): string {
  const { savedOnly, limitParam } = options;
  const state: JiraArchiveListState = { all: !savedOnly, limit: limitParam };
  const tab = (all: boolean, label: string) =>
    `<a class="ja-tab${all === !savedOnly ? " ja-tab-on" : ""}" href="${esc(
      jiraArchiveUrl({ all, limit: limitParam }),
    )}">${esc(label)}</a>`;

  const list = rows.length
    ? `<div class="ja-rows">${rows.map((r) => jiraArchiveRowHtml(r, state)).join("")}</div>`
    : `<p class="ja-empty">${
        savedOnly
          ? "Ingen lagrede utkast ennå. Trykk «Lagre» på et utkastkort i samtalen, så havner det her."
          : "Ingen utkast ennå. Lag ett med «🧾 Lag Jira-sak» på et svar i chatten."
      }</p>`;

  // The count is over the rows the page actually rendered, and it says so when
  // the clamp bound it: "50 utkast" beside a table that was truncated is a
  // number the reader cannot check. Truncation is the CALLER's fact (it read one
  // row past the limit); a full page is not necessarily a cut one.
  const count = rows.length
    ? `<span class="ja-count">${rows.length} utkast${
        options.capped ? ` (de nyeste ${options.limit})` : ""
      }</span>`
    : "";

  return `<div class="ja-listhead">
    <div class="ja-tabs">${tab(false, "Lagrede")}${tab(true, "Alle forsøk")}</div>
    ${count}
  </div>
  ${list}`;
}

// ── One draft, read-only ─────────────────────────────────────────────────────

/** The back link every draft page carries — back to the list the reader came
 *  from, `?all=1&limit=` included, not to a default list they never chose. */
export function jiraBackLinkHtml(state?: JiraArchiveListState): string {
  return `<a class="ja-back" href="${esc(jiraArchiveUrl(state ?? { all: false, limit: null }))}">← Arkivet</a>`;
}

/**
 * The read-only render of one draft.
 *
 * `bodyHtml` is the markdown already rendered — server-side, through
 * `formatWebHtml`. It is passed in rather than rendered here for the reason the
 * chat card takes the same parameter: this module is bundled for the browser and
 * must stay dependency-free, and the renderer is the shared one either way.
 *
 * A `failed` draft renders its stored error and NO preview, view switch or copy
 * button — even when the row still carries the previous turn's markdown: the
 * retry is another 🧾 in the conversation, and this page starts nothing.
 */
export function jiraDraftViewHtml(
  draft: JiraDraftView,
  bodyHtml: string,
  state?: JiraArchiveListState,
): string {
  const title = deriveDraftHeading(draft);
  const chatHref = jiraChatUrl(draft.bot, draft.threadId, draft.threadUserId);

  const provenance =
    draft.source === "thread"
      ? `<div class="ja-banner ja-banner-thread">Utkast fra samtalen «${esc(
          threadDraftLabel(draft.threadName, draft.threadId),
        )}» — kildene er det samtalen fant.${
          chatHref
            ? ` <a class="ja-threadlink" href="${esc(chatHref)}">Juster i samtalen →</a>`
            : ""
        }</div>`
      : "";

  const meta = [
    `<span class="ja-chip ja-chip-${esc(draft.status)}">${esc(draftStatusLabel(draft.status))}</span>`,
    draft.savedAt !== null
      ? `<span class="ja-chip ja-chip-saved"${timeAttrs(draft.savedAt)}>lagret ${esc(
          formatArchiveTime(draft.savedAt),
        )}</span>`
      : `<span class="ja-chip ja-chip-unsaved">ikke lagret</span>`,
    `<span class="ja-meta-bit">${esc(draft.bot)}</span>`,
    `<span class="ja-meta-bit">${esc(draft.template)} · ${esc(depthLabel(draft.depth))}</span>`,
    `<time class="ja-meta-bit"${timeAttrs(draft.createdAt)}>${esc(formatArchiveTime(draft.createdAt))}</time>`,
    `<span class="ja-draftid" title="Utkastets id">${esc(draft.draftId)}</span>`,
  ].join("");

  const error = draft.error
    ? `<div class="ja-banner ja-banner-bad"><strong>Genereringen feilet:</strong> ${esc(draft.error)}</div>`
    : "";

  const flags = draft.markdownFlags.length
    ? `<div class="ja-banner ja-banner-warn"><strong>Markdown Jira ikke konverterer:</strong>
        <ul>${draft.markdownFlags.map((f) => `<li>${esc(markdownFlagLine(f))}</li>`).join("")}</ul></div>`
    : "";

  const chips = draft.keyVerdicts.length
    ? `<div class="ja-keys">${draft.keyVerdicts
        .map((v) => {
          const chip = keyVerdictChip(v);
          const inner = chip.note ? `${esc(chip.key)} <em>${esc(chip.note)}</em>` : esc(chip.key);
          const href = safeExternalHref(v.url);
          return href
            ? `<a class="${chip.cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(chip.hint)}">${inner}</a>`
            : `<span class="${chip.cls}" title="${esc(chip.hint)}">${inner}</span>`;
        })
        .join("")}</div>`
    : "";

  // The raw material stays available but SECONDARY: on a notes draft it is what
  // the task was written from and the reader occasionally needs it; on a thread
  // draft `notes` is the `fra samtale: <navn>` placeholder the NOT NULL column
  // needed, and offering nine words of server bookkeeping as "the raw material"
  // is what the provenance banner exists to replace.
  const notes =
    draft.source === "notes" && draft.notes.trim()
      ? `<details class="ja-notes"><summary>Råmateriale</summary><pre>${esc(draft.notes)}</pre></details>`
      : "";
  const extra = draft.extra.trim()
    ? `<details class="ja-notes"><summary>Ekstra instruks</summary><pre>${esc(draft.extra)}</pre></details>`
    : "";

  // **A `failed` draft shows no text, whatever the row still holds.**
  // `failJiraDraft` leaves `markdown` alone, so a failed REGENERATE keeps the
  // PREVIOUS turn's task — rendering it under «Genereringen feilet» offers a
  // draft this run did not produce, and Kopier would put it on the clipboard as
  // if it had. Same contract as the chat card's failed card: the error, and the
  // way back to the conversation.
  const body = draft.status === "failed"
    ? `<p class="ja-empty">${
        draft.markdown
          ? "Teksten fra det forrige forsøket ligger fortsatt på raden, men vises ikke her — dette forsøket ble ikke ferdig. Kjør utkastet på nytt i samtalen."
          : "Dette utkastet har ingen tekst."
      }</p>`
    : draft.markdown
    ? `<div class="ja-switch">
        <button type="button" ${JA_VIEW_ATTR}="preview" class="ja-tab ja-tab-on" aria-pressed="true">Forhåndsvisning</button>
        <button type="button" ${JA_VIEW_ATTR}="markdown" class="ja-tab" aria-pressed="false">Markdown</button>
        <span class="ja-spacer"></span>
        <button type="button" id="${JA_COPY_ID}" class="ja-secondary">${JA_COPY_LABEL}</button>
      </div>
      <div class="ja-preview markdown-body" id="${JA_PREVIEW_ID}">${bodyHtml}</div>
      <textarea class="ja-raw" id="${JA_RAW_ID}" readonly spellcheck="false" hidden>${esc(draft.markdown)}</textarea>`
    : `<p class="ja-empty">${
        draft.status === "generating"
          ? "Utkastet skrives fortsatt — det vises i samtalen mens det blir til."
          : "Dette utkastet har ingen tekst."
      }</p>`;

  return `${jiraBackLinkHtml(state)}
    <h1 class="ja-title">${esc(title)}</h1>
    <div class="ja-meta">${meta}</div>
    ${provenance}
    ${error}
    ${coverageNoticeHtml(draft.retrievalCoverage, draft.coverage, draft.source)}
    ${flags}
    ${body}
    ${chips}
    ${notes}${extra}`;
}

/**
 * The `<h1>` on a draft page.
 *
 * `jiraDraftTitle` is the LISTING's derivation and is deliberately not
 * re-implemented here: the row a reader clicked and the page it opened must
 * agree about what the draft is called.
 */
export function deriveDraftHeading(draft: Pick<JiraDraftView, "markdown">): string {
  return jiraDraftTitle(draft.markdown) ?? JA_UNTITLED;
}

// ── Missing ──────────────────────────────────────────────────────────────────

/** A `?draft=` that names nothing — a non-uuid, a deleted row, a stale link in
 *  someone's notes. Named, with the way back, never a bare 500. */
export function jiraArchiveMissingHtml(draftId: string, state?: JiraArchiveListState): string {
  return `${jiraBackLinkHtml(state)}
    <h1 class="ja-title">Utkastet finnes ikke</h1>
    <p class="ja-empty">Ingen lagret Jira-utkast har id-en <code>${esc(draftId)}</code>.
      Det kan være slettet, eller lenken kan være feil.</p>`;
}

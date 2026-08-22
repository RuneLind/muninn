/**
 * The `/jira` composer's PURE half — ids, markup and every decision worth
 * testing without a browser.
 *
 * Split for the reason `wiki-share-dialog.ts` is: the DOM half
 * (`jira-composer.ts`) cannot be unit-tested and everything here can. It is also
 * import-safe (no DOM access at module load), so the page bundle and the tests
 * reach the same module.
 *
 * **Everything it imports must be dependency-free.** `src/jira/wire.ts` is, on
 * purpose (`templates.ts` reaches for the bot config, `retrieval.ts` for the
 * research layer, `verify-keys.ts` for huginn) — so the wire module is the ONLY
 * server-side import here, and the coverage sentences live in it rather than
 * beside `assessCoverage`.
 */

import { escHtml as esc } from "./escape.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_DEPTHS,
  JIRA_EXTRA_MAX,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_NOTES_MAX,
  type JiraCitation,
  type JiraCoverage,
  type JiraDepth,
  type JiraDraftStatus,
  type JiraKeyVerdict,
  type JiraMarkdownFlag,
} from "../../../jira/wire.ts";

// ── Ids and attribute hooks ──────────────────────────────────────────────────
// Shared by the render, the delegated listeners and the tests, so the three
// cannot drift apart the way three string literals would.

export const JC_ROOT_ID = "jcRoot";
export const JC_LEFT_ID = "jcLeft";
export const JC_MID_ID = "jcMid";
export const JC_RIGHT_ID = "jcRight";

export const JC_NOTES_ID = "jcNotes";
export const JC_TEMPLATE_ID = "jcTemplate";
export const JC_EXTRA_ID = "jcExtra";
export const JC_SUBMIT_ID = "jcSubmit";
export const JC_REGEN_ID = "jcRegen";
export const JC_COPY_ID = "jcCopy";
export const JC_SAVE_ID = "jcSave";
export const JC_MARKDOWN_ID = "jcMarkdown";
export const JC_PREVIEW_ID = "jcPreview";
export const JC_STATUS_ID = "jcStatus";
export const JC_NOTES_COUNT_ID = "jcNotesCount";
/** The "unsaved changes" line. ALWAYS rendered, `hidden` when clean — the draft
 *  edit deliberately does not re-render the column it is typed into, so the
 *  marker has to be a node the input handler can toggle rather than markup a
 *  render would have to produce. */
export const JC_DIRTY_ID = "jcDirty";

/** `data-jc-depth="<id>"` on the depth radios. */
export const JC_DEPTH_ATTR = "data-jc-depth";
/** `data-jc-doc="<index into state.citations>"` on a citation's retain toggle. */
export const JC_DOC_ATTR = "data-jc-doc";
/** `data-jc-open="<index into state.citations>"` on a citation's title button. */
export const JC_OPEN_ATTR = "data-jc-open";
/** `data-jc-view="markdown|preview"` on the two view-switch buttons. */
export const JC_VIEW_ATTR = "data-jc-view";

/** The default depth. `Skisse` is the plan's default: enough to estimate without
 *  locking the design. */
export const JC_DEFAULT_DEPTH: JiraDepth = "skisse";

/** How often the `?draft=` landing polls `GET /api/jira/draft/:id`.
 *
 *  Polling, NOT a stream re-attach: there is nothing to attach to (the only SSE
 *  endpoint STARTS a generation) and a re-POST of identical content would hit the
 *  single-flight 409 — which is exactly this case. */
export const JC_POLL_INTERVAL_MS = 2_500;

/**
 * When the poller gives up.
 *
 * Sized off the server's own ceiling: `Full` is budgeted 600 s and the
 * single-flight slot outlives it by `JIRA_SLOT_SLACK_MS` (180 s), so a draft that
 * is still `generating` at 13 min is a draft nothing is working on. Giving up
 * says so rather than polling a dead row forever.
 */
export const JC_POLL_MAX_MS = 13 * 60_000;

// ── The page's state ─────────────────────────────────────────────────────────

export interface JiraTemplateOption {
  id: string;
  label: string;
}

export type JiraViewMode = "markdown" | "preview";

export interface JiraComposerState {
  /** The picker's options, IN THE ORDER THE ROUTE SERVED THEM. `templates.ts`
   *  keeps the shipped set an ordered array precisely because the variant loader
   *  sorts ids with `localeCompare`, which renders `bug, spike, story, task`. */
  templates: JiraTemplateOption[];
  templatesError?: string;
  bot?: string;

  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;

  /** A generation (first draft or regenerate) is in flight. */
  running: boolean;
  /** A poll loop is in flight against a draft this page did not stream. */
  polling: boolean;
  /** The last `phase` event's label, shown while running. */
  phase?: string;
  /** The live `delta` buffer — shown in place of the draft while streaming. */
  streamed: string;

  draftId?: string;
  status?: JiraDraftStatus;
  /** The draft as it stands, INCLUDING the reader's unsaved edits. */
  markdown: string;
  /** The last text the server confirmed — what `dirty` compares against. */
  savedMarkdown?: string;

  /** The WIDE stored hit set (24-ish). Never re-sliced by depth. */
  citations: JiraCitation[];
  /** Doc ids the reader has switched OFF. */
  excludeDocIds: string[];

  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  coverage: JiraCoverage | null;
  retrievalCoverage: JiraCoverage | null;
  retrievalQuestion: string;

  view: JiraViewMode;
  /** A blocking error (a 400/409/503, a dropped stream, a failed draft). */
  error?: string;
  /** Set alongside `error` on a 409 so the copy can count the slot down. */
  conflictExpiresAtMs?: number;
  copied: boolean;
  saving: boolean;
  /** Transient confirmation under the draft ("Lagret."). */
  savedNote?: string;
}

export function initialJiraState(): JiraComposerState {
  return {
    templates: [],
    template: "",
    depth: JC_DEFAULT_DEPTH,
    notes: "",
    extra: "",
    running: false,
    polling: false,
    streamed: "",
    markdown: "",
    citations: [],
    excludeDocIds: [],
    keyVerdicts: [],
    markdownFlags: [],
    coverage: null,
    retrievalCoverage: null,
    retrievalQuestion: "",
    view: "markdown",
    copied: false,
    saving: false,
  };
}

// ── The decisions ────────────────────────────────────────────────────────────

/**
 * Flip one document's retain toggle.
 *
 * The state holds the EXCLUSION set rather than the retained one because that is
 * what the wire carries: `excludeDocIds` is what a regenerate posts and what
 * `GET /api/jira/draft/:id` answers with, so a retained-set representation would
 * have to be inverted at both ends against a citation list that is only correct
 * once it has loaded.
 */
export function toggleExclusion(excludeDocIds: string[], docId: string): string[] {
  return excludeDocIds.includes(docId)
    ? excludeDocIds.filter((d) => d !== docId)
    : [...excludeDocIds, docId];
}

/** One rendered row of the middle column. */
export interface JiraCitationRow {
  index: number;
  citation: JiraCitation;
  /** Checked ⇒ this source is used by the next generation. */
  retained: boolean;
}

export function citationRows(citations: JiraCitation[], excludeDocIds: string[]): JiraCitationRow[] {
  const excluded = new Set(excludeDocIds);
  return citations.map((citation, index) => ({
    index,
    citation,
    retained: !excluded.has(citation.docId),
  }));
}

export function retainedCount(citations: JiraCitation[], excludeDocIds: string[]): number {
  return citationRows(citations, excludeDocIds).filter((r) => r.retained).length;
}

/**
 * The POST body for the next generation.
 *
 * Two shapes, and the split is the wire's, not a preference: a FIRST draft
 * carries the raw material, a REGENERATE carries the draft id and the exclusion
 * set and **must not carry notes at all** — `parseJiraDraftBody` refuses new
 * notes on a regenerate, because the stored hit set was retrieved for the
 * original raw material. `extra` rides both, since the route reads it on both
 * paths and it is the one steer a reader can usefully change between runs.
 */
export function jiraDraftBody(state: JiraComposerState): Record<string, unknown> {
  if (state.draftId && state.citations.length > 0) {
    return {
      draftId: state.draftId,
      template: state.template,
      depth: state.depth,
      extra: state.extra,
      excludeDocIds: [...state.excludeDocIds],
    };
  }
  return {
    notes: state.notes,
    template: state.template,
    depth: state.depth,
    extra: state.extra,
  };
}

/** Is this POST a regenerate (reusing a stored hit set) rather than a first draft? */
export function isRegenerate(state: JiraComposerState): boolean {
  return !!state.draftId && state.citations.length > 0;
}

/** Can the **Skriv utkast** button fire? */
export function canSubmit(state: JiraComposerState): boolean {
  if (state.running || state.polling || state.saving) return false;
  if (!state.template) return false;
  if (isRegenerate(state)) return true;
  const notes = state.notes.trim();
  return notes.length > 0 && state.notes.length <= JIRA_NOTES_MAX;
}

/** Why the button is off, when it is off for a reason the reader can fix. */
export function submitBlockedReason(state: JiraComposerState): string | undefined {
  if (state.notes.length > JIRA_NOTES_MAX) {
    return `Råmaterialet er ${state.notes.length} tegn — grensen er ${JIRA_NOTES_MAX}.`;
  }
  if (state.extra.length > JIRA_EXTRA_MAX) {
    return `Ekstra instruks er ${state.extra.length} tegn — grensen er ${JIRA_EXTRA_MAX}.`;
  }
  if (!isRegenerate(state) && !state.notes.trim()) return "Lim inn råmateriale først.";
  return undefined;
}

export type JiraNoticeTone = "warn" | "bad";

export interface JiraCoverageNotice {
  tone: JiraNoticeTone;
  text: string;
}

/**
 * Which coverage sentence the middle column shows — the PAIR, never the derived
 * verdict alone.
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
 */
export function jiraCoverageNotice(
  retrievalCoverage: JiraCoverage | null | undefined,
  coverage: JiraCoverage | null | undefined,
): JiraCoverageNotice | null {
  if (!coverage || coverage === "answer") return null;
  if (coverage === "low_confidence") return { tone: "warn", text: JIRA_LOW_CONFIDENCE_MESSAGE };
  // coverage === "no_hits"
  if (retrievalCoverage && retrievalCoverage !== "no_hits") {
    return { tone: "bad", text: JIRA_ALL_EXCLUDED_MESSAGE };
  }
  return { tone: "bad", text: JIRA_NO_HITS_MESSAGE };
}

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
 * wrote for it: a key present only in the notes is the reader's own claim, not
 * something retrieval confirmed. `resolved` is a SEPARATE axis — "does the issue
 * exist" — and `undefined` means the lookup was unavailable, which must never
 * read as a fabrication verdict.
 */
export function keyVerdictChip(v: JiraKeyVerdict): JiraKeyChip {
  if (v.state === "verified") {
    return { key: v.key, cls: "jc-key jc-key-ok", note: "", hint: "Hentet i retrieval — saken finnes." };
  }
  if (v.state === "notes") {
    const exists =
      v.resolved === true
        ? " Nøkkelen finnes i jira-issues, men retrieval hentet den ikke."
        : v.resolved === false
          ? " Nøkkelen finnes ikke i jira-issues — sannsynligvis en skrivefeil i notatene."
          : " Oppslaget mot jira-issues var utilgjengelig.";
    return {
      key: v.key,
      cls: "jc-key jc-key-notes",
      note: "fra notatene — ikke bekreftet",
      hint: `Bare i råmaterialet ditt, ikke i det som ble hentet.${exists}`,
    };
  }
  return {
    key: v.key,
    cls: "jc-key jc-key-unknown",
    note: "ukjent",
    hint: "Hverken hentet i retrieval eller nevnt i notatene — kontroller den før du oppretter saken.",
  };
}

export interface JiraKeyCounts {
  verified: number;
  notes: number;
  unknown: number;
}

export function keyVerdictCounts(verdicts: JiraKeyVerdict[]): JiraKeyCounts {
  return {
    verified: verdicts.filter((v) => v.state === "verified").length,
    notes: verdicts.filter((v) => v.state === "notes").length,
    unknown: verdicts.filter((v) => v.state === "unknown").length,
  };
}

/**
 * Stop polling?
 *
 * `ready` and `failed` are the two terminal statuses; `generating` (and an absent
 * status, which is what a degraded payload looks like) keeps the loop running.
 * Written as an explicit terminal list rather than `!== "generating"` so a status
 * the server adds later cannot silently stop the poller.
 */
export function shouldStopPolling(status: JiraDraftStatus | string | undefined): boolean {
  return status === "ready" || status === "failed";
}

/**
 * The 409 copy.
 *
 * The server's own `error` sentence leads — it names the surface ("Det skrives
 * allerede et utkast for dette råmaterialet") — and the countdown is appended,
 * because the whole reason this page streams with `fetch` rather than an
 * EventSource is that `expiresAtMs` rides the body of a NON-200, which an
 * EventSource never surfaces.
 */
export function jiraConflictCopy(
  serverError: string | undefined,
  expiresAtMs: number,
  now: number,
): string {
  const lead = serverError?.trim() || "Det skrives allerede et likt utkast.";
  const secs = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  if (secs <= 0) return `${lead} Slotten skulle vært ledig nå — prøv igjen.`;
  return `${lead} Plassen frigis om ~${secs} s.`;
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

// ── Markup ───────────────────────────────────────────────────────────────────

/** LEFT: the raw material and the two dials. */
export function jiraLeftHtml(state: JiraComposerState): string {
  const templates = state.templates.length
    ? state.templates
        .map(
          (t) =>
            `<option value="${esc(t.id)}"${t.id === state.template ? " selected" : ""}>${esc(t.label)}</option>`,
        )
        .join("")
    : `<option value="">(ingen maler)</option>`;

  const depths = JIRA_DEPTHS.map(
    (d) => `<label class="jc-depth${d.id === state.depth ? " jc-depth-on" : ""}">
      <input type="radio" name="jcDepth" ${JC_DEPTH_ATTR}="${esc(d.id)}" value="${esc(d.id)}"${d.id === state.depth ? " checked" : ""}>
      <span class="jc-depth-name">${esc(d.label)}</span>
      <span class="jc-depth-hint">${esc(d.hint)}</span>
    </label>`,
  ).join("");

  const regen = isRegenerate(state);
  const blocked = submitBlockedReason(state);

  return `
    <h2 class="jc-h">Råmateriale</h2>
    <p class="jc-sub">Møtenotat, Slack-tråd, «det vi ble enige om i går». Hentes over
      <code>jira-issues</code>, <code>melosys-confluence-v3</code> og <code>nav-wiki</code>${
        state.bot ? ` på <code>${esc(state.bot)}</code>` : ""
      }.</p>
    <textarea id="${JC_NOTES_ID}" class="jc-notes" rows="16" spellcheck="false"
      placeholder="Lim inn notatene her…">${esc(state.notes)}</textarea>
    <div class="jc-charcount" id="${JC_NOTES_COUNT_ID}">${state.notes.length} / ${JIRA_NOTES_MAX}</div>

    <label class="jc-lab" for="${JC_TEMPLATE_ID}">Mal</label>
    <select id="${JC_TEMPLATE_ID}" class="jc-select">${templates}</select>
    ${state.templatesError ? `<p class="jc-err">${esc(state.templatesError)}</p>` : ""}

    <div class="jc-lab">Teknisk dybde</div>
    <div class="jc-depths">${depths}</div>

    <label class="jc-lab" for="${JC_EXTRA_ID}">Ekstra instruks <span class="jc-opt">(valgfritt)</span></label>
    <textarea id="${JC_EXTRA_ID}" class="jc-extra" rows="2" spellcheck="false"
      placeholder="f.eks. «fokuser på migreringsrisikoen»">${esc(state.extra)}</textarea>

    <button id="${JC_SUBMIT_ID}" class="jc-primary" type="button"${canSubmit(state) ? "" : " disabled"}>
      ${state.running ? "Skriver…" : regen ? "Generer på nytt" : "Skriv utkast"}
    </button>
    ${blocked ? `<p class="jc-note">${esc(blocked)}</p>` : ""}
    ${
      regen
        ? `<p class="jc-note">Råmaterialet er låst til dette utkastet — treffene ble hentet for akkurat denne teksten.
             Endre notatene ved å starte et nytt utkast (åpne <code>/jira</code> uten <code>?draft=</code>).</p>`
        : ""
    }
    <div class="jc-status" id="${JC_STATUS_ID}">${statusLineHtml(state)}</div>`;
}

/** The one line that says what the page is doing right now. */
export function statusLineHtml(state: JiraComposerState): string {
  const parts: string[] = [];
  if (state.running) parts.push(`<span class="jc-run">${esc(phaseLabel(state.phase))}</span>`);
  else if (state.polling) parts.push(`<span class="jc-run">Venter på utkastet…</span>`);
  if (state.error) parts.push(`<span class="jc-err">${esc(state.error)}</span>`);
  return parts.join(" ");
}

/** Server phase names → what the reader is actually waiting for. */
export function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "condensing":
      return "Koker notatene ned til ett søk…";
    case "retrieving":
      return "Søker i de tre samlingene…";
    case "regenerating":
      return "Skriver på nytt fra de valgte kildene…";
    case "writing":
      return "Skriver saken…";
    default:
      return "Jobber…";
  }
}

/** MIDDLE: the retrieved hits, always the stored wide set. */
export function jiraCitationsHtml(state: JiraComposerState): string {
  const rows = citationRows(state.citations, state.excludeDocIds);
  const kept = rows.filter((r) => r.retained).length;
  const notice = jiraCoverageNotice(state.retrievalCoverage, state.coverage);

  const head = `<h2 class="jc-h">Hentede kilder ${
    state.citations.length ? `<span class="jc-count">${kept} av ${state.citations.length} på</span>` : ""
  }</h2>`;

  const question = state.retrievalQuestion
    ? `<p class="jc-searched">Søkte etter: ${esc(state.retrievalQuestion)}</p>`
    : "";

  const noticeHtml = notice
    ? `<div class="jc-banner jc-banner-${notice.tone}">${esc(notice.text)}</div>`
    : "";

  if (rows.length === 0) {
    return `${head}${question}${noticeHtml}
      <p class="jc-empty">${
        state.running || state.polling
          ? "Henter…"
          : "Ingen kilder ennå. Skriv et utkast, så vises hele det lagrede trefflista her."
      }</p>`;
  }

  const list = rows
    .map((r) => {
      const c = r.citation;
      const rel = Number.isFinite(c.relevance) ? c.relevance.toFixed(2) : "";
      const link = c.url
        ? ` <a class="jc-cite-src" href="${esc(c.url)}" target="_blank" rel="noopener">↗</a>`
        : "";
      return `<div class="jc-cite${r.retained ? "" : " jc-cite-off"}">
        <label class="jc-cite-toggle" title="Av ⇒ kilden utelates fra neste generering">
          <input type="checkbox" ${JC_DOC_ATTR}="${r.index}"${r.retained ? " checked" : ""}>
        </label>
        <div class="jc-cite-body">
          <div class="jc-cite-head">
            <span class="jc-badge">${esc(c.badge)}</span>
            <button type="button" class="jc-cite-title" ${JC_OPEN_ATTR}="${r.index}"
              title="Åpne dokumentet">${esc(c.key ? `${c.key} — ${c.title}` : c.title)}</button>${link}
            <span class="jc-rel" title="Relevans">${esc(rel)}</span>
          </div>
          ${c.snippet ? `<p class="jc-snip">${esc(c.snippet)}</p>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const regenBtn = `<button id="${JC_REGEN_ID}" class="jc-secondary" type="button"${
    state.running || state.polling ? " disabled" : ""
  }>Generer på nytt</button>`;

  return `${head}${question}${noticeHtml}
    <div class="jc-citelist">${list}</div>
    <div class="jc-citefoot">${regenBtn}
      <span class="jc-note">Slå av kilder du ikke vil ha med, og generer på nytt — ingen nye søk kjøres.</span>
    </div>`;
}

/** RIGHT: the draft itself. */
export function jiraDraftHtml(state: JiraComposerState): string {
  const counts = keyVerdictCounts(state.keyVerdicts);
  const idLine = state.draftId
    ? `<span class="jc-draftid" title="Utkastets id">${esc(state.draftId)}</span>`
    : `<span class="jc-draftid jc-dim">ingen utkast ennå</span>`;
  const statusChip = state.status
    ? `<span class="jc-chip jc-chip-${esc(state.status)}">${esc(draftStatusLabel(state.status))}</span>`
    : "";
  const keyLine = state.keyVerdicts.length
    ? `<span class="jc-keycount">${counts.verified} bekreftet · ${counts.notes} fra notatene · ${counts.unknown} ukjent</span>`
    : "";

  const flags = state.markdownFlags.length
    ? `<div class="jc-banner jc-banner-warn"><strong>Markdown Jira ikke konverterer:</strong>
        <ul>${state.markdownFlags.map((f) => `<li>${esc(markdownFlagLine(f))}</li>`).join("")}</ul></div>`
    : "";

  const chips = state.keyVerdicts.length
    ? `<div class="jc-keys">${state.keyVerdicts
        .map((v) => {
          const chip = keyVerdictChip(v);
          const inner = chip.note ? `${esc(chip.key)} <em>${esc(chip.note)}</em>` : esc(chip.key);
          return v.url
            ? `<a class="${chip.cls}" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(chip.hint)}">${inner}</a>`
            : `<span class="${chip.cls}" title="${esc(chip.hint)}">${inner}</span>`;
        })
        .join("")}</div>`
    : "";

  // While a run streams, the live text REPLACES the body — but `state.markdown`
  // is deliberately left alone underneath it, so a failed regenerate leaves the
  // previous draft intact rather than wiping a task the reader never copied.
  const body = state.running && state.streamed
    ? `<pre class="jc-stream">${esc(state.streamed)}</pre>`
    : state.view === "preview"
      ? `<div class="jc-preview markdown-body" id="${JC_PREVIEW_ID}"></div>`
      : `<textarea id="${JC_MARKDOWN_ID}" class="jc-md" spellcheck="false"
           placeholder="Utkastet vises her.">${esc(state.markdown)}</textarea>`;

  const dirty = state.savedMarkdown !== undefined && state.markdown !== state.savedMarkdown;

  return `
    <div class="jc-drafthead">
      <h2 class="jc-h">Utkast</h2>
      ${statusChip}${idLine}${keyLine}
    </div>
    ${flags}
    <div class="jc-switch">
      <button type="button" ${JC_VIEW_ATTR}="markdown" class="jc-tab${state.view === "markdown" ? " jc-tab-on" : ""}"
        aria-pressed="${state.view === "markdown"}">Markdown</button>
      <button type="button" ${JC_VIEW_ATTR}="preview" class="jc-tab${state.view === "preview" ? " jc-tab-on" : ""}"
        aria-pressed="${state.view === "preview"}">Forhåndsvisning</button>
      <span class="jc-spacer"></span>
      <button type="button" id="${JC_COPY_ID}" class="jc-secondary"${state.markdown ? "" : " disabled"}>${
        state.copied ? "✓ Kopiert" : "Kopier markdown"
      }</button>
      <button type="button" id="${JC_SAVE_ID}" class="jc-secondary"${
        state.draftId && state.markdown && !state.saving ? "" : " disabled"
      }>${state.saving ? "Lagrer…" : "Lagre utkast"}</button>
    </div>
    <p class="jc-note jc-dirty" id="${JC_DIRTY_ID}"${dirty ? "" : " hidden"}>Ulagrede endringer.</p>
    ${state.savedNote ? `<p class="jc-note jc-saved">${esc(state.savedNote)}</p>` : ""}
    ${body}
    ${chips}`;
}

export function draftStatusLabel(status: JiraDraftStatus): string {
  switch (status) {
    case "generating":
      return "skrives";
    case "ready":
      return "klar";
    default:
      return "feilet";
  }
}

/// <reference lib="dom" />
/**
 * The «Decisions» section of the Your work card (P3a of mimir
 * plans/muninn-wiki-decision-triage.mdx, layout A of D21): the wiki's open cards
 * from `GET /api/wiki/decision-inbox` in four lanes, «close?» and «ask you» open.
 * A row opens to the card, its evidence and its actions; an answer goes through
 * `POST /api/wiki/answers` with the reader card's body, and a 409 sends the
 * reader to the page, never a second write. Imported by `wiki-start-cards.ts`,
 * which appends {@link inboxHtml} to the card's markup. Every page string is escaped.
 */

import type { DecisionInboxBody, InboxCard } from "../../routes/wiki-decision-inbox.ts";
import { inboxBornMs, settlingAnswers, type InboxLane } from "../../../wiki/decision-triage/inbox.ts";
import { QUESTION_NOT_SURE } from "../../../format/question.ts";
import { escHtml as esc } from "./escape.ts";
import { alreadyAnsweredOf, isVersionConflict } from "./wiki-answer-card-model.ts";

const LANES: { lane: InboxLane; label: string; hint: string; open: boolean }[] = [
  { lane: "close", label: "Close?", hint: "answered or ruled on the page", open: true },
  { lane: "ask", label: "Ask you", hint: "addressed to you", open: true },
  { lane: "pass", label: "Pass on", hint: "addressed to someone else", open: false },
  { lane: "default", label: "Take the default", hint: "the recommendation usually holds", open: false },
];

interface InboxState {
  url: string;
  body: DecisionInboxBody | null;
  open: string | null;
  laneOpen: Partial<Record<InboxLane, boolean>>;
  picked: Record<string, string>;
  notes: Record<string, string>;
  /** Cards whose POST is out, one entry each: a reply clears only its own. */
  sending: Record<string, true>;
  /** The last load failed (not a 404): said in the section, the cards it had kept. */
  failed: string | null;
  msg: Record<string, { text: string; warn: boolean; page: boolean }>;
  /** A close's preview from `POST …/close` with `preview: true`: the lines it writes and the hash it writes on. */
  /** With the evidence it was made on: a reload that changes the evidence drops it. */
  preview: Record<string, { lines: string[]; warnings: string[]; baseHash: string; rulingHash: string; ev: string }>;
  showKept: boolean;
  /** The last close, said in the «close?» lane: its row leaves on the reload. */
  closed: string | null;
}

const KEPT_KEY = "muninn-inbox-kept";
/** «Still open» cards, `wiki|relPath#id` to the evidence they were kept on: a change
 *  shows them again. Read on every use; anything but an object reads as none. */
function readKept(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function writeKept(kept: Record<string, string>): void {
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify(kept));
  } catch {
    /* not remembered */
  }
}
const evidenceKey = (c: InboxCard) => JSON.stringify([c.answers.map((a) => [a.author, a.choice, a.at]), c.hint?.decision, c.hint?.word]);
const keptKey = (c: InboxCard) => `${st?.body?.wiki}|${keyOf(c)}`;
const isKept = (c: InboxCard) => readKept()[keptKey(c)] === evidenceKey(c);
function setKept(c: InboxCard, on: boolean): void {
  const kept = readKept();
  if (on) kept[keptKey(c)] = evidenceKey(c);
  else delete kept[keptKey(c)];
  writeKept(kept);
}
/** Drop this wiki's entries whose card has left the inbox. */
function pruneKept(body: DecisionInboxBody): void {
  const kept = readKept();
  const live = new Set(body.cards.map((c) => `${body.wiki}|${keyOf(c)}`));
  const gone = Object.keys(kept).filter((k) => k.startsWith(`${body.wiki}|`) && !live.has(k));
  for (const k of gone) delete kept[k];
  if (gone.length) writeKept(kept);
}

let st: InboxState | null = null;
let loadSeq = 0;
let listening = false;
let repaint: (focusSel?: string, passive?: boolean) => void = () => {};

const keyOf = (c: InboxCard) => `${c.relPath}#${c.id}`;
const sel = (k: string) => `[data-wi-key="${CSS.escape(k)}"]`;
const firstLine = (body: string) => (body.split("\n").find((l) => l.trim()) ?? "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "");
const ddmm = (iso: string) => new Date(iso).toLocaleDateString("nb-NO", { day: "2-digit", month: "2-digit" });

/** Wire the repaint; `focusSel` names the control to focus after it. A `passive` one, any
 *  repaint after an await, waits while a selection touches the card or a press is down. */
export function initInbox(paint: (focusSel?: string, passive?: boolean) => void): void {
  repaint = paint;
  if (listening || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  listening = true;
  document.addEventListener("input", (e) => {
    const t = e.target as HTMLTextAreaElement | null;
    const k = t?.getAttribute?.("data-wi-note");
    if (!st || k == null) return;
    st.notes[k] = t!.value;
    const btn = document.querySelector<HTMLButtonElement>(`${sel(k)} [data-wi-act="answer"]`);
    if (btn) btn.disabled = !canAnswer(k);
  });
}

/** Fetch the inbox (`url` carries the wiki). A wiki outside the triage scope answers 404: no section. */
export function loadInbox(url: string): void {
  const seq = ++loadSeq;
  if (!st || st.url !== url) st = { url, body: null, open: null, laneOpen: {}, picked: {}, notes: {}, sending: {}, failed: null, msg: {}, preview: {}, showKept: false, closed: null };
  fetch(url)
    .then(async (r) => ({ status: r.status, body: r.ok ? ((await r.json().catch(() => null)) as DecisionInboxBody | null) : null }))
    .catch(() => ({ status: 0, body: null }))
    .then(({ status, body }) => {
      if (seq !== loadSeq || !st || st.url !== url) return;
      if (body && Array.isArray(body.cards)) {
        st.body = body;
        pruneKept(body);
        for (const k of Object.keys(st.preview)) {
          const c = body.cards.find((x) => keyOf(x) === k);
          if (!c || evidenceKey(c) !== st.preview[k]!.ev) delete st.preview[k];
        }
        st.failed = null;
      } else if (status === 404) {
        st.body = null;
        st.failed = null;
      } else st.failed = !status ? "the server did not answer" : status < 300 ? `HTTP ${status}, not an inbox` : `HTTP ${status}`;
      repaint(undefined, true);
    });
}

function canAnswer(k: string): boolean {
  return !!st && !st.sending[k] && (!!st.picked[k] || !!st.notes[k]?.trim());
}

function evidenceHtml(c: InboxCard): string {
  let out = "";
  for (const a of c.answers) {
    const notSure = a.choice === QUESTION_NOT_SURE;
    const head = a.choice === null ? "Text answer: read it before closing" : notSure ? "Not sure" : `Answered ${esc(a.choice)}`;
    const warn = a.choice === null || notSure || a.questionChanged;
    out +=
      `<div class="wiki-wi-ev${warn ? " warn" : ""}"><b>${head} · ${esc(a.author)} · ${ddmm(a.at)}${a.questionChanged ? " · the wording changed after this answer" : ""}</b>` +
      (a.body ? `<div class="wiki-wi-quote">${esc(a.body)}</div>` : "") +
      `</div>`;
  }
  const h = c.hint;
  if (h) {
    out += h.decision
      ? `<div class="wiki-wi-ev"><b>The page already rules: ${esc(h.decision)}</b><div class="wiki-wi-quote">${esc(h.decisionText)}</div></div>`
      : `<div class="wiki-wi-ev warn"><b>The card's own log item says «${esc(h.word)}», with no decision naming it</b><div class="wiki-wi-quote">${esc(h.ownItem)}</div></div>`;
  }
  return out;
}

function actionsHtml(c: InboxCard, k: string, href: string): string {
  const s = st!;
  const open = `<a class="wiki-wm-link" href="${esc(href)}" data-relpath="${esc(c.relPath)}">Open on the page</a>`;
  if (c.lane === "close") {
    const busy = s.sending[k] ? " disabled" : "";
    const p = s.preview[k];
    if (p) {
      return (
        p.warnings.map((w) => `<div class="wiki-wi-ev warn"><b>${esc(w)}</b></div>`).join("") +
        `<pre class="wiki-wi-pre" aria-label="The lines the close writes">${esc(p.lines.join("\n"))}</pre>` +
        `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="close"${busy}>${s.sending[k] ? "Closing…" : "Close the card"}</button><button class="wiki-wi-btn" data-wi-act="cancel"${busy}>Cancel</button>${open}</div>`
      );
    }
    const keep = isKept(c) ? `<button class="wiki-wi-btn" data-wi-act="unkeep">Ask again</button>` : `<button class="wiki-wi-btn" data-wi-act="keep">Still open</button>`;
    return `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="preview"${busy}>Close…</button>${keep}${open}</div>`;
  }
  if (c.lane === "pass") {
    return `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="copy">Copy the link for ${esc(c.targets.join(", "))}</button>${open}</div>`;
  }
  if (c.viewerAnswered) return `<div class="wiki-wi-acts"><span class="wiki-wi-hint">You have answered this card: change it on the page.</span>${open}</div>`;
  const busy = s.sending[k] ? " disabled" : "";
  const choices = c.choices.length ? [...c.choices, QUESTION_NOT_SURE] : [];
  const picks = choices
    .map((ch) => `<button class="wiki-wi-btn${s.picked[k] === ch ? " on" : ""}" data-wi-act="pick" data-wi-choice="${esc(ch)}" aria-pressed="${s.picked[k] === ch}"${busy}>${esc(ch === QUESTION_NOT_SURE ? "Not sure" : ch)}${ch === c.recommendation ? " ★" : ""}</button>`)
    .join("");
  const take = c.lane === "default" && c.recommendation ? `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="take"${busy}>Take ${esc(c.recommendation)} (the recommendation)</button></div>` : "";
  return (
    take +
    (picks ? `<div class="wiki-wi-acts">${picks}</div>` : "") +
    `<textarea class="wiki-wi-note" data-wi-note="${esc(k)}" rows="2" placeholder="Note (optional)" aria-label="Note"${busy}>${esc(s.notes[k] ?? "")}</textarea>` +
    `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="answer"${canAnswer(k) ? "" : " disabled"}>${s.sending[k] ? "Saving…" : "Answer"}</button>${open}</div>`
  );
}

function rowHtml(c: InboxCard, now: number, hrefFor: (rel: string) => string): string {
  const s = st!;
  const k = keyOf(c);
  const days = Math.max(0, Math.floor((now - inboxBornMs(c, now)) / 86_400_000));
  const settling = settlingAnswers(c.answers);
  const tag = c.lane !== "close" ? "" : isKept(c) ? "kept open" : c.hint && !settling.length ? "page rules" : settling.some((a) => a.questionChanged) ? "wording changed" : settling.some((a) => a.choice === null) ? "read it before closing" : "answered";
  const msg = s.msg[k];
  return (
    `<li class="wiki-wi-item" data-wi-key="${esc(k)}">` +
    `<button class="wiki-wi-row" data-wi-act="row" aria-expanded="${s.open === k}">` +
    `<span class="wiki-wi-q">${esc(c.id)} · ${esc(firstLine(c.body))}<span class="wiki-wi-page">${esc(c.title)}</span></span>` +
    (c.lane === "pass" ? `<span class="wiki-wi-who">→ ${esc(c.targets.join(", "))}</span>` : "") +
    (tag ? `<span class="wiki-wi-tag${tag === "answered" || tag === "page rules" ? "" : " warn"}">${tag}</span>` : "") +
    `<span class="wiki-wi-age${days >= 14 ? " old" : ""}">${days} d</span></button>` +
    (msg ? `<div class="wiki-wi-msg${msg.warn ? " warn" : ""}" role="status">${esc(msg.text)}${msg.page ? ` <a class="wiki-wm-link" href="${esc(hrefFor(c.relPath))}" data-relpath="${esc(c.relPath)}">Open the page</a>` : ""}</div>` : "") +
    (s.open === k ? `<div class="wiki-wi-detail"><div class="wiki-wi-body">${esc(c.body)}</div>${evidenceHtml(c)}${actionsHtml(c, k, hrefFor(c.relPath))}</div>` : "") +
    `</li>`
  );
}

/** The section's markup, or "" before the inbox has loaded or where it is out of scope. */
export function inboxHtml(hrefFor: (rel: string) => string, now: number): string {
  if (!st) return "";
  const s = st;
  const failed = s.failed ? `<div class="wiki-wi-msg warn" role="status">The inbox couldn’t load: ${esc(s.failed)}.</div>` : "";
  if (!s.body) return failed ? `<div class="wiki-wm-section wiki-wi" id="wikiWorkInbox"><div class="wiki-wm-section-title">Decisions</div>${failed}</div>` : "";
  const hidden = s.body.cards.filter((c) => c.lane === "close" && isKept(c)).length;
  const cards = s.showKept ? s.body.cards : s.body.cards.filter((c) => c.lane !== "close" || !isKept(c));
  const lanes = LANES.map(({ lane, label, hint, open }) => {
    const list = cards.filter((c) => c.lane === lane);
    const isOpen = s.laneOpen[lane] ?? (open || list.some((c) => keyOf(c) === s.open));
    const rows =
      (list.length ? `<ul class="wiki-wi-rows">${list.map((c) => rowHtml(c, now, hrefFor)).join("")}</ul>` : `<div class="wiki-wm-empty">None.</div>`) +
      (lane === "close" && s.closed ? `<div class="wiki-wi-msg" role="status">${esc(s.closed)}</div>` : "") +
      (lane === "close" && hidden ? `<button class="wiki-wi-btn" data-wi-act="kept">${s.showKept ? "Hide" : "Show"} ${hidden} kept open</button>` : "");
    return `<details class="wiki-wi-lane" data-wi-lane="${lane}"${isOpen ? " open" : ""}><summary class="wiki-wm-lane-title">${label} <span class="wiki-wm-count">${list.length}</span> <span class="wiki-wi-hint">${hint}</span></summary>${rows}</details>`;
  }).join("");
  return `<div class="wiki-wm-section wiki-wi" id="wikiWorkInbox"><div class="wiki-wm-section-title">Decisions · ${cards.length} open</div>${failed}${lanes}</div>`;
}

async function sendAnswer(c: InboxCard, k: string, choice: string | null, note: string): Promise<void> {
  const s = st!;
  s.sending[k] = true;
  delete s.msg[k];
  repaint(`${sel(k)} .wiki-wi-row`);
  let status = 0;
  let data: unknown = null;
  try {
    const res = await fetch("/api/wiki/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: s.body!.wiki, relPath: c.relPath, questionId: c.id, choice, body: note }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  if (st !== s) return;
  delete s.sending[k];
  if (status >= 200 && status < 300) {
    delete s.picked[k];
    delete s.notes[k];
    s.msg[k] = { text: `Answered ${c.id}.`, warn: false, page: false };
  } else if (alreadyAnsweredOf(status, data) || isVersionConflict(status, data)) {
    s.msg[k] = { text: "This card already has your answer from elsewhere: change it on the page.", warn: true, page: true };
  } else {
    const err = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : status ? `HTTP ${status}` : "the server did not answer";
    s.msg[k] = { text: `Couldn’t save the answer: ${err}.`, warn: true, page: false };
  }
  repaint(`${sel(k)} .wiki-wi-row`, true);
  if (status >= 200 && status < 500) loadInbox(s.url);
}

async function sendClose(c: InboxCard, k: string, sent: { baseHash: string; rulingHash: string } | null): Promise<void> {
  const s = st!;
  s.sending[k] = true;
  delete s.msg[k];
  repaint(`${sel(k)} .wiki-wi-row`);
  let status = 0;
  let data: { error?: string; lines?: string[]; warnings?: string[]; baseHash?: string; rulingHash?: string; decision?: string } | null = null;
  try {
    const res = await fetch("/api/wiki/decision-inbox/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: s.body!.wiki, relPath: c.relPath, questionId: c.id, ...(sent ?? { preview: true }) }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  if (st !== s) return;
  delete s.sending[k];
  const ok = status >= 200 && status < 300;
  if (ok && !sent && data?.lines && data.baseHash && data.rulingHash) s.preview[k] = { lines: data.lines, warnings: data.warnings ?? [], baseHash: data.baseHash, rulingHash: data.rulingHash, ev: evidenceKey(c) };
  else {
    delete s.preview[k];
    if (ok) s.closed = `Closed ${c.id} (${data?.decision ?? ""}).`;
    else s.msg[k] = { text: `Couldn’t close: ${data?.error ?? (status ? `HTTP ${status}` : "the server did not answer")}.`, warn: true, page: status === 409 };
  }
  repaint(`${sel(k)} .wiki-wi-row`, true);
  // A refusal reloads too: the evidence that moved the ruling shows on the row.
  if (sent && status >= 200 && status < 500) loadInbox(s.url);
}

/** The section's clicks, from the card's click handler. True when the click was the inbox's. */
export function handleInboxClick(target: Element, hrefFor: (rel: string) => string): boolean {
  const s = st;
  if (!s?.body || !target.closest("#wikiWorkInbox")) return false;
  const summary = target.closest("[data-wi-lane] > summary");
  if (summary) {
    // Recorded before the browser toggles it: the next paint keeps the reader's choice.
    const d = summary.parentElement as HTMLDetailsElement;
    s.laneOpen[d.getAttribute("data-wi-lane") as InboxLane] = !d.open;
    return true;
  }
  const act = target.closest("[data-wi-act]");
  if (act?.getAttribute("data-wi-act") === "kept") {
    s.showKept = !s.showKept;
    repaint();
    return true;
  }
  const k = target.closest("[data-wi-key]")?.getAttribute("data-wi-key");
  const c = k ? s.body.cards.find((x) => keyOf(x) === k) : undefined;
  if (!act || !k || !c) return false;
  switch (act.getAttribute("data-wi-act")) {
    case "row":
      s.open = s.open === k ? null : k;
      repaint(`${sel(k)} .wiki-wi-row`);
      break;
    case "pick": {
      const ch = act.getAttribute("data-wi-choice") ?? "";
      s.picked[k] = s.picked[k] === ch ? "" : ch;
      repaint(`${sel(k)} [data-wi-choice="${CSS.escape(ch)}"]`);
      break;
    }
    case "answer":
      if (canAnswer(k)) void sendAnswer(c, k, s.picked[k] || null, s.notes[k] ?? "");
      break;
    case "preview":
      if (!s.sending[k]) void sendClose(c, k, null);
      break;
    case "close":
      if (!s.sending[k] && s.preview[k]) void sendClose(c, k, { baseHash: s.preview[k].baseHash, rulingHash: s.preview[k].rulingHash });
      break;
    case "cancel":
      delete s.preview[k];
      repaint(`${sel(k)} .wiki-wi-row`);
      break;
    case "keep":
    case "unkeep":
      setKept(c, act.getAttribute("data-wi-act") === "keep");
      if (s.open === k && !s.showKept) s.open = null;
      // The row may be gone now: focus its lane.
      repaint(s.showKept ? `${sel(k)} .wiki-wi-row` : '[data-wi-lane="close"] > summary');
      break;
    case "take":
      if (c.recommendation && !s.sending[k]) void sendAnswer(c, k, c.recommendation, "");
      break;
    case "copy": {
      const url = new URL(hrefFor(c.relPath), location.href).href;
      const done = (ok: boolean) => {
        s.msg[k] = ok ? { text: "Link copied.", warn: false, page: false } : { text: `Couldn’t copy: ${url}`, warn: true, page: false };
        repaint(`${sel(k)} [data-wi-act="copy"]`, true);
      };
      navigator.clipboard?.writeText(url).then(() => done(true), () => done(false)) ?? done(false);
      break;
    }
    default:
      return false;
  }
  return true;
}

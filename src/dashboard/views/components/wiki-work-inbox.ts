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
}

let st: InboxState | null = null;
let loadSeq = 0;
let listening = false;
let repaint: (focusSel?: string) => void = () => {};

const keyOf = (c: InboxCard) => `${c.relPath}#${c.id}`;
const sel = (k: string) => `[data-wi-key="${CSS.escape(k)}"]`;
const firstLine = (body: string) => (body.split("\n").find((l) => l.trim()) ?? "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "");
const ddmm = (iso: string) => new Date(iso).toLocaleDateString("nb-NO", { day: "2-digit", month: "2-digit" });

/** Wire the repaint; `focusSel` names the control to focus after it. */
export function initInbox(paint: (focusSel?: string) => void): void {
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
  if (!st || st.url !== url) st = { url, body: null, open: null, laneOpen: {}, picked: {}, notes: {}, sending: {}, failed: null, msg: {} };
  fetch(url)
    .then(async (r) => ({ status: r.status, body: r.ok ? ((await r.json()) as DecisionInboxBody) : null }))
    .catch(() => ({ status: 0, body: null }))
    .then(({ status, body }) => {
      if (seq !== loadSeq || !st || st.url !== url) return;
      if (body && Array.isArray(body.cards)) {
        st.body = body;
        st.failed = null;
      } else if (status === 404) {
        st.body = null;
        st.failed = null;
      } else st.failed = status ? `HTTP ${status}` : "the server did not answer";
      repaint();
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
  if (c.lane === "close") return `<div class="wiki-wi-acts">${open}</div>`;
  if (c.lane === "pass") {
    return `<div class="wiki-wi-acts"><button class="wiki-wi-btn primary" data-wi-act="copy">Copy the link for ${esc(c.targets.join(", "))}</button>${open}</div>`;
  }
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
  const tag = c.lane === "close" ? (c.hint && !settlingAnswers(c.answers).length ? "page rules" : c.answers.some((a) => a.choice === null) ? "read it before closing" : "answered") : "";
  const msg = s.msg[k];
  return (
    `<li class="wiki-wi-item" data-wi-key="${esc(k)}">` +
    `<button class="wiki-wi-row" data-wi-act="row" aria-expanded="${s.open === k}">` +
    `<span class="wiki-wi-q">${esc(c.id)} · ${esc(firstLine(c.body))}<span class="wiki-wi-page">${esc(c.title)}</span></span>` +
    (c.lane === "pass" ? `<span class="wiki-wi-who">→ ${esc(c.targets.join(", "))}</span>` : "") +
    (tag ? `<span class="wiki-wi-tag${tag === "read it before closing" ? " warn" : ""}">${tag}</span>` : "") +
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
  const cards = s.body.cards;
  const lanes = LANES.map(({ lane, label, hint, open }) => {
    const list = cards.filter((c) => c.lane === lane);
    const isOpen = s.laneOpen[lane] ?? (open || list.some((c) => keyOf(c) === s.open));
    const rows = list.length ? `<ul class="wiki-wi-rows">${list.map((c) => rowHtml(c, now, hrefFor)).join("")}</ul>` : `<div class="wiki-wm-empty">None.</div>`;
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
  repaint(`${sel(k)} .wiki-wi-row`);
  if (status >= 200 && status < 500) loadInbox(s.url);
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
    case "take":
      if (c.recommendation && !s.sending[k]) void sendAnswer(c, k, c.recommendation, "");
      break;
    case "copy": {
      const url = new URL(hrefFor(c.relPath), location.href).href;
      const done = (ok: boolean) => {
        s.msg[k] = ok ? { text: "Link copied.", warn: false, page: false } : { text: `Couldn’t copy: ${url}`, warn: true, page: false };
        repaint(`${sel(k)} [data-wi-act="copy"]`);
      };
      navigator.clipboard?.writeText(url).then(() => done(true), () => done(false)) ?? done(false);
      break;
    }
    default:
      return false;
  }
  return true;
}

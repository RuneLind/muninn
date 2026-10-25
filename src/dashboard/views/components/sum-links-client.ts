/// <reference lib="dom" />
/**
 * The `/summaries` doc panel's 🔎 Find links section — the DOM half. Published
 * on `globalThis` by `sum-links-browser.ts`; the page's inline scripts call
 * {@link sumLinksOnOpen} where they call `sumFactcheckOnOpen`.
 *
 * The button shows only on a document the save path accepts (`GET
 * /api/summaries/links/options`). A click lists candidates (one POST), a
 * search streams each selected candidate's state and verified results (POST +
 * SSE), and each ✓ Accept writes one line (one POST at a time — a concurrent
 * one would meet `409 in_flight`). The section's state is kept per document,
 * so the article reload after a save keeps the panel and its `linksBaseHash`.
 * No client code parses the stored section: the server answers the hash.
 */

import { makeSseFrameParser } from "./client-runtime.ts";
import { escHtml } from "./escape.ts";
import { DOC_PANEL_FIND_LINKS_BTN_ID } from "./doc-panel.ts";

export const SUM_LINKS_SECTION_ID = "sumLinks";
/** Mirrors the server's cap (`FIND_LINKS_MAX_SELECTED`); the server refuses more. */
const MAX_SELECTED = 6;
const DEFAULT_SELECTED = 3;

interface Candidate {
  title: string | null;
  author: string | null;
  topic: string;
  kind: string;
}
interface Found {
  url: string;
  title: string;
  detail: string;
  label: "matched" | "reachable" | "unread";
}
interface Row {
  candidate: Candidate;
  selected: boolean;
  state: "idle" | "queued" | "searching" | "checking" | "done";
  outcome?: string;
  results: Found[];
}
interface DocState {
  /** The section is showing (survives the article reload a save triggers). */
  open: boolean;
  baseHash: string | null;
  rows: Row[] | null;
  listed: number;
  loading: boolean;
  searching: boolean;
  /** URLs written, and the one being written. */
  accepted: Set<string>;
  saving: string | null;
  queue: Found[];
  message: { text: string; error: boolean } | null;
}

const states = new Map<string, DocState>();
let current: { source: string; docId: string; key: string } | null = null;

const keyOf = (source: string, docId: string) => `${source}\u0000${docId}`;

function stateFor(key: string): DocState {
  let s = states.get(key);
  if (!s) {
    s = { open: false, baseHash: null, rows: null, listed: 0, loading: false, searching: false, accepted: new Set(), saving: null, queue: [], message: null };
    states.set(key, s);
  }
  return s;
}

function button(): HTMLButtonElement | null {
  return document.getElementById(DOC_PANEL_FIND_LINKS_BTN_ID) as HTMLButtonElement | null;
}

function section(): HTMLElement | null {
  return document.getElementById(SUM_LINKS_SECTION_ID);
}

/** At the start of an open (`mainEl` null) and again once the article is rendered. */
export function sumLinksOnOpen(docId: string, source: string | null, mainEl: HTMLElement | null): void {
  const btn = button();
  if (!source) {
    current = null;
    if (btn) btn.hidden = true;
    return;
  }
  const key = keyOf(source, docId);
  const changed = current?.key !== key;
  current = { source, docId, key };
  if (btn && changed) btn.hidden = true;
  if (!mainEl) return;
  // Above the article, and above the fact-check section, which keeps its
  // place directly over the body.
  let el = section();
  if (!el || !mainEl.contains(el)) {
    el?.remove();
    el = document.createElement("section");
    el.id = SUM_LINKS_SECTION_ID;
    el.className = "sum-links";
    el.setAttribute("aria-label", "Find links");
    const anchor = mainEl.querySelector("#sumFactcheck") ?? mainEl.querySelector("#sumArticleBody");
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else mainEl.appendChild(el);
  }
  el.dataset.key = key;
  el.hidden = !stateFor(key).open;
  render();
  void loadOptions(source, docId, key);
}

export function sumLinksOnClose(): void {
  current = null;
}

async function loadOptions(source: string, docId: string, key: string): Promise<void> {
  try {
    const res = await fetch(`/api/summaries/links/options?source=${encodeURIComponent(source)}&docId=${encodeURIComponent(docId)}`, {
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { available?: boolean; linksBaseHash?: string };
    if (current?.key !== key) return;
    const btn = button();
    if (btn) btn.hidden = data.available !== true;
    const s = stateFor(key);
    // A save in flight owns the hash; otherwise the file's own is the fresh one.
    if (data.available && data.linksBaseHash && !s.saving) s.baseHash = data.linksBaseHash;
  } catch {
    // No button on an unreadable document: the options answer is the gate.
  }
}

/** The 🔎 button. */
export function sumLinksStart(): void {
  if (!current) return;
  const { source, docId, key } = current;
  const s = stateFor(key);
  s.open = true;
  const el = section();
  if (el) el.hidden = false;
  if (s.loading || s.searching) return;
  s.loading = true;
  s.message = null;
  render();
  void (async () => {
    try {
      const res = await fetch("/api/summaries/links/candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, docId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: Candidate[];
        listed?: number;
        linksBaseHash?: string;
        error?: string;
      };
      if (!res.ok || !Array.isArray(data.candidates)) {
        s.message = { text: data.error ?? `Finding candidates failed (HTTP ${res.status}).`, error: true };
        return;
      }
      if (data.linksBaseHash) s.baseHash = data.linksBaseHash;
      s.listed = data.listed ?? 0;
      s.rows = data.candidates.map((candidate, i) => ({ candidate, selected: i < DEFAULT_SELECTED, state: "idle", results: [] }));
    } catch {
      s.message = { text: "Finding candidates failed: the server did not answer.", error: true };
    } finally {
      s.loading = false;
      render();
    }
  })();
}

async function search(source: string, docId: string, key: string): Promise<void> {
  const s = stateFor(key);
  if (!s.rows || s.searching) return;
  const picked = s.rows.filter((r) => r.selected);
  if (picked.length === 0) return;
  s.searching = true;
  s.message = null;
  for (const r of s.rows) if (r.selected) Object.assign(r, { state: "queued", outcome: undefined, results: [] });
  render();
  try {
    const res = await fetch("/api/summaries/links/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, docId, candidates: picked.map((r) => r.candidate) }),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      s.message = { text: data.error ?? `The search failed (HTTP ${res.status}).`, error: true };
      for (const r of picked) r.state = "idle";
      return;
    }
    const parser = makeSseFrameParser((frame) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const row = typeof data.index === "number" ? picked[data.index] : undefined;
      if (frame.event === "state" && row) row.state = data.state === "checking" ? "checking" : "searching";
      else if (frame.event === "result" && row) {
        row.state = "done";
        row.outcome = String(data.outcome ?? "");
        row.results = Array.isArray(data.results) ? (data.results as Found[]) : [];
      } else if (frame.event === "app_error") {
        s.message = { text: String(data.error ?? "The search failed."), error: true };
      }
      render();
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch {
    s.message = { text: "The search stopped: the connection dropped.", error: true };
  } finally {
    s.searching = false;
    for (const r of picked) if (r.state !== "done") r.state = "idle";
    render();
  }
}

function accept(found: Found): void {
  if (!current) return;
  const s = stateFor(current.key);
  if (s.accepted.has(found.url) || s.saving === found.url || s.queue.some((q) => q.url === found.url)) return;
  s.queue.push(found);
  render();
  void drain(current.source, current.docId, current.key);
}

/** Accepts go one at a time: the server holds one write per document. */
async function drain(source: string, docId: string, key: string): Promise<void> {
  const s = stateFor(key);
  if (s.saving) return;
  for (let next = s.queue.shift(); next; next = s.queue.shift()) {
    s.saving = next.url;
    render();
    try {
      const res = await fetch("/api/summaries/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, docId, baseHash: s.baseHash, add: [{ url: next.url, title: next.title, detail: next.detail }] }),
      });
      const data = (await res.json().catch(() => ({}))) as { added?: number; linksBaseHash?: string | null; error?: string; code?: string };
      if (res.ok) {
        s.accepted.add(next.url);
        if (data.linksBaseHash) s.baseHash = data.linksBaseHash;
        s.message = data.added
          ? { text: data.linksBaseHash ? "Saved to the Links section." : "Saved. Reopen the summary before accepting another link.", error: false }
          : { text: "That link is already in the Links section.", error: false };
        reopenIfShown(source, docId);
      } else {
        s.message = { text: data.error ?? `Saving failed (HTTP ${res.status}).`, error: true };
        // Stale or busy: the queued accepts would meet the same answer.
        s.queue.length = 0;
      }
    } catch {
      s.message = { text: "Saving failed: the server did not answer.", error: true };
      s.queue.length = 0;
    } finally {
      s.saving = null;
      render();
    }
  }
}

function reopenIfShown(source: string, docId: string): void {
  const reopen = (globalThis as { openSummaryDoc?: (id: string, url: string, src: string) => void }).openSummaryDoc;
  if (reopen && current && current.source === source && current.docId === docId) reopen(docId, "", source);
}

const LABELS: Record<Found["label"], { text: string; title: string }> = {
  matched: { text: "matched", title: "The page's title and author match what the summary describes" },
  reachable: { text: "reachable", title: "The page resolves and carries the agent's quote, but its title does not match" },
  unread: { text: "reachable, not read", title: "A PDF or other file that resolves; muninn did not read it" },
};

const STATE_TEXT: Record<Row["state"], string> = {
  idle: "",
  queued: "waiting…",
  searching: "searching…",
  checking: "checking…",
  done: "",
};

const OUTCOME_TEXT: Record<string, string> = {
  not_found: "not found",
  timeout: "timed out",
  skipped: "not searched — time ran out",
  error: "search failed",
};

function candidateLabel(c: Candidate): string {
  const head = c.title ? `“${c.title}”` : c.topic;
  return [head, c.author && !head.includes(c.author) ? c.author : "", c.kind].filter(Boolean).join(" · ");
}

function rowHtml(s: DocState, r: Row, i: number): string {
  const busy = s.searching;
  const status = r.state === "done" ? (r.outcome && r.outcome !== "found" ? OUTCOME_TEXT[r.outcome] ?? r.outcome : "") : STATE_TEXT[r.state];
  const results = r.results
    .map((f) => {
      const saved = s.accepted.has(f.url);
      const saving = s.saving === f.url || s.queue.some((q) => q.url === f.url);
      const action = saved
        ? `<span class="sum-links-saved">✓ Saved</span>`
        : `<button type="button" class="sum-links-btn" data-accept="${escHtml(f.url)}"${saving ? " disabled" : ""}>${saving ? "Saving…" : "✓ Accept"}</button>`;
      return (
        `<li class="sum-links-result"><span class="sum-links-label" data-label="${f.label}" title="${escHtml(LABELS[f.label].title)}">${LABELS[f.label].text}</span>` +
        `<a href="${escHtml(f.url)}" target="_blank" rel="noopener noreferrer">${escHtml(f.title)}</a>` +
        (f.detail ? `<span class="sum-links-detail">${escHtml(f.detail)}</span>` : "") +
        `${action}</li>`
      );
    })
    .join("");
  return (
    `<li class="sum-links-row" data-row="${i}"><label><input type="checkbox" data-pick="${i}"${r.selected ? " checked" : ""}${busy ? " disabled" : ""}> ` +
    `<span>${escHtml(candidateLabel(r.candidate))}</span></label>` +
    (status ? ` <span class="sum-links-state" data-state="${r.state}">${escHtml(status)}</span>` : "") +
    (results ? `<ul class="sum-links-results">${results}</ul>` : "") +
    `</li>`
  );
}

function render(): void {
  const el = section();
  if (!el || !current || el.dataset.key !== current.key) return;
  const s = stateFor(current.key);
  const picked = s.rows?.filter((r) => r.selected).length ?? 0;
  const head =
    `<div class="sum-links-head"><span class="sum-links-title">🔎 Find links</span>` +
    `<button type="button" class="sum-links-close" data-close aria-label="Close Find links">×</button></div>`;
  let body = "";
  if (s.loading) body = `<div class="sum-links-note">Reading the summary for posts, papers, repos and tools it names…</div>`;
  else if (s.rows && s.rows.length === 0) {
    body = `<div class="sum-links-note">The summary names nothing more to look up${s.listed ? ` (${s.listed} already in Links)` : ""}.</div>`;
  } else if (s.rows) {
    body =
      `<div class="sum-links-note">Pick up to ${MAX_SELECTED} to search the web for${s.listed ? `; ${s.listed} already in Links left out` : ""}.</div>` +
      `<ul class="sum-links-list">${s.rows.map((r, i) => rowHtml(s, r, i)).join("")}</ul>` +
      `<div class="sum-links-actions"><button type="button" class="sum-links-btn primary" data-search${s.searching || picked === 0 || picked > MAX_SELECTED ? " disabled" : ""}>` +
      `${s.searching ? "Searching…" : `Search ${picked} selected`}</button>` +
      (picked > MAX_SELECTED ? `<span class="sum-links-note">At most ${MAX_SELECTED} at a time.</span>` : "") +
      `</div>`;
  }
  const msg = s.message ? `<div class="sum-links-msg${s.message.error ? " error" : ""}" role="status">${escHtml(s.message.text)}</div>` : "";
  el.innerHTML = head + body + msg;
}

/** One delegated listener per page, wired by the browser entry. */
export function wireSumLinks(): void {
  button()?.addEventListener("click", () => sumLinksStart());
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const el = section();
    if (!target || !el || !el.contains(target) || !current) return;
    const acceptBtn = target.closest<HTMLElement>("[data-accept]");
    if (acceptBtn) {
      const url = acceptBtn.getAttribute("data-accept") ?? "";
      const found = stateFor(current.key).rows?.flatMap((r) => r.results).find((f) => f.url === url);
      if (found) accept(found);
      return;
    }
    if (target.closest("[data-search]")) {
      void search(current.source, current.docId, current.key);
      return;
    }
    if (target.closest("[data-close]")) {
      stateFor(current.key).open = false;
      el.hidden = true;
    }
  });
  document.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement | null;
    if (!target?.matches?.("[data-pick]") || !current) return;
    const s = stateFor(current.key);
    const row = s.rows?.[Number(target.getAttribute("data-pick"))];
    if (row) row.selected = target.checked;
    render();
  });
}

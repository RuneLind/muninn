/// <reference lib="dom" />
/**
 * The `/summaries` doc panel's 🔎 Find links section — the DOM half. Published
 * on `globalThis` by `sum-links-browser.ts`; the page's inline scripts call
 * {@link sumLinksOnOpen} where they call `sumFactcheckOnOpen`.
 *
 * The button shows only on a document the links save accepts (`GET
 * /api/summaries/links/options`). A click lists candidates (one POST), a
 * search streams each selected candidate's state and verified results (POST +
 * SSE), and each ✓ Accept writes one line (one POST at a time — a concurrent
 * one would meet `409 in_flight`). The state is kept per document, so the
 * article reload after a save keeps the panel.
 *
 * The CAS baseline (`baseHash`) is set by the candidates call and moved only by
 * this panel's own saves — never by a reload — so an accept of a result found
 * before an outside write (a re-run, a fact-check write-back) meets the
 * server's 409. No client code parses the stored section.
 */

import { makeSseFrameParser } from "./client-runtime.ts";
import { escHtml } from "./escape.ts";
import { DOC_PANEL_FIND_LINKS_BTN_ID } from "./doc-panel.ts";

export const SUM_LINKS_SECTION_ID = "sumLinks";
/** Selected by default when the list arrives. */
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
  /** What muninn checked on the page: the panel names it (D21). */
  evidence: "title" | "repo" | "author" | "quote" | "pdf";
}
interface Row {
  candidate: Candidate;
  selected: boolean;
  state: "idle" | "queued" | "searching" | "checking" | "done";
  /** `interrupted`: the stream ended before this row's result arrived. */
  outcome?: string;
  results: Found[];
}
interface DocState {
  /** The section is showing (survives the article reload a save triggers). */
  open: boolean;
  /** From the candidates call, then from this panel's own saves. */
  baseHash: string | null;
  /** The server's selection cap, from the candidates answer. */
  maxSelected: number;
  rows: Row[] | null;
  listed: number;
  linked: number;
  loading: boolean;
  searching: boolean;
  /** URLs written, the one being written, and the ones waiting. */
  accepted: Set<string>;
  saving: string | null;
  queue: Found[];
  message: { text: string; error: boolean } | null;
}

const states = new Map<string, DocState>();
let current: { source: string; docId: string; key: string } | null = null;
/** The running search's fetch. Aborted when the panel closes or moves to another document, so the server stops launching agents. */
let searchAbort: { key: string; controller: AbortController } | null = null;

function abortSearch(): void {
  searchAbort?.controller.abort();
  searchAbort = null;
}

const keyOf = (source: string, docId: string) => `${source}\u0000${docId}`;

function stateFor(key: string): DocState {
  let s = states.get(key);
  if (!s) {
    s = {
      open: false,
      baseHash: null,
      maxSelected: DEFAULT_SELECTED,
      rows: null,
      listed: 0,
      linked: 0,
      loading: false,
      searching: false,
      accepted: new Set(),
      saving: null,
      queue: [],
      message: null,
    };
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
  if (changed && searchAbort && searchAbort.key !== key) abortSearch();
  current = { source, docId, key };
  if (btn && changed) btn.hidden = true;
  if (!mainEl) return;
  // Above the fact-check section when it is there, else directly above the
  // article body: the reader's own action sits first.
  let el = section();
  if (!el || !mainEl.contains(el)) {
    el?.remove();
    el = document.createElement("section");
    el.id = SUM_LINKS_SECTION_ID;
    el.className = "sum-links";
    el.setAttribute("aria-label", "Find links");
    const anchor = mainEl.querySelector("#sumFactcheck") ?? mainEl.querySelector("#sumArticleBody");
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else mainEl.insertBefore(el, mainEl.firstChild);
  }
  el.dataset.key = key;
  el.hidden = !stateFor(key).open;
  render();
  void loadOptions(source, docId, key);
}

export function sumLinksOnClose(): void {
  abortSearch();
  current = null;
}

/** The button's gate. It never touches `baseHash`. */
async function loadOptions(source: string, docId: string, key: string): Promise<void> {
  try {
    const res = await fetch(`/api/summaries/links/options?source=${encodeURIComponent(source)}&docId=${encodeURIComponent(docId)}`, {
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { available?: boolean };
    if (current?.key !== key) return;
    const btn = button();
    if (btn) btn.hidden = data.available !== true;
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
  if (s.loading || s.searching || s.saving) return;
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
        linked?: number;
        maxSelected?: number;
        linksBaseHash?: string;
        error?: string;
      };
      if (!res.ok || !Array.isArray(data.candidates) || !data.linksBaseHash) {
        s.message = { text: data.error ?? `Finding candidates failed (HTTP ${res.status}).`, error: true };
        return;
      }
      s.baseHash = data.linksBaseHash;
      s.maxSelected = data.maxSelected ?? DEFAULT_SELECTED;
      s.listed = data.listed ?? 0;
      s.linked = data.linked ?? 0;
      s.accepted.clear();
      s.rows = data.candidates.map((candidate, i) => ({
        candidate,
        selected: i < Math.min(DEFAULT_SELECTED, s.maxSelected),
        state: "idle",
        results: [],
      }));
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
  if (picked.length === 0 || picked.length > s.maxSelected) return;
  s.searching = true;
  s.message = null;
  for (const r of picked) Object.assign(r, { state: "queued", outcome: undefined, results: [] });
  render();
  const controller = new AbortController();
  searchAbort = { key, controller };
  let streamed = false;
  let finished = false;
  try {
    const res = await fetch("/api/summaries/links/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, docId, candidates: picked.map((r) => r.candidate) }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      s.message = { text: data.error ?? `The search failed (HTTP ${res.status}).`, error: true };
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
      } else if (frame.event === "done") {
        finished = true;
      }
      render();
    });
    streamed = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
    if (!finished && !s.message) s.message = { text: "The search ended before it finished. Search again for the rows marked not finished.", error: true };
  } catch {
    s.message = controller.signal.aborted
      ? { text: "The search stopped when the panel closed.", error: true }
      : { text: "The search stopped: the connection dropped.", error: true };
  } finally {
    if (searchAbort?.controller === controller) searchAbort = null;
    s.searching = false;
    for (const r of picked) {
      if (r.state === "done") continue;
      // A row the stream reached but never answered for is marked, so it does not read as never searched.
      if (streamed) Object.assign(r, { state: "done", outcome: "interrupted", results: [] });
      else r.state = "idle";
    }
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
        // The whole row the panel showed: the server writes its own copy of exactly that row.
        body: JSON.stringify({ source, docId, baseHash: s.baseHash, add: [{ url: next.url, title: next.title, detail: next.detail, label: next.label, evidence: next.evidence }] }),
      });
      const data = (await res.json().catch(() => ({}))) as { added?: number; linksBaseHash?: string | null; error?: string };
      if (res.ok) {
        s.accepted.add(next.url);
        // The server's hash of the file it just wrote: the next accept's base.
        if (data.linksBaseHash) s.baseHash = data.linksBaseHash;
        s.message = data.added
          ? { text: data.linksBaseHash ? "Saved to the Links section." : "Saved. Run Find links again before accepting another link.", error: false }
          : { text: "That link is already in the Links section.", error: false };
        if (!data.linksBaseHash) s.queue.length = 0;
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

/** The evidence muninn checked, never a claim that the page IS the item: open it before you accept. */
const EVIDENCE: Record<Found["evidence"], { text: string; title: string }> = {
  title: { text: "title matches", title: "The page's title has the same words as the title the summary states" },
  repo: { text: "names this repo", title: "The summary names this GitHub repo as owner/repo" },
  author: { text: "title overlaps, author named on page", title: "The page's title shares most words with the item, and the author the summary names appears on the page" },
  quote: { text: "quote found on page", title: "The page resolves and carries the sentence the search agent quoted" },
  pdf: { text: "PDF, not read", title: "A PDF that resolves; muninn did not read it" },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const STATE_TEXT: Record<Row["state"], string> = {
  idle: "",
  queued: "waiting…",
  searching: "searching…",
  checking: "checking…",
  done: "",
};

const OUTCOME_TEXT: Record<string, string> = {
  not_found: "not found",
  already_linked: "already linked",
  timeout: "timed out",
  skipped: "not searched",
  error: "search failed",
  interrupted: "not finished",
};

function candidateLabel(c: Candidate): string {
  const head = c.title ? `“${c.title}”` : c.topic;
  return [head, c.author && !head.includes(c.author) ? c.author : "", c.kind].filter(Boolean).join(" · ");
}

function rowHtml(s: DocState, r: Row, i: number): string {
  // A finished row always says how it ended: an empty status would read as never searched.
  // The server sends `found` only with results; `found` with none, or no outcome, is a malformed frame.
  const outcome = r.outcome === "found" ? (r.results.length > 0 ? "found" : "error") : r.outcome || "error";
  const status = r.state === "done" ? (outcome === "found" ? "" : OUTCOME_TEXT[outcome] ?? outcome) : STATE_TEXT[r.state];
  const results = r.results
    .map((f) => {
      const saved = s.accepted.has(f.url);
      const saving = s.saving === f.url || s.queue.some((q) => q.url === f.url);
      const action = saved
        ? `<span class="sum-links-saved">✓ Saved</span>`
        : `<button type="button" class="sum-links-btn" data-accept="${escHtml(f.url)}"${saving ? " disabled" : ""}>${saving ? "Saving…" : "✓ Accept"}</button>`;
      return (
        `<li class="sum-links-result"><span class="sum-links-label" data-evidence="${escHtml(f.evidence)}" title="${escHtml(EVIDENCE[f.evidence]?.title ?? "")}">${escHtml(EVIDENCE[f.evidence]?.text ?? f.evidence)}</span>` +
        `<a href="${escHtml(f.url)}" target="_blank" rel="noopener noreferrer">${escHtml(f.title)}</a>` +
        `<span class="sum-links-host">${escHtml(hostOf(f.url))}</span>` +
        (f.detail ? `<span class="sum-links-detail">${escHtml(f.detail)}</span>` : "") +
        `${action}</li>`
      );
    })
    .join("");
  return (
    `<li class="sum-links-row" data-row="${i}"><label><input type="checkbox" data-pick="${i}"${r.selected ? " checked" : ""}${s.searching ? " disabled" : ""}> ` +
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
  const left = [s.listed ? `${s.listed} already in Links` : "", s.linked ? `${s.linked} already linked in the text` : ""]
    .filter(Boolean)
    .join(", ");
  const head =
    `<div class="sum-links-head"><span class="sum-links-title">🔎 Find links</span>` +
    `<button type="button" class="sum-links-close" data-close aria-label="Close Find links">×</button></div>`;
  let body = "";
  if (s.loading) body = `<div class="sum-links-note">Reading the summary for posts, papers, repos and tools it names…</div>`;
  else if (s.rows && s.rows.length === 0) {
    body = `<div class="sum-links-note">The summary names nothing more to look up${left ? ` (${left})` : ""}.</div>`;
  } else if (s.rows) {
    body =
      `<div class="sum-links-note">Pick up to ${s.maxSelected} to search the web for${left ? `; left out: ${left}` : ""}.</div>` +
      `<ul class="sum-links-list">${s.rows.map((r, i) => rowHtml(s, r, i)).join("")}</ul>` +
      `<div class="sum-links-actions"><button type="button" class="sum-links-btn primary" data-search${s.searching || picked === 0 || picked > s.maxSelected ? " disabled" : ""}>` +
      `${s.searching ? "Searching…" : `Search ${picked} selected`}</button>` +
      (picked > s.maxSelected ? `<span class="sum-links-note">At most ${s.maxSelected} at a time.</span>` : "") +
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
      // The clicked candidate's row, not the first row carrying this URL: two candidates can verify one URL differently.
      const ri = Number(acceptBtn.closest<HTMLElement>("[data-row]")?.getAttribute("data-row"));
      const found = stateFor(current.key).rows?.[ri]?.results.find((f) => f.url === url);
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
    const row = stateFor(current.key).rows?.[Number(target.getAttribute("data-pick"))];
    if (row) row.selected = target.checked;
    render();
  });
}

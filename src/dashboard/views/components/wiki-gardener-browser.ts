/// <reference lib="dom" />
/**
 * Browser entrypoint for the /wiki/gardener review page. Bundled by Bun.build()
 * (see wiki-gardener-client.ts) and injected as an IIFE. Loads a bot's proposals
 * from /api/wiki/proposals, renders one card each (preview + diff + sources +
 * actions), and POSTs approve/reject. Server pre-renders the markdown preview and
 * the diff, so the client just lays them out.
 */

import { escHtml as esc } from "./escape.ts";
import {
  backlogStripModel,
  backlogStripHtml,
  backlogOutcomeHtml,
  backlogTailHtml,
  sourceDraftResultHtml,
  type IngestBacklogResponse,
  type SourceBacklogResult,
} from "./wiki-gardener-strip.ts";
import { sourcesHtml } from "./wiki-gardener-sources.ts";
import { wiringHtml, type WiringPreview } from "./wiki-gardener-wiring.ts";

interface SourceDoc {
  collection: string;
  docId: string;
  title: string;
  url: string;
}
interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
}
interface ProposalView {
  id: string;
  topicKey: string;
  title: string;
  kind: string;
  mode: string;
  targetPath: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  rationale: string | null;
  sourceDocs: SourceDoc[];
  previewHtml: string;
  diff: DiffLine[] | null;
  unresolvedLinks?: string[];
  containedLinks?: string[] | null;
  wiring?: WiringPreview | null;
}
interface ProposalsResponse {
  proposals: ProposalView[];
  error?: string;
}
interface LintFinding {
  check: string;
  relPath: string;
  message: string;
  detail?: string;
}
interface LintResponse {
  findings: LintFinding[];
  counts: Record<string, number>;
  generatedAt: number;
  error?: string;
}
const injectedBot = (window as unknown as { __WIKI_BOT__?: unknown }).__WIKI_BOT__;
const BOT =
  typeof injectedBot === "string"
    ? injectedBot
    : new URLSearchParams(location.search).get("bot") || "";

function withBot(url: string): string {
  if (!BOT) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "bot=" + encodeURIComponent(BOT);
}

let allProposals: ProposalView[] = [];
let statusFilter = "";

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function chip(status: string): string {
  return `<span class="gard-badge chip-${esc(status)}">${esc(status)}</span>`;
}

function diffHtml(diff: DiffLine[]): string {
  let body = "";
  diff.forEach((l) => {
    const cls = l.type === "add" ? "d-add" : l.type === "del" ? "d-del" : "d-ctx";
    const prefix = l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ";
    body += `<span class="${cls}">${esc(prefix + l.text)}</span>`;
  });
  return `<div class="gard-diff">${body}</div>`;
}

function cardHtml(p: ProposalView): string {
  const isDraft = p.status === "draft";
  let html = `<div class="gard-card" data-id="${esc(p.id)}">`;

  // Head
  html += '<div class="gard-card-head"><div class="gard-title-row">';
  html += `<span class="gard-title">${esc(p.title)}</span>`;
  html += `<span class="gard-badge badge-${esc(p.kind)}">${esc(p.kind)}</span>`;
  html += `<span class="gard-badge badge-${esc(p.mode)}">${esc(p.mode)}</span>`;
  html += chip(p.status);
  // New rows: neutral/informational report of body links auto-de-linked at persist
  // time. Legacy rows (no containment report): the old amber unresolved-link chip.
  const contained = p.containedLinks || [];
  if (contained.length) {
    const label = contained.length + (contained.length === 1 ? " link auto-de-linked" : " links auto-de-linked");
    html += `<span class="gard-badge chip-delinked" title="Unresolvable body links de-linked to plain text: ${esc(contained.join(", "))}">${esc(label)}</span>`;
  } else {
    const unresolved = p.unresolvedLinks || [];
    if (unresolved.length) {
      const label = unresolved.length + (unresolved.length === 1 ? " unresolved link" : " unresolved links");
      html += `<span class="gard-badge chip-unresolved" title="Body links to pages that don't exist yet: ${esc(unresolved.join(", "))}">${esc(label)}</span>`;
    }
  }
  html += "</div>";
  html += `<div class="gard-meta-row"><span class="gard-path">${esc(p.targetPath)}</span><span>·</span><span>${esc(fmtDate(p.createdAt))}</span></div>`;
  html += "</div>";

  // Body
  html += '<div class="gard-body">';
  if (p.status === "stale") {
    html +=
      '<div class="gard-stale-note">Target changed since drafting — this proposal was not applied. The topic becomes eligible again on the next weekly gardener run.</div>';
  }
  if (p.rationale) {
    html += `<div class="gard-rationale">${esc(p.rationale)}</div>`;
  }
  html += sourcesHtml(p.sourceDocs);
  // Wiring preview (reviewable rows only) — what approve will link into the wiki.
  html += wiringHtml(p.wiring);

  // Toggles: diff (update only) + preview. Terminal rows (applied/rejected/error)
  // carry no server-rendered preview/diff — metadata only.
  html += '<div class="gard-toggle-row">';
  if (p.diff && p.diff.length) {
    html += `<button class="gard-toggle" data-toggle="diff">Show diff</button>`;
  }
  if (p.previewHtml) {
    html += `<button class="gard-toggle" data-toggle="preview">Show preview</button>`;
  }
  html += "</div>";

  if (p.diff && p.diff.length) {
    html += `<div class="gard-collapsible" data-section="diff">${diffHtml(p.diff)}</div>`;
  }
  if (p.previewHtml) {
    html += `<div class="gard-collapsible" data-section="preview"><div class="gard-preview">${p.previewHtml}</div></div>`;
  }
  html += "</div>";

  // Actions (draft only)
  if (isDraft) {
    html += '<div class="gard-actions">';
    html += `<button class="gard-btn gard-approve" data-action="approve">Approve</button>`;
    html += `<button class="gard-btn gard-reject" data-action="reject">Reject</button>`;
    html += '<span class="gard-outcome"></span>';
    html += "</div>";
  }

  html += "</div>";
  return html;
}

function render(): void {
  const list = document.getElementById("gardList")!;
  const shown = statusFilter
    ? allProposals.filter((p) => p.status === statusFilter)
    : allProposals;
  if (!shown.length) {
    list.innerHTML =
      '<div class="gard-empty">' +
      (allProposals.length ? "No proposals in this view." : "No wiki proposals yet. The gardener drafts them on its weekly run.") +
      "</div>";
    return;
  }
  list.innerHTML = shown.map(cardHtml).join("");
}

function setOutcome(card: HTMLElement, text: string, kind: "ok" | "err" | ""): void {
  const el = card.querySelector(".gard-outcome") as HTMLElement | null;
  if (el) {
    el.textContent = text;
    el.className = "gard-outcome" + (kind ? " " + kind : "");
  }
}

async function act(id: string, action: "approve" | "reject", card: HTMLElement): Promise<void> {
  const buttons = card.querySelectorAll(".gard-btn");
  buttons.forEach((b) => ((b as HTMLButtonElement).disabled = true));
  setOutcome(card, action === "approve" ? "Applying…" : "Rejecting…", "");
  try {
    const res = await fetch(
      withBot("/api/wiki/proposals/" + encodeURIComponent(id) + "/" + action),
      { method: "POST" },
    );
    const data = await res.json();
    if (!res.ok) {
      setOutcome(card, data.error || "Failed (" + res.status + ")", "err");
      buttons.forEach((b) => ((b as HTMLButtonElement).disabled = false));
      return;
    }
    // Update local state + re-render so the status chip + filters reflect the outcome.
    const p = allProposals.find((x) => x.id === id);
    if (p) {
      p.status = ["applied", "stale", "rejected", "error"].includes(data.outcome)
        ? data.outcome
        : p.status;
      p.resolvedAt = Date.now();
    }
    render();
    // A draft that just got applied/rejected changes "drafts awaiting review".
    if (lastBacklogData) renderBacklog(lastBacklogData);
  } catch (err) {
    setOutcome(card, "Network error: " + (err as Error).message, "err");
    buttons.forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

// Delegated clicks: filters, toggles, actions.
document.getElementById("gardFilters")!.addEventListener("click", (e) => {
  const chipEl = (e.target as HTMLElement).closest(".gard-filter");
  if (!chipEl) return;
  statusFilter = chipEl.getAttribute("data-status") || "";
  document.querySelectorAll("#gardFilters .gard-filter").forEach((c) => c.classList.remove("active"));
  chipEl.classList.add("active");
  render();
});

document.getElementById("gardList")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  const toggle = target.closest("[data-toggle]");
  if (toggle) {
    const card = toggle.closest(".gard-card")!;
    const section = toggle.getAttribute("data-toggle");
    const panel = card.querySelector('[data-section="' + section + '"]') as HTMLElement | null;
    if (panel) {
      const open = panel.classList.toggle("open");
      toggle.textContent = (open ? "Hide " : "Show ") + section;
    }
    return;
  }

  const actionBtn = target.closest("[data-action]");
  if (actionBtn) {
    const card = actionBtn.closest(".gard-card") as HTMLElement;
    const id = card.getAttribute("data-id")!;
    act(id, actionBtn.getAttribute("data-action") as "approve" | "reject", card);
  }
});

// ── Lint findings (report-only) ─────────────────────────────────────────────

// Grouped display order + labels; keys mirror the lint engine's check names.
const LINT_LABELS: Record<string, string> = {
  "broken-link": "Broken links",
  orphan: "Orphan pages",
  "stale-updated": "Stale/missing updated:",
  "missing-sources": "Missing sources",
};

function renderLint(findings: LintFinding[]): void {
  const el = document.getElementById("lintList");
  if (!el) return;
  if (!findings.length) {
    el.innerHTML = '<div class="gard-empty">No lint findings — the wiki is clean.</div>';
    return;
  }
  let html = "";
  for (const check of Object.keys(LINT_LABELS)) {
    const items = findings.filter((f) => f.check === check);
    if (!items.length) continue;
    html +=
      '<div class="lint-group"><div class="lint-group-head">' +
      esc(LINT_LABELS[check] || check) +
      ` <span class="lint-count">${items.length}</span></div><ul class="lint-items">`;
    items.forEach((f) => {
      html +=
        `<li><span class="lint-path">${esc(f.relPath)}</span><span class="lint-msg">${esc(f.message)}</span></li>`;
    });
    html += "</ul></div>";
  }
  el.innerHTML = html;
}

function loadLint(): void {
  const el = document.getElementById("lintList");
  if (el) el.innerHTML = '<div class="gard-empty">Loading lint findings…</div>';
  fetch(withBot("/api/wiki/linter-findings"))
    .then((r) => r.json())
    .then((data: LintResponse) => {
      if (data.error) {
        if (el) el.innerHTML = `<div class="gard-empty">${esc(data.error)}</div>`;
        return;
      }
      renderLint(data.findings || []);
    })
    .catch((err: Error) => {
      if (el) el.innerHTML = `<div class="gard-empty">Failed to load lint findings: ${esc(err.message)}</div>`;
    });
}

document.getElementById("lintRefresh")?.addEventListener("click", loadLint);

// ── Ingest backlog strip (report-only "queued up" counter) ──────────────────

let backlogPolling = false;
// Last backlog GET payload, kept so the strip can re-render when the proposal
// list loads/refreshes (the pending-draft count is a client-side count of the
// proposals the page already loaded — not on the backlog payload).
let lastBacklogData: IngestBacklogResponse | null = null;

// The consent panel's open/closed state lives here (not only in the DOM class):
// the strip's innerHTML is replaced wholesale on every render (proposal
// approve/reject, poll ticks), which would otherwise silently collapse a panel
// the user is reading.
let backlogConfirmOpen = false;

// Last source-draft batch result (client-only) — survives the strip's wholesale
// re-renders so the "N drafted…" note stays visible after a refresh.
let lastSourceDraftResult: SourceBacklogResult | { error: string } | null = null;
// Human label of the collection the last batch drafted — names it in the result note.
let lastSourceDraftCollectionLabel: string | null = null;
// The collection chosen in the source-draft <select>. Persisted here (not only in
// the DOM) because the strip's innerHTML is replaced wholesale on every render —
// re-applied after each render so the user's pick + the button's gate survive a poll.
let sourceDraftCollection: string | null = null;
// True while a source-draft batch POST is in flight — keeps the button disabled
// (the batch awaits minutes of model calls) across any interleaved re-render.
let sourceDraftInFlight = false;

function pendingDraftCount(): number {
  return allProposals.filter((p) => p.status === "draft").length;
}

// Re-apply the persisted source-draft collection to the freshly-rendered <select>
// and gate the button on the selected collection's queued count. If the remembered
// collection is no longer an option (e.g. drained to 0 and dropped), adopt whatever
// the server pre-selected (the largest queue). No-op while a batch is in flight
// (the caller re-forces the "Drafting…" disabled state after this).
function syncSourceDraftControl(el: HTMLElement): void {
  const sel = el.querySelector<HTMLSelectElement>(".bk-source-draft-select");
  if (!sel) return;
  if (
    sourceDraftCollection &&
    Array.from(sel.options).some((o) => o.value === sourceDraftCollection)
  ) {
    sel.value = sourceDraftCollection;
  } else {
    sourceDraftCollection = sel.value;
  }
  if (!sourceDraftInFlight) gateSourceDraftButton(el, sel);
}

// Disable the source-draft button when the selected collection has 0 queued docs.
function gateSourceDraftButton(el: HTMLElement, sel: HTMLSelectElement): void {
  const btn = el.querySelector<HTMLButtonElement>(".bk-source-draft-btn");
  if (!btn) return;
  const opt = sel.selectedOptions[0];
  const queued = opt ? Number(opt.getAttribute("data-queued")) : 0;
  btn.disabled = !(Number.isFinite(queued) && queued > 0);
}

function renderBacklog(data: IngestBacklogResponse): void {
  const el = document.getElementById("gardBacklog");
  if (!el) return;
  if (data.error) {
    // A resolution error (non-bot/unknown wiki) — stay quiet, the body already
    // explains the situation.
    lastBacklogData = null;
    el.innerHTML = "";
    return;
  }
  lastBacklogData = data;
  const model = backlogStripModel(data, pendingDraftCount());
  // Tail (collapsed all-time accounting) renders last — below the sentence,
  // control, and last-run note, so the recency-first rows stay the headline.
  // Re-renders (drain polls every 3s) must not slam an open tail shut: capture
  // its open state before replacing the HTML and re-apply after.
  const tailWasOpen = el.querySelector<HTMLDetailsElement>(".bk-tail")?.open === true;
  el.innerHTML =
    backlogStripHtml(model, data.errors) +
    backlogOutcomeHtml(data.lastBacklogRun) +
    sourceDraftResultHtml(lastSourceDraftResult, lastSourceDraftCollectionLabel ?? undefined) +
    backlogTailHtml(model);
  if (tailWasOpen) {
    const tail = el.querySelector<HTMLDetailsElement>(".bk-tail");
    if (tail) tail.open = true;
  }
  // Restore the user's chosen collection + gate the source-draft button on its
  // queued count (the strip's innerHTML is replaced wholesale on every render).
  syncSourceDraftControl(el);
  // Re-apply the in-flight disabled state after a re-render (a concurrent drain
  // poll could otherwise re-enable the button mid-batch).
  if (sourceDraftInFlight) {
    const sd = el.querySelector<HTMLButtonElement>(".bk-source-draft-btn");
    if (sd) {
      sd.disabled = true;
      sd.textContent = "Drafting…";
    }
  }
  const confirm = el.querySelector(".bk-confirm");
  if (confirm) {
    if (backlogConfirmOpen) confirm.classList.add("open");
  } else {
    // The run control (and its panel) left the strip — running/all-offered/etc.
    backlogConfirmOpen = false;
  }
}

function loadBacklog(): void {
  fetch(withBot("/api/wiki/ingest-backlog"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => {
      renderBacklog(data);
      // A run already in flight (e.g. page reloaded mid-drain) — resume polling.
      if (data.running) pollBacklogUntilDone();
    })
    .catch(() => {
      // Best-effort strip — a failed load just leaves it empty, never breaks the page.
      const el = document.getElementById("gardBacklog");
      if (el) el.innerHTML = "";
    });
}

// Poll the backlog GET while a run is in flight; on completion do one final
// ?refresh=1 fetch (to pick up newly-consumed docs) and reload the proposal list.
// A single transient GET failure must NOT stop the loop mid-run (a drain takes
// minutes) — only give up after 3 consecutive failures.
function pollBacklogUntilDone(): void {
  if (backlogPolling) return;
  backlogPolling = true;
  let consecutiveFailures = 0;
  const tick = (): void => {
    fetch(withBot("/api/wiki/ingest-backlog"))
      .then((r) => r.json())
      .then((data: IngestBacklogResponse) => {
        consecutiveFailures = 0;
        renderBacklog(data);
        if (data.running) {
          setTimeout(tick, 3000);
          return;
        }
        backlogPolling = false;
        // Final refresh so the strip reflects the newly-drafted (now pending) docs.
        fetch(withBot("/api/wiki/ingest-backlog?refresh=1"))
          .then((r) => r.json())
          .then((fresh: IngestBacklogResponse) => renderBacklog(fresh))
          .catch(() => {});
        loadProposals();
      })
      .catch(() => {
        consecutiveFailures++;
        if (consecutiveFailures < 3) {
          setTimeout(tick, 3000);
          return;
        }
        backlogPolling = false;
      });
  };
  setTimeout(tick, 2000);
}

async function startBacklogRun(): Promise<void> {
  try {
    const res = await fetch(withBot("/api/wiki/gardener/backlog-run"), { method: "POST" });
    const data = await res.json();
    if (res.ok && (data.state === "started" || data.state === "running")) {
      pollBacklogUntilDone();
    } else if (data.error) {
      const el = document.getElementById("gardBacklog");
      if (el) {
        const note = document.createElement("span");
        note.className = "bk-err";
        note.textContent = " " + data.error;
        el.appendChild(note);
      }
    }
  } catch {
    // Best-effort — leave the strip as-is.
  }
}

// Poll the backlog GET after a manual "Run gardener now" until the scheduler
// claims the forced run (`running` true → hand off to pollBacklogUntilDone) or the
// force flag clears without a visible run (a very fast run we missed between polls —
// do one final refresh + reload proposals). The forced run fires within one
// scheduler tick (~60s), so cap the wait at ~3 min to avoid an endless loop if the
// scheduler is disabled (dev:chat) or the flag is externally cleared.
let runStartPolling = false;
function pollBacklogUntilRunStarts(): void {
  if (runStartPolling || backlogPolling) return;
  runStartPolling = true;
  let attempts = 0;
  const tick = (): void => {
    fetch(withBot("/api/wiki/ingest-backlog"))
      .then((r) => r.json())
      .then((data: IngestBacklogResponse) => {
        renderBacklog(data);
        if (data.running) {
          runStartPolling = false;
          pollBacklogUntilDone(); // the run started — the drain poller owns it now
          return;
        }
        attempts++;
        const stillQueued = data.watcher?.forceQueued === true;
        if (stillQueued && attempts < 60) {
          setTimeout(tick, 3000);
          return;
        }
        // Flag cleared with no visible run (fast run we missed), or we gave up: do a
        // final refresh + reload proposals so any drafts land, then stop.
        runStartPolling = false;
        fetch(withBot("/api/wiki/ingest-backlog?refresh=1"))
          .then((r) => r.json())
          .then((fresh: IngestBacklogResponse) => renderBacklog(fresh))
          .catch(() => {});
        loadProposals();
      })
      .catch(() => {
        runStartPolling = false;
      });
  };
  setTimeout(tick, 3000);
}

// Manually queue a wiki-gardener watcher run (fresh, in-window docs are the weekly
// watcher's turf — the drain refuses them, so this is the only affordance to act on
// them without waiting up to a week). Reuses the generic watcher trigger endpoint
// (sets force_next_run; the scheduler claims it on the next tick). Optimistically
// swaps the button to a queued state, then lets the strip refresh pick up
// forceQueued/running from the server.
async function triggerWatcherRun(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Queuing…";
  try {
    const res = await fetch("/api/watchers/" + encodeURIComponent(id) + "/trigger", { method: "POST" });
    if (!res.ok) throw new Error("status " + res.status);
    // Refresh the strip: the POST persisted force_next_run, so the GET now reports
    // forceQueued → the fresh segment renders the queued note in place of the button.
    const data = await fetch(withBot("/api/wiki/ingest-backlog"))
      .then((r) => r.json())
      .catch(() => null);
    if (data) renderBacklog(data as IngestBacklogResponse);
    pollBacklogUntilRunStarts();
  } catch {
    // Restore the button + surface the error the same way startBacklogRun does.
    if (lastBacklogData) renderBacklog(lastBacklogData);
    const el = document.getElementById("gardBacklog");
    if (el) {
      const note = document.createElement("span");
      note.className = "bk-err";
      note.textContent = " failed to queue gardener run";
      el.appendChild(note);
    }
  }
}

// Draft per-article source pages for a small batch of uncovered docs. An explicit
// click: disables the button (the batch awaits minutes of model calls), POSTs the
// batch, then renders the totals + reloads the strip and proposal list so the fresh
// drafts appear in the gate. Skip-not-fail — a per-doc error is a recorded outcome
// the totals surface, never a failed request.
async function startSourceDraftBacklog(btn: HTMLButtonElement): Promise<void> {
  if (sourceDraftInFlight) return;
  // Always send an explicit collection (falls back to the remembered pick, then
  // youtube — the route's own default — so a missing select can't send nothing).
  const el = document.getElementById("gardBacklog");
  const sel = el?.querySelector<HTMLSelectElement>(".bk-source-draft-select");
  const collection = sel?.value || sourceDraftCollection || "youtube-summaries";
  lastSourceDraftCollectionLabel =
    lastBacklogData?.byCollection.find((c) => c.collection === collection)?.label || collection;
  sourceDraftInFlight = true;
  btn.disabled = true;
  btn.textContent = "Drafting…";
  try {
    const res = await fetch(
      withBot("/api/wiki/gardener/source-draft-backlog?collection=" + encodeURIComponent(collection)),
      { method: "POST" },
    );
    const data = await res.json();
    lastSourceDraftResult =
      res.ok && !data.error ? (data as SourceBacklogResult) : { error: data.error || "failed (" + res.status + ")" };
  } catch (err) {
    lastSourceDraftResult = { error: (err as Error).message };
  } finally {
    sourceDraftInFlight = false;
  }
  // Refresh the strip (newly-covered docs drop from the queue) + reload proposals so
  // the drafts show up in the gate. renderBacklog picks up lastSourceDraftResult.
  fetch(withBot("/api/wiki/ingest-backlog?refresh=1"))
    .then((r) => r.json())
    .then((fresh: IngestBacklogResponse) => renderBacklog(fresh))
    .catch(() => {
      if (lastBacklogData) renderBacklog(lastBacklogData);
    });
  loadProposals();
}

async function resetBacklog(): Promise<void> {
  try {
    await fetch(withBot("/api/wiki/gardener/backlog-reset"), { method: "POST" });
  } catch {
    // ignore
  }
  fetch(withBot("/api/wiki/ingest-backlog?refresh=1"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => renderBacklog(data))
    .catch(() => {});
}

// Soft-cancel an in-flight drain. The POST just flips the run's cancel flag; the
// existing 3s poll keeps running and reports the cancelled outcome on settle. A
// fresh GET right after flips the button to "Cancelling…" without waiting a tick.
async function cancelBacklogRun(): Promise<void> {
  try {
    await fetch(withBot("/api/wiki/gardener/backlog-cancel"), { method: "POST" });
  } catch {
    // Best-effort — the poll still reflects the run's real state.
  }
  fetch(withBot("/api/wiki/ingest-backlog"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => renderBacklog(data))
    .catch(() => {});
}

// Recover an interrupted (crashed/errored) drain — return its undrafted batch docs
// to the pool, then re-fetch the strip so eligible-now grows back + the banner clears.
async function recoverBacklog(): Promise<void> {
  try {
    await fetch(withBot("/api/wiki/gardener/backlog-recover"), { method: "POST" });
  } catch {
    // Best-effort — the follow-up GET reflects the real state either way.
  }
  fetch(withBot("/api/wiki/ingest-backlog"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => renderBacklog(data))
    .catch(() => {});
}

// Dismiss an interrupted drain — leave the batch skipped, just clear the journal so
// the banner disappears on the next render.
async function dismissBacklog(): Promise<void> {
  try {
    await fetch(withBot("/api/wiki/gardener/backlog-dismiss"), { method: "POST" });
  } catch {
    // ignore
  }
  fetch(withBot("/api/wiki/ingest-backlog"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => renderBacklog(data))
    .catch(() => {});
}

// Delegated backlog controls (run / reset / recover / dismiss) — the strip's
// innerHTML is replaced on every render, so listen on the stable container.
document.getElementById("gardBacklog")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-backlog-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-backlog-action");
  const strip = document.getElementById("gardBacklog");
  const confirm = strip?.querySelector(".bk-confirm") as HTMLElement | null;
  if (action === "confirm") {
    // Expand the inline informed-consent panel (no POST yet).
    backlogConfirmOpen = true;
    if (confirm) confirm.classList.add("open");
  } else if (action === "cancel") {
    backlogConfirmOpen = false;
    if (confirm) confirm.classList.remove("open");
  } else if (action === "run") {
    // [Start batch] — the panel's confirmed run.
    backlogConfirmOpen = false;
    if (confirm) confirm.classList.remove("open");
    void startBacklogRun();
  } else if (action === "reset") {
    void resetBacklog();
  } else if (action === "run-watcher") {
    // "Run gardener now" on the fresh segment — queue the weekly watcher.
    const id = btn.getAttribute("data-watcher-id");
    if (id) void triggerWatcherRun(id, btn as HTMLButtonElement);
  } else if (action === "cancel-run") {
    // Soft-cancel the in-flight drain (distinct from the confirm panel's "cancel").
    void cancelBacklogRun();
  } else if (action === "recover") {
    void recoverBacklog();
  } else if (action === "dismiss") {
    void dismissBacklog();
  } else if (action === "source-draft") {
    // Draft per-article source pages for a small batch of uncovered docs.
    void startSourceDraftBacklog(btn as HTMLButtonElement);
  }
});

// Delegated collection picker for the source-draft control — remember the choice
// (it must survive the strip's wholesale re-renders) and re-gate the button on the
// selected collection's queued count.
document.getElementById("gardBacklog")?.addEventListener("change", (e) => {
  const sel = (e.target as HTMLElement).closest(".bk-source-draft-select") as HTMLSelectElement | null;
  if (!sel) return;
  sourceDraftCollection = sel.value;
  const el = document.getElementById("gardBacklog");
  if (el && !sourceDraftInFlight) gateSourceDraftButton(el, sel);
});

const wikiBotSel = document.getElementById("wikiBot") as HTMLSelectElement | null;
if (wikiBotSel) {
  wikiBotSel.addEventListener("change", () => {
    const value = wikiBotSel.value;
    location.href = value ? "/wiki/gardener?bot=" + encodeURIComponent(value) : "/wiki/gardener";
  });
}

function loadProposals(): void {
  fetch(withBot("/api/wiki/proposals"))
    .then((r) => r.json())
    .then((data: ProposalsResponse) => {
      if (data.error && !(data.proposals || []).length) {
        document.getElementById("gardList")!.innerHTML =
          `<div class="gard-empty">${esc(data.error)}</div>`;
        return;
      }
      allProposals = data.proposals || [];
      render();
      // The strip's "drafts awaiting review" count + re-render depend on the
      // proposal list — refresh it now that the count is known.
      if (lastBacklogData) renderBacklog(lastBacklogData);
    })
    .catch((err: Error) => {
      document.getElementById("gardList")!.innerHTML =
        `<div class="gard-empty">Failed to load proposals: ${esc(err.message)}</div>`;
    });
}

// Boot. A non-bot (extra) wiki has no proposals — the server already rendered the
// "unavailable" notice into #gardList, so skip the fetch and leave it in place.
const unavailable = (window as unknown as { __WIKI_GARDENER_UNAVAILABLE__?: unknown })
  .__WIKI_GARDENER_UNAVAILABLE__ === true;
if (!unavailable) loadBacklog();
if (!unavailable) loadLint();
else {
  const lintEl = document.getElementById("lintList");
  if (lintEl)
    lintEl.innerHTML =
      '<div class="gard-empty">The linter is only available for bot wikis.</div>';
}
if (!unavailable) loadProposals();

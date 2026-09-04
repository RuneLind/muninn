/// <reference lib="dom" />
/**
 * Browser entrypoint for the /wiki/gardener review page. Bundled by Bun.build()
 * (see wiki-gardener-client.ts) and injected as an IIFE. Loads a bot's proposals
 * from /api/wiki/proposals, renders one card each (preview + diff + sources +
 * actions), and POSTs approve/reject. Server pre-renders the markdown preview and
 * the diff, so the client just lays them out.
 */

import { escHtml as esc } from "./escape.ts";
// TYPE-ONLY: a value import from the lint engine would drag `node:path` + `Bun.file`
// into this browser bundle.
import type { LintCheck } from "../../../wiki/lint.ts";
import { installWikiReadonlyGuard } from "./wiki-readonly-client.ts";
import {
  backlogStripModel,
  backlogStripHtml,
  backlogOutcomeHtml,
  weeklyRunHtml,
  backlogTailHtml,
  backlogGlossaryHtml,
  sourceDraftResultHtml,
  backlogInspectorHtml,
  backlogDocKey,
  filterBacklogDocs,
  initialInspectorState,
  INSPECTOR_PAGE_SIZE,
  type BacklogBucket,
  type BacklogDoc,
  type BacklogInspectorState,
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
  check: LintCheck;
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
    rerenderStrip();
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

// Grouped display order + labels. `Record<LintCheck, string>` so a check added to
// the engine cannot compile without a label here — `renderLint` iterates THIS map,
// so an unlabelled check renders nothing at all, findings and count included.
const LINT_LABELS: Record<LintCheck, string> = {
  "broken-link": "Broken links",
  orphan: "Orphan pages",
  "stale-updated": "Unusable updated: (missing / unparseable / future)",
  "missing-sources": "Missing sources",
  "index-truncation": "Truncated wikilinks (unclosed [[)",
  "nested-annotation": "Markup nested inside a wikilink",
  "stem-collision": "Same-stem pages (one is hidden from the wiki)",
};

function renderLint(findings: LintFinding[]): void {
  const el = document.getElementById("lintList");
  if (!el) return;
  if (!findings.length) {
    el.innerHTML = '<div class="gard-empty">No lint findings — the wiki is clean.</div>';
    return;
  }
  let html = "";
  for (const check of Object.keys(LINT_LABELS) as LintCheck[]) {
    const items = findings.filter((f) => f.check === check);
    if (!items.length) continue;
    html +=
      '<div class="lint-group"><div class="lint-group-head">' +
      esc(LINT_LABELS[check]) +
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

// Backlog inspector (the panel behind every count in the strip). Module-level for
// the same reason as `backlogConfirmOpen` / the source-draft pick: renderBacklog
// replaces the strip's innerHTML wholesale and the drain poller re-renders every
// 3s, so any state parked in the DOM would be wiped on the next tick.
let inspector: BacklogInspectorState = initialInspectorState();
// True while the lazy `?docs=1` fetch is in flight — one at a time.
let inspectorFetching = false;

// Reindex poll cadence after a delete (huginn's 200 only starts the reindex).
const REINDEX_POLL_INTERVAL_MS = 2000;
// Hard stop so an abandoned/stuck reindex can't leave a row wedged on "removing…";
// the server cache heals at TTL expiry either way.
const REINDEX_POLL_MAX_MS = 120_000;
// How many consecutive NON-terminal, non-`running` status reads (an `idle`, a 400, an
// unreachable huginn) before the poll gives up on that collection. Small: the status
// is only ever `idle` here when something is wrong, since huginn flips the collection
// to `running` synchronously BEFORE its DELETE responds (verified in huginn
// main/runtime/knowledge_store.py) — so the first poll can never see a stale terminal
// state from a previous run.
const REINDEX_STATUS_RETRY_MAX = 3;
// Server-side cap on one dismiss request's key list (`MAX_DISMISS_KEYS` in
// wiki-gardener-routes.ts). The client chunks to stay under it so the bulk affordance
// can never trip the 400 on a tail-heavy bot.
const DISMISS_KEY_CHUNK = 2000;

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
  // Same guard for the glossary `<details>` at the strip's foot — a poll tick must
  // not slam it shut while the user is reading the bucket definitions.
  const glossaryWasOpen = el.querySelector<HTMLDetailsElement>(".bk-glossary")?.open === true;
  // Same footgun for the inspector's scrolling row list: replacing the innerHTML
  // resets it to the top mid-read on every 3s poll tick, so capture + re-apply.
  const inspectorScrollTop = el.querySelector<HTMLElement>(".bk-inspector-rows")?.scrollTop ?? 0;
  el.innerHTML =
    backlogStripHtml(model, data.errors, inspector) +
    backlogOutcomeHtml(data.lastBacklogRun) +
    weeklyRunHtml(data.weeklyRun) +
    sourceDraftResultHtml(lastSourceDraftResult, lastSourceDraftCollectionLabel ?? undefined) +
    backlogTailHtml(model, inspector) +
    // The inspector renders last (its own full-width row below the tail) and only
    // when open — its state lives at module level, so a poll re-render can't shut it.
    backlogInspectorHtml(inspector, model.perSource, {
      pruneEnabled: model.pruneEnabled,
      // The per-doc drafter's own route gate — `gardenerEnabled` only; unlike the
      // prune verbs it writes no watcher snapshot, so it needs no seeded watcher.
      draftEnabled: data.gardenerEnabled !== false,
      wikiName: BOT,
    }) +
    backlogGlossaryHtml(model);
  if (tailWasOpen) {
    const tail = el.querySelector<HTMLDetailsElement>(".bk-tail");
    if (tail) tail.open = true;
  }
  if (glossaryWasOpen) {
    const gloss = el.querySelector<HTMLDetailsElement>(".bk-glossary");
    if (gloss) gloss.open = true;
  }
  if (inspectorScrollTop > 0) {
    const rows = el.querySelector<HTMLElement>(".bk-inspector-rows");
    if (rows) rows.scrollTop = inspectorScrollTop;
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
          .then((fresh: IngestBacklogResponse) => {
            renderBacklog(fresh);
            // The drain just consumed docs — an open panel's rows are stale.
            refreshInspectorAfterMutation();
          })
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
          .then((fresh: IngestBacklogResponse) => {
            renderBacklog(fresh);
            refreshInspectorAfterMutation();
          })
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
    rerenderStrip();
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
    .then((fresh: IngestBacklogResponse) => {
      renderBacklog(fresh);
      // Freshly-covered docs left the queue — refetch an open panel's rows.
      refreshInspectorAfterMutation();
    })
    .catch(() => {
      rerenderStrip();
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
    .then((data: IngestBacklogResponse) => {
      renderBacklog(data);
      // The offered bucket just emptied — its rows would still chip "offered".
      refreshInspectorAfterMutation();
    })
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
    .then((data: IngestBacklogResponse) => {
      renderBacklog(data);
      // The recovered batch moved back out of the offered bucket.
      refreshInspectorAfterMutation();
    })
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

// Re-render the strip from the last payload — the inspector's state changes are
// client-only (open/filter/paging/removing), so they never need a server round-trip.
// NB: this must re-enter `renderBacklog`, NOT itself (a self-call shipped in PR 1 and
// blew the stack on the first inspector toggle).
function rerenderStrip(): void {
  if (lastBacklogData) renderBacklog(lastBacklogData);
}

// Lazy per-doc fetch (`?docs=1`) behind the inspector. Runs on OPEN only — the
// strip's 3s drain poll never asks for docs, so the hot path stays count-only.
// Any previously-loaded rows stay on screen while this refreshes.
async function loadInspectorDocs(): Promise<void> {
  if (inspectorFetching) return;
  inspectorFetching = true;
  inspector.loading = true;
  rerenderStrip();
  try {
    const res = await fetch(withBot("/api/wiki/ingest-backlog?docs=1"));
    const data = (await res.json()) as IngestBacklogResponse;
    if (Array.isArray(data.docs)) {
      inspector.docs = data.docs as BacklogDoc[];
      inspector.error = null;
      inspector.loading = false;
      inspectorFetching = false;
      // The docs response carries the fresh live fields too — render from it so the
      // counts and the rows behind them come from the same snapshot.
      renderBacklog(data);
      return;
    }
    inspector.error = data.error || "no doc list in the response";
  } catch {
    inspector.error = "couldn't load the doc list";
  }
  inspectorFetching = false;
  inspector.loading = false;
  rerenderStrip();
}

// Re-run the lazy doc fetch when a MUTATING action changed the backlog under an
// open panel (a drain settling, Reset offered, Backfill oldest, recover/dismiss):
// the rows and their bucket chips are a snapshot, so without this an open panel
// keeps showing drained rows chipped "drainable". Once per event — never per poll
// tick (the 3s drain poll stays count-only) — and a no-op while closed.
function refreshInspectorAfterMutation(): void {
  if (inspector.open) void loadInspectorDocs();
}

// ── Prune verbs (dismiss / un-dismiss / delete) ────────────────────────────
//
// Dismiss lands at the LIVE-merge layer (the dismissed set is read per request,
// outside the 5-min cache), so a PLAIN refetch already reflects it — never
// `refresh=1`, which would force the expensive recompute (wiki sweep + 5 sequential
// huginn listings) on every click.

// Set/clear the STICKY prune notice. It lives on its own state field (not
// `inspector.error`) precisely because every prune verb ends in a refetch and
// `loadInspectorDocs` nulls `error` on success — a 409/404/400 or the honest
// skipped-reindex note would otherwise vanish within a frame. Cleared by the next
// user action (a prune click, a filter change, a panel toggle), never by a refetch.
function setInspectorNotice(text: string, kind: "err" | "info"): void {
  inspector.notice = { text, kind };
}
function clearInspectorNotice(): void {
  inspector.notice = null;
}

// Plain (non-refresh) strip refetch + inspector refresh — the dismiss verbs' tail.
function reloadAfterDismiss(): void {
  fetch(withBot("/api/wiki/ingest-backlog"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => {
      renderBacklog(data);
      refreshInspectorAfterMutation();
    })
    .catch(() => {});
}

// POST a key list to a dismiss verb, CHUNKED under the route's `MAX_DISMISS_KEYS`
// cap (sequential awaits — the routes serialize on the per-bot gardener mutex, so
// parallel chunks would just 409 each other). Stops on the first failed chunk and
// leaves a sticky notice; the already-applied chunks stand (dismiss is idempotent
// and reversible, so a partial apply is safe — the counts show what landed).
async function postDismissKeys(path: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  clearInspectorNotice();
  for (let i = 0; i < keys.length; i += DISMISS_KEY_CHUNK) {
    const chunk = keys.slice(i, i + DISMISS_KEY_CHUNK);
    let failed = false;
    try {
      const res = await fetch(withBot(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: chunk }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setInspectorNotice(body.error || `dismiss failed (${res.status})`, "err");
        failed = true;
      }
    } catch {
      setInspectorNotice("couldn't reach the server", "err");
      failed = true;
    }
    if (failed) break;
  }
  reloadAfterDismiss();
}

// "Reset dismissed (N)" — the offered-reset analogue for the prune bucket.
async function resetDismissed(): Promise<void> {
  clearInspectorNotice();
  try {
    const res = await fetch(withBot("/api/wiki/gardener/backlog-docs-dismiss-reset"), {
      method: "POST",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setInspectorNotice(body.error || `reset failed (${res.status})`, "err");
    }
  } catch {
    setInspectorNotice("couldn't reach the server", "err");
  }
  reloadAfterDismiss();
}

// The keys the bulk button acts on: the whole FILTERED set minus already-dismissed
// rows (mirrors `backlogInspectorHtml`'s own bulk-target derivation).
function bulkDismissTargets(): string[] {
  if (!inspector.docs) return [];
  return filterBacklogDocs(inspector.docs, inspector.bucket, inspector.collection)
    .filter((d) => d.bucket !== "dismissed")
    .map((d) => backlogDocKey(d));
}

/**
 * Delete one doc from huginn, then wait for the truth to catch up.
 *
 * huginn's 200 means "source moved + background reindex started" — the doc is still
 * in its LISTING until that reindex finishes. So: mark the row "removing…", poll
 * each started collection's update-status until terminal (which is also where the
 * server drops the bot's cached backlog), and only THEN re-fetch with `refresh=1`.
 * An immediate `refresh=1` would re-list the still-present doc and cache that wrong
 * payload for the full 5-min TTL.
 *
 * A `skipped_already_running` collection is reported honestly instead of polled: its
 * in-flight run started BEFORE the move, so its success says nothing about this delete.
 * If the poll is abandoned (page reload) the cache entry heals at TTL expiry.
 *
 * **`refresh=1` is conditional on a TERMINAL poll.** The server drops its cached
 * backlog only when a status poll reads `succeeded`/`failed`; so when NOTHING reached
 * terminal (every collection `skipped_already_running`, or the status never resolved)
 * a `refresh=1` would recompute against the still-listing huginn and re-cache that
 * wrong payload for the full 5-min TTL — the exact move the route comment warns
 * against. Those cases do a PLAIN refetch and say so in the sticky notice.
 */
async function deleteBacklogDoc(collection: string, id: string, label: string): Promise<void> {
  const key = `${collection}/${id}`;
  if (inspector.removing.includes(key)) return;
  if (!window.confirm(`Delete "${label}" from ${collection}?\n\nThis removes the document from huginn AND deletes every unapplied source-page draft written from it (an applied page is kept). It cannot be undone from this page.`)) {
    return;
  }
  inspector.removing = [...inspector.removing, key];
  inspector.error = null;
  clearInspectorNotice();
  rerenderStrip();

  let polling: string[] = [];
  let skipped: string[] = [];
  try {
    const res = await fetch(withBot("/api/wiki/gardener/backlog-doc-delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection, id }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      polling?: string[];
      skipped?: string[];
    };
    if (!res.ok) {
      setInspectorNotice(body.error || `delete failed (${res.status})`, "err");
      inspector.removing = inspector.removing.filter((k) => k !== key);
      rerenderStrip();
      return;
    }
    polling = Array.isArray(body.polling) ? body.polling : [];
    skipped = Array.isArray(body.skipped) ? body.skipped : [];
  } catch {
    setInspectorNotice("couldn't reach the server", "err");
    inspector.removing = inspector.removing.filter((k) => k !== key);
    rerenderStrip();
    return;
  }

  // The route also deleted the doc's source-page proposals — a gate card for one
  // of them is now a 404 behind Approve, so the gate re-lists before anything else.
  loadProposals();

  const { unresolved } = await waitForReindex(polling);
  inspector.removing = inspector.removing.filter((k) => k !== key);

  // Honest, not silent: the doc IS gone from disk, but the listing this panel reads
  // won't reflect it until those collections reindex again.
  const caveats: string[] = [];
  if (skipped.length) caveats.push(`a reindex was already running for ${skipped.join(", ")}`);
  if (unresolved.length) {
    caveats.push(`the reindex for ${unresolved.join(", ")} never reported a terminal status`);
  }
  if (caveats.length) {
    setInspectorNotice(
      `deleted — but ${caveats.join(" and ")}, so the doc may still be listed until the next index run`,
      "info",
    );
  }

  // Only a TERMINAL poll invalidated the server cache; without one, `refresh=1` would
  // re-cache the still-listed doc for the whole TTL. Plain refetch instead — the row
  // disappears on a later manual refresh once the blocking run (and a retried update)
  // has finished.
  const invalidated = polling.length - unresolved.length > 0;
  if (!invalidated) {
    reloadAfterDismiss();
    return;
  }
  fetch(withBot("/api/wiki/ingest-backlog?refresh=1"))
    .then((r) => r.json())
    .then((data: IngestBacklogResponse) => {
      renderBacklog(data);
      refreshInspectorAfterMutation();
    })
    .catch(() => {
      rerenderStrip();
    });
}

/**
 * Run the source drafter on ONE doc — the row's `draft` / `rename & draft` verbs.
 *
 * `title` is the rename affordance: the drafter uses it verbatim and skips the
 * collision retry whose SKIP branch is what dropped these docs in the first place.
 * The outcome is reported through the sticky notice (a `covered`/`skipped` is a
 * legitimate answer, not a failure) and the rows are refetched so the row's own
 * "why" line reflects the attempt just recorded — one source of truth, server-side.
 *
 * No `refresh=1`: the attempt ledger is read per request, OUTSIDE the 5-min backlog
 * cache, exactly like the dismissed set.
 */
async function draftBacklogDoc(
  collection: string,
  id: string,
  label: string,
  title?: string,
): Promise<void> {
  const key = `${collection}/${id}`;
  if (inspector.drafting.includes(key) || inspector.removing.includes(key)) return;
  inspector.drafting = [...inspector.drafting, key];
  inspector.error = null;
  setInspectorNotice(`drafting “${label}”… (one model call, up to a minute)`, "info");
  rerenderStrip();

  try {
    const res = await fetch(withBot("/api/wiki/gardener/source-draft-doc"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection, id, ...(title ? { title } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      outcome?: string;
      reason?: string;
      title?: string;
    };
    if (!res.ok) {
      // A per-doc `error` outcome rides a 500 with `reason` (not `error`) — read both,
      // or the one message worth showing is replaced by the status code.
      setInspectorNotice(body.error || body.reason || `draft failed (${res.status})`, "err");
    } else if (body.outcome === "drafted") {
      setInspectorNotice(`drafted “${body.title || label}” — review it in the gate below`, "info");
      loadProposals(); // a new draft card exists in the gate now
    } else {
      setInspectorNotice(
        `${body.outcome ?? "no outcome"}${body.reason ? ` — ${body.reason}` : ""}`,
        body.outcome === "error" ? "err" : "info",
      );
    }
  } catch {
    setInspectorNotice("couldn't reach the server", "err");
  }

  inspector.drafting = inspector.drafting.filter((k) => k !== key);
  refreshInspectorAfterMutation();
  rerenderStrip();
}

/**
 * Poll each collection's reindex until TERMINAL (bounded — never a wedged spinner).
 *
 * Terminal is `succeeded`/`failed` EXPLICITLY — huginn's status vocabulary is
 * `idle|running|succeeded|failed`, and the server invalidates its backlog cache on
 * exactly those two, so a looser `status !== "running"` predicate would report "done"
 * for an `idle`/`unknown`/400 read that dropped no cache. There is no
 * "first poll sees the previous run's terminal status" race to guard against: huginn
 * marks the collection `running` synchronously before the DELETE responds.
 *
 * Returns the collections whose status never resolved (retry budget exhausted, huginn
 * unreachable, or the overall deadline hit) so the caller can skip `refresh=1`.
 */
async function waitForReindex(collections: string[]): Promise<{ unresolved: string[] }> {
  const deadline = Date.now() + REINDEX_POLL_MAX_MS;
  const pending = new Set(collections);
  const unresolved = new Set<string>();
  const strikes = new Map<string, number>();
  const strike = (collection: string): void => {
    const n = (strikes.get(collection) ?? 0) + 1;
    strikes.set(collection, n);
    if (n >= REINDEX_STATUS_RETRY_MAX) {
      pending.delete(collection);
      unresolved.add(collection);
    }
  };
  while (pending.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, REINDEX_POLL_INTERVAL_MS));
    for (const collection of [...pending]) {
      try {
        const res = await fetch(
          withBot(
            `/api/wiki/gardener/backlog-doc-delete-status?collection=${encodeURIComponent(collection)}`,
          ),
        );
        const body = (await res.json()) as { status?: string };
        if (body.status === "succeeded" || body.status === "failed") {
          pending.delete(collection);
        } else if (body.status === "running") {
          strikes.delete(collection);
        } else {
          // `idle` / `unknown` / a 400 body — retry a couple of ticks (a transient
          // blip), then stop waiting on it rather than spinning to the deadline.
          strike(collection);
        }
      } catch {
        strike(collection);
      }
    }
  }
  // Anything still pending when the deadline hit never went terminal either.
  for (const collection of pending) unresolved.add(collection);
  return { unresolved: [...unresolved] };
}

// Open the inspector on a count's (bucket, collection) pair — or close it when the
// same count is clicked again (the toggle contract).
function toggleInspector(bucket: BacklogBucket | "all", collection: string): void {
  clearInspectorNotice();
  if (inspector.open && inspector.bucket === bucket && inspector.collection === collection) {
    inspector.open = false;
    rerenderStrip();
    return;
  }
  inspector.open = true;
  // A stale error from a previous failed open must not render in place of the
  // "Loading docs…" state on the next one.
  inspector.error = null;
  inspector.bucket = bucket;
  inspector.collection = collection;
  inspector.limit = INSPECTOR_PAGE_SIZE;
  rerenderStrip();
  void loadInspectorDocs();
}

// Delegated backlog controls (run / reset / recover / dismiss) — the strip's
// innerHTML is replaced on every render, so listen on the stable container.
document.getElementById("gardBacklog")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  // Inspector toggles (the counts in the sentence / tail / offered chip).
  const toggle = target.closest("[data-backlog-inspect]");
  if (toggle) {
    const bucket = (toggle.getAttribute("data-backlog-inspect") || "all") as BacklogBucket | "all";
    toggleInspector(bucket, toggle.getAttribute("data-inspect-collection") || "");
    return;
  }
  // Per-row prune verbs (dismiss / un-dismiss / delete).
  const docAction = target.closest("[data-doc-action]");
  if (docAction) {
    const what = docAction.getAttribute("data-doc-action");
    const key = docAction.getAttribute("data-doc-key") || "";
    if (what === "dismiss") void postDismissKeys("/api/wiki/gardener/backlog-docs-dismiss", [key]);
    else if (what === "undismiss") {
      void postDismissKeys("/api/wiki/gardener/backlog-docs-undismiss", [key]);
    } else if (what === "delete") {
      void deleteBacklogDoc(
        docAction.getAttribute("data-doc-collection") || "",
        docAction.getAttribute("data-doc-id") || "",
        docAction.getAttribute("data-doc-label") || key,
      );
    } else if (what === "draft" || what === "rename-draft") {
      const collection = docAction.getAttribute("data-doc-collection") || "";
      const id = docAction.getAttribute("data-doc-id") || "";
      const label = docAction.getAttribute("data-doc-label") || key;
      let title: string | undefined;
      if (what === "rename-draft") {
        // Seeded with the doc's own label: the collision case needs a title DIFFERENT
        // from the existing page, and the article's own name is the obvious start.
        const answer = window.prompt(
          `Title for the new wiki page about "${label}":\n\nUse this when the drafter skipped the doc for colliding with an existing page — pick a title that says what THIS source adds.`,
          label,
        );
        if (answer === null) return; // cancelled
        title = answer.trim();
        if (!title) return;
      }
      void draftBacklogDoc(collection, id, label, title);
    }
    return;
  }
  // Inspector panel controls (close / show more / bulk dismiss).
  const inspectAction = target.closest("[data-inspect-action]");
  if (inspectAction) {
    const what = inspectAction.getAttribute("data-inspect-action");
    if (what === "close") inspector.open = false;
    else if (what === "more") inspector.limit += INSPECTOR_PAGE_SIZE;
    else if (what === "bulk-dismiss") {
      const keys = bulkDismissTargets();
      if (keys.length && window.confirm(`Dismiss ${keys.length} doc(s)? They stop being selected by the gardener, and can be un-dismissed later.`)) {
        void postDismissKeys("/api/wiki/gardener/backlog-docs-dismiss", keys);
      }
      return;
    }
    rerenderStrip();
    return;
  }
  // Inspector bucket filter.
  const bucketBtn = target.closest("[data-inspect-bucket]");
  if (bucketBtn) {
    clearInspectorNotice();
    inspector.bucket = (bucketBtn.getAttribute("data-inspect-bucket") || "all") as BacklogBucket | "all";
    inspector.limit = INSPECTOR_PAGE_SIZE;
    rerenderStrip();
    return;
  }
  const btn = target.closest("[data-backlog-action]");
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
  } else if (action === "reset-dismissed") {
    void resetDismissed();
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
  // The inspector's collection filter (client-only — the docs are already loaded).
  const inspectSel = (e.target as HTMLElement).closest(".bk-inspector-select") as HTMLSelectElement | null;
  if (inspectSel) {
    clearInspectorNotice();
    inspector.collection = inspectSel.value;
    inspector.limit = INSPECTOR_PAGE_SIZE;
    rerenderStrip();
    return;
  }
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
      rerenderStrip();
    })
    .catch((err: Error) => {
      document.getElementById("gardList")!.innerHTML =
        `<div class="gard-empty">Failed to load proposals: ${esc(err.message)}</div>`;
    });
}

// A wiki-readonly instance dims + blocks Approve, Start batch, Backfill oldest
// and the per-row draft verbs, so the 403 is visible before the click. No-op
// when this instance owns writes.
installWikiReadonlyGuard();

// Boot. A non-bot (extra) wiki has no proposals — the server already rendered the
// "unavailable" notice into #gardList, so skip the fetch and leave it in place.
const unavailable = (window as unknown as { __WIKI_GARDENER_UNAVAILABLE__?: unknown })
  .__WIKI_GARDENER_UNAVAILABLE__ === true;
if (!unavailable) loadBacklog();
// The lint is loaded UNCONDITIONALLY — unlike the proposals/backlog it needs nothing
// from a bot or a search collection, just the wiki's own page index, so it works on
// the very wikis this page otherwise reports as gardener-"unavailable" (a standalone
// `WIKI_EXTRA` wiki with no collections). Those are exactly the hand-authored wikis
// whose frontmatter the lint has the most to say about.
loadLint();
if (!unavailable) loadProposals();

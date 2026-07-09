/// <reference lib="dom" />
/**
 * Browser entrypoint for the /wiki/gardener review page. Bundled by Bun.build()
 * (see wiki-gardener-client.ts) and injected as an IIFE. Loads a bot's proposals
 * from /api/wiki/proposals, renders one card each (preview + diff + sources +
 * actions), and POSTs approve/reject. Server pre-renders the markdown preview and
 * the diff, so the client just lays them out.
 */

import { escHtml as esc } from "./escape.ts";

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
interface BacklogCollection {
  collection: string;
  source: string;
  label: string;
  total: number;
  ingested: number;
  queued: number;
}
interface LastBacklogRun {
  finishedAt: number;
  offered: number;
  drafted: number;
  error?: string;
}
interface IngestBacklogResponse {
  byCollection: BacklogCollection[];
  total: number;
  ingested: number;
  queued: number;
  wikiUrlCount: number;
  generatedAt: number;
  errors?: { source: string; collection: string; error: string }[];
  error?: string;
  // Live fields (PR 2) — merged fresh on every response, outside the TTL cache.
  running?: boolean;
  offered?: number;
  remaining?: number;
  watcherSeeded?: boolean;
  lastBacklogRun?: LastBacklogRun | null;
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

function sourcesHtml(docs: SourceDoc[]): string {
  if (!docs.length) return "";
  let html = '<div class="gard-section-label">Sources (' + docs.length + ")</div><ul class=\"gard-sources\">";
  docs.forEach((d) => {
    const label = d.title || d.docId;
    html += "<li>";
    html += d.url
      ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(label)}</a>`
      : esc(label);
    html += ` <span class="gard-src-coll">${esc(d.collection)}</span></li>`;
  });
  return html + "</ul>";
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

function backlogOutcome(run: LastBacklogRun | null | undefined): string {
  if (!run) return "";
  if (run.error) {
    return ` <span class="bk-err">last run failed: ${esc(run.error)}</span>`;
  }
  if (run.drafted > 0) {
    return ` <span class="bk-run-note">last run: ${run.drafted} draft(s) from ${run.offered} docs — see proposals below</span>`;
  }
  return ` <span class="bk-run-note">last run finished — nothing clustered; ${run.offered} docs offered</span>`;
}

function backlogControl(data: IngestBacklogResponse): string {
  // Hide the whole control when there's no wiki-gardener watcher (no offered-memory FK).
  if (data.watcherSeeded === false) return "";
  if (data.running) {
    return `<button class="gard-btn bk-run" disabled>Running…</button>`;
  }
  const remaining = typeof data.remaining === "number" ? data.remaining : data.queued;
  if (remaining <= 0 && data.queued > 0) {
    // Everything queued has already been offered — offer a reset to re-run.
    return `<span class="bk-run-note">all offered</span> <button class="gard-btn bk-reset" data-backlog-action="reset">Reset to re-run</button>`;
  }
  if (remaining <= 0) return ""; // nothing queued at all
  return `<button class="gard-btn bk-run" data-backlog-action="run">Ingest backlog (${remaining})</button>`;
}

function renderBacklog(data: IngestBacklogResponse): void {
  const el = document.getElementById("gardBacklog");
  if (!el) return;
  if (data.error) {
    // A resolution error (non-bot/unknown wiki) — stay quiet, the body already
    // explains the situation.
    el.innerHTML = "";
    return;
  }
  // Per-source queued counts, in the byCollection (SUMMARY_SOURCES) order.
  const parts = (data.byCollection || [])
    .map((c) => `<span class="bk-src">${esc(c.label)} <span class="bk-n">${c.queued}</span></span>`)
    .join('<span class="bk-sep">·</span>');
  const errNote = data.errors && data.errors.length
    ? ` <span class="bk-err">(some sources unavailable)</span>`
    : "";
  el.innerHTML =
    `<span class="bk-label">Ingest backlog:</span> <span class="bk-total">${data.queued}</span>` +
    ` summaries never ingested into the wiki` +
    (parts ? ` <span class="bk-sep">—</span> ${parts}` : "") +
    errNote +
    ` <span class="bk-control">${backlogControl(data)}</span>` +
    backlogOutcome(data.lastBacklogRun);
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

// Delegated backlog controls (run / reset) — the strip's innerHTML is replaced
// on every render, so listen on the stable container.
document.getElementById("gardBacklog")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-backlog-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-backlog-action");
  if (action === "run") void startBacklogRun();
  else if (action === "reset") void resetBacklog();
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

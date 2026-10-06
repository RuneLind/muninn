/// <reference lib="dom" />
/**
 * The Fact check section's write-back controls — ➕ Add to summary and
 * ✎ Integrate corrections — the DOM half of
 * `src/dashboard/routes/summaries-factcheck-writeback.ts`.
 *
 * The integrate preview arrives as server-rendered HTML (one checkbox per edit,
 * `data-edit-idx` into the proposal's `edits`), so this module carries no diff
 * code. Apply posts the CHECKED edits back with the proposal's `rawSha256` and
 * `rowVersion`; the server re-resolves them against a fresh read.
 *
 * Imports nothing from `wiki-integrate.ts`: the bundle stays the size of its
 * own buttons.
 */

import { escHtml } from "./escape.ts";

export interface WritebackSaved {
  claims: { verdict: string }[];
  createdAt: number;
  appliedAt?: number | null;
}

interface ProposedEdit {
  claimIndex: number;
  verdict: string;
  old: string;
  new: string;
  reason: string;
}

interface Proposal {
  edits: ProposedEdit[];
  html: string;
  note?: string;
  rawSha256: string;
  rowVersion: string;
  selected: boolean[];
}

interface WritebackState {
  busy: "" | "append" | "propose" | "apply";
  proposal: Proposal | null;
  message: { text: string; tone: "ok" | "error"; items?: string[] } | null;
  /** The web result the proposal and message belong to (`createdAt`). */
  resultAt: number | null;
  /** The next full open is the write's own reload: keep the message once. */
  keepMessage: boolean;
}

const states = new Map<string, WritebackState>();

function stateFor(key: string): WritebackState {
  let s = states.get(key);
  if (!s) {
    s = { busy: "", proposal: null, message: null, resultAt: null, keepMessage: false };
    states.set(key, s);
  }
  return s;
}

/** A new web result replaces the proposal and the message it was made for. */
function syncResult(s: WritebackState, createdAt: number): void {
  if (s.resultAt !== null && s.resultAt !== createdAt) {
    s.proposal = null;
    s.message = null;
  }
  s.resultAt = createdAt;
}

/** A full open of the document: a reader coming back sees no stale message. */
export function writebackOnOpen(key: string): void {
  const s = stateFor(key);
  if (s.keepMessage) s.keepMessage = false;
  else s.message = null;
}

/** The write is about to reopen the document it wrote. */
export function writebackKeepMessage(key: string): void {
  stateFor(key).keepMessage = true;
}

const CORRECTABLE = new Set(["❌", "⚠️", "⚠"]);

/** Does the saved check carry a ❌ or ⚠️ claim? */
export function hasCorrectableVerdict(saved: WritebackSaved): boolean {
  return saved.claims.some((c) => CORRECTABLE.has(c.verdict));
}

/** The write-back block under the answer. `stale` and `blockAdded` are `/result`'s. */
export function writebackHtml(key: string, saved: WritebackSaved, stale: boolean | null, blockAdded: boolean | null = null): string {
  const s = stateFor(key);
  syncResult(s, saved.createdAt);
  const items = s.message?.items?.length
    ? `<ul class="sum-fc-wb-items">${s.message.items.map((i) => `<li>${escHtml(i)}</li>`).join("")}</ul>`
    : "";
  const msg = s.message
    ? `<div class="sum-fc-wb-msg ${s.message.tone}" role="${s.message.tone === "error" ? "alert" : "status"}">${escHtml(s.message.text)}${items}</div>`
    : "";
  if (stale && saved.appliedAt) {
    return (
      '<div class="sum-fc-wb">' +
      '<div class="sum-fc-wb-msg error" data-wb-notice="changed-since-apply">Summary changed since the integrate — re-check to re-apply.</div>' +
      msg +
      "</div>"
    );
  }
  if (stale !== false) return msg ? `<div class="sum-fc-wb">${msg}</div>` : "";
  if (s.proposal) {
    const p = s.proposal;
    const none = p.edits.length === 0;
    return (
      '<div class="sum-fc-wb">' +
      '<div class="sum-fc-int">' +
      `<div class="sum-fc-int-head">${none ? "No edit could be placed" : `Proposed corrections (${p.edits.length})`}</div>` +
      (p.note ? `<div class="sum-fc-int-note">${escHtml(p.note)}</div>` : "") +
      p.html +
      '<div class="sum-fc-int-actions">' +
      (none
        ? ""
        : `<button type="button" class="sum-fc-wb-btn primary" data-wb="apply"${s.busy ? " disabled" : ""}>${s.busy === "apply" ? "Applying…" : "Apply selected"}</button>`) +
      `<button type="button" class="sum-fc-wb-btn" data-wb="cancel"${s.busy ? " disabled" : ""}>Cancel</button>` +
      "</div></div>" +
      msg +
      "</div>"
    );
  }
  const busy = s.busy !== "";
  const applied = saved.appliedAt
    ? `<span class="sum-fc-wb-done" data-wb-applied>Corrections integrated</span>`
    : "";
  // Hidden while an apply's reload runs: the row is not yet re-read as applied.
  const integrate =
    hasCorrectableVerdict(saved) && !saved.appliedAt && s.busy !== "apply"
      ? `<button type="button" class="sum-fc-wb-btn" data-wb="propose"${busy ? " disabled" : ""} title="Rewrite the ❌/⚠️ sentences to say what the sources say, after a preview">${s.busy === "propose" ? "Proposing…" : "✎ Integrate corrections"}</button>`
      : "";
  return (
    '<div class="sum-fc-wb"><div class="sum-fc-int-actions">' +
    (blockAdded
      ? '<span class="sum-fc-wb-done" data-wb-added>Fact check section added</span>'
      : `<button type="button" class="sum-fc-wb-btn" data-wb="append"${busy ? " disabled" : ""} title="Add these verdicts to the stored summary as a Fact check section">${s.busy === "append" ? "Adding…" : "➕ Add to summary"}</button>`) +
    integrate +
    applied +
    "</div>" +
    msg +
    "</div>"
  );
}

export interface WritebackContext {
  source: string;
  docId: string;
  key: string;
  /** Re-render the section. */
  render: () => void;
  /** After a write: re-read the saved row (resolves when it is back) and
   *  reload the article if the panel still shows it. */
  afterWrite: () => Promise<void>;
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

/** A refusal as one sentence; a fork names the sibling so the reader can delete it. */
function failureText(data: Record<string, unknown>, status: number): string {
  const error = typeof data.error === "string" ? data.error : `Request failed (HTTP ${status}).`;
  if (data.code === "forked" && typeof data.siblingDocId === "string") {
    return `${error} Open “${data.siblingDocId}” and delete it with ⋯ More → Delete.`;
  }
  return error;
}

/** Wire the buttons {@link writebackHtml} drew inside `el`. */
export function wireWriteback(el: HTMLElement, ctx: WritebackContext): void {
  const s = stateFor(ctx.key);
  const ref = { source: ctx.source, docId: ctx.docId };
  el.querySelectorAll<HTMLInputElement>(".sum-fc-int-cb").forEach((cb) => {
    const i = Number(cb.dataset.editIdx);
    if (s.proposal && Number.isInteger(i)) cb.checked = s.proposal.selected[i] !== false;
    cb.addEventListener("change", () => {
      if (s.proposal && Number.isInteger(i)) s.proposal.selected[i] = cb.checked;
    });
  });
  el.querySelectorAll<HTMLButtonElement>("[data-wb]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.wb;
      if (action === "cancel") {
        s.proposal = null;
        s.message = null;
        ctx.render();
        return;
      }
      if (s.busy) return;
      if (action === "append") void run("append");
      else if (action === "propose") void run("propose");
      else if (action === "apply") void run("apply");
    });
  });

  async function run(action: "append" | "propose" | "apply"): Promise<void> {
    // A response for a web result that has since been replaced is dropped.
    const origin = s.resultAt;
    const current = () => s.resultAt === origin;
    s.busy = action;
    s.message = null;
    ctx.render();
    try {
      if (action === "append") {
        const { status, data } = await post("/api/summaries/factcheck/append", ref);
        if (!current()) return;
        if (status !== 200) s.message = { text: failureText(data, status), tone: "error" };
        else {
          s.message = { text: "Added the Fact check section to the summary.", tone: "ok" };
          await ctx.afterWrite();
        }
      } else if (action === "propose") {
        const { status, data } = await post("/api/summaries/factcheck/integrate", ref);
        if (!current()) return;
        if (status !== 200) s.message = { text: failureText(data, status), tone: "error" };
        else {
          const edits = Array.isArray(data.edits) ? (data.edits as ProposedEdit[]) : [];
          s.proposal = {
            edits,
            html: typeof data.html === "string" ? data.html : "",
            ...(typeof data.note === "string" ? { note: data.note } : {}),
            rawSha256: String(data.rawSha256 || ""),
            rowVersion: String(data.rowVersion || ""),
            selected: edits.map(() => true),
          };
        }
      } else {
        const p = s.proposal;
        if (!p) return;
        const accepted = p.edits
          .filter((_, i) => p.selected[i] !== false)
          .map((e) => ({ claimIndex: e.claimIndex, verdict: e.verdict, old: e.old, new: e.new, reason: e.reason }));
        if (accepted.length === 0) {
          s.message = { text: "Select at least one edit to apply.", tone: "error" };
          return;
        }
        const { status, data } = await post("/api/summaries/factcheck/integrate/apply", {
          ...ref,
          rawSha256: p.rawSha256,
          rowVersion: p.rowVersion,
          edits: accepted,
        });
        if (!current()) return;
        if (status !== 200) {
          s.message = { text: failureText(data, status), tone: "error" };
        } else {
          s.proposal = null;
          s.message = applyMessage(data, accepted.length);
          await ctx.afterWrite();
        }
      }
    } catch (err) {
      s.message = { text: `Request failed: ${err instanceof Error ? err.message : String(err)}`, tone: "error" };
    } finally {
      s.busy = "";
      ctx.render();
    }
  }
}

/** The apply's result as one message: the count, what the stamp came to, and
 *  each accepted edit that did not anchor. */
function applyMessage(data: Record<string, unknown>, accepted: number): NonNullable<WritebackState["message"]> {
  const n = typeof data.applied === "number" ? data.applied : accepted;
  const items = Array.isArray(data.notApplied)
    ? (data.notApplied as { reason?: string; edit?: { claimIndex?: number; old?: string } }[]).map(
        (d) => `Claim ${d.edit?.claimIndex ?? "?"} not applied (${d.reason ?? "could not be placed"}): “${(d.edit?.old ?? "").slice(0, 120)}”`,
      )
    : [];
  if (data.stamp !== "stamped") {
    const why = typeof data.message === "string" ? data.message : "The summary was written, but the fact check is not marked applied.";
    return { text: `Applied ${n} edit(s). ${why}`, tone: "error", items };
  }
  return { text: `Integrated ${n} correction(s) and the Fact check section.`, tone: "ok", items };
}

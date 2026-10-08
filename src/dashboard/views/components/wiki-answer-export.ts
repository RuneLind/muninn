/// <reference lib="dom" />
/**
 * The answer cards' export button (answer cards PR 4): "Copy new answers (N)"
 * and "Copy again" in the reader's breadcrumb row, for an admin only (the page
 * payload's `answers.canExport`).
 *
 * The block is fetched BEFORE the click — on mount and after every change the
 * cards report — so the click writes the clipboard synchronously, inside the
 * user gesture (Safari drops the gesture across an await). Only after the
 * write succeeds is the export confirmed, and then the cards reload so they
 * flip to Copied. A block fetched for a different set of answers than the
 * cards now show is never copied: the click reloads the cards and the block
 * and asks the reader to click once more.
 */
import { questionLabels, type QuestionLabels, type QuestionLanguage } from "../../../format/question-labels.ts";
import type { AnswerCardsHandle, PageAnswersInfo } from "./wiki-answer-cards.ts";
import type { AnswerWire } from "./wiki-answer-card-model.ts";
import { copyText } from "./copy-path.ts";
import { restampAnswerExport } from "../../../wiki/answer-export.ts";

export const ANSWER_EXPORT_ID = "wikiAnswerExport";

/** One export block: what `GET /api/wiki/answers/export` answers, and its `again`. */
export interface ExportBlockWire {
  block: string;
  rows: [string, number][];
  count: number;
}

/** What `GET /api/wiki/answers/export` answers: the new block, the wiki's
 *  orphan count, and the page's last batch for "Copy again". */
export interface ExportWire extends ExportBlockWire {
  orphanCount: number;
  again: ExportBlockWire;
}

/** One `(answerId, version)` set as a comparable string. */
export function exportRowsKey(rows: readonly (readonly [string, number])[]): string {
  return rows
    .map(([id, v]) => `${id}:${v}`)
    .sort()
    .join(",");
}

/** The rows the export should carry for these answers: the latest version of
 *  every answer neither exported nor redacted — the server's own selection —
 *  minus rows this page view already confirmed (`confirmed`, `id:version`). */
export function unexportedRowsKey(answers: readonly AnswerWire[], confirmed: ReadonlySet<string> = new Set()): string {
  return exportRowsKey(
    answers
      .filter((a) => !a.exported && !a.redacted && !confirmed.has(`${a.answerId}:${a.version}`))
      .map((a) => [a.answerId, a.version] as const),
  );
}

interface ExportUi {
  root: HTMLElement;
  newBtn: HTMLButtonElement;
  againBtn: HTMLButtonElement;
  orphans: HTMLElement;
  msg: HTMLElement;
}

let current: { handle: AnswerCardsHandle; root: HTMLElement; unsubscribe: () => void } | null = null;

/** Remove the export controls and drop their subscription to the cards. The
 *  reader calls it on every navigation, so a page that never mounts them (an
 *  explainer, an Ask answer, the graph) does not keep the last page's alive. */
export function unmountAnswerExport(): void {
  if (!current) return;
  current.unsubscribe();
  current.root.remove();
  current = null;
}

/**
 * Put the export controls into `host` (the breadcrumb row) for this page's
 * cards, or remove them when the viewer may not export. Idempotent per handle
 * while the viewer may export.
 */
export function mountAnswerExport(
  host: HTMLElement | null,
  handle: AnswerCardsHandle | null,
  info: PageAnswersInfo | undefined,
  opts: {
    wiki: string;
    relPath: string;
    lang: QuestionLanguage;
    fetchFn?: typeof fetch;
    copy?: (text: string) => Promise<boolean>;
    now?: () => number;
  },
): void {
  if (current && current.handle === handle && current.root.isConnected && info?.canExport) return;
  unmountAnswerExport();
  document.getElementById(ANSWER_EXPORT_ID)?.remove();
  if (!host || !handle || !info?.canExport) return;

  const L: QuestionLabels = questionLabels(opts.lang);
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const copy = opts.copy ?? copyText;
  const now = opts.now ?? Date.now;
  const ui = build(L);
  host.appendChild(ui.root);

  let fresh: (ExportBlockWire & { key: string }) | null = null;
  let again: ExportBlockWire | null = null;
  let orphanCount = 0;
  let seq = 0;
  let busy = false;
  // A load failure or a stale click: cleared by the next successful prefetch.
  // A click's own outcome (copied, copy or confirm failed) stays until the next.
  let message: { text: string; transient: boolean } | null = null;
  // Rows this page view confirmed. exported_at is never cleared, so a row once
  // confirmed is exported for good: it never goes into a block again, even
  // when a refresh of the cards failed and they still show it as new.
  const confirmed = new Set<string>();
  const url = `/api/wiki/answers/export?wiki=${encodeURIComponent(opts.wiki)}&relPath=${encodeURIComponent(opts.relPath)}`;

  const newCount = () =>
    handle.answers().filter((a) => !a.exported && !a.redacted && !confirmed.has(`${a.answerId}:${a.version}`)).length;

  const render = () => {
    const n = newCount();
    ui.newBtn.textContent = L.copyNew(n);
    ui.newBtn.disabled = busy || n === 0;
    ui.againBtn.disabled = busy || !again || again.count === 0;
    ui.orphans.hidden = orphanCount === 0;
    ui.orphans.textContent = orphanCount > 0 ? L.exportStatus.orphans(orphanCount) : "";
    ui.msg.textContent = message?.text ?? "";
  };

  const prefetch = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const r = await fetchFn(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const n = (await r.json()) as ExportWire;
      if (mine !== seq) return;
      fresh = { block: n.block, rows: n.rows, count: n.count, key: exportRowsKey(n.rows) };
      again = n.again ?? null;
      orphanCount = n.orphanCount ?? 0;
      if (message?.transient) message = null;
    } catch {
      if (mine !== seq) return;
      fresh = null;
      message = { text: L.exportStatus.loadFailed, transient: true };
    }
    render();
  };

  ui.newBtn.addEventListener("click", () => {
    if (busy || newCount() === 0) return;
    const pre = fresh;
    const stale =
      !pre ||
      pre.key !== unexportedRowsKey(handle.answers(), confirmed) ||
      pre.rows.some(([id, v]) => confirmed.has(`${id}:${v}`));
    if (stale) {
      // Never copy a block built for other answers than the cards show. The
      // cards may be the ones behind (another tab answered or exported), so
      // reload them: their change notice fetches the block again. When the
      // reload changed nothing (or failed), fetch the block here instead.
      message = { text: L.exportStatus.stale, transient: true };
      render();
      const before = seq;
      void handle.refresh().then(() => {
        if (seq === before) void prefetch();
      });
      return;
    }
    // Started synchronously, inside the click: the clipboard write needs the
    // gesture. The header carries the click's time, which is the minute the
    // confirm below stamps on the rows and "Copy again" prints.
    const text = restampAnswerExport(pre.block, now());
    const copied = copy(text);
    busy = true;
    message = null;
    render();
    void copied
      .then(async (ok) => {
        if (!ok) {
          message = { text: L.exportStatus.copyFailed, transient: false };
          return;
        }
        try {
          const r = await fetchFn("/api/wiki/answers/export/confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wiki: opts.wiki, relPath: opts.relPath, rows: pre.rows }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch {
          message = { text: L.exportStatus.confirmFailed, transient: false };
          return;
        }
        for (const [id, v] of pre.rows) confirmed.add(`${id}:${v}`);
        // No prefetch started before this point may land: its block holds the
        // rows just marked, and its last batch is the one before this copy.
        seq++;
        fresh = null;
        // What "Copy again" now copies, until the next prefetch brings the
        // server's own: exactly the text that went to the clipboard.
        again = { block: text, rows: pre.rows, count: pre.count };
        message = { text: L.exportStatus.copied(pre.count), transient: false };
        await handle.refresh();
      })
      .finally(() => {
        busy = false;
        render();
      });
  });

  ui.againBtn.addEventListener("click", () => {
    const a = again;
    if (busy || !a || a.count === 0) return;
    void copy(a.block).then((ok) => {
      message = { text: ok ? L.exportStatus.copiedAgain(a.count) : L.exportStatus.copyFailed, transient: false };
      render();
    });
  });

  const unsubscribe = handle.onChange(() => {
    // The page this was mounted for is gone: let go of the cards.
    if (!ui.root.isConnected) {
      if (current?.root === ui.root) unmountAnswerExport();
      else unsubscribe();
      return;
    }
    render();
    void prefetch();
  });
  current = { handle, root: ui.root, unsubscribe };
  render();
  // The cards' first load notifies on success, and that notice fetches the
  // block; fetching here as well would send the GET twice.
  if (handle.loaded()) void prefetch();
}

function build(L: QuestionLabels): ExportUi {
  const root = document.createElement("span");
  root.id = ANSWER_EXPORT_ID;
  root.className = "wiki-answer-export";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "wiki-bc-answers";
  newBtn.setAttribute("data-answer-export", "new");
  newBtn.textContent = L.copyNew(0);
  const againBtn = document.createElement("button");
  againBtn.type = "button";
  againBtn.className = "wiki-bc-answers";
  againBtn.setAttribute("data-answer-export", "again");
  againBtn.textContent = L.copyAgain;
  const orphans = document.createElement("span");
  orphans.className = "wiki-answer-export-orphans";
  orphans.title = L.exportStatus.orphansTitle;
  orphans.hidden = true;
  const msg = document.createElement("span");
  msg.className = "wiki-answer-export-msg";
  msg.setAttribute("role", "status");
  msg.setAttribute("aria-live", "polite");
  root.append(newBtn, againBtn, orphans, msg);
  return { root, newBtn, againBtn, orphans, msg };
}

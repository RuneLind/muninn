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
 * cards now show is never copied: the click fetches again and asks the reader
 * to click once more.
 */
import { questionLabels, type QuestionLabels, type QuestionLanguage } from "../../../format/question-labels.ts";
import type { AnswerCardsHandle, PageAnswersInfo } from "./wiki-answer-cards.ts";
import type { AnswerWire } from "./wiki-answer-card-model.ts";
import { copyText } from "./copy-path.ts";

export const ANSWER_EXPORT_ID = "wikiAnswerExport";

/** What `GET /api/wiki/answers/export` answers. */
export interface ExportWire {
  block: string;
  rows: [string, number][];
  count: number;
  orphanCount: number;
}

/** One `(answerId, version)` set as a comparable string. */
export function exportRowsKey(rows: readonly (readonly [string, number])[]): string {
  return rows
    .map(([id, v]) => `${id}:${v}`)
    .sort()
    .join(",");
}

/** The rows the export should carry for these answers: the latest version of
 *  every answer neither exported nor redacted — the server's own selection. */
export function unexportedRowsKey(answers: readonly AnswerWire[]): string {
  return exportRowsKey(answers.filter((a) => !a.exported && !a.redacted).map((a) => [a.answerId, a.version] as const));
}

interface ExportUi {
  root: HTMLElement;
  newBtn: HTMLButtonElement;
  againBtn: HTMLButtonElement;
  orphans: HTMLElement;
  msg: HTMLElement;
}

let current: { handle: AnswerCardsHandle; root: HTMLElement; unsubscribe: () => void } | null = null;

/**
 * Put the export controls into `host` (the breadcrumb row) for this page's
 * cards, or remove them when the viewer may not export. Idempotent per handle.
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
  },
): void {
  if (current && current.handle === handle && current.root.isConnected) return;
  if (current) {
    current.unsubscribe();
    current.root.remove();
    current = null;
  }
  document.getElementById(ANSWER_EXPORT_ID)?.remove();
  if (!host || !handle || !info?.canExport) return;

  const L: QuestionLabels = questionLabels(opts.lang);
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const copy = opts.copy ?? copyText;
  const ui = build(L);
  host.appendChild(ui.root);

  let fresh: (ExportWire & { key: string }) | null = null;
  let again: ExportWire | null = null;
  let seq = 0;
  let busy = false;
  let message = "";
  const url = `/api/wiki/answers/export?wiki=${encodeURIComponent(opts.wiki)}&relPath=${encodeURIComponent(opts.relPath)}`;

  const getJson = async (u: string): Promise<ExportWire> => {
    const r = await fetchFn(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as ExportWire;
  };

  const render = () => {
    const n = handle.unexportedCount();
    ui.newBtn.textContent = L.copyNew(n);
    ui.newBtn.disabled = busy || n === 0;
    ui.againBtn.disabled = busy || !again || again.count === 0;
    const orphanCount = fresh?.orphanCount ?? again?.orphanCount ?? 0;
    ui.orphans.hidden = orphanCount === 0;
    ui.orphans.textContent = orphanCount > 0 ? L.exportStatus.orphans(orphanCount) : "";
    ui.msg.textContent = message;
  };

  const prefetch = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const [n, a] = await Promise.all([getJson(url), getJson(url + "&again=1")]);
      if (mine !== seq) return;
      fresh = { ...n, key: exportRowsKey(n.rows) };
      again = a;
    } catch {
      if (mine !== seq) return;
      fresh = null;
      message = L.exportStatus.loadFailed;
    }
    render();
  };

  ui.newBtn.addEventListener("click", () => {
    if (busy || handle.unexportedCount() === 0) return;
    const pre = fresh;
    if (!pre || pre.key !== unexportedRowsKey(handle.answers())) {
      // Never copy a block built for other answers than the cards show.
      message = L.exportStatus.stale;
      render();
      void prefetch();
      return;
    }
    // Started synchronously, inside the click: the clipboard write needs the gesture.
    const copied = copy(pre.block);
    busy = true;
    message = "";
    render();
    void copied
      .then(async (ok) => {
        if (!ok) {
          message = L.exportStatus.copyFailed;
          return;
        }
        try {
          const r = await fetchFn("/api/wiki/answers/export/confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rows: pre.rows }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch {
          message = L.exportStatus.confirmFailed;
          return;
        }
        message = L.exportStatus.copied(pre.count);
        fresh = null;
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
      message = ok ? L.exportStatus.copiedAgain(a.count) : L.exportStatus.copyFailed;
      render();
    });
  });

  const unsubscribe = handle.onChange(() => {
    render();
    void prefetch();
  });
  current = { handle, root: ui.root, unsubscribe };
  render();
  void prefetch();
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

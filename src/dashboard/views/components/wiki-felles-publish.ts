/// <reference lib="dom" />
/**
 * The reader's ⇪ Felles control: publish the open page to the melosys-felles
 * bucket through `POST /api/wiki/felles-publish`, remove it from there again, or
 * copy the publish command line for a terminal. Shown only on a wiki whose `/api/wiki/pages`
 * payload carries `fellesPublish` (see `src/wiki/felles-publish.ts`).
 *
 * The pure half (command line, outcome copy, markup) is exported for tests; the
 * DOM half touches `document` only when called, so `bun test` can import this.
 */
import { copyText, flashCopyResult } from "./copy-path.ts";
import { escHtml as esc } from "./escape.ts";

export const FELLES_BTN_ID = "wikiFellesBtn";
const DIALOG_ID = "wikiFellesDialog";

/** A token as a POSIX shell reads it: bare when it is plain, else single-quoted. */
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(token)) return token;
  return "'" + token.replace(/'/g, "'\\''") + "'";
}

/** The command the operator types by hand, for the ⧉ copy. */
export function fellesPublishCommand(opts: {
  bin: string;
  root: string;
  relPath: string;
  allowIdent: boolean;
  dryRun?: boolean;
  /** muninn's `FELLES_WIKI_BUCKET`, so the line targets the button's bucket. */
  bucket?: string;
}): string {
  return [
    ...(opts.bucket ? ["FELLES_WIKI_BUCKET=" + shellQuote(opts.bucket)] : []),
    "bun",
    // Without it bun loads the `.env` of the directory the line runs in, which
    // can override the bucket or credentials; the route spawns with it too.
    "--no-env-file",
    shellQuote(opts.bin),
    ...(opts.dryRun ? ["--dry-run"] : []),
    ...(opts.allowIdent ? ["--tillat-ident"] : []),
    shellQuote(opts.root),
    // The script reads a dash-led argument as a flag.
    shellQuote(opts.relPath.startsWith("-") ? "./" + opts.relPath : opts.relPath),
  ].join(" ");
}

/** The command that removes a published page from the bucket by hand, for a
 *  page the local wiki no longer lists (architecture review 2026-10, finding
 *  80): the route refuses a relPath the index does not list, by design. No
 *  `--ja`, so the script asks before it deletes. The relPath is the object
 *  name, so it goes in NFC and with no `./`. */
export function fellesRemoveCommand(opts: { bin: string; relPath: string; bucket?: string; alsoRemove?: readonly string[] }): string {
  return [
    ...(opts.bucket ? ["FELLES_WIKI_BUCKET=" + shellQuote(opts.bucket)] : []),
    "bun",
    // Without it bun loads the `.env` of the directory the line runs in, which
    // can override the bucket or credentials; the route spawns with it too.
    "--no-env-file",
    shellQuote(opts.bin),
    "--fjern",
    "--",
    ...[opts.relPath, ...(opts.alsoRemove ?? [])].map((r) => shellQuote(r.normalize("NFC"))),
  ].join(" ");
}

/** `remove-data` is the retry of a remove's data-file run alone
 *  (`dataFilesOnly` on the route), for a page already gone from the bucket. */
export type FellesAction = "publish" | "remove" | "remove-data";

/** The POST body for one dialog run. Retry data files is a real remove with
 *  `dataFilesOnly`; the route knows no `remove-data` action. */
export function fellesRunBody(
  page: { wiki: string; relPath: string },
  action: FellesAction,
  dryRun: boolean,
  allowIdent: boolean,
): Record<string, unknown> {
  return {
    wiki: page.wiki,
    relPath: page.relPath,
    dryRun,
    allowIdent,
    action: action === "remove-data" ? "remove" : action,
    ...(action === "remove-data" ? { dataFilesOnly: true } : {}),
  };
}

/** One line for a publish run's exit code (`publiser-felles-wiki.ts` header). */
export function fellesOutcomeLine(exitCode: number, dryRun: boolean): { text: string; ok: boolean } {
  switch (exitCode) {
    case 0:
      return dryRun
        ? { text: "Dry run passed — nothing was uploaded.", ok: true }
        : { text: "Published. The pod picks it up within about 2 minutes.", ok: true };
    case 1:
      // Also any crash of the script, which can land after an upload.
      return { text: "A file was refused by the scanner, or the script failed. See the output.", ok: false };
    case 2:
      return { text: "Usage or environment error — nothing was uploaded. See the output.", ok: false };
    case 3:
      return { text: "Upload failed. See the output.", ok: false };
    default:
      return { text: `The script exited with code ${exitCode}.`, ok: false };
  }
}

/** What the route read from one `--fjern` run (`fellesFjernVerdict`). */
export type FellesFjernVerdict = "deleted" | "missing" | "failed" | "error" | "timeout";

/** The route's answer to a remove, a retry, or their refusals. */
export interface FellesRemoveAnswer {
  exitCode?: number;
  error?: string;
  output?: string;
  removes?: string[];
  keptShared?: string[];
  keptRefused?: string[];
  dataFiles?: string[];
  pageRun?: FellesFjernVerdict;
  dataRun?: FellesFjernVerdict;
  dataFilesExitCode?: number | null;
  retryDataFiles?: boolean;
  dataFilesOnly?: boolean;
}

/** The confirm row after a run: hidden, or a text with Confirm remove, Retry
 *  data files, or neither button. */
export type FellesConfirmRow = { hidden: true } | { hidden: false; html: string; button: "confirm" | "retry" | "none" };

const HIDDEN_ROW: FellesConfirmRow = { hidden: true };
const NOT_IN_BUCKET = "an error muninn does not read as «not in the bucket» — gcloud may need a login, or the bucket could not be reached";
const dataRunFailed = (v: FellesFjernVerdict | undefined) => v === "failed" || v === "timeout";

/**
 * The status line and confirm row for a remove or a retry, from the route's
 * answer: the decision table's OUTCOMES cells (`src/wiki/CLAUDE.md`). Retry
 * data files is offered only when the route says so AND the answer shows the
 * page gone (a page run `deleted` or `missing`, or a retry the route admitted)
 * AND the data-file run did not finish clean. A page run that leaves the page
 * possibly published offers the terminal command instead.
 */
export function fellesRemoveView(
  action: "remove" | "remove-data",
  dryRun: boolean,
  httpStatus: number,
  data: FellesRemoveAnswer | null,
  cmd: { bin: string; relPath: string; bucket?: string },
): { text: string; ok: boolean; row: FellesConfirmRow } {
  const dataFiles = data?.dataFiles ?? [];
  const pageGone = action === "remove-data" ? data?.dataFilesOnly === true : data?.pageRun === "deleted" || data?.pageRun === "missing";
  const retry: FellesConfirmRow =
    !dryRun && data?.retryDataFiles === true && dataFiles.length > 0 && pageGone && dataRunFailed(data.dataRun)
      ? { hidden: false, button: "retry", html: fellesDataRetryHtml(dataFiles) }
      : HIDDEN_ROW;
  if (httpStatus !== 200 || !data || typeof data.exitCode !== "number") {
    return { text: data?.error ?? `Request failed (HTTP ${httpStatus}).`, ok: false, row: retry };
  }
  const code = data.exitCode;
  // A data-file run that exited neither 0 nor 3 would fail the same way again.
  const dataCommandRow = (): FellesConfirmRow => {
    const [first, ...rest] = dataFiles;
    if (first === undefined) return HIDDEN_ROW;
    const command = fellesRemoveCommand({ bin: cmd.bin, relPath: first, bucket: cmd.bucket, alsoRemove: rest });
    return { hidden: false, button: "none", html: `To delete the data files from a terminal with your own gcloud login: <code>${esc(command)}</code>` };
  };
  if (dryRun) {
    if (code === 0) {
      return {
        text: "Dry run: this is the object a remove deletes. The dry run does not check that it is in the bucket.",
        ok: true,
        row: {
          hidden: false,
          button: "confirm",
          html: fellesRemoveConfirmHtml(data.removes ?? [cmd.relPath], data.keptShared ?? [], data.keptRefused ?? []),
        },
      };
    }
    const text =
      code === 1
        ? "The script refused a path or failed — a dry run deletes nothing. See the output."
        : code === 2
          ? "Usage or environment error — a dry run deletes nothing. See the output."
          : code === 3
            ? "Delete failed in a dry run, which deletes nothing — see the output."
            : `The script exited with code ${code}. See the output.`;
    return { text, ok: false, row: HIDDEN_ROW };
  }
  const dataCode = data.dataFilesExitCode ?? code;
  if (action === "remove-data") {
    const text =
      data.dataRun === "deleted"
        ? "Removed the data files. The pod drops them within about 2 minutes."
        : data.dataRun === "missing"
          ? "The data files are gone from the bucket: the ones still there were deleted, the rest were already gone."
          : data.dataRun === "failed"
            ? `At least one data-file delete failed with ${NOT_IN_BUCKET}. See the output; Retry data files tries again.`
            : data.dataRun === "timeout"
              ? "The data-file delete timed out or could not start, so data files may still be in the bucket. Retry data files runs it again."
              : `The data-file delete exited with code ${dataCode}, so data files may still be in the bucket. See the output.`;
    const row = data.dataRun === "error" ? dataCommandRow() : retry;
    return { text, ok: data.dataRun === "deleted" || data.dataRun === "missing", row };
  }
  if (data.pageRun === "deleted" || data.pageRun === "missing") {
    const page = data.pageRun === "deleted" ? "Removed the page." : "The page was not in the bucket (never published, or already removed).";
    switch (data.dataRun) {
      case undefined:
        return data.pageRun === "deleted"
          ? { text: "Removed. The pod drops the page within about 2 minutes.", ok: true, row: retry }
          : { text: `${page} Nothing was deleted.`, ok: true, row: retry };
      case "deleted":
        return data.pageRun === "deleted"
          ? { text: "Removed the page and its data files. The pod drops them within about 2 minutes.", ok: true, row: retry }
          : { text: `${page} Removed its data files.`, ok: true, row: retry };
      case "missing":
        return {
          text: `${page} Its data files are gone from the bucket too: the ones still there were deleted, the rest were not in it (never uploaded, or already deleted).`,
          ok: true,
          row: retry,
        };
      case "failed":
        return { text: `${page} At least one data-file delete failed with ${NOT_IN_BUCKET}. See the output; Retry data files deletes what is left.`, ok: false, row: retry };
      case "timeout":
        return { text: `${page} The data-file delete timed out or could not start, so data files may still be in the bucket. Retry data files runs it again.`, ok: false, row: retry };
      default:
        return {
          text: `${page} The data-file delete exited with code ${dataCode}, so data files may still be in the bucket. See the output.`,
          ok: false,
          row: dataCommandRow(),
        };
    }
  }
  // The page may still be published: no data file was touched, and no retry
  // is offered. The operator's own terminal (own gcloud login) is the way out.
  const text =
    data.pageRun === "failed"
      ? `The page delete failed with ${NOT_IN_BUCKET}. The page may still be published; nothing else was deleted. See the output.`
      : code === 2
        ? "Usage or environment error (exit 2) — nothing was deleted. See the output."
        : code === 1
          ? "The script refused the path or failed (exit 1). The page may still be published; nothing else was deleted. See the output."
          : `The script exited with code ${code}. The page may still be published; nothing else was deleted. See the output.`;
  const command = fellesRemoveCommand({ bin: cmd.bin, relPath: cmd.relPath, bucket: cmd.bucket, alsoRemove: dataFiles });
  return {
    text,
    ok: false,
    row: { hidden: false, button: "none", html: `To remove it from a terminal with your own gcloud login: <code>${esc(command)}</code>` },
  };
}

/** Paint a confirm row onto the dialog's four nodes (plain objects in tests). */
export function paintConfirmRow(
  row: FellesConfirmRow,
  els: { row: { hidden: boolean }; text: { innerHTML: string }; confirm: { hidden: boolean }; retry: { hidden: boolean } },
): void {
  els.row.hidden = row.hidden;
  if (row.hidden) return;
  els.text.innerHTML = row.html;
  els.confirm.hidden = row.button !== "confirm";
  els.retry.hidden = row.button !== "retry";
}

/** The confirm row's text when it offers Retry data files: the data files
 *  alone, never the page. */
export function fellesDataRetryHtml(dataFiles: readonly string[]): string {
  const list = dataFiles.map((r) => `<code>${esc(r)}</code>`).join(", ");
  return `Delete the data files again? ${list}. A file that is already gone counts as deleted.`;
}

const REMOVE_QUESTION = "Delete it from the bucket? The bucket keeps no copy; your local page stays.";

/** The confirm row's text after a remove dry run: every object the confirm
 *  deletes (the page and the data files only it reads), the data files kept
 *  because another local page reads them, and the ones kept because the script
 *  refuses their name. The lists are the route's answer. */
export function fellesRemoveConfirmHtml(
  removes: readonly string[],
  keptShared: readonly string[],
  keptRefused: readonly string[] = [],
): string {
  if (removes.length <= 1 && keptShared.length === 0 && keptRefused.length === 0) return REMOVE_QUESTION;
  const list = (items: readonly string[]) => items.map((r) => `<code>${esc(r)}</code>`).join(", ");
  let html =
    removes.length <= 1
      ? REMOVE_QUESTION
      : `Delete ${removes.length} objects from the bucket? The page and the data files only it reads: ${list(removes)}. The bucket keeps no copy; your local files stay.`;
  if (keptShared.length > 0) html += ` Kept, since another page reads it: ${list(keptShared)}.`;
  if (keptRefused.length > 0) html += ` Kept, since the script refuses its name: ${list(keptRefused)}.`;
  return html;
}

/** Escaped output with every `https://` address made a link (the script prints
 *  the published page's address). */
export function fellesOutputHtml(output: string): string {
  return esc(output).replace(
    /https:\/\/[^\s<>"]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
  );
}

/** What the status says about a page's published copy: `stale` for a page
 *  that changed since, `refused` for one the scanner refuses now (so the
 *  published copy stays older until it is fixed), null otherwise. */
export type FellesMark = "stale" | "refused" | null;

export const FELLES_STALE_CLASS = "wiki-felles-stale";
export const FELLES_REFUSED_CLASS = "wiki-felles-refused";
const FELLES_BTN_TITLE = "Publish this page to the melosys-felles wiki";
export const FELLES_STALE_TITLE = "Published copy is out of date — this page changed since it was published to melosys-felles";
export const FELLES_REFUSED_TITLE = "Local copy is refused by the scanner — the published copy is older";

const MARK_CLASS = { stale: FELLES_STALE_CLASS, refused: FELLES_REFUSED_CLASS } as const;
const MARK_TITLE = { stale: FELLES_STALE_TITLE, refused: FELLES_REFUSED_TITLE } as const;

/** The breadcrumb button. The page's relPath rides on it, as Copy path's does,
 *  so a click can never act on a page a navigation has since replaced. */
export function fellesBtnHtml(relPath: string, mark: FellesMark = null): string {
  return (
    `<button class="wiki-bc-share${mark ? " " + MARK_CLASS[mark] : ""}" id="${FELLES_BTN_ID}" type="button" ` +
    `data-felles-relpath="${esc(relPath)}" title="${mark ? MARK_TITLE[mark] : FELLES_BTN_TITLE}">⇪ Felles</button>`
  );
}

/** Mark or unmark a rendered ⇪ Felles button, for a status that arrives after
 *  the breadcrumb was drawn. */
export function setFellesBtnMark(btn: Element, mark: FellesMark): void {
  btn.classList.toggle(FELLES_STALE_CLASS, mark === "stale");
  btn.classList.toggle(FELLES_REFUSED_CLASS, mark === "refused");
  btn.setAttribute("title", mark ? MARK_TITLE[mark] : FELLES_BTN_TITLE);
}

export function fellesDialogHtml(relPath: string): string {
  return (
    `<div class="wiki-felles-body"><div class="wiki-felles-head"><span>melosys-felles</span>` +
    `<button type="button" class="wiki-felles-x" data-felles="close" aria-label="Close">✕</button></div>` +
    `<div class="wiki-felles-path" title="${esc(relPath)}">${esc(relPath)}</div>` +
    `<label class="wiki-felles-check"><input type="checkbox" data-felles="ident" checked> ` +
    `Allow NAVident and e-mail (<code>--tillat-ident</code>)</label>` +
    `<div class="wiki-felles-actions">` +
    `<button type="button" data-felles="dry">Dry run</button>` +
    `<button type="button" class="primary" data-felles="publish">Publish</button>` +
    `<button type="button" class="wiki-felles-copy" data-felles="copy" title="Copy the command line">⧉ Copy command</button>` +
    `<button type="button" class="danger" data-felles="remove" title="Delete this page from the melosys-felles bucket">Remove…</button>` +
    `</div>` +
    `<div class="wiki-felles-confirm" hidden>` +
    `<span class="wiki-felles-confirm-text">${REMOVE_QUESTION}</span>` +
    `<button type="button" class="danger" data-felles="remove-confirm">Confirm remove</button>` +
    `<button type="button" class="danger" data-felles="remove-data" hidden>Retry data files</button>` +
    `<button type="button" data-felles="remove-cancel">Cancel</button>` +
    `</div>` +
    `<div class="wiki-felles-status" role="status"></div>` +
    `<pre class="wiki-felles-out" hidden></pre></div>`
  );
}

export function fellesPublishStyles(): string {
  return `
    /* Padding sits on the inner box: a click on the <dialog> element itself is
       the backdrop click that closes it. */
    .wiki-felles {
      width: min(640px, calc(100vw - 32px)); padding: 0; border-radius: 12px;
      border: 1px solid var(--border-secondary); background: var(--bg-surface);
      color: var(--text-primary); font-size: 12.5px;
    }
    .wiki-felles-body { padding: 14px; }
    .wiki-felles::backdrop { background: rgba(5,5,10,0.55); }
    .wiki-felles-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 14px; }
    .wiki-felles-x { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
    .wiki-felles-path {
      margin: 8px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      color: var(--text-secondary); overflow-wrap: anywhere;
    }
    .wiki-felles-check { display: flex; gap: 6px; align-items: center; color: var(--text-secondary); }
    .wiki-felles-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .wiki-felles-actions button {
      padding: 5px 12px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }
    .wiki-felles-actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    /* Red marks the edge only: --status-error measures under 4.5:1 as text on
       the light inset, the same reason the status line keeps its words primary. */
    .wiki-felles-actions button.danger, .wiki-felles-confirm button.danger { border-color: var(--status-error); }
    .wiki-felles-actions button[disabled], .wiki-felles-confirm button[disabled] { opacity: 0.5; cursor: default; }
    .wiki-felles-actions .danger { margin-left: auto; }
    .wiki-felles-confirm:not([hidden]) { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
    .wiki-felles-confirm button {
      padding: 5px 12px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }
    .wiki-felles-status { margin-top: 10px; min-height: 1.2em; color: var(--text-secondary); }
    /* The status colours measure under 4.5:1 as text on the light surface, so
       they mark the edge and the words stay --text-primary. */
    .wiki-felles-status.ok, .wiki-felles-status.err { color: var(--text-primary); padding-left: 8px; }
    .wiki-felles-status.ok { border-left: 3px solid var(--status-success); }
    .wiki-felles-status.err { border-left: 3px solid var(--status-error); }
    .wiki-felles-out {
      margin-top: 8px; max-height: 40vh; overflow: auto; padding: 8px 10px; border-radius: 8px;
      background: var(--bg-inset); border: 1px solid var(--border-secondary);
      white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px;
    }
    /* The page's published copy is out of date: a dot, and the title says so.
       The dot carries no text, so the warning hue needs no text contrast. */
    .wiki-bc-share.wiki-felles-stale { border-color: var(--status-warning); color: var(--text-primary); }
    .wiki-bc-share.wiki-felles-stale::after {
      content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 5px;
      border-radius: 50%; background: var(--status-warning); vertical-align: middle;
    }
    /* Refused by the scanner: the same dot in the error hue, its own title. */
    .wiki-bc-share.wiki-felles-refused { border-color: var(--status-error); color: var(--text-primary); }
    .wiki-bc-share.wiki-felles-refused::after {
      content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 5px;
      border-radius: 50%; background: var(--status-error); vertical-align: middle;
    }
    /* The rail's «Felles: N changed», on its own line under the toolbar. */
    .wiki-felles-sync { display: flex; }
    .wiki-felles-sync[hidden] { display: none; }
    .wiki-felles-sync-btn[data-state="ok"]:not([data-changed="0"]) { color: var(--text-primary); border-color: var(--status-warning); }
    .wiki-felles-sync-btn[data-state="error"] { border-color: var(--status-error); }
    .wiki-felles-sync-btn[aria-disabled="true"] { cursor: default; }
    .wiki-felles-lists { max-height: 45vh; overflow: auto; margin: 8px 0; }
    .wiki-felles-summary { margin: 0 0 6px; color: var(--text-secondary); }
    .wiki-felles-section h3 { margin: 10px 0 4px; font-size: 12.5px; font-weight: 600; }
    .wiki-felles-hint { margin: 0 0 4px; color: var(--text-secondary); }
    .wiki-felles-pages { margin: 0; padding-left: 18px; }
    .wiki-felles-pages > li { margin: 3px 0; overflow-wrap: anywhere; }
    .wiki-felles-pages a { color: var(--accent-light); }
    .wiki-felles-files {
      margin: 2px 0 0; padding-left: 16px; color: var(--text-secondary);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    }
    .wiki-felles-self { font-family: inherit; font-style: italic; }
    .wiki-felles-refresh { margin: 6px 0 0; color: var(--text-primary); padding-left: 8px; border-left: 3px solid var(--status-error); }
    .wiki-felles-refresh[hidden] { display: none; }
    .wiki-felles-masked { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .wiki-felles-cmd { display: flex; gap: 6px; align-items: flex-start; margin-top: 2px; }
    .wiki-felles-cmd code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11.5px; color: var(--text-secondary); }
    .wiki-felles-warn { color: var(--text-secondary); font-size: 11.5px; border-left: 3px solid var(--status-warning); padding-left: 6px; margin-top: 2px; }
  `;
}

/** The route's answers that prove nothing spawned (its header lists them). A
 *  502 is not among them: the route's own 502 means the spawn threw, but a proxy
 *  answers 502 too, so the client cannot tell it from a run that went through. */
const REFUSED_BEFORE_SPAWN = new Set([400, 403, 404, 409, 415, 501]);

/** Whether a run may have changed the bucket, so the sync status must refresh.
 *  `httpStatus` is null when the request failed without an answer. Only a dry
 *  run or a refusal before spawning is known to have changed nothing; any
 *  other outcome (a 200, a 504, a 500, a dropped connection) may have. */
export function fellesRunCouldChangeBucket(dryRun: boolean, httpStatus: number | null): boolean {
  return !dryRun && (httpStatus === null || !REFUSED_BEFORE_SPAWN.has(httpStatus));
}

export interface OpenFellesOptions {
  wiki: string;
  relPath: string;
  bin: string;
  root: string;
  bucket?: string;
  /** Called after a run that could have changed the bucket
   *  ({@link fellesRunCouldChangeBucket}), so the sync status can refresh. */
  onRun?: () => void;
}

/** Open the dialog for one page. Re-opening replaces any previous dialog. */
export function openFellesPublishDialog(opts: OpenFellesOptions): void {
  document.getElementById(DIALOG_ID)?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.className = "wiki-felles";
  dialog.innerHTML = fellesDialogHtml(opts.relPath);
  document.body.appendChild(dialog);
  // Chrome makes a repeated Escape non-cancelable, so `cancel` alone cannot
  // hold the dialog; while a run is in flight a close re-opens it instead.
  dialog.addEventListener("close", () => {
    if (running) dialog.showModal();
    else dialog.remove();
  });

  const q = <T extends Element>(sel: string) => dialog.querySelector(sel) as T;
  const ident = q<HTMLInputElement>('[data-felles="ident"]');
  const status = q<HTMLElement>(".wiki-felles-status");
  const out = q<HTMLElement>(".wiki-felles-out");
  const confirmRow = q<HTMLElement>(".wiki-felles-confirm");
  const confirmText = q<HTMLElement>(".wiki-felles-confirm-text");
  const confirmBtn = q<HTMLButtonElement>('[data-felles="remove-confirm"]');
  const retryBtn = q<HTMLButtonElement>('[data-felles="remove-data"]');
  // ✕ is disabled with the run buttons: closing mid-run would drop the result
  // and let a re-opened dialog start a second upload beside the first.
  const runButtons = [
    q<HTMLButtonElement>('[data-felles="dry"]'),
    q<HTMLButtonElement>('[data-felles="publish"]'),
    q<HTMLButtonElement>('[data-felles="remove"]'),
    q<HTMLButtonElement>('[data-felles="remove-confirm"]'),
    q<HTMLButtonElement>('[data-felles="remove-data"]'),
    q<HTMLButtonElement>('[data-felles="remove-cancel"]'),
    q<HTMLButtonElement>('[data-felles="close"]'),
  ];
  let running = false;
  dialog.addEventListener("cancel", (e) => {
    if (running) e.preventDefault();
  });

  const setStatus = (text: string, kind: "" | "ok" | "err") => {
    status.textContent = text;
    status.className = "wiki-felles-status" + (kind ? " " + kind : "");
  };

  const showConfirmRow = (row: FellesConfirmRow) => paintConfirmRow(row, { row: confirmRow, text: confirmText, confirm: confirmBtn, retry: retryBtn });

  // Remove is two runs: the script's own dry run names the object, and only
  // then does the confirm row offer the real delete. Any other run hides it.
  async function run(action: FellesAction, dryRun: boolean): Promise<void> {
    if (running) return;
    let httpStatus: number | null = null;
    running = true;
    runButtons.forEach((b) => (b.disabled = true));
    confirmRow.hidden = true;
    const verb = action === "publish" ? "Publishing…" : "Removing…";
    setStatus(dryRun ? "Running dry run…" : verb, "");
    out.hidden = true;
    try {
      const res = await fetch("/api/wiki/felles-publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fellesRunBody(opts, action, dryRun, ident.checked)),
      });
      const data = (await res.json().catch(() => null)) as (FellesRemoveAnswer & { exitCode?: number }) | null;
      httpStatus = res.status;
      if (action !== "publish") {
        const view = fellesRemoveView(action, dryRun, res.status, data, opts);
        setStatus(view.text, view.ok ? "ok" : "err");
        showConfirmRow(view.row);
        if (res.ok && data?.output) {
          out.innerHTML = fellesOutputHtml(data.output);
          out.hidden = false;
        }
      } else if (res.ok && data && typeof data.exitCode === "number") {
        const line = fellesOutcomeLine(data.exitCode, dryRun);
        setStatus(line.text, line.ok ? "ok" : "err");
        if (data.output) {
          out.innerHTML = fellesOutputHtml(data.output);
          out.hidden = false;
        }
      } else {
        setStatus(data?.error ?? `Request failed (HTTP ${res.status}).`, "err");
      }
    } catch (err) {
      setStatus(`Request failed: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      running = false;
      runButtons.forEach((b) => (b.disabled = false));
      if (fellesRunCouldChangeBucket(dryRun, httpStatus)) opts.onRun?.();
    }
  }

  dialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // A click on the backdrop lands on the <dialog> itself.
    if (target === dialog && !running) return dialog.close();
    const action = target.closest("[data-felles]")?.getAttribute("data-felles");
    if (action === "close") dialog.close();
    else if (action === "dry") void run("publish", true);
    else if (action === "publish") void run("publish", false);
    else if (action === "remove") void run("remove", true);
    else if (action === "remove-confirm") void run("remove", false);
    else if (action === "remove-data") void run("remove-data", false);
    else if (action === "remove-cancel") {
      confirmRow.hidden = true;
      setStatus("", "");
      out.hidden = true;
    }
    else if (action === "copy") {
      const btn = target.closest("button") as HTMLButtonElement;
      const command = fellesPublishCommand({ ...opts, allowIdent: ident.checked });
      void copyText(command).then((ok) =>
        flashCopyResult(btn, ok, {
          text: "⧉ Copy command",
          ariaLabel: "Copy the command line",
          okText: "✓ Copied",
          failText: "Copy failed",
        }),
      );
    }
  });

  dialog.showModal();
}

// ── «Felles: N changed» — the wiki-level sync status ─────────────────────
//
// `GET /api/wiki/felles-status` runs the script's read-only `--status --json`
// (a bucket listing plus a scan), so the reader asks for it AFTER the page has
// rendered and never blocks on it. The chip lives in the rail, under the
// toolbar: the status is about the whole wiki, and the breadcrumb row it could
// share with ⇪ Felles has no width to spare (see the Copy path section of
// `src/wiki/CLAUDE.md`). The ⇪ Felles button reads the same answer for its stale
// marker, so a navigation repaints the marker without a second request.

export const FELLES_SYNC_SLOT_ID = "wikiFellesSync";
export const FELLES_SYNC_BTN_ID = "wikiFellesSyncBtn";
const SYNC_DIALOG_ID = "wikiFellesSyncDialog";
/** The header the status route requires (`FELLES_STATUS_HEADER`). */
const STATUS_HEADER = "x-muninn-felles";

export type FellesSyncState = "unchanged" | "changed" | "refused" | "missing-locally";

/** `GET /api/wiki/felles-status`'s answer (`src/wiki/felles-status.ts`). */
export interface FellesSyncStatus {
  bucket: string;
  pages: {
    relPath: string;
    masked: boolean;
    state: FellesSyncState;
    changedFiles: string[];
    refusals: string[];
    warnings: string[];
  }[];
  orphans: { path: string; masked: boolean }[];
  maybeOrphans: { path: string; masked: boolean }[];
  changed: number;
  checkedAt?: number;
}

export type FellesChipState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; changed: number };

/** The rail chip. Loading is neutral and inert — `aria-disabled`, not
 *  `disabled`, since a disabled button drops keyboard focus to BODY mid-retry;
 *  a failure says so in a few words (the reason is in the title) and a click
 *  retries. */
export function fellesSyncChipHtml(state: FellesChipState): string {
  const base = `class="wiki-tool-btn wiki-felles-sync-btn" id="${FELLES_SYNC_BTN_ID}" type="button"`;
  if (state.kind === "loading") {
    return `<button ${base} data-state="loading" aria-disabled="true" title="Checking melosys-felles for changed pages">Felles: checking…</button>`;
  }
  if (state.kind === "error") {
    return `<button ${base} data-state="error" title="${esc(state.message)} — click to try again">Felles: status failed</button>`;
  }
  return (
    `<button ${base} data-state="ok" data-changed="${state.changed}" ` +
    `title="Pages whose published copy in melosys-felles is out of date">Felles: ${state.changed} changed</button>`
  );
}

/** NFC on both sides: the script names objects in NFC, readdir may answer NFD. */
export function fellesStatusKey(relPath: string): string {
  return relPath.normalize("NFC");
}

/** relPath → state, for the ⇪ Felles marker. Masked paths name no page. */
export function fellesStateMap(status: FellesSyncStatus): Map<string, FellesSyncState> {
  const map = new Map<string, FellesSyncState>();
  for (const p of status.pages) if (!p.masked) map.set(fellesStatusKey(p.relPath), p.state);
  return map;
}

/** One page's path: a reader link when the path names a page, plain text when
 *  the script masked it. */
function pathHtml(relPath: string, masked: boolean, hrefFor: (relPath: string) => string): string {
  if (masked) return `<span class="wiki-felles-masked">${esc(relPath)}</span>`;
  return `<a href="${esc(hrefFor(relPath))}" data-felles-open="${esc(relPath)}">${esc(relPath)}</a>`;
}

function listHtml(items: string[], first = ""): string {
  return items.length || first
    ? `<ul class="wiki-felles-files">${first}${items.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : "";
}

/** A changed page's files without its own path, which the link above them
 *  already names: «page changed» stands in for it. */
function changedFilesHtml(relPath: string, files: string[]): string {
  const own = fellesStatusKey(relPath);
  const others = files.filter((f) => fellesStatusKey(f) !== own);
  return listHtml(others, others.length < files.length ? `<li class="wiki-felles-self">page changed</li>` : "");
}

/** The status lists in the sync dialog: changed pages with their files,
 *  refused pages with the scanner's reasons, pages missing locally, orphans.
 *  With `removeCommandFor`, each unmasked page missing locally carries the
 *  command that removes it and a ⧉ copy for it. */
export function fellesSyncListHtml(
  status: FellesSyncStatus,
  hrefFor: (relPath: string) => string,
  removeCommandFor?: (relPath: string) => string,
): string {
  const by = (state: FellesSyncState) => status.pages.filter((p) => p.state === state);
  const changed = by("changed");
  const refused = by("refused");
  const missing = by("missing-locally");
  // `hint` is trusted markup: every caller below passes a literal.
  const section = (cls: string, title: string, hint: string, rows: string[]) =>
    rows.length
      ? `<section class="wiki-felles-section ${cls}"><h3>${esc(title)} (${rows.length})</h3>` +
        (hint ? `<p class="wiki-felles-hint">${hint}</p>` : "") +
        `<ul class="wiki-felles-pages">${rows.join("")}</ul></section>`
      : "";
  const warn = (w: string[]) => (w.length ? `<div class="wiki-felles-warn">${w.map(esc).join("<br>")}</div>` : "");
  const html =
    section(
      "changed",
      "Changed since published",
      "",
      changed.map((p) => `<li>${pathHtml(p.relPath, p.masked, hrefFor)}${changedFilesHtml(p.relPath, p.changedFiles)}${warn(p.warnings)}</li>`),
    ) +
    section(
      "refused",
      "Refused by the scanner",
      "Publish changed skips these. Fix what the scanner found, then check again.",
      refused.map((p) => `<li>${pathHtml(p.relPath, p.masked, hrefFor)}${listHtml(p.refusals)}${warn(p.warnings)}</li>`),
    ) +
    section(
      "missing",
      "Missing locally",
      removeCommandFor
        ? "In the bucket, but not in this wiki. To remove one from the bucket, run its command in a terminal; the script asks before it deletes. A renamed page is tracked under its new name only after it is published once."
        : "In the bucket, but not in this wiki.",
      missing.map(
        (p) =>
          `<li><span class="wiki-felles-masked">${esc(p.relPath)}</span>` +
          (removeCommandFor && !p.masked
            ? `<div class="wiki-felles-cmd"><code>${esc(removeCommandFor(p.relPath))}</code>` +
              `<button type="button" class="wiki-felles-copy-remove" data-felles="copy-remove" data-felles-path="${esc(p.relPath)}" aria-label="Copy the remove command">⧉ Copy</button></div>`
            : "") +
          `${warn(p.warnings)}</li>`,
      ),
    ) +
    section(
      "orphans",
      "Orphans in the bucket",
      "Objects in the bucket that belong to no published page. If one is left over, remove it with the script's <code>--fjern</code>.",
      status.orphans.map((o) => `<li><span class="wiki-felles-masked">${esc(o.path)}</span></li>`),
    ) +
    section(
      "maybe-orphans",
      "Possibly orphaned in the bucket",
      "No local page names these, but a tracked page is not up to date (changed, refused or missing locally), and the published copy of such a page may still name them. Check that page before removing anything.",
      (status.maybeOrphans ?? []).map((o) => `<li><span class="wiki-felles-masked">${esc(o.path)}</span></li>`),
    );
  const unchanged = by("unchanged").length;
  return (
    `<p class="wiki-felles-summary">${status.changed} changed · ${unchanged} up to date in <code>${esc(status.bucket)}</code></p>` +
    (html || `<p class="wiki-felles-hint">Every published page matches its local copy.</p>`)
  );
}

export function fellesSyncDialogHtml(
  status: FellesSyncStatus,
  hrefFor: (relPath: string) => string,
  removeCommandFor?: (relPath: string) => string,
): string {
  return (
    `<div class="wiki-felles-body"><div class="wiki-felles-head"><span>melosys-felles — sync</span>` +
    `<button type="button" class="wiki-felles-x" data-felles="close" aria-label="Close">✕</button></div>` +
    `<div class="wiki-felles-lists">${fellesSyncListHtml(status, hrefFor, removeCommandFor)}</div>` +
    `<p class="wiki-felles-refresh" role="alert" hidden></p>` +
    `<label class="wiki-felles-check"><input type="checkbox" data-felles="ident" checked> ` +
    `Allow NAVident and e-mail (<code>--tillat-ident</code>)</label>` +
    `<div class="wiki-felles-actions">` +
    `<button type="button" data-felles="sync-dry">Dry run</button>` +
    `<button type="button" class="primary" data-felles="sync"${status.changed ? "" : " disabled"}>Publish changed (${status.changed})</button>` +
    `</div>` +
    `<div class="wiki-felles-status" role="status"></div>` +
    `<pre class="wiki-felles-out" hidden></pre></div>`
  );
}

/** One line for `--synk`'s exit code (`publiser-felles-wiki.ts`). */
export function fellesSyncOutcomeLine(exitCode: number, dryRun: boolean): { text: string; ok: boolean } {
  switch (exitCode) {
    case 0:
      return dryRun
        ? { text: "Dry run passed — nothing was uploaded.", ok: true }
        : { text: "Published the changed pages. The pod picks them up within about 2 minutes.", ok: true };
    case 1:
      return dryRun
        ? { text: "Dry run: a page is refused by the scanner, or the script failed. Nothing was uploaded. See the output.", ok: false }
        : { text: "A page is refused by the scanner, or the script failed. See the output.", ok: false };
    case 2:
      return { text: "Usage or environment error — nothing was uploaded. See the output.", ok: false };
    case 3:
      return { text: "An upload failed — some pages may have been published. See the output.", ok: false };
    default:
      return { text: `The script exited with code ${exitCode}.`, ok: false };
  }
}

/** The sync's line from its exit code AND the status read after it. The real
 *  wiki carries a page the scanner refuses for good, and `--synk` exits 1
 *  whenever the status holds a refused page, so exit 1 alone would make every
 *  sync read as a failure. It is not one when the status after it shows
 *  nothing left to publish (for a dry run: nothing would be left) and at least
 *  one refused page — the refusal is the 1. Anything else keeps the
 *  exit-code line, red. `after` must be read AFTER the run, a dry run
 *  included: the status the dialog opened with can be minutes old, and a
 *  refused page in it says nothing about why this run exited 1 (architecture
 *  review 2026-10, finding 79). `before` is the view the run started from; a
 *  failed real run says pages were published only when `changed` dropped.
 *  A dry run reads ok only when its own `output` reports a refusal: a crash
 *  also exits 1, and the status before and after it both hold the wiki's
 *  permanently refused page, so no status comparison can tell the two apart. */
export function fellesSyncRunOutcome(
  exitCode: number,
  dryRun: boolean,
  after: FellesSyncStatus | null,
  before: FellesSyncStatus | null = null,
  output = "",
): { text: string; ok: boolean } {
  if (exitCode === 1 && after) {
    const refused = after.pages.filter((p) => p.state === "refused").length;
    // A dry run uploads nothing, so the status after it still counts the
    // changed pages it would have published.
    const explained = dryRun ? (fellesDrySummaryRefusals(output) ?? 0) > 0 : after.changed === 0;
    if (refused > 0 && explained) {
      return dryRun
        ? {
            text: `Dry run: all changed pages would be published. ${refused} refused page(s) would not — see Refused. Nothing was uploaded.`,
            ok: true,
          }
        : { text: `All changed pages were published. ${refused} refused page(s) were not — see Refused.`, ok: true };
    }
    if (!dryRun && before && after.changed < before.changed) {
      return {
        text: `A page is refused by the scanner, or the script failed. ${before.changed - after.changed} changed page(s) were published. See the output.`,
        ok: false,
      };
    }
  }
  return fellesSyncOutcomeLine(exitCode, dryRun);
}

/** The refused count in a `--synk --dry-run` summary line
 *  (`Oppsummering: N klar(e), M avvist…`, `publiser-felles-wiki.ts`), which
 *  the script prints last on every run that finished. Null without one. */
export function fellesDrySummaryRefusals(output: string): number | null {
  const m = /^Oppsummering: \d+ klar\(e\), (\d+) avvist\b/m.exec(output);
  return m ? Number(m[1]) : null;
}

export interface FellesSyncOptions {
  wiki: string;
  /** The reader's address for a page, for the dialog's links. */
  hrefFor: (relPath: string) => string;
  /** Open a page in the reader (a plain click on a dialog link). */
  openPage: (relPath: string) => void;
  /** Called whenever a status arrives, so the ⇪ Felles marker can repaint. */
  onStatus: () => void;
  /** The publish script and muninn's bucket, for the remove command a page
   *  missing locally carries (finding 80). Without `bin`, no command. */
  bin?: string;
  bucket?: string;
}

export interface FellesSync {
  /** Fetch the default status (`--tillat-ident` on) for the chip and the
   *  marker. Concurrent calls share one request — unless `afterRun`: a run that
   *  could have changed the bucket has just ended, so this call starts its own
   *  request and no answer to an older one is applied after it. */
  load(opts?: { afterRun?: boolean }): Promise<StatusResult>;
  /** Read the status again on the reader's own refetch triggers (focus,
   *  visibility, heartbeat), without the chip's "checking…" flash. A no-op
   *  while a sync dialog run is in flight: that run reloads the status itself
   *  when it ends, in a newer generation. */
  refresh(): void;
  /** What the last good status says about this page. Null until one arrived. */
  markFor(relPath: string): FellesMark;
}

export type StatusResult = { ok: true; status: FellesSyncStatus } | { ok: false; message: string };

async function requestStatus(wiki: string, allowIdent: boolean): Promise<StatusResult> {
  try {
    const res = await fetch(
      `/api/wiki/felles-status?wiki=${encodeURIComponent(wiki)}&allowIdent=${allowIdent ? "1" : "0"}`,
      { headers: { [STATUS_HEADER]: "status" } },
    );
    const data = (await res.json().catch(() => null)) as (FellesSyncStatus & { error?: string }) | null;
    if (!res.ok || !data || !Array.isArray(data.pages)) return { ok: false, message: data?.error ?? `HTTP ${res.status}` };
    return { ok: true, status: data };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Wire the rail chip and its dialog. Call once, on a wiki that offers ⇪ Felles. */
export function initFellesSync(opts: FellesSyncOptions): FellesSync {
  const bin = opts.bin;
  const removeCommandFor = bin
    ? (relPath: string) => fellesRemoveCommand({ bin, relPath, bucket: opts.bucket })
    : undefined;
  // The last GOOD default status: a failed reload leaves it and the markers
  // standing, and only the chip says the status failed.
  let status: FellesSyncStatus | null = null;
  let states = new Map<string, FellesSyncState>();
  // Moves on every `afterRun` load; an answer from an older generation is
  // returned to its caller but never painted.
  let generation = 0;
  let inflight: { gen: number; promise: Promise<StatusResult> } | null = null;
  // True while a sync dialog run is in flight; `refresh()` stands down then.
  let runInFlight = false;

  const slot = document.getElementById(FELLES_SYNC_SLOT_ID);
  // The chip is updated IN PLACE, never re-created, so keyboard focus survives
  // a retry's loading → answer repaint.
  const paint = (state: FellesChipState) => {
    if (!slot) return;
    const t = document.createElement("template");
    t.innerHTML = fellesSyncChipHtml(state);
    const fresh = t.content.firstElementChild!;
    const btn = slot.querySelector("#" + FELLES_SYNC_BTN_ID);
    if (!btn) slot.replaceChildren(fresh);
    else {
      for (const a of Array.from(btn.attributes)) if (!fresh.hasAttribute(a.name)) btn.removeAttribute(a.name);
      for (const a of Array.from(fresh.attributes)) btn.setAttribute(a.name, a.value);
      btn.textContent = fresh.textContent;
    }
    slot.hidden = false;
  };

  function load(o: { afterRun?: boolean; quiet?: boolean } = {}): Promise<StatusResult> {
    if (o.afterRun) generation++;
    if (inflight && inflight.gen === generation) return inflight.promise;
    const gen = generation;
    // A background refresh keeps the chip's last answer on screen meanwhile.
    if (!(o.quiet && status)) paint({ kind: "loading" });
    const promise: Promise<StatusResult> = requestStatus(opts.wiki, true).then((r) => {
      if (inflight?.promise === promise) inflight = null;
      if (gen !== generation) return r;
      if (r.ok) {
        status = r.status;
        states = fellesStateMap(r.status);
        paint({ kind: "ok", changed: r.status.changed });
      } else {
        paint({ kind: "error", message: r.message });
      }
      opts.onStatus();
      return r;
    });
    inflight = { gen, promise };
    return promise;
  }

  slot?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("#" + FELLES_SYNC_BTN_ID);
    if (!btn) return;
    const state = btn.getAttribute("data-state");
    if (state === "error") void load();
    else if (state === "ok" && status) openDialog(status, true);
  });

  /** `fresh`: read the dialog's view again once it is open, so it never sits
   *  on an answer older than the click (finding 67). */
  function openDialog(initial: FellesSyncStatus, fresh = false): void {
    document.getElementById(SYNC_DIALOG_ID)?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = SYNC_DIALOG_ID;
    dialog.className = "wiki-felles wiki-felles-sync-dialog";
    dialog.innerHTML = fellesSyncDialogHtml(initial, opts.hrefFor, removeCommandFor);
    document.body.appendChild(dialog);
    let running = false;
    // Same hold as the page dialog: a run in flight keeps it open.
    dialog.addEventListener("close", () => {
      if (running) dialog.showModal();
      else dialog.remove();
    });
    dialog.addEventListener("cancel", (e) => {
      if (running) e.preventDefault();
    });
    const q = <T extends Element>(sel: string) => dialog.querySelector(sel) as T;
    const ident = q<HTMLInputElement>('[data-felles="ident"]');
    const lists = q<HTMLElement>(".wiki-felles-lists");
    const refresh = q<HTMLElement>(".wiki-felles-refresh");
    const statusLine = q<HTMLElement>(".wiki-felles-status");
    const out = q<HTMLElement>(".wiki-felles-out");
    const syncBtn = q<HTMLButtonElement>('[data-felles="sync"]');
    // The checkbox is held with the buttons: a run reads it once, and the
    // status after the run is read with the same flag.
    const holdDuringRun = [q<HTMLButtonElement>('[data-felles="sync-dry"]'), q<HTMLButtonElement>('[data-felles="close"]'), ident];
    const setStatus = (text: string, kind: "" | "ok" | "err") => {
      statusLine.textContent = text;
      statusLine.className = "wiki-felles-status" + (kind ? " " + kind : "");
    };
    const setRefresh = (text: string) => {
      refresh.textContent = text;
      refresh.hidden = !text;
    };

    // The dialog's own status, read with the checkbox's flag: without
    // --tillat-ident a page with a NAVident is refused, not changed, so the
    // chip's count would overstate what Publish changed sends. `viewReady` is
    // false from the moment the flag or the bucket may have moved until a
    // status for it arrives; Publish changed stays off meanwhile.
    let view = initial;
    let listsHtml = fellesSyncListHtml(initial, opts.hrefFor, removeCommandFor);
    let viewReady = true;
    let viewSeq = 0;
    const syncEnabled = () => {
      syncBtn.disabled = running || !viewReady || view.changed === 0;
    };

    async function reloadView(afterRun: boolean): Promise<FellesSyncStatus | null> {
      const seq = ++viewSeq;
      viewReady = false;
      syncEnabled();
      const allowIdent = ident.checked;
      let r: StatusResult;
      // With the default flag the view IS the chip's status: one request
      // updates the chip, the page markers and the view together.
      if (allowIdent) r = await load(afterRun ? { afterRun: true } : { quiet: true });
      else {
        // After a run the chip refreshes too, with its own default flag.
        if (afterRun) void load({ afterRun: true });
        r = await requestStatus(opts.wiki, allowIdent);
      }
      if (seq !== viewSeq) return null;
      if (r.ok) {
        view = r.status;
        viewReady = true;
        // An unchanged answer keeps the nodes: a swap would pull a link out
        // from under a pointer that is on it.
        const html = fellesSyncListHtml(view, opts.hrefFor, removeCommandFor);
        if (html !== listsHtml) lists.innerHTML = listsHtml = html;
        syncBtn.textContent = `Publish changed (${view.changed})`;
        setRefresh("");
      } else {
        setRefresh(`Could not refresh the status: ${r.message}. The lists show the last status; Publish changed stays off until a fresh one arrives.`);
      }
      syncEnabled();
      return r.ok ? r.status : null;
    }

    ident.addEventListener("change", () => void reloadView(false));

    async function run(dryRun: boolean): Promise<void> {
      if (running) return;
      running = true;
      runInFlight = true;
      const before = viewReady ? view : null;
      // Links are inert mid-run: a click would navigate behind the modal.
      lists.inert = true;
      holdDuringRun.forEach((b) => (b.disabled = true));
      syncEnabled();
      setStatus(dryRun ? "Running dry run…" : "Publishing the changed pages… (one upload per file; this can take minutes)", "");
      out.hidden = true;
      let exitCode: number | null = null;
      let httpStatus: number | null = null;
      let output = "";
      try {
        try {
          const res = await fetch("/api/wiki/felles-publish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wiki: opts.wiki, action: "sync", dryRun, allowIdent: ident.checked }),
          });
          const data = (await res.json().catch(() => null)) as { exitCode?: number; output?: string; error?: string } | null;
          httpStatus = res.status;
          if (res.ok && data && typeof data.exitCode === "number") {
            exitCode = data.exitCode;
            output = data.output ?? "";
            if (data.output) {
              out.innerHTML = fellesOutputHtml(data.output);
              out.hidden = false;
            }
            setStatus(dryRun ? "Dry run finished." : "Checking the status after the run…", "");
          } else {
            setStatus(data?.error ?? `Request failed (HTTP ${res.status}).`, "err");
          }
        } catch (err) {
          setStatus(`Request failed: ${err instanceof Error ? err.message : String(err)}`, "err");
        }
        // A dry run that answered is judged on a status read after it too
        // (finding 79); with the default flag that read also refreshes the chip.
        const after = fellesRunCouldChangeBucket(dryRun, httpStatus)
          ? await reloadView(true)
          : dryRun && exitCode !== null
            ? await reloadView(false)
            : viewReady
              ? view
              : null;
        if (exitCode !== null) {
          const line = fellesSyncRunOutcome(exitCode, dryRun, after, before, output);
          setStatus(line.text, line.ok ? "ok" : "err");
        }
      } finally {
        running = false;
        runInFlight = false;
        lists.inert = false;
        holdDuringRun.forEach((b) => (b.disabled = false));
        syncEnabled();
      }
    }

    dialog.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target === dialog && !running) return dialog.close();
      const link = target.closest("[data-felles-open]");
      if (link) {
        const me = e as MouseEvent;
        if (running) return e.preventDefault();
        if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
        e.preventDefault();
        dialog.close();
        opts.openPage(link.getAttribute("data-felles-open") || "");
        return;
      }
      const action = target.closest("[data-felles]")?.getAttribute("data-felles");
      if (action === "close") dialog.close();
      else if (action === "sync-dry") void run(true);
      else if (action === "sync") void run(false);
      else if (action === "copy-remove" && removeCommandFor) {
        const btn = target.closest("button") as HTMLButtonElement;
        void copyText(removeCommandFor(btn.getAttribute("data-felles-path") || "")).then((ok) =>
          flashCopyResult(btn, ok, {
            text: "⧉ Copy",
            ariaLabel: "Copy the remove command",
            okText: "✓ Copied",
            failText: "Copy failed",
          }),
        );
      }
    });
    dialog.showModal();
    if (fresh) void reloadView(false);
  }

  return {
    load,
    refresh: () => {
      if (!runInFlight) void load({ quiet: true });
    },
    markFor: (relPath) => {
      const state = states.get(fellesStatusKey(relPath));
      return state === "changed" ? "stale" : state === "refused" ? "refused" : null;
    },
  };
}

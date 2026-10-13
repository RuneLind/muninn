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
    shellQuote(opts.bin),
    ...(opts.dryRun ? ["--dry-run"] : []),
    ...(opts.allowIdent ? ["--tillat-ident"] : []),
    shellQuote(opts.root),
    // The script reads a dash-led argument as a flag.
    shellQuote(opts.relPath.startsWith("-") ? "./" + opts.relPath : opts.relPath),
  ].join(" ");
}

export type FellesAction = "publish" | "remove";

/** One line for the script's exit code (`publiser-felles-wiki.ts` header). */
export function fellesOutcomeLine(
  exitCode: number,
  dryRun: boolean,
  action: FellesAction = "publish",
): { text: string; ok: boolean } {
  if (action === "remove") return fellesRemoveOutcomeLine(exitCode, dryRun);
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

/** The bucket has no soft delete, so the dry run names the object first and
 *  the confirm button deletes it. The script's dry run never asks the bucket,
 *  so its line claims the name, not that the object exists. */
function fellesRemoveOutcomeLine(exitCode: number, dryRun: boolean): { text: string; ok: boolean } {
  switch (exitCode) {
    case 0:
      return dryRun
        ? { text: "Dry run: this is the object a remove deletes. The dry run does not check that it is in the bucket.", ok: true }
        : { text: "Removed. The pod drops the page within about 2 minutes.", ok: true };
    case 1:
      return { text: "The script refused the path or failed before deleting — nothing was removed. See the output.", ok: false };
    case 2:
      return { text: "Usage or environment error — nothing was removed. See the output.", ok: false };
    case 3:
      return { text: "Delete failed — the page may not be in the bucket, or gcloud needs a login. See the output.", ok: false };
    default:
      return { text: `The script exited with code ${exitCode}.`, ok: false };
  }
}

/** Escaped output with every `https://` address made a link (the script prints
 *  the published page's address). */
export function fellesOutputHtml(output: string): string {
  return esc(output).replace(
    /https:\/\/[^\s<>"]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
  );
}

/** The breadcrumb button. The page's relPath rides on it, as Copy path's does,
 *  so a click can never act on a page a navigation has since replaced. */
export function fellesBtnHtml(relPath: string, stale = false): string {
  return (
    `<button class="wiki-bc-share${stale ? " " + FELLES_STALE_CLASS : ""}" id="${FELLES_BTN_ID}" type="button" ` +
    `data-felles-relpath="${esc(relPath)}" title="${stale ? FELLES_STALE_TITLE : FELLES_BTN_TITLE}">⇪ Felles</button>`
  );
}

export const FELLES_STALE_CLASS = "wiki-felles-stale";
const FELLES_BTN_TITLE = "Publish this page to the melosys-felles wiki";
export const FELLES_STALE_TITLE = "Published copy is out of date — this page changed since it was published to melosys-felles";

/** Mark or unmark a rendered ⇪ Felles button, for a status that arrives after
 *  the breadcrumb was drawn. */
export function setFellesBtnStale(btn: Element, stale: boolean): void {
  btn.classList.toggle(FELLES_STALE_CLASS, stale);
  btn.setAttribute("title", stale ? FELLES_STALE_TITLE : FELLES_BTN_TITLE);
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
    `<span>Delete it from the bucket? The bucket keeps no copy; your local page stays.</span>` +
    `<button type="button" class="danger" data-felles="remove-confirm">Confirm remove</button>` +
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
    /* The rail's «Felles: N changed», on its own line under the toolbar. */
    .wiki-felles-sync { display: flex; }
    .wiki-felles-sync[hidden] { display: none; }
    .wiki-felles-sync-btn[data-state="ok"]:not([data-changed="0"]) { color: var(--text-primary); border-color: var(--status-warning); }
    .wiki-felles-sync-btn[data-state="error"] { border-color: var(--status-error); }
    .wiki-felles-sync-btn[disabled] { cursor: default; }
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
    .wiki-felles-masked { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .wiki-felles-warn { color: var(--text-secondary); font-size: 11.5px; border-left: 3px solid var(--status-warning); padding-left: 6px; margin-top: 2px; }
  `;
}

export interface OpenFellesOptions {
  wiki: string;
  relPath: string;
  bin: string;
  root: string;
  bucket?: string;
  /** Called after every completed run, so the sync status can refresh. */
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
  // ✕ is disabled with the run buttons: closing mid-run would drop the result
  // and let a re-opened dialog start a second upload beside the first.
  const runButtons = [
    q<HTMLButtonElement>('[data-felles="dry"]'),
    q<HTMLButtonElement>('[data-felles="publish"]'),
    q<HTMLButtonElement>('[data-felles="remove"]'),
    q<HTMLButtonElement>('[data-felles="remove-confirm"]'),
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

  // Remove is two runs: the script's own dry run names the object, and only
  // then does the confirm row offer the real delete. Any other run hides it.
  async function run(action: FellesAction, dryRun: boolean): Promise<void> {
    if (running) return;
    running = true;
    runButtons.forEach((b) => (b.disabled = true));
    confirmRow.hidden = true;
    const verb = action === "remove" ? "Removing…" : "Publishing…";
    setStatus(dryRun ? "Running dry run…" : verb, "");
    out.hidden = true;
    try {
      const res = await fetch("/api/wiki/felles-publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wiki: opts.wiki, relPath: opts.relPath, dryRun, allowIdent: ident.checked, action }),
      });
      const data = (await res.json().catch(() => null)) as
        | { exitCode?: number; output?: string; error?: string }
        | null;
      if (res.ok && data && typeof data.exitCode === "number") {
        const line = fellesOutcomeLine(data.exitCode, dryRun, action);
        setStatus(line.text, line.ok ? "ok" : "err");
        if (action === "remove" && dryRun && data.exitCode === 0) confirmRow.hidden = false;
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
      opts.onRun?.();
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
  changed: number;
  checkedAt?: number;
}

export type FellesChipState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; changed: number };

/** The rail chip. Loading is neutral and inert; a failure says so in a few
 *  words (the reason is in the title) and a click retries. */
export function fellesSyncChipHtml(state: FellesChipState): string {
  const base = `class="wiki-tool-btn wiki-felles-sync-btn" id="${FELLES_SYNC_BTN_ID}" type="button"`;
  if (state.kind === "loading") {
    return `<button ${base} data-state="loading" disabled title="Checking melosys-felles for changed pages">Felles: checking…</button>`;
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

/** relPath → state, for the stale marker. Masked paths name no page. */
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

function listHtml(items: string[]): string {
  return items.length ? `<ul class="wiki-felles-files">${items.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
}

/** The status lists in the sync dialog: changed pages with their files,
 *  refused pages with the scanner's reasons, pages missing locally, orphans. */
export function fellesSyncListHtml(status: FellesSyncStatus, hrefFor: (relPath: string) => string): string {
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
      changed.map((p) => `<li>${pathHtml(p.relPath, p.masked, hrefFor)}${listHtml(p.changedFiles)}${warn(p.warnings)}</li>`),
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
      "In the bucket, but not in this wiki.",
      missing.map((p) => `<li><span class="wiki-felles-masked">${esc(p.relPath)}</span>${warn(p.warnings)}</li>`),
    ) +
    section(
      "orphans",
      "Orphans in the bucket",
      "Objects in the bucket that belong to no published page. If one is left over, remove it with the script's <code>--fjern</code>.",
      status.orphans.map((o) => `<li><span class="wiki-felles-masked">${esc(o.path)}</span></li>`),
    );
  const unchanged = by("unchanged").length;
  return (
    `<p class="wiki-felles-summary">${status.changed} changed · ${unchanged} up to date in <code>${esc(status.bucket)}</code></p>` +
    (html || `<p class="wiki-felles-hint">Every published page matches its local copy.</p>`)
  );
}

export function fellesSyncDialogHtml(status: FellesSyncStatus, hrefFor: (relPath: string) => string): string {
  return (
    `<div class="wiki-felles-body"><div class="wiki-felles-head"><span>melosys-felles — sync</span>` +
    `<button type="button" class="wiki-felles-x" data-felles="close" aria-label="Close">✕</button></div>` +
    `<div class="wiki-felles-lists">${fellesSyncListHtml(status, hrefFor)}</div>` +
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
        : { text: "A page is refused by the scanner, or the script failed. The other changed pages were published. See the output.", ok: false };
    case 2:
      return { text: "Usage or environment error — nothing was uploaded. See the output.", ok: false };
    case 3:
      return { text: "An upload failed — some pages may have been published. See the output.", ok: false };
    default:
      return { text: `The script exited with code ${exitCode}.`, ok: false };
  }
}

export interface FellesSyncOptions {
  wiki: string;
  /** The reader's address for a page, for the dialog's links. */
  hrefFor: (relPath: string) => string;
  /** Open a page in the reader (a plain click on a dialog link). */
  openPage: (relPath: string) => void;
  /** Called whenever a status arrives, so the ⇪ Felles marker can repaint. */
  onStatus: () => void;
}

export interface FellesSync {
  /** Fetch the status (again). Concurrent calls share one request. */
  load(): Promise<void>;
  /** Is this page's published copy out of date? False until a status arrived. */
  isStale(relPath: string): boolean;
}

/** Wire the rail chip and its dialog. Call once, on a wiki that offers ⇪ Felles. */
export function initFellesSync(opts: FellesSyncOptions): FellesSync {
  let status: FellesSyncStatus | null = null;
  let states = new Map<string, FellesSyncState>();
  let loading: Promise<void> | null = null;
  let dialogRefresh: (() => void) | null = null;

  const slot = document.getElementById(FELLES_SYNC_SLOT_ID);
  const paint = (state: FellesChipState) => {
    if (!slot) return;
    slot.innerHTML = fellesSyncChipHtml(state);
    slot.hidden = false;
  };

  async function fetchStatus(): Promise<void> {
    paint({ kind: "loading" });
    try {
      const res = await fetch("/api/wiki/felles-status?wiki=" + encodeURIComponent(opts.wiki), {
        headers: { [STATUS_HEADER]: "status" },
      });
      const data = (await res.json().catch(() => null)) as (FellesSyncStatus & { error?: string }) | null;
      if (!res.ok || !data || !Array.isArray(data.pages)) {
        status = null;
        states = new Map();
        paint({ kind: "error", message: data?.error ?? `HTTP ${res.status}` });
      } else {
        status = data;
        states = fellesStateMap(data);
        paint({ kind: "ok", changed: data.changed });
      }
    } catch (err) {
      status = null;
      states = new Map();
      paint({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
    opts.onStatus();
    dialogRefresh?.();
  }

  function load(): Promise<void> {
    if (!loading) loading = fetchStatus().finally(() => (loading = null));
    return loading;
  }

  slot?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("#" + FELLES_SYNC_BTN_ID);
    if (!btn) return;
    const state = btn.getAttribute("data-state");
    if (state === "error") void load();
    else if (state === "ok" && status) openDialog();
  });

  function openDialog(): void {
    document.getElementById(SYNC_DIALOG_ID)?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = SYNC_DIALOG_ID;
    dialog.className = "wiki-felles wiki-felles-sync-dialog";
    dialog.innerHTML = fellesSyncDialogHtml(status!, opts.hrefFor);
    document.body.appendChild(dialog);
    let running = false;
    // Same hold as the page dialog: a run in flight keeps it open.
    dialog.addEventListener("close", () => {
      if (running) dialog.showModal();
      else {
        dialog.remove();
        dialogRefresh = null;
      }
    });
    dialog.addEventListener("cancel", (e) => {
      if (running) e.preventDefault();
    });
    const q = <T extends Element>(sel: string) => dialog.querySelector(sel) as T;
    const ident = q<HTMLInputElement>('[data-felles="ident"]');
    const statusLine = q<HTMLElement>(".wiki-felles-status");
    const out = q<HTMLElement>(".wiki-felles-out");
    const syncBtn = q<HTMLButtonElement>('[data-felles="sync"]');
    const runButtons = [q<HTMLButtonElement>('[data-felles="sync-dry"]'), syncBtn, q<HTMLButtonElement>('[data-felles="close"]')];
    const setStatus = (text: string, kind: "" | "ok" | "err") => {
      statusLine.textContent = text;
      statusLine.className = "wiki-felles-status" + (kind ? " " + kind : "");
    };
    // A fresh status repaints the lists and the button's count; the run's
    // result line and output stay.
    dialogRefresh = () => {
      if (!status) return;
      q<HTMLElement>(".wiki-felles-lists").innerHTML = fellesSyncListHtml(status, opts.hrefFor);
      syncBtn.textContent = `Publish changed (${status.changed})`;
      if (!running) syncBtn.disabled = status.changed === 0;
    };

    async function run(dryRun: boolean): Promise<void> {
      if (running) return;
      running = true;
      runButtons.forEach((b) => (b.disabled = true));
      setStatus(dryRun ? "Running dry run…" : "Publishing the changed pages… (one upload per file; this can take minutes)", "");
      out.hidden = true;
      try {
        const res = await fetch("/api/wiki/felles-publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wiki: opts.wiki, action: "sync", dryRun, allowIdent: ident.checked }),
        });
        const data = (await res.json().catch(() => null)) as { exitCode?: number; output?: string; error?: string } | null;
        if (res.ok && data && typeof data.exitCode === "number") {
          const line = fellesSyncOutcomeLine(data.exitCode, dryRun);
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
        syncBtn.disabled = !status || status.changed === 0;
      }
      await load();
    }

    dialog.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target === dialog && !running) return dialog.close();
      const link = target.closest("[data-felles-open]");
      if (link) {
        const me = e as MouseEvent;
        if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
        e.preventDefault();
        if (!running) dialog.close();
        opts.openPage(link.getAttribute("data-felles-open") || "");
        return;
      }
      const action = target.closest("[data-felles]")?.getAttribute("data-felles");
      if (action === "close") dialog.close();
      else if (action === "sync-dry") void run(true);
      else if (action === "sync") void run(false);
    });
    dialog.showModal();
  }

  return {
    load,
    isStale: (relPath) => states.get(fellesStatusKey(relPath)) === "changed",
  };
}

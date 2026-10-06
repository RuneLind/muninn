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

/** The bucket has no soft delete, so the dry run is the step that shows what
 *  goes; the confirm button is the step that deletes. */
function fellesRemoveOutcomeLine(exitCode: number, dryRun: boolean): { text: string; ok: boolean } {
  switch (exitCode) {
    case 0:
      return dryRun
        ? { text: "Dry run: the object below would be deleted. Nothing was removed yet.", ok: true }
        : { text: "Removed. The pod drops the page within about 2 minutes.", ok: true };
    case 1:
      return { text: "The script refused the path, or failed. Nothing may have been removed. See the output.", ok: false };
    case 2:
      return { text: "Usage or environment error — nothing was removed. See the output.", ok: false };
    case 3:
      return { text: "Delete failed — the page may not be in the bucket. See the output.", ok: false };
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
export function fellesBtnHtml(relPath: string): string {
  return (
    `<button class="wiki-bc-share" id="${FELLES_BTN_ID}" type="button" data-felles-relpath="${esc(relPath)}" ` +
    `title="Publish this page to the melosys-felles wiki">⇪ Felles</button>`
  );
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
  `;
}

export interface OpenFellesOptions {
  wiki: string;
  relPath: string;
  bin: string;
  root: string;
  bucket?: string;
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

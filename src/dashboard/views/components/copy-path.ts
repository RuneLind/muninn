/// <reference lib="dom" />
/**
 * The clipboard primitive two of the dashboard's copy controls share, the path
 * they copy, and the way they report the result.
 *
 * **Scope, stated exactly, because the first version of this comment was wrong.**
 * Six places on the dashboard write the clipboard. This module unified TWO of
 * them — the fenced-code copy button (`code-block-chrome.ts`) and the ⧉ Copy path
 * pair (`plan-board.ts`, `wiki-browser.ts`). The other four each have their own
 * write and their own fallback (or none): `share-dialog.ts`, `jira-archive-browser.ts`,
 * `sum-outcomes.ts` and `chat/views/components/jira-card.ts`. Three of those have
 * NO `execCommand` fallback at all, so on the tailnet-over-plain-HTTP deployment
 * this file's own reasoning is about, they are silently inert — 📤 Share's Copy
 * sits in the same breadcrumb row as ⧉ Copy path and is one of them. That is a
 * real gap; it is not this module's yet, and a reader must not conclude from
 * here that copying is now one function everywhere.
 *
 * The two that ARE unified had genuinely different fallbacks — verified against
 * `origin/main`, not remembered: the plan drawer's ran `select()`/`execCommand`
 * inside a `try` with the removal in a `finally`, while the fence's removed the
 * staged `<textarea>` in the statement AFTER `execCommand`, so any throw left a
 * hidden but focusable node in the DOM of a page the reader keeps tabbing
 * through. They were written three weeks apart (#487, #494) and never shared a
 * version, so this is not drift between copies — it is two independent authors
 * getting a fiddly fallback differently right. One copy, with the `finally`.
 *
 * `wikiPagePath` is here rather than beside the navigation rules because it is
 * not a navigation path — it is the on-disk string the two ⧉ buttons hand to
 * `copyText`, and its only reason to exist is that both must build it the same
 * way. `flashCopyResult` is here for the same reason, and because the part that
 * actually differed between the copies was never the clipboard write.
 */

/**
 * Copy `text`, resolving `true` on success.
 *
 * `navigator.clipboard` is unavailable on a page served over plain HTTP to
 * anything but localhost — which is exactly how this dashboard is reached over
 * a tailnet — so the `execCommand` path is the common case there, not a legacy
 * fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.select();
      return document.execCommand("copy");
    } finally {
      // `select()` and `execCommand` can both throw (CSP sandboxes; it is on
      // removal tracks), and the removal used to sit AFTER them — so a throw
      // left a hidden focusable textarea in the DOM of a page the reader keeps
      // using. `finally`, not a trailing statement.
      ta.remove();
    }
  } catch {
    return false;
  }
}

/**
 * The ON-DISK path of a wiki page — the string you paste into an agent brief.
 *
 * Absolute (root + relPath) when the caller knows the wiki's root; the relPath
 * alone otherwise, which still identifies the file inside its own wiki. Both
 * arguments degrade the same way and for the same reason: an unknown part must
 * yield a shorter TRUE answer or NO answer, never a false one. So a blank
 * relPath answers `""` rather than `<root>/` — a directory is not the page, and
 * `<root>/undefined` is worse than nothing precisely because it is path-shaped.
 * The callers render `""` as a refusal ("Copy failed"), never as a live control.
 */
export function wikiPagePath(
  root: string | null | undefined,
  relPath: string | null | undefined,
): string {
  const rel = (relPath ?? "").trim();
  if (!rel) return "";
  const raw = (root ?? "").trim();
  if (!raw) return rel;
  // Trailing slashes are stripped so a root that carries one does not yield a
  // doubled separator. A root that is NOTHING BUT slashes strips to "" and the
  // join below then yields `/relPath` — which is the right answer for it, and
  // why there is no branch here: a mutation check found the guard that used to
  // spell that case out was equivalent to the join it guarded.
  const base = raw.replace(/\/+$/, "");
  return `${base}/${rel}`;
}

/** The /wiki breadcrumb's ⧉ Copy path button — the id the render, the click
 *  delegate, the read-only audit and the e2e spec all key on. Exported from the
 *  module that OWNS the control's behaviour, like `SHARE_BTN_ID` and
 *  `DISCUSS_ARTICLE_BTN_ID`, so those four cannot key on four spellings. */
export const COPY_PATH_BTN_ID = "wikiCopyPathBtn";

/** Its label at rest. */
export const COPY_PATH_IDLE = "⧉ Copy path";

/** Its accessible name at rest. Built by a FUNCTION, not written twice: the
 *  markup and the click both need it, and the click cannot read it back off the
 *  element — mid-flash the element carries the verdict-prefixed one, so a second
 *  click within the window would nest them. */
export function copyPathAriaLabel(full: string): string {
  return full ? `Copy this page's file path: ${full}` : "Copy this page's file path";
}

/** How long a copy button shows its verdict before going back to its label.
 *  ONE number for all of them — the fence button and the two ⧉ Copy path
 *  buttons shipped 1600 and 1500 respectively, which is the same drift this
 *  module exists to stop, one layer up from the clipboard write. */
export const COPIED_MS = 1600;

/** Just enough of a button for `flashCopyResult` — keeps it testable without a
 *  DOM, and makes the set of properties it touches explicit. */
export interface CopyFlashButton {
  textContent: string | null;
  readonly isConnected: boolean;
  setAttribute(name: string, value: string): void;
}

/** The revert timer PER BUTTON. A `WeakMap` rather than a field on the element
 *  so nothing has to be cleaned up when the breadcrumb is re-rendered out from
 *  under a pending revert. */
const pendingRevert = new WeakMap<CopyFlashButton, ReturnType<typeof setTimeout>>();

/**
 * Report a copy IN the button, then put the button back.
 *
 * Two things here are defects the shipped copies had, both found by review:
 *
 *  - **The pending revert is CANCELLED.** Each click used to schedule its own
 *    timer, so a second click 1.2 s after the first had its "Copied" wiped
 *    ~300 ms later by the first click's timer — a copy that DID happen reading
 *    as a dead control, which is exactly what provokes a third click. Measured
 *    in a browser, not reasoned about.
 *  - **The accessible name moves with the text.** An `aria-label` OVERRIDES a
 *    button's text content, so a static one makes `textContent` invisible to a
 *    screen reader: the only feedback a clipboard write can give, silenced —
 *    and silenced hardest on the `execCommand` path, which is the PRIMARY path
 *    on the plain-HTTP tailnet deployment and the one that actually fails.
 *
 * `timeoutMs` is a parameter only so a unit test need not wait 1.6 s.
 */
export function flashCopyResult(
  btn: CopyFlashButton,
  ok: boolean,
  idle: { text: string; ariaLabel: string },
  timeoutMs: number = COPIED_MS,
): void {
  const verdict = ok ? "Copied" : "Copy failed";
  btn.textContent = verdict;
  btn.setAttribute("aria-label", `${verdict} — ${idle.ariaLabel}`);
  const prev = pendingRevert.get(btn);
  if (prev !== undefined) clearTimeout(prev);
  pendingRevert.set(
    btn,
    setTimeout(() => {
      pendingRevert.delete(btn);
      // A navigation within the window replaces the breadcrumb wholesale, so
      // the button this closure holds is detached; writing into it is pointless.
      if (!btn.isConnected) return;
      btn.textContent = idle.text;
      btn.setAttribute("aria-label", idle.ariaLabel);
    }, timeoutMs),
  );
}

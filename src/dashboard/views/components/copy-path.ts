/// <reference lib="dom" />
/**
 * The clipboard primitive the reader's copy controls share, and the one path
 * join two of them copy.
 *
 * Three controls write to the clipboard from a dashboard page: the fenced-code
 * copy button (`code-block-chrome.ts`), the plan drawer's ⧉ Copy path
 * (`plan-board.ts`) and the /wiki breadcrumb's (`wiki-browser.ts`). They lived
 * as two independent copies of the same twenty lines, which is how they came to
 * DISAGREE about the fallback path: the fence version left a hidden focusable
 * `<textarea>` in the DOM whenever `select()`/`execCommand` threw, because its
 * removal sat after the throwing statement instead of in a `finally`. One copy,
 * with the plan board's `finally`.
 *
 * `wikiPagePath` is here rather than beside the navigation rules because it is
 * not a navigation path — it is the on-disk string these two buttons hand to
 * `copyText`, and its only reason to exist is that both must build it the same
 * way.
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
 * alone otherwise, which still identifies the file inside its own wiki. The
 * fallback is deliberately not an empty string or a `null/undefined` spliced
 * into the middle of a path: an unknown root must degrade to a shorter TRUE
 * answer, never to a false one.
 */
export function wikiPagePath(root: string | null | undefined, relPath: string): string {
  const raw = (root ?? "").trim();
  if (!raw) return relPath;
  // Trailing slashes are stripped so a root that carries one does not yield a
  // doubled separator. A root that is NOTHING BUT slashes strips to "" and the
  // join below then yields `/relPath` — which is the right answer for it, and
  // why there is no branch here: a mutation check found the guard that used to
  // spell that case out was equivalent to the join it guarded.
  const base = raw.replace(/\/+$/, "");
  return `${base}/${relPath}`;
}

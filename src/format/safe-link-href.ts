/**
 * Whether a markdown link target may become a live href. Dependency-free on
 * purpose: the summaries export calls it on the server, and the dashboard's
 * client `renderMarkdown` copies inject it by source (`.toString()`), so the
 * browser and the export apply one rule.
 *
 * Written for the export, which leaves this machine and opens from `file://`,
 * where a `javascript:`/`data:`/`vbscript:` href is script execution on the
 * reader's disk — measured through a real click. marked has no sanitizer of
 * its own; the source is model output over third-party material.
 *
 * After the control-character refusal (browsers strip tab/CR/LF before
 * parsing the scheme, so `java<TAB>script:` is `javascript:` to a click and
 * "no scheme" to a naive regex — measured; other C0 controls are
 * percent-encoded, refused here for the same conservatism) and a trim, an
 * href is exactly ONE of three things, and the rule is written over that
 * enumeration rather than as a list of prefixes:
 *
 *  1. It has a scheme — allowed only for `http`, `https`, `mailto`.
 *  2. It has no scheme and opens with TWO slash-class characters — the
 *     network-path shape, refused: `//host` and `/\host` navigate to
 *     `file://host` (the WHATWG parser treats `\` as `/` on a special base —
 *     the second verify pass clicked `/\evil.example/p` into
 *     `file://evil.example/p`). `///path` has an EMPTY host and is refused
 *     with them: a link no reader needs, over-refused rather than carved out.
 *  3. Anything else — a fragment, a relative path resolved inside the folder,
 *     or an absolute path resolved against the local filesystem root (no
 *     host, no network; measured `/local/p` → `file:///local/p`).
 */
export function isSafeLinkHref(href: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(href)) return false;
  const trimmed = href.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined) return scheme === "http" || scheme === "https" || scheme === "mailto";
  return !/^[/\\]{2}/.test(trimmed);
}

/**
 * Decodes numeric character references, the five XML named ones and the named
 * forms of `:`, tab and newline, so the client renderer checks the destination
 * CommonMark means (`&amp;` is `&`, `java&Tab;script:` is refused). Other named
 * references stay literal: the renderer escapes `&` on output, so the browser
 * reads them as text, never as a scheme character.
 * Dependency-free: the client copies inject it by `.toString()`.
 */
export function decodeBasicCharRefs(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", Tab: "\t", NewLine: "\n",
  };
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|colon|Tab|NewLine));/g, (m, dec, hex, name) => {
    if (name) return named[name]!;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
  });
}

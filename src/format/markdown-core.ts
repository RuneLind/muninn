/**
 * Shared utilities for the platform-specific markdown formatters
 * (web, telegram, slack). Each platform still owns its conversion logic;
 * this module consolidates the duplicated escape + placeholder mechanics.
 */

/** Escape HTML entities: & < > and ". Safe for both attribute values and text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Placeholder store using `\x00<MARKER><idx>\x00` sentinels. Use to protect
 * regions (code blocks, inline code, links) from further markdown processing,
 * then restore them at the end.
 */
export class Placeholders {
  private stores = new Map<string, string[]>();

  /** Reserve a placeholder slot; returns the sentinel to embed in the text. */
  add(marker: string, rendered: string): string {
    let arr = this.stores.get(marker);
    if (!arr) {
      arr = [];
      this.stores.set(marker, arr);
    }
    const idx = arr.length;
    arr.push(rendered);
    return `\x00${marker}${idx}\x00`;
  }

  /** Replace all sentinels in `text` with their rendered values. */
  restore(text: string): string {
    let result = text;
    for (const [marker, items] of this.stores) {
      result = result.replace(
        restoreRegex(marker),
        (_m, idx) => items[parseInt(idx, 10)] ?? "",
      );
    }
    return result;
  }
}

const restoreRegexCache = new Map<string, RegExp>();
function restoreRegex(marker: string): RegExp {
  let re = restoreRegexCache.get(marker);
  if (!re) {
    re = new RegExp(`\\x00${marker}(\\d+)\\x00`, "g");
    restoreRegexCache.set(marker, re);
  }
  return re;
}

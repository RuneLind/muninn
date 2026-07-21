/**
 * Renders one wiki page's markdown to HTML for the /wiki reader.
 *
 * Reuses the web chat's markdown pipeline (`formatWebHtml`) — wikilinks are the
 * only wiki-specific syntax, so they are swapped for `\x00`-sentinel tokens
 * before rendering (the pipeline HTML-escapes text, which would otherwise
 * mangle them) and restored as internal anchors afterwards. Resolved links
 * become `<a href="/wiki?page=…" data-wiki-page="…">`; unresolved ones become
 * muted spans so dead links are visible but not clickable.
 */

import { formatWebHtml } from "../web/web-format.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import type { WikiPageMeta } from "./store.ts";

const WIKILINK_WITH_LABEL_RE = /\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;

export function renderWikiHtml(
  markdown: string,
  resolve: (target: string) => WikiPageMeta | undefined,
  opts?: { stripTitle?: string },
): string {
  let body = stripFrontmatter(markdown);
  // The reader renders its own title header — drop the page's leading H1 when
  // it just repeats that title, but keep distinct ones (e.g. index.md's
  // "# Wiki Index" under the fallback title "index").
  if (opts?.stripTitle) {
    const m = body.match(/^\s*#\s+(.+)\n?/);
    if (m && m[1]!.trim().toLowerCase() === opts.stripTitle.trim().toLowerCase()) {
      body = body.slice(m.index! + m[0].length);
    }
  }

  const rendered: string[] = [];
  const withTokens = body.replace(WIKILINK_WITH_LABEL_RE, (_m, target: string, label?: string) => {
    const text = (label ?? target).trim() || target.trim();
    const meta = resolve(target);
    const html = meta
      ? `<a href="/wiki?page=${encodeURIComponent(meta.name)}" class="wiki-link" data-wiki-page="${escapeHtml(meta.name)}">${escapeHtml(text)}</a>`
      : `<span class="wiki-link-missing" title="No page named ${escapeHtml(target.trim())}">${escapeHtml(text)}</span>`;
    const idx = rendered.length;
    rendered.push(html);
    return `\x00WIKIPAGELINK${idx}\x00`;
  });

  const html = formatWebHtml(withTokens).replace(
    /\x00WIKIPAGELINK(\d+)\x00/g,
    (_m, idx: string) => rendered[parseInt(idx, 10)] ?? "",
  );
  return upgradeObsidianCallouts(html);
}

/** Obsidian callout type → the reader's callout tone palette. */
function calloutTone(type: string): "info" | "warn" | "good" | "bad" {
  switch (type.toLowerCase()) {
    case "warning":
    case "caution":
    case "attention":
    case "important":
      return "warn";
    case "tip":
    case "hint":
    case "success":
    case "check":
    case "done":
      return "good";
    case "danger":
    case "error":
    case "failure":
    case "fail":
    case "missing":
    case "bug":
      return "bad";
    default:
      return "info";
  }
}

/**
 * Upgrades Obsidian-style callout blockquotes (`> [!warning] Title` + body
 * lines) in already-rendered HTML to the same `.callout` markup the mdx
 * `<Callout>` component produces, so `.md` wiki pages get the styled box
 * instead of a plain blockquote with a literal `[!warning]` tag showing.
 *
 * Runs on rendered output because the markdown pipeline is shared with web
 * chat — the blockquote renderer joins lines with `<br>`, so the first segment
 * is the callout's title line. An empty title falls back to the capitalized
 * type name (Obsidian's own behavior).
 */
function upgradeObsidianCallouts(html: string): string {
  return html.replace(
    /<blockquote>\[!([a-zA-Z]+)\]\s*([\s\S]*?)<\/blockquote>/g,
    (_m, type: string, rest: string) => {
      const tone = calloutTone(type);
      const brIdx = rest.indexOf("<br>");
      let title = (brIdx === -1 ? rest : rest.slice(0, brIdx)).trim();
      let body = brIdx === -1 ? "" : rest.slice(brIdx + 4).replace(/^(?:\s*<br>)+/, "").trim();
      if (!title) title = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      const titleHtml = `<strong class="callout-title">${title}</strong>`;
      const bodyHtml = body ? `<div class="callout-body">${body}</div>` : "";
      return `<div class="callout callout-${tone}">${titleHtml}${bodyHtml}</div>`;
    },
  );
}

/** Drop the leading `---` frontmatter fence so it doesn't render as an hr + text. */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after === -1 ? "" : markdown.slice(after + 1);
}

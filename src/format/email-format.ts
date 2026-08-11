/**
 * Markdown → email HTML. The fourth {@link BlockRenderer}, beside web, telegram
 * and slack, so a new `Block` variant is a compile error here too.
 *
 * Why a separate renderer instead of reusing `formatWebHtml`: mail clients drop
 * `<style>` blocks and ignore classes, and `formatWebHtml`'s components are
 * class-driven `<div>`s whose entire appearance lives in the page's CSS. Pasted
 * into a mail client, a `<div class="callout callout-warn">` is an unstyled
 * paragraph and a `<details>` is a body of text with no way to tell it was
 * collapsed. So every rule here rides an inline `style=` attribute, and anything
 * that cannot survive as inline style degrades to something readable rather than
 * to nothing.
 *
 * Deliberately conservative: no flexbox, no CSS variables, no pseudo-elements, no
 * `<details>`. Table cells carry their own borders (a bare `<table>` renders
 * borderless in most clients). Colours are a fixed light palette — a mail body
 * has no theme to follow, and a dark-mode client inverts it on its own terms.
 */

import {
  parseBlocks,
  scanInlineComponents,
  normalizeCalloutTone,
  normalizePillTone,
  normalizeVerdictValue,
  normalizeFactVerdict,
  FACT_VERDICT_MARK,
  FACT_VERDICT_WORD,
  FACT_COUNT_WORD,
  parseMeterAttrs,
  firstCodeBlock,
  parseChecklist,
} from "./markdown-ast.ts";
import type { Block, FactVerdict } from "./markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "./block-renderer.ts";
import { Placeholders, escapeHtml } from "./markdown-core.ts";

type ComponentBlock = Extract<Block, { type: "component" }>;
const isTab = (b: Block): b is ComponentBlock => b.type === "component" && b.name === "Tab";

// ── Inline style vocabulary ──────────────────────────────────────────────────
// One place per role, so the renderer below reads as structure rather than as a
// wall of style strings.

const TEXT = "#1f2328";
const DIM = "#57606a";
const BORDER = "#d0d7de";
const SURFACE = "#f6f8fa";
const LINK = "#0969da";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const S = {
  h: (level: number) =>
    `margin:24px 0 8px;font-size:${[22, 19, 17, 16, 15, 14][Math.min(level, 6) - 1]}px;` +
    `font-weight:600;line-height:1.3;color:${TEXT};`,
  p: `margin:0 0 12px;line-height:1.55;color:${TEXT};`,
  list: `margin:0 0 12px;padding-left:22px;line-height:1.55;color:${TEXT};`,
  li: "margin:0 0 4px;",
  pre:
    `margin:0 0 12px;padding:12px;background:${SURFACE};border:1px solid ${BORDER};` +
    `border-radius:6px;overflow-x:auto;font-family:${MONO};font-size:13px;line-height:1.45;`,
  code: `padding:1px 4px;background:${SURFACE};border-radius:4px;font-family:${MONO};font-size:13px;`,
  quote: `margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid ${BORDER};color:${DIM};`,
  hr: `border:0;border-top:1px solid ${BORDER};margin:20px 0;`,
  table: `border-collapse:collapse;margin:0 0 12px;font-size:14px;`,
  th: `border:1px solid ${BORDER};padding:6px 10px;background:${SURFACE};text-align:left;font-weight:600;`,
  td: `border:1px solid ${BORDER};padding:6px 10px;vertical-align:top;`,
  link: `color:${LINK};text-decoration:underline;`,
  dim: `color:${DIM};font-size:13px;`,
} as const;

/** Callout accent per tone — the one thing a callout has that a plain box hasn't. */
const CALLOUT_ACCENT: Record<"info" | "warn" | "good" | "bad", string> = {
  info: "#0969da",
  warn: "#bf8700",
  good: "#1a7f37",
  bad: "#cf222e",
};

const VERDICT_COLOR = { yes: "#1a7f37", no: "#cf222e" } as const;

const FACT_COLOR: Record<FactVerdict, string> = {
  ok: "#1a7f37",
  warn: "#bf8700",
  bad: "#cf222e",
  unknown: DIM,
};

/**
 * Convert markdown to inline-styled HTML suitable for pasting into an email.
 * Returns a document FRAGMENT (no `<html>`/`<body>`) — the caller decides whether
 * it becomes a mail body, a clipboard payload or a preview pane.
 */
export function formatEmailHtml(text: string): string {
  return renderBlocks(parseBlocks(text), emailRenderer).replace(/\n{3,}/g, "\n\n").trim();
}

const emailRenderer: BlockRenderer = {
  code_block: (block) => `<pre style="${S.pre}"><code>${escapeHtml(block.code)}</code></pre>`,
  hr: () => `<hr style="${S.hr}">`,
  heading(block) {
    const tag = `h${Math.min(block.level + 1, 6)}`;
    return `<${tag} style="${S.h(block.level + 1)}">${renderInline(block.content)}</${tag}>`;
  },
  blockquote: (lines) =>
    `<blockquote style="${S.quote}">${lines.map(renderInline).join("<br>")}</blockquote>`,
  ul: (items) =>
    `<ul style="${S.list}">${items.map((i) => `<li style="${S.li}">${renderInline(i)}</li>`).join("")}</ul>`,
  ol: (items, start) =>
    `<ol style="${S.list}"${start !== 1 ? ` start="${start}"` : ""}>` +
    items.map((i) => `<li style="${S.li}">${renderInline(i)}</li>`).join("") +
    `</ol>`,
  table(headers, rows) {
    const thead =
      "<thead><tr>" + headers.map((h) => `<th style="${S.th}">${renderInline(h)}</th>`).join("") + "</tr></thead>";
    const tbody =
      "<tbody>" +
      rows
        .map((row) => "<tr>" + row.map((c) => `<td style="${S.td}">${renderInline(c)}</td>`).join("") + "</tr>")
        .join("") +
      "</tbody>";
    return `<table style="${S.table}" cellspacing="0" cellpadding="0">${thead}${tbody}</table>`;
  },
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout": {
        const accent = CALLOUT_ACCENT[normalizeCalloutTone(attrs.tone)];
        const title = attrs.title
          ? `<div style="font-weight:600;margin:0 0 6px;color:${accent};">${escapeHtml(attrs.title)}</div>`
          : "";
        return (
          `<div style="margin:0 0 12px;padding:10px 14px;background:${SURFACE};` +
          `border-left:3px solid ${accent};border-radius:0 6px 6px 0;">${title}${children}</div>`
        );
      }
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return verdictSpan(value, label);
      }
      case "Pill":
        return pillSpan(normalizePillTone(attrs.tone), children.trim());
      case "Figure": {
        const caption = attrs.caption
          ? `<div style="${S.dim}margin-top:6px;">${escapeHtml(attrs.caption)}</div>`
          : "";
        return `<div style="margin:0 0 12px;">${children}${caption}</div>`;
      }
      case "FileRef":
        return `<code style="${S.code}">${children.trim() || escapeHtml(attrs.path ?? "")}</code>`;
      case "ComparisonTable":
        return children;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        // No bar: a `width:%` div inside a mail client is a coin flip, and a
        // half-drawn bar misstates the value. The number always reads.
        if (!meter) return children;
        return `<div style="margin:0 0 8px;color:${TEXT};">${children}: <strong>${meter.value}/${meter.max}</strong></div>`;
      }
      case "Diff": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children;
        return `<pre style="${S.pre}"><code>${escapeHtml(fence.code)}</code></pre>`;
      }
      case "FileTree":
        return children; // the rendered fence IS the tree
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children;
        const rows = items
          .map(
            (it) =>
              `<li style="${S.li}list-style:none;">` +
              `<span style="color:${it.checked ? VERDICT_COLOR.yes : DIM};">${it.checked ? "☑" : "☐"}</span> ` +
              `${renderInline(it.text)}</li>`,
          )
          .join("");
        return `<ul style="${S.list}padding-left:4px;">${rows}</ul>`;
      }
      case "AnnotatedCode": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children;
        const file = attrs.file
          ? `<div style="${S.dim}font-family:${MONO};margin:0 0 4px;">${escapeHtml(attrs.file)}</div>`
          : "";
        const notes = renderBlocks(
          rawChildren.filter((b) => b.type !== "code_block"),
          emailRenderer,
        );
        return `<div style="margin:0 0 12px;">${file}<pre style="${S.pre}"><code>${escapeHtml(fence.code)}</code></pre>${notes}</div>`;
      }
      case "CodeTabs": {
        const tabs = rawChildren.filter(isTab);
        // No tab bar is possible without JS, so every tab is rendered in sequence
        // under its own label — the reader sees all of them rather than one.
        if (tabs.length === 0) return children;
        return tabs
          .map((t, i) => emailRenderer.component("Tab", { label: t.attrs.label ?? `Tab ${i + 1}` },
            renderBlocks(t.children, emailRenderer), t.children))
          .join("");
      }
      case "Tab": {
        const label = attrs.label ? escapeHtml(attrs.label) : "Tab";
        return `<div style="margin:0 0 12px;"><div style="${S.dim}font-weight:600;margin:0 0 4px;">${label}</div>${children}</div>`;
      }
      case "Fact": {
        const v = normalizeFactVerdict(attrs.v);
        if (!children.trim()) return factMarker(v);
        return (
          `<div style="margin:0 0 12px;padding-left:10px;border-left:3px solid ${FACT_COLOR[v]};">` +
          `${children} ${factMarker(v)}</div>`
        );
      }
      case "FactCheck":
        // No <details> in mail — the appendix renders open, under its summary line.
        return (
          `<div style="margin:16px 0 12px;padding-top:12px;border-top:1px solid ${BORDER};">` +
          `<div style="${S.dim}margin:0 0 8px;">${factCheckSummaryHtml(attrs)}</div>${children}</div>`
        );
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  inlineComponent(name, attrs, text) {
    switch (name) {
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = text.trim() ? escapeHtml(text.trim()) : value === "yes" ? "Yes" : "No";
        return verdictSpan(value, label);
      }
      case "Pill":
        return pillSpan(normalizePillTone(attrs.tone), escapeHtml(text.trim()));
      case "Fact":
        // Reachable only via a direct call — `renderInline` intercepts `Fact` so
        // its wrapped PROSE keeps running through the inline pipeline (escaping it
        // here would render `**1.32 kg**` as literal asterisks). Marker-only.
        return factMarker(normalizeFactVerdict(attrs.v));
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  text(lines) {
    // Blank lines are dropped rather than joined: `<br>` is a VISIBLE line here
    // (web joins with `\n`, which collapses), so a text block that opens with an
    // empty line — as a `FactCheck` claim's evidence does — otherwise renders a
    // stray blank line under every heading.
    const kept = lines.filter((l) => l.trim() !== "");
    if (kept.length === 0) return "";
    return `<p style="${S.p}">${kept.map(renderInline).join("<br>")}</p>`;
  },
};

function verdictSpan(value: "yes" | "no", label: string): string {
  return `<span style="color:${VERDICT_COLOR[value]};font-weight:600;">${value === "yes" ? "✅" : "❌"} ${label}</span>`;
}

function pillSpan(tone: "default" | "rec" | "warn", label: string): string {
  const color = tone === "rec" ? VERDICT_COLOR.yes : tone === "warn" ? CALLOUT_ACCENT.warn : DIM;
  return (
    `<span style="display:inline-block;padding:1px 7px;border:1px solid ${color};border-radius:10px;` +
    `color:${color};font-size:12px;">${label}</span>`
  );
}

/** The verdict glyph a `Fact` leaves behind. No chip — there is nothing on a mail
 *  page for it to expand, so the mark is the whole affordance. */
function factMarker(v: FactVerdict): string {
  return `<span style="color:${FACT_COLOR[v]};" title="${escapeHtml(FACT_VERDICT_WORD[v])}">${FACT_VERDICT_MARK[v]}</span>`;
}

/** The `FactCheck` counts line. Same digits-only rule as every other platform: an
 *  absent or garbage count is OMITTED, never rendered as a `0` nobody wrote. */
function factCheckSummaryHtml(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of ["ok", "warn", "bad", "unknown"] as const) {
    const raw = attrs[key]?.trim();
    if (!raw || !/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n)) {
      parts.push(`<span style="color:${FACT_COLOR[key]};">${FACT_VERDICT_MARK[key]} ${n} ${FACT_COUNT_WORD[key]}</span>`);
    }
  }
  const date = attrs.date?.trim();
  const lead = date ? `Fact-checked <strong>${escapeHtml(date)}</strong>` : "Fact-checked";
  return parts.length ? `${lead}: ${parts.join(", ")}` : lead;
}

function renderInline(text: string): string {
  const ph = new Placeholders();

  // Inline code FIRST — parking it before the component scan keeps a complete
  // component tag inside backticks literal (the sentinel carries no `<`).
  let result = text.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `<code style="${S.code}">${escapeHtml(code)}</code>`),
  );

  result = scanInlineComponents(result)
    .map((seg) => {
      if (seg.kind === "text") return seg.text;
      if (seg.name === "Fact") {
        // `Fact` wraps PROSE: park only the generated tags, leave the body in the
        // stream for the escape/bold/link passes below.
        const v = normalizeFactVerdict(seg.attrs.v);
        if (!seg.text) return ph.add("INLINECMP", factMarker(v));
        return (
          ph.add("INLINECMP", `<span style="border-bottom:2px solid ${FACT_COLOR[v]};">`) +
          seg.text +
          ph.add("INLINECMP", "</span>") +
          ph.add("INLINECMP", ` ${factMarker(v)}`)
        );
      }
      return ph.add("INLINECMP", emailRenderer.inlineComponent(seg.name, seg.attrs, seg.text));
    })
    .join("");

  // Slack-style angle-bracket links → markdown, before the escape hides them.
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  result = escapeHtml(result);

  // Markdown links → <a>. http/https only — a `javascript:` target must never
  // become a live href, and a relative target has nothing to resolve against in a
  // mail client, so it degrades to its label.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    /^https?:\/\//.test(url) ? `<a href="${url}" style="${S.link}">${label}</a>` : label,
  );

  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italics with the CommonMark-style flanking rule (no whitespace immediately
  // inside the delimiters), the twin of `SLACK_ITALIC_RE` in `slack-format.ts`.
  // Deliberately duplicated rather than hoisted into a shared home: telegram and
  // web ship the weaker `(?<!\w)\*([^*]+?)\*(?!\w)` — under which prose
  // arithmetic (`2 * 3 and 4 * 5`) becomes one emphasis span — and a shared rule
  // would change their long-standing output as a side effect of adding email.
  // The four columns are pinned side by side in `markdown-all-platforms.test.ts`.
  result = result.replace(/(?<![\w*])\*(?=\S)([^*\n]*[^\s*])\*(?![\w*])/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return ph.restore(result);
}

import {
  parseBlocks,
  scanInlineComponents,
  normalizeCalloutTone,
  normalizePillTone,
  normalizeVerdictValue,
  normalizeFactVerdict,
  factClaimIndex,
  factClaimNumberFromHeading,
  FACT_VERDICT_MARK,
  FACT_VERDICT_WORD,
  FACT_COUNT_WORD,
  parseMeterAttrs,
  firstCodeBlock,
  diffLineClass,
  parseChecklist,
} from "../format/markdown-ast.ts";
import type { Block, FactVerdict } from "../format/markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "../format/block-renderer.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

type ComponentBlock = Extract<Block, { type: "component" }>;
const isTab = (b: Block): b is ComponentBlock => b.type === "component" && b.name === "Tab";

// ── Fact-check annotation ────────────────────────────────────────────────────
// `<Fact n="4" v="bad">passage</Fact>` marks a fact-checked passage and hangs a
// verdict chip off its end; `<FactCheck …>` is the collapsed appendix holding the
// per-claim evidence. Both render fully SERVER-SIDE — the reader's client only
// wires the chip's expand-on-click, so an article with JS disabled still shows
// which passages were checked and how they came out.

/** The three generated pieces of a `Fact` mark, kept separate because the wrapped
 *  PROSE must keep flowing through the rest of the inline pipeline (bold, links)
 *  rather than being escaped as an opaque label. */
function factMarkParts(attrs: Record<string, string>): {
  open: string;
  close: string;
  chip: string;
} {
  const v = normalizeFactVerdict(attrs.v);
  const n = factClaimIndex(attrs.n);
  const nAttr = n === null ? "" : ` data-fact="${n}"`;
  const label = n === null
    ? `Fact check: ${FACT_VERDICT_WORD[v]}`
    : `Claim ${n} — ${FACT_VERDICT_WORD[v]}`;
  return {
    open: `<span class="fc-mark fc-mark-${v}"${nAttr}>`,
    close: `</span>`,
    // A real <button>: the chip is the interactive affordance for the evidence
    // card, so it must be keyboard-reachable and announce itself. The glyph is
    // aria-hidden (a screen reader saying "check mark" is noise) and the label
    // rides a visually-hidden span instead.
    chip:
      `<button type="button" class="fc-chip fc-chip-${v}"${nAttr}` +
      ` aria-expanded="false" title="${escapeHtml(label)}">` +
      `<span aria-hidden="true">${FACT_VERDICT_MARK[v]}</span>` +
      `<span class="fc-chip-label">${escapeHtml(label)}</span></button>`,
  };
}

/** Counts strip for the collapsed `FactCheck` appendix. A count attr that is
 *  absent or not a number is omitted rather than rendered as `0` — the appendix
 *  must not claim "0 corrected" on a page whose writer simply didn't say.
 *  Counts are DIGITS-ONLY: a bare `Number()` rendered `ok="1e5"` as "100000
 *  confirmed" and `ok="0x10"` as 16. */
function factCheckSummary(attrs: Record<string, string>): string {
  const date = attrs.date?.trim();
  const parts: string[] = [];
  const count = (key: "ok" | "warn" | "bad" | "unknown", v: FactVerdict) => {
    const raw = attrs[key]?.trim();
    if (!raw || !/^\d+$/.test(raw)) return;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return;
    parts.push(
      `<span class="fc-count fc-count-${v}">${FACT_VERDICT_MARK[v]} ${n} ${FACT_COUNT_WORD[v]}</span>`,
    );
  };
  count("ok", "ok");
  count("warn", "warn");
  count("bad", "bad");
  // The ❓ claims — no `<Fact>` mark and no appendix section, so this count is the
  // ONLY trace a deadline-truncated run leaves. Last, after the real verdicts.
  count("unknown", "unknown");
  const lead = date ? `Fact-checked <b>${escapeHtml(date)}</b>` : "Fact-checked";
  return `<span class="fc-strip-lead">${lead}</span>${parts.join("")}`;
}

/**
 * Render the appendix children, wrapping each claim's blocks in a
 * `<section id="fc-claim-N">`. Those ids are what the reader's client clones into
 * the evidence card when a chip is activated — the claim's evidence therefore
 * lives on the page EXACTLY ONCE, rather than being duplicated into `data-`
 * attributes on every chip (where arbitrary source and "Was:" text would have to
 * survive attribute escaping).
 */
function factCheckSections(children: Block[]): string {
  const groups: { n: number | null; blocks: Block[] }[] = [];
  for (const b of children) {
    const n = b.type === "heading" ? factClaimNumberFromHeading(b.content) : null;
    if (n !== null || groups.length === 0) groups.push({ n, blocks: [] });
    groups[groups.length - 1]!.blocks.push(b);
  }
  // Two headings carrying the SAME claim number would emit two
  // `id="fc-claim-1"` — invalid HTML, and `getElementById` would hand the chip
  // whichever the browser picked first. Only the first occurrence keeps the id;
  // later duplicates still render their evidence, just unaddressed.
  const seen = new Set<number>();
  return groups
    .map((g) => {
      const body = renderBlocks(g.blocks, webRenderer);
      if (g.n === null) return body;
      if (seen.has(g.n)) return `<section class="fc-claim" data-claim="${g.n}">${body}</section>`;
      seen.add(g.n);
      return `<section class="fc-claim" id="fc-claim-${g.n}" data-claim="${g.n}">${body}</section>`;
    })
    .join("");
}

/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 *
 * Walks the shared block AST from `parseBlocks` via the shared `renderBlocks`
 * dispatcher; each block emits its own HTML and inline content runs through
 * `renderInline`. The chat-page client picks this up automatically via
 * `web-format-browser.ts`'s bundle.
 */
export function formatWebHtml(text: string): string {
  const rendered = renderBlocks(parseBlocks(text), webRenderer);
  return collapseBlockSpacing(rendered).trim();
}

const webRenderer: BlockRenderer = {
  code_block(block) {
    const langClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`;
  },
  hr: () => "<hr>",
  heading(block) {
    const tag = `h${Math.min(block.level + 1, 6)}`;
    return `<${tag}>${renderInline(block.content)}</${tag}>`;
  },
  blockquote: (lines) => `<blockquote>${lines.map(renderInline).join("<br>")}</blockquote>`,
  ul: (items) => `<ul>${items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ul>`,
  ol: (items, start) =>
    `<ol${start !== 1 ? ` start="${start}"` : ""}>${items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ol>`,
  table(headers, rows) {
    const thead = "<thead><tr>" + headers.map((h) => `<th>${renderInline(h)}</th>`).join("") + "</tr></thead>";
    const tbody = "<tbody>" + rows.map((row) =>
      "<tr>" + row.map((cell) => `<td>${renderInline(cell)}</td>`).join("") + "</tr>"
    ).join("") + "</tbody>";
    return `<table>${thead}${tbody}</table>`;
  },
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout": {
        const tone = normalizeCalloutTone(attrs.tone);
        const title = attrs.title
          ? `<strong class="callout-title">${escapeHtml(attrs.title)}</strong>`
          : "";
        return `<div class="callout callout-${tone}">${title}<div class="callout-body">${children}</div></div>`;
      }
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `<span class="verdict verdict-${value}">${label}</span>`;
      }
      case "Pill": {
        const tone = normalizePillTone(attrs.tone);
        const cls = tone === "default" ? "pill" : `pill pill-${tone}`;
        return `<span class="${cls}">${children}</span>`;
      }
      case "Figure": {
        const caption = attrs.caption
          ? `<figcaption class="caption">${escapeHtml(attrs.caption)}</figcaption>`
          : "";
        return `<figure class="figure"><div class="figure-body">${children}</div>${caption}</figure>`;
      }
      case "FileRef":
        return `<code class="fileref">${children.trim() || escapeHtml(attrs.path ?? "")}</code>`;
      case "ComparisonTable":
        return `<div class="tablewrap">${children}</div>`;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        const pct = Math.round((meter.value / meter.max) * 100);
        const cls = meter.tone === "default" ? "meter" : `meter meter-${meter.tone}`;
        return (
          `<div class="${cls}">` +
          `<span class="meter-label">${children}</span>` +
          `<span class="meter-bar"><span class="meter-fill" style="width:${pct}%"></span></span>` +
          `<span class="meter-value">${meter.value}/${meter.max}</span>` +
          `</div>`
        );
      }
      case "Diff": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children; // no fenced diff → fall back to the rendered body
        const rows = fence.code
          .split("\n")
          .map((line) => {
            const content = escapeHtml(line);
            return `<div class="diff-line diff-${diffLineClass(line)}">${content || "&nbsp;"}</div>`;
          })
          .join("");
        return `<div class="diff">${rows}</div>`;
      }
      case "FileTree":
        // Wrap-only: the rendered fence (a <pre><code>) is the tree; CSS gives it
        // the monospace box + guide styling.
        return `<div class="filetree">${children}</div>`;
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children; // no task list → render body as-is
        const rows = items
          .map((it) => {
            const state = it.checked ? "done" : "todo";
            const mark = it.checked ? "✓" : "✗";
            return (
              `<li class="check-item check-${state}">` +
              `<span class="check-mark">${mark}</span> ${renderInline(it.text)}</li>`
            );
          })
          .join("");
        return `<ul class="checklist">${rows}</ul>`;
      }
      case "AnnotatedCode": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children; // no code fence → nothing to annotate; body as-is
        const lang = attrs.lang || fence.lang;
        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        const codeHtml = `<pre><code${langClass}>${escapeHtml(fence.code)}</code></pre>`;
        const fileHeader = attrs.file
          ? `<div class="annotated-code-file">${escapeHtml(attrs.file)}</div>`
          : "";
        // Annotations are every non-fence body block (the paragraphs after it).
        const notes = rawChildren.filter((b) => b.type !== "code_block");
        const notesHtml = renderBlocks(notes, webRenderer);
        const notesBlock = notesHtml.trim()
          ? `<div class="annotated-code-notes">${notesHtml}</div>`
          : "";
        return (
          `<div class="annotated-code">${fileHeader}` +
          `<div class="annotated-code-panel">${codeHtml}</div>${notesBlock}</div>`
        );
      }
      case "CodeTabs": {
        const tabs = rawChildren.filter(isTab);
        if (tabs.length === 0) {
          // No recognized <Tab> children (e.g. nested past the depth cap) → a
          // visible fallback panel rather than raw escaped tags.
          return `<div class="code-tabs-fallback">${children}</div>`;
        }
        const bar = tabs
          .map((t, i) => {
            const label = t.attrs.label ? escapeHtml(t.attrs.label) : `Tab ${i + 1}`;
            return `<button class="code-tabs-tab${i === 0 ? " is-active" : ""}" type="button">${label}</button>`;
          })
          .join("");
        const panels = tabs
          .map((t, i) => {
            const body = renderBlocks(t.children, webRenderer);
            return `<div class="code-tabs-panel${i === 0 ? " is-active" : ""}">${body}</div>`;
          })
          .join("");
        return (
          `<div class="code-tabs">` +
          `<div class="code-tabs-bar" role="tablist">${bar}</div>` +
          `<div class="code-tabs-panels">${panels}</div></div>`
        );
      }
      case "Tab": {
        // A standalone <Tab> (outside CodeTabs) gets its own labeled panel.
        const label = attrs.label ? escapeHtml(attrs.label) : "Tab";
        return `<div class="code-tab-standalone"><div class="code-tab-label">${label}</div>${children}</div>`;
      }
      case "Fact": {
        // BLOCK form — a `<Fact>` owning its whole line, which the block parser
        // claims before `renderInline` ever sees it. `children` is already rendered
        // block HTML (a <p>), so the mark is a block-level wrapper here; the
        // common inline form is handled in `renderInline`.
        const { chip } = factMarkParts(attrs);
        const v = normalizeFactVerdict(attrs.v);
        const n = factClaimIndex(attrs.n);
        const nAttr = n === null ? "" : ` data-fact="${n}"`;
        if (!children.trim()) return chip;
        return `<div class="fc-mark fc-mark-block fc-mark-${v}"${nAttr}>${children}${chip}</div>`;
      }
      case "FactCheck": {
        // Collapsed by DEFAULT — the per-claim evidence is reachable from the
        // chips in the prose, so the appendix that used to add 74 lines to the
        // page now adds one summary line. `open` is deliberately not set.
        return (
          `<details class="fc-block">` +
          `<summary class="fc-strip">${factCheckSummary(attrs)}</summary>` +
          `<div class="fc-block-body">${factCheckSections(rawChildren)}</div>` +
          `</details>`
        );
      }
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
        return `<span class="verdict verdict-${value}">${label}</span>`;
      }
      case "Pill": {
        const tone = normalizePillTone(attrs.tone);
        const cls = tone === "default" ? "pill" : `pill pill-${tone}`;
        return `<span class="${cls}">${escapeHtml(text.trim())}</span>`;
      }
      case "Fact": {
        // Reachable only via a direct call — `renderInline` intercepts `Fact`
        // before delegating here, because its wrapped body is PROSE that must keep
        // running through the inline pipeline. Escaping the body (what every other
        // inline component correctly does with its plain label) would render
        // `**1.32 kg**` as literal asterisks. Chip-only is the safe answer here.
        return factMarkParts(attrs).chip;
      }
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

function renderInline(text: string): string {
  const ph = new Placeholders();

  // Inline code FIRST — protect its content from further markdown processing.
  // Parking code before the component scan is what keeps a component tag inside
  // backticks (`` `<Verdict …>x</Verdict>` ``) literal: the parked sentinel
  // contains no `<`, so the scan below never sees the tag and it stays code.
  let result = text.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `<code>${escapeHtml(code)}</code>`),
  );

  // Inline components (Verdict, Pill) on the code-shielded text. Their generated
  // HTML must be parked BEFORE the escapeHtml pass below — otherwise the escape
  // would turn the chip markup into visible text. The inner text is escaped
  // inside inlineComponent, so the parked value is safe. A component whose label
  // contained backticks now embeds an INLINE sentinel; the fixed-point restore
  // in Placeholders resolves that nesting.
  result = scanInlineComponents(result)
    .map((seg) => {
      if (seg.kind === "text") return seg.text;
      // `Fact` is the one inline component that wraps PROSE rather than a plain
      // label: only its generated tags are parked, and the body is left in the
      // stream so the bold/link/escape passes below still apply to it. Every other
      // inline component escapes its own label inside `inlineComponent`.
      if (seg.name === "Fact") {
        const { open, close, chip } = factMarkParts(seg.attrs);
        if (!seg.text) return ph.add("INLINECMP", chip);
        return (
          ph.add("INLINECMP", open) +
          seg.text +
          ph.add("INLINECMP", close) +
          ph.add("INLINECMP", chip)
        );
      }
      return ph.add("INLINECMP", webRenderer.inlineComponent(seg.name, seg.attrs, seg.text));
    })
    .join("");

  // Defensive: Claude occasionally outputs Slack-style angle-bracket links;
  // normalize them to markdown form before HTML-escaping (which would otherwise
  // turn the angle brackets into entities and hide the link).
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Escape HTML entities — prevents raw HTML in Claude's response from being
  // interpreted as tags. Must happen before generated tags are emitted below.
  result = escapeHtml(result);

  // Markdown links → <a>. Only http/https to prevent javascript: injection.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    }
    return label;
  });

  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return ph.restore(result);
}

const BLOCK_TAG = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
const NL_BEFORE_BLOCK = new RegExp(`\\n+(</?${BLOCK_TAG}[>\\s])`, "g");
const NL_AFTER_BLOCK = new RegExp(`(</${BLOCK_TAG}>|<hr>)\\n+`, "g");

/** Collapse excess blank lines, especially around block-level elements. */
function collapseBlockSpacing(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(NL_BEFORE_BLOCK, "\n$1")
    .replace(NL_AFTER_BLOCK, "$1\n");
}

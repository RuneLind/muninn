import {
  parseBlocks,
  scanInlineComponents,
  normalizeVerdictValue,
  normalizeFactVerdict,
  FACT_VERDICT_MARK,
  FACT_COUNT_WORD,
  parseMeterAttrs,
  parseChecklist,
} from "../format/markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "../format/block-renderer.ts";
import {
  Placeholders,
  escapeHtml,
  RAW_EMPHASIS_SOURCES,
  parkLeftoverStarRuns,
  LINKABLE_TARGET_RE,
} from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Slack mrkdwn.
 * Walks the shared block AST via `renderBlocks`; tables become labeled bullet
 * lists and inline content runs through `renderInline` (which also accepts a
 * few HTML tags Claude occasionally emits and converts them to mrkdwn).
 */
export function formatSlackMrkdwn(text: string): string {
  const rendered = renderBlocks(parseBlocks(text), slackRenderer);
  return rendered
    .replace(/^[•\-\*]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const slackRenderer: BlockRenderer = {
  code_block: (block) => "```\n" + block.code + "\n```",
  hr: () => "",
  heading: (block) => `*${renderInline(block.content)}*`,
  blockquote: (lines) => lines.map((l) => `> ${renderInline(l)}`).join("\n"),
  ul: (items) => items.map((i) => `- ${renderInline(i)}`).join("\n"),
  ol: (items, start) => items.map((i, idx) => `${start + idx}. ${renderInline(i)}`).join("\n"),
  table: (headers, rows) => renderTable(headers, rows),
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout":
        return attrs.title ? `*${renderInline(attrs.title)}*\n${children}` : children;
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `${value === "yes" ? "✅" : "❌"} ${label}`;
      }
      case "Pill":
        return `[${children.trim()}]`;
      case "Figure":
        return attrs.caption ? `${children}\n${renderInline(attrs.caption)}` : children;
      case "FileRef":
        return children.trim() || renderInline(attrs.path ?? "");
      case "ComparisonTable":
        return children;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        return `${children}: ${meter.value}/${meter.max}`;
      }
      case "Diff":
        return children; // fence-as-is: Slack already renders the ``` code block
      case "FileTree":
        return children; // fence-as-is: the indented-path fence renders verbatim
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children;
        return items.map((it) => `${it.checked ? "☑" : "☐"} ${renderInline(it.text)}`).join("\n");
      }
      case "AnnotatedCode":
        // file line + fence + annotation paragraphs (already in children).
        return attrs.file ? `*${renderInline(attrs.file)}*\n${children}` : children;
      case "CodeTabs":
        // Each Tab child already rendered itself as a `— label —` section.
        return children;
      case "Tab":
        return attrs.label ? `— ${renderInline(attrs.label)} —\n${children}` : children;
      case "Fact":
        // The passage itself is the content; the chip is a reader affordance with
        // no plain-text equivalent worth the noise, so only the verdict glyph rides
        // along. Never drop the passage — it is the article's own prose.
        return `${children}${children.trim() ? ` ${FACT_VERDICT_MARK[normalizeFactVerdict(attrs.v)]}` : ""}`;
      case "FactCheck":
        // The collapsed appendix has no fold here, so it degrades to its summary
        // line followed by the per-claim evidence.
        return `${factCheckSummaryText(attrs)}\n${children}`;
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
        const label = text.trim() || (value === "yes" ? "Yes" : "No");
        return `${value === "yes" ? "✅" : "❌"} ${label}`;
      }
      case "Pill":
        return `[${text.trim()}]`;
      case "Fact":
        return `${text}${text.trim() ? ` ${FACT_VERDICT_MARK[normalizeFactVerdict(attrs.v)]}` : ""}`;
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

/**
 * Tables become labeled bullet lists for Slack.
 *   • *Header1:* val1  *Header2:* val2
 * Single-column tables use simple bullets (• val).
 */
function renderTable(headers: string[], rows: string[][]): string {
  const renderedHeaders = headers.map(renderInline);
  const lines: string[] = [];
  for (const row of rows) {
    if (headers.length === 1) {
      const val = renderInline(row[0] ?? "");
      if (val) lines.push(`• ${val}`);
      continue;
    }
    const parts: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const val = renderInline(row[c] ?? "");
      if (val) parts.push(`*${renderedHeaders[c]!}:* ${val}`);
    }
    if (parts.length > 0) lines.push(`• ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

/**
 * Markdown `*italic*` → mrkdwn `_italic_`. Slack renders a single `*` as BOLD, so
 * without this pass an italic word arrives looking like a second bold word.
 *
 * The rule itself lives in `markdown-core.ts` ({@link RAW_EMPHASIS_SOURCES}) and is
 * built from the same pieces as the email renderer's variant — one home, so the
 * two cannot drift. Slack takes the RAW variant because it escapes nothing before
 * this pass; email takes the entity-aware one. Its strictness is the whole safety
 * story: an earlier, looser version paired two unrelated asterisks across non-word
 * characters and mangled paths, SQL, regexes and bare URLs. See that constant for
 * the measured cases.
 */
const SLACK_ITALIC_RE = new RegExp(RAW_EMPHASIS_SOURCES.italic, "gu");

/** `***x***` → `*_x_*`, rewritten BEFORE both emphasis passes. Without it the
 *  non-greedy `\*\*(.+?)\*\*` bold pass claims the first two stars and leaves the
 *  third dangling. Carries the SAME flanking guards as the italics rule (round 3 —
 *  the unguarded version re-opened every protected case three stars wide), and
 *  whatever it rejects is parked literal by `parkLeftoverStarRuns` below. */
const SLACK_TRIPLE_RE = new RegExp(RAW_EMPHASIS_SOURCES.triple, "gu");

/** The two COMPOSITION shapes, rewritten BEFORE the triple rule and the park —
 *  `**bold *italic***` → `*bold _italic_*` and `***italic* bold**` → `*_italic_ bold*`.
 *  Round 4: their `***` run is a real delimiter with a `**` on its other side, so
 *  the triple rule can't claim it and the park used to swallow it, orphaning the
 *  `**` opener onto the NEXT bold on the line (measured — every following bold
 *  inverted). Same guards as the rules above; see `markdown-core.ts`. */
const SLACK_BOLD_THEN_ITALIC_RE = new RegExp(RAW_EMPHASIS_SOURCES.boldThenItalic, "gu");
const SLACK_ITALIC_THEN_BOLD_RE = new RegExp(RAW_EMPHASIS_SOURCES.italicThenBold, "gu");

function renderInline(text: string): string {
  const ph = new Placeholders();

  // Inline code FIRST — park it before the component scan so a complete
  // component tag inside backticks stays literal code (backticked) instead of
  // being interpreted. The parked sentinel carries no `<`, shielding the code
  // content from the scan below and from the trailing tag-strip.
  let result = text.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `\`${code}\``),
  );

  // Inline components (Verdict, Pill) on the code-shielded text: substitute each
  // occurrence with its plain-text fallback (✅/❌ + label, or [label]) directly
  // into the string. No parking needed — the fallback is plain mrkdwn, so the
  // label rides through the passes below (the trailing tag-strip neutralizes any
  // tag in the label text).
  result = scanInlineComponents(result)
    .map((seg) =>
      seg.kind === "text" ? seg.text : slackRenderer.inlineComponent(seg.name, seg.attrs, seg.text),
    )
    .join("");

  // Markdown links BEFORE the emphasis passes. Slack's link rewrite used to run
  // last, which meant the `**bold**` pass ran over raw link URLs — `[docs](https://
  // ex.com/a**b**c)` came out with a rewritten URL. Only the generated `<url|`
  // and `>` delimiters are parked (sentinels carry no `<`/`>`, so the trailing
  // tag-strip leaves them alone); the LABEL stays in the stream so bold/italics
  // still render inside link text, as they did when this pass ran last.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const target = url.trim();
    if (!LINKABLE_TARGET_RE.test(target)) return label;
    return ph.add("LINKOPEN", `<${target}|`) + label + ph.add("LINKCLOSE", ">");
  });

  // Composition FIRST — `**a *b***` / `***a* b**` mix a two-star and a three-star
  // delimiter, so neither the triple rule nor the bold pass can see them whole,
  // and the park below would claim the `***` half and orphan the `**` half.
  result = result.replace(SLACK_BOLD_THEN_ITALIC_RE, "*$1_$2_*");
  result = result.replace(SLACK_ITALIC_THEN_BOLD_RE, "*_$1_$2*");

  // Triple emphasis BEFORE either single pass — neither can see `***x***` whole.
  result = result.replace(SLACK_TRIPLE_RE, "*_$1_*");

  // …and every 3+ star run the guarded triple rule REJECTED is parked literal
  // here, before the unguardable `\*\*(.+?)\*\*` bold pass can chew on it.
  result = parkLeftoverStarRuns(result, ph);

  // Italics BEFORE the bold rewrite, and both guards are load-bearing (measured on
  // `**b** and *i*`): placed AFTER the bold rewrite, even the `(?<!\*)…(?!\*)`
  // guarded pattern re-reads the just-produced `*b*` and inverts the emphasis.
  result = result.replace(SLACK_ITALIC_RE, "_$1_");
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Claude occasionally emits raw HTML tags; convert the recognised ones to
  // mrkdwn before the catch-all strip below removes them.
  result = result.replace(/<b>(.*?)<\/b>/g, "*$1*");
  result = result.replace(/<i>(.*?)<\/i>/g, "_$1_");
  result = result.replace(/<s>(.*?)<\/s>/g, "~$1~");
  result = result.replace(/<code>(.*?)<\/code>/g, "`$1`");
  result = result.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "<$1|$2>");

  // Park Slack-style links so the next pass doesn't strip them.
  result = result.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
    ph.add("LINK", `<${url}|${label}>`),
  );
  result = result.replace(/<(https?:\/\/[^>]+)>/g, (_m, url: string) =>
    ph.add("LINK", `<${url}>`),
  );

  // Catch-all strip for whatever tag-shaped text is left. `[^>\x00]` is
  // load-bearing: without the NUL exclusion the "tag" body runs THROUGH a
  // placeholder sentinel, so a `<` in a link LABEL swallows the parked `>` and
  // every character up to the next `>` in the document — measured on
  // `[a<b](https://x.com) then more > text`, which lost its trailing prose.
  result = result.replace(/<\/?[^>\x00]+>/g, "");

  return ph.restore(result);
}

/** Plain-text counts line for the `FactCheck` appendix — the platforms with no
 *  disclosure widget render this instead of a collapsed summary strip. Absent or
 *  non-numeric counts are omitted, never rendered as a misleading `0`.
 *
 *  Kept byte-identical to the Telegram twin: counts are DIGITS-ONLY (`Number`
 *  alone reads `1e5` as 100000) and the date is escaped (cosmetic here, but the
 *  two formatters must not drift). */
function factCheckSummaryText(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of ["ok", "warn", "bad", "unknown"] as const) {
    const raw = attrs[key]?.trim();
    if (!raw || !/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n)) parts.push(`${n} ${FACT_COUNT_WORD[key]}`);
  }
  const date = attrs.date?.trim();
  const lead = date ? `Fact-checked ${escapeHtml(date)}` : "Fact-checked";
  return parts.length ? `${lead}: ${parts.join(", ")}` : lead;
}

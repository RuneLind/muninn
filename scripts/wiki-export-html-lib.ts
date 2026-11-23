/**
 * The pure half of `wiki-export-html.ts`: everything after the reader has rendered
 * the page. The browser half captures the article, the dark-theme mermaid SVGs and
 * the stylesheet's rule tree; this file cleans the article for life outside the
 * reader, keeps the CSS rules the page can use, and writes one standalone file.
 *
 * Split so the decisions are unit-tested without a browser: happy-dom parses the
 * captured HTML here through a private `Window` (no globals installed).
 */
import { Window } from "happy-dom";
import { SYSTEM_PALETTES } from "../src/dashboard/views/components/palettes.ts";
import { COMPACT_WORDS, DL_COMPACT_SHOWN, MORE_WORDS } from "../src/format/reader-lens.ts";

/** A stylesheet rule as the browser half serializes it. */
export type RuleNode =
  | { k: "style"; sel: string; css: string }
  | { k: "keep"; css: string }
  | { k: "group"; head: string; kids: RuleNode[] };

/** Reader chrome that means nothing outside muninn: staleness pills and the provenance (session cost) strip. */
export const CHROME_SELECTORS = [
  "#wikiStalePill",
  "#wikiStatusDate",
  ".wiki-stale-pill-slot",
  ".wiki-prov-strip",
  "[data-walkthrough-btn]",
  // The Agent lens swaps the article for the reader's agent pane, which the export does not carry.
  '.wiki-lens-switch [data-lens="agent"]',
  // "Open interactive ↗" on a diagram or embed opens a reader asset the file does not carry.
  "a.dgm-open",
  "a.embed-open",
  ".fact-btn",
  ".wiki-discuss-btn",
];

/** Controls the exported page wires up itself; every other button or field is disabled. */
export const WIRED_CONTROLS = [
  ".wiki-lens-switch [data-lens]",
  ".wiki-count-pill-decisions",
  "section.vc button[data-vc-mode]",
  "button.dl-more",
  "section.decision-log > button.dl-all",
  "button.diagram-expand",
];

const DISABLED_TITLE = "Works in the muninn reader";

/**
 * A selector with the parts that depend on state the export cannot reproduce at
 * capture time removed: the theme and palette attributes on `html`, and dynamic
 * pseudo-classes and pseudo-elements. A rule is kept when either form matches.
 */
export function normalizeSelector(sel: string): string {
  return sel
    .replace(/(html|:root)\[data-(theme|palette)(="[^"]*")?\]/g, "$1")
    .replace(/:not\(\[data-(theme|palette)(="[^"]*")?\]\)/g, "")
    .replace(
      /::?(hover|focus-visible|focus-within|focus|active|visited|target|before|after|marker|placeholder|selection|first-letter|first-line|backdrop|-webkit-[a-z-]+|-moz-[a-z-]+)(\([^)]*\))?/g,
      "",
    )
    .trim();
}

/** Every selector the browser half must test, each style rule's own and its normalized form. */
export function selectorCandidates(tree: readonly RuleNode[]): string[] {
  const out = new Set<string>();
  const walk = (nodes: readonly RuleNode[]) => {
    for (const n of nodes) {
      if (n.k === "style") {
        out.add(n.sel);
        const norm = normalizeSelector(n.sel);
        if (norm) out.add(norm);
      } else if (n.k === "group") walk(n.kids);
    }
  };
  walk(tree);
  return [...out];
}

/** The CSS text of the rules whose selector (or its normalized form) matched; a group survives only with a kept child. */
export function assembleCss(tree: readonly RuleNode[], matched: ReadonlySet<string>): string {
  const keep = (n: RuleNode): string => {
    if (n.k === "keep") return n.css;
    if (n.k === "style") return matched.has(n.sel) || matched.has(normalizeSelector(n.sel)) ? n.css : "";
    const inner = n.kids.map(keep).filter(Boolean).join("\n");
    return inner ? `${n.head}{\n${inner}\n}` : "";
  };
  return tree.map(keep).filter(Boolean).join("\n");
}

/** At-rules whose block holds more rules, parsed into groups; any other block at-rule (keyframes, font-face, …) is kept whole. */
const GROUP_AT_RULES = new Set(["media", "supports", "container", "layer", "scope", "document", "starting-style"]);

/**
 * The stylesheet's rules, cut from its source text. The source and not the CSSOM:
 * Chrome serializes a `var()` shorthand that a later longhand in the same rule
 * overrides as empty longhands (`border-left-color: ;`), which a re-parse drops,
 * so the export lost the Tldr's border and the glossary underline. Handles
 * comments, quoted strings and nested grouping at-rules; statement at-rules
 * (`@charset`, `@import`) are dropped. Assumes no CSS nesting, which the reader
 * CSS does not use.
 */
export function parseCss(src: string): RuleNode[] {
  let i = 0;
  const n = src.length;
  const skipString = () => {
    const q = src[i];
    i++;
    while (i < n && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  const skipComment = () => {
    const end = src.indexOf("*/", i + 2);
    i = end < 0 ? n : end + 2;
  };
  const skipSpace = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i] ?? "")) i++;
      if (src.startsWith("/*", i)) skipComment();
      else return;
    }
  };
  /** Advance to the next top-level `{`, `;` or `}` and return which it was. */
  const readPrelude = (): string => {
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") skipString();
      else if (src.startsWith("/*", i)) skipComment();
      else if (c === "{" || c === ";" || c === "}") return c;
      else i++;
    }
    return "";
  };
  /** From just after a `{`, advance past its matching `}`. */
  const skipBlock = () => {
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '"' || c === "'") skipString();
      else if (src.startsWith("/*", i)) skipComment();
      else {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
    }
  };
  const parseList = (inBlock: boolean): RuleNode[] => {
    const out: RuleNode[] = [];
    while (i < n) {
      skipSpace();
      if (i >= n) break;
      if (src[i] === "}") {
        i++;
        if (inBlock) return out;
        continue;
      }
      const start = i;
      const end = readPrelude();
      if (end !== "{") {
        if (end === ";") i++;
        continue;
      }
      const brace = i;
      i++;
      const prelude = src.slice(start, brace).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const at = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
      if (at && GROUP_AT_RULES.has(at)) {
        const kids = parseList(true);
        if (kids.length) out.push({ k: "group", head: src.slice(start, brace), kids });
      } else {
        skipBlock();
        out.push(at ? { k: "keep", css: src.slice(start, i) } : { k: "style", sel: prelude, css: src.slice(start, i) });
      }
    }
    return out;
  };
  return parseList(false);
}

/** A stylesheet as the browser half sees it: `document.styleSheets` entries. */
export interface SheetLike {
  href: string | null;
  ownerNode: { textContent: string | null } | null;
}

/**
 * Each stylesheet's source text: a linked sheet through `fetchText`, an inline one
 * read from its node. A linked sheet that fails to load (blocked, cross-origin) reads
 * as empty, so it costs its own rules and not the export. Runs in the page
 * (`page.evaluate` of its source), so it is self-contained.
 */
export async function sheetSources(sheets: ArrayLike<SheetLike>, fetchText: (href: string) => Promise<string>): Promise<string[]> {
  return Promise.all(
    Array.from(sheets, (sheet) =>
      sheet.href ? fetchText(sheet.href).catch(() => "") : Promise.resolve(sheet.ownerNode?.textContent ?? ""),
    ),
  );
}

export interface Captured {
  /** `.wiki-article-head` outerHTML. */
  headHtml: string;
  /** `.wiki-article` outerHTML, every `<details>` open and carrying `data-export-was-open`. */
  articleHtml: string;
  /** The mermaid SVGs rendered in the dark theme, in document order. */
  darkSvgs: string[];
}

function parse(html: string) {
  const doc = new Window().document;
  const box = doc.createElement("div");
  box.innerHTML = html;
  return box;
}

/** Rename an SVG id and every id it prefixes (`wm-1_flowchart-…`) but not a longer id (`wm-10`). */
export function renameSvgIds(svg: string, id: string, suffix: string): string {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return svg.replace(new RegExp(`${esc}(?!\\d)`, "g"), `${id}${suffix}`);
}

/**
 * Every outermost SVG set aside before happy-dom parses the article, each replaced
 * by an empty placeholder span. happy-dom (21.0.4) drops everything after a
 * `<style>` inside an `<svg>` (any CSS, even an empty one, also in a nested SVG or
 * a foreignObject), and every mermaid SVG carries one, so parsing the article
 * whole would cut it short. The cleanup's edits inside an SVG are made on the
 * markup: its links ({@link cleanSvgLinks}) and a dark copy's ids ({@link renameSvgIds}).
 */
export function stashMermaid(html: string): { html: string; svgs: string[] } {
  const svgs: string[] = [];
  let out = "";
  let pos = 0;
  const start = /<svg\b/g;
  for (let m = start.exec(html); m; m = start.exec(html)) {
    let depth = 0;
    let end = -1;
    const tag = /<svg\b|<\/svg>/g;
    tag.lastIndex = m.index;
    for (let t = tag.exec(html); t; t = tag.exec(html)) {
      depth += t[0] === "</svg>" ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    if (end < 0) break;
    out += html.slice(pos, m.index) + `<span data-export-svg="${svgs.length}"></span>`;
    svgs.push(html.slice(m.index, end));
    pos = end;
    start.lastIndex = end;
  }
  return { html: out + html.slice(pos), svgs };
}

/** Put stashed SVGs back, each through `render` (index, svg) → markup. */
export function restoreMermaid(html: string, svgs: readonly string[], render: (i: number, svg: string) => string = (_i, s) => s): string {
  return html.replace(/<span data-export-svg="(\d+)"><\/span>/g, (whole, n) => {
    const svg = svgs[Number(n)];
    return svg === undefined ? whole : render(Number(n), svg);
  });
}

/** What the export does with a link: keep it (in-page), open it in a new tab (external), or turn it to text (into the local reader). */
export function linkFate(href: string): "keep" | "external" | "dead" {
  if (href.startsWith("#")) return "keep";
  if (/^https?:\/\//.test(href) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(href)) return "external";
  return "dead";
}

/**
 * {@link linkFate} applied to the `<a>` tags of an SVG's markup, which happy-dom
 * cannot parse (see {@link stashMermaid}): a SystemMap node links to its page.
 */
export function cleanSvgLinks(svg: string): string {
  return svg.replace(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (tag, attrs: string) => {
    const href = /\s(?:xlink:)?href="([^"]*)"/.exec(attrs)?.[1];
    if (href === undefined) return tag;
    const fate = linkFate(href);
    if (fate === "keep") return tag;
    const rest = attrs.replace(/\s+(?:xlink:href|href|target|rel)="[^"]*"/g, (m) => (fate === "external" && /^\s+(?:xlink:)?href=/.test(m) ? m : ""));
    return fate === "external" ? `<a${rest} target="_blank" rel="noopener">` : `<a${rest} data-export-dead="">`;
  });
}

/**
 * The article made fit for life outside the reader: chrome removed, links into the
 * local reader turned to text, each mermaid diagram paired with its dark render,
 * folds back to their authored state, and controls nothing drives disabled.
 */
export function cleanExport(c: Captured): { headHtml: string; articleHtml: string } {
  const stashed = stashMermaid(c.headHtml + c.articleHtml);
  const svgs = stashed.svgs.map(cleanSvgLinks);
  const box = parse(stashed.html);
  for (const sel of CHROME_SELECTORS) box.querySelectorAll(sel).forEach((e) => e.remove());

  box.querySelectorAll("a[href]").forEach((a) => {
    const fate = linkFate(a.getAttribute("href") ?? "");
    if (fate === "keep") return;
    if (fate === "external") {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else {
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      a.setAttribute("data-export-dead", "");
    }
  });

  // An embedded reader page is served by the dashboard; the file cannot carry it.
  box.querySelectorAll("iframe[src]").forEach((f) => {
    if (linkFate(f.getAttribute("src") ?? "") !== "dead") return;
    const note = f.ownerDocument.createElement("p");
    note.className = "export-embed-note";
    const title = f.getAttribute("title");
    note.textContent = `Embedded page${title ? ` “${title}”` : ""}: open it in the muninn reader.`;
    f.replaceWith(note);
  });

  box.querySelectorAll("details[data-export-was-open]").forEach((d) => {
    if (d.getAttribute("data-export-was-open") === "1") d.setAttribute("open", "");
    else d.removeAttribute("open");
    d.removeAttribute("data-export-was-open");
  });

  // The reader paints each Steps bar an opaque fill computed for the theme it was
  // drawn in (`paintStepsBar`); without it the reader's CSS fallback, the pane's fill, applies in both themes.
  box.querySelectorAll("section.stp > .stp-ctrl").forEach((bar) => {
    // happy-dom drops the emptied style attribute itself.
    (bar as unknown as HTMLElement).style.removeProperty("background-color");
  });

  // The page scrolls, not the article pane as in the reader, so the shell clips
  // sideways overflow (a scroll container would unstick the Steps bar) and each
  // bare table scrolls in its own box instead.
  box.querySelectorAll("table").forEach((t) => {
    const parent = t.parentElement;
    if (!parent || parent.matches(".tablewrap, .dt-wrap, .query-table-wrap") || parent.closest("table")) return;
    const scroll = t.ownerDocument.createElement("div");
    scroll.className = "export-scroll";
    parent.insertBefore(scroll, t);
    scroll.append(t);
  });

  const wired = WIRED_CONTROLS.join(", ");
  box.querySelectorAll("button, input, textarea, select").forEach((el) => {
    if (el.matches(wired)) return;
    el.setAttribute("disabled", "");
    if (!el.getAttribute("title")) el.setAttribute("title", DISABLED_TITLE);
  });

  // Each mermaid diagram beside its dark render (the k-th `wm-` SVG of each pass). The
  // dark copy is renamed by its OWN id: the passes number diagrams from a per-draw
  // counter that can skip, so the two copies of one diagram need not share an id.
  const isMermaid = (svg: string) => /^<svg\b[^>]*\bid="wm-/.test(svg);
  const mermaidOrdinal = new Map<number, number>();
  svgs.forEach((svg, i) => {
    if (isMermaid(svg)) mermaidOrdinal.set(i, mermaidOrdinal.size);
  });
  const pair = (i: number, light: string) => {
    const k = mermaidOrdinal.get(i);
    const dark = k === undefined ? undefined : cleanSvgLinks(c.darkSvgs[k] ?? "");
    if (!dark) return light;
    const darkId = /^<svg\b[^>]*\bid="([^"]+)"/.exec(dark)?.[1] ?? "";
    return `<div class="export-mm"><div class="export-mm-light">${light}</div><div class="export-mm-dark">${renameSvgIds(dark, darkId, "-dark")}</div></div>`;
  };
  const head = box.querySelector(".wiki-article-head");
  const article = box.querySelector(".wiki-article");
  return {
    headHtml: restoreMermaid(head?.outerHTML ?? "", svgs, pair),
    articleHtml: restoreMermaid(article?.outerHTML ?? "", svgs, pair),
  };
}

/**
 * Copies of the article in each state the exported page's script can switch to, so
 * the CSS for those states survives pruning: charts in table mode, decisions
 * expanded, every decision shown, folds flipped, and the Overview lens.
 */
export function stateVariants(articleHtml: string): string[] {
  const stashed = stashMermaid(articleHtml);
  articleHtml = stashed.html;
  const states = parse(articleHtml);
  states.querySelectorAll("section.vc").forEach((e) => e.classList.add("vc-mode-table"));
  states.querySelectorAll(".dl-item").forEach((e) => e.classList.add("dl-expanded"));
  states.querySelectorAll("section.decision-log").forEach((e) => e.classList.add("lens-show-all"));
  states.querySelectorAll("details").forEach((d) => (d.hasAttribute("open") ? d.removeAttribute("open") : d.setAttribute("open", "")));
  const lens = (l: string) => {
    const b = parse(articleHtml);
    const art = b.querySelector(".wiki-article");
    if (art) art.className = `${art.className.replace(/\blens-[a-z]+\b/g, "").trim()} lens-${l}`;
    return b.innerHTML;
  };
  return [states.innerHTML, lens("overview")].map((h) => restoreMermaid(h, stashed.svgs));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type ExportLang = keyof typeof MORE_WORDS;
export interface ExportLabels {
  more: string;
  less: string;
  showNewest: string;
  /** "Show all N decisions" around N: the script counts each log's decisions. */
  showAll: [before: string, after: string];
}

/** The labels the exported script writes, from the reader's own word tables. */
export function exportLabels(lang: ExportLang): ExportLabels {
  const n = 987654321;
  const [before = "", after = ""] = COMPACT_WORDS[lang].showAll(n).split(String(n));
  return { more: MORE_WORDS[lang].more, less: MORE_WORDS[lang].less, showNewest: COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN), showAll: [before, after] };
}

export interface StandaloneInput {
  title: string;
  description: string;
  css: string;
  headHtml: string;
  articleHtml: string;
  /** `<wiki>/<relPath>`, for the generator meta and the footer. */
  source: string;
  /** ISO date of the export. */
  date: string;
  /** The wiki's reader language; labels and `<html lang>` follow it. Default `en`. */
  lang?: ExportLang;
}

/** The theme button's cycle. The reader's warm palettes ride on `data-palette`; "Auto" clears both attributes so the OS media query picks them. */
export const THEME_MODES: ReadonlyArray<readonly [theme: string, palette: string, label: string]> = [
  ["", "", "◐ Auto"],
  ["light", SYSTEM_PALETTES.light, "☀ Light"],
  ["dark", SYSTEM_PALETTES.dark, "☾ Dark"],
];

/** The standalone document: pruned reader CSS, a centered card, the theme button and the controls' script. */
export function buildStandaloneHtml(o: StandaloneInput): string {
  const lang = o.lang ?? "en";
  const script = exportScript(exportLabels(lang));

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<meta name="generator" content="muninn scripts/wiki-export-html.ts from ${escapeHtml(o.source)}">
<style>
${o.css}
/* --- standalone shell --- */
html, body { margin: 0; }
body { background: var(--bg-page); }
.export-shell { max-width: 1000px; margin: 24px auto 64px; background: var(--bg-panel);
  border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; }
.export-shell > .wiki-article-wrap { overflow-x: clip; height: auto; padding: 24px 32px; }
/* The table's own 12px margin (reader rule .wiki-article table) moves to its scroll box. */
.export-scroll { overflow-x: auto; margin: 12px 0; }
.export-scroll > table { margin: 0 !important; }
.diagram:fullscreen { background: var(--bg-panel); overflow: auto; padding: 24px; }
@media (max-width: 720px) {
  .export-shell { margin: 0; border-radius: 0; border: 0; }
  .export-shell > .wiki-article-wrap { padding: 16px; }
}
.export-shell a[data-export-dead] { color: inherit !important; text-decoration: none !important; border-bottom: 0 !important; pointer-events: none; }
.export-embed-note { margin: 0; padding: 12px 16px; border: 1px dashed var(--border, rgba(127,127,127,.35)); border-radius: 8px; opacity: .8; }
.export-mm-dark { display: none; }
html[data-theme="dark"] .export-mm-light { display: none; }
html[data-theme="dark"] .export-mm-dark { display: block; }
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) .export-mm-light { display: none; }
  html:not([data-theme="light"]) .export-mm-dark { display: block; }
}
.export-theme { position: fixed; bottom: 16px; right: 16px; z-index: 10; font: inherit; font-size: 13px;
  padding: 4px 10px; border-radius: 999px; cursor: pointer; color: inherit;
  background: var(--bg-panel); border: 1px solid var(--border, rgba(127,127,127,.35)); }
.export-foot { max-width: 1000px; margin: -48px auto 32px; padding: 0 16px; font-size: 12px; opacity: .65; }
</style>
</head>
<body>
<button class="export-theme" type="button" title="Theme: follow system, light, dark">◐ Auto</button>
<div class="export-shell"><div class="wiki-article-wrap">
${o.headHtml}
${o.articleHtml}
</div></div>
<p class="export-foot">Exported ${escapeHtml(o.date)} from ${escapeHtml(o.source)}.</p>
<script>
${script}
</script>
</body>
</html>
`;
}



/** The exported page's script: theme cycle, lens switch, chart mode, decision expand and show-all, in-page links, diagram full-window. */
export function exportScript(labels: ExportLabels): string {
  return `(() => {
  const root = document.documentElement;
  const btn = document.querySelector(".export-theme");
  const modes = ${JSON.stringify(THEME_MODES)};
  let i = 0;
  btn?.addEventListener("click", () => {
    i = (i + 1) % modes.length;
    const [theme, palette, label] = modes[i];
    if (theme) { root.setAttribute("data-theme", theme); root.setAttribute("data-palette", palette); }
    else { root.removeAttribute("data-theme"); root.removeAttribute("data-palette"); }
    btn.textContent = label;
  });
  const openTo = (el) => { for (let e = el; e; e = e.parentElement) if (e.tagName === "DETAILS") e.open = true; };
  const art = document.querySelector(".wiki-article");
  document.querySelectorAll(".wiki-lens-switch [data-lens]").forEach((b) => b.addEventListener("click", () => {
    art.className = art.className.replace(/\\blens-[a-z]+\\b/g, "").trim() + " lens-" + b.dataset.lens;
    document.querySelectorAll(".wiki-lens-switch [data-lens]").forEach((o) => {
      const on = o === b; o.classList.toggle("on", on); o.setAttribute("aria-pressed", String(on));
    });
  }));
  document.querySelectorAll("section.vc button[data-vc-mode]").forEach((b) => b.addEventListener("click", () => {
    b.closest("section.vc").classList.toggle("vc-mode-table", b.dataset.vcMode === "table");
    b.closest(".vc-group")?.querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
  }));
  const labels = ${JSON.stringify(labels)};
  // The reader's setExpanded and setAllShown (wiki-lens.ts), both labels from its word tables.
  const setExpanded = (item, on) => {
    item.classList.toggle("dl-expanded", on);
    const b = item.querySelector(":scope > .dl-text > .dl-more");
    if (!b) return;
    b.textContent = on ? labels.less : labels.more;
    b.setAttribute("aria-expanded", String(on));
  };
  const setAllShown = (section, on) => {
    section.classList.toggle("lens-show-all", on);
    const b = section.querySelector(":scope > .dl-all");
    if (!b) return;
    const n = section.querySelectorAll(".dl-item.dl-decision").length;
    b.textContent = on ? labels.showNewest : labels.showAll[0] + n + labels.showAll[1];
    b.setAttribute("aria-expanded", String(on));
  };
  document.querySelectorAll("button.dl-more").forEach((b) => b.addEventListener("click", () => {
    const item = b.closest(".dl-item");
    setExpanded(item, !item.classList.contains("dl-expanded"));
  }));
  document.querySelectorAll("section.decision-log > button.dl-all").forEach((b) => b.addEventListener("click", () => {
    setAllShown(b.parentElement, !b.parentElement.classList.contains("lens-show-all"));
  }));
  document.querySelectorAll("button.diagram-expand").forEach((b) => b.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen(); else b.closest(".diagram")?.requestFullscreen?.();
  }));
  const pill = document.querySelector(".wiki-count-pill-decisions");
  const log = document.querySelector(".decision-log");
  if (pill && log) pill.addEventListener("click", () => { openTo(log); log.scrollIntoView({ behavior: "smooth", block: "start" }); });
  document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener("click", () => {
    const t = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (!t) return;
    openTo(t);
    // As the reader's reveal: a decision, or anything in its rest, shows the whole
    // item, and an older decision shows its whole log.
    const item = t.closest(".dl-item[id]");
    if (item?.querySelector(":scope > .dl-text > .dl-more")) setExpanded(item, true);
    const section = t.closest(".dl-older")?.closest("section.decision-log");
    if (section) setAllShown(section, true);
  }));
})();`;
}


/**
 * What in the written file would not work from disk: a stylesheet `<link>`, and any
 * `src`/`href`-like attribute that is not in-page, external, `data:`, `mailto:` or
 * `tel:` (an external script counts too). Attributes, not text, so prose that quotes
 * markup and `data-*` attributes never count. Each problem as `<tag attr="value">`.
 * Runs in the page (`page.evaluate` of its source), so it is self-contained.
 */
export function selfCheck(doc: Document): string[] {
  const ATTRS = ["href", "xlink:href", "src", "srcset", "poster", "action", "formaction", "data"];
  const fine = (v: string) =>
    /^(#|data:|mailto:|tel:)/.test(v) || (/^https?:\/\//.test(v) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(v));
  const out: string[] = [];
  doc.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    for (const name of ATTRS) {
      const v = el.getAttribute(name);
      if (v === null) continue;
      if (tag === "link" || (tag === "script" && name === "src") || !fine(v.trim())) out.push(`<${tag} ${name}="${v}">`);
    }
  });
  return out;
}

export interface CliArgs {
  wiki: string;
  relPath: string;
  out: string;
  base: string;
}

/** `<wiki> <relPath> <out.html>` with `--base <url>` anywhere; null on a missing or extra argument. */
export function parseCliArgs(argv: readonly string[]): CliArgs | null {
  const args = [...argv];
  let base = "http://localhost:3010";
  const at = args.indexOf("--base");
  if (at >= 0) {
    const value = args[at + 1];
    if (!value || value.startsWith("--")) return null;
    base = value.replace(/\/+$/, "");
    args.splice(at, 2);
  }
  const [wiki, relPath, out] = args;
  if (args.length !== 3 || !wiki || !relPath || !out) return null;
  return { wiki, relPath, out, base };
}

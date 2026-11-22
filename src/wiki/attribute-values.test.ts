import { describe, expect, test } from "bun:test";
import { COMPONENT_NAMES, COMPONENT_SPEC, SELF_CLOSING_ALLOWED, type AttrSpec, type ComponentName } from "../format/component-spec.ts";
import type { PageFileResult, PageFiles } from "../format/query-block.ts";
import { renderAskAnswerHtml } from "./ask-render.ts";
import { diagramSvgFromHtml } from "./diagram-svg.ts";
import { questionRenderOptionsFor, renderWikiHtml } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";

/**
 * F58 (architecture review 2026-11-16): the finished-HTML passes after the
 * render (glossary marks, line-ref chips, callout upgrades, paragraph gaps, the
 * sentinel restores) split and rewrite the page as a string, so each needs
 * every attribute value to hold no raw `<`, `>` or `"`. One page per component,
 * setup and hostile fill goes through `renderWikiHtml` (views on and off) and
 * `renderAskAnswerHtml`; the output is parsed quote-aware, and a tag that does
 * not parse, a value holding `<` or `>`, a raw `<` in text, a NUL, an `on*` or
 * `data-pwn` attribute, or an element the same setup never renders with a
 * benign fill fails.
 *
 * Each component renders under its `hostile` setup (the fill in every
 * attribute: the fallback paths) and under setups that walk each enumerated
 * or typed attribute through its valid values while the fill sits in every
 * free-text attribute, the body and the sibling files of the type the
 * component reads, so the real views render (`the real views render` pins it).
 */

const F53_FILL = `[x](https://example.com/**b**_e_/file.ts:12)`;
const F55_FILL = "**bold** _em_ `code` [1] Hold";
const F56_FILL = "x\n\ny";
const F29_FILL = "<Pill>p</Pill>INLINE0`c`";
/** What every hostile render is compared with: the same setup's elements. */
const BENIGN_FILL = "Benign Hold";

const FILLS = [
  // F26: a `>` and markup in an id, with a glossary term after the `>` and without.
  `Q-1>Hold <img src=x data-pwn onerror=alert(1)>`,
  `Q-1><img src=x data-pwn onerror=alert(1)>`,
  // A raw quote that would close the value and add attributes.
  `x" onmouseover="alert(1)" data-pwn="1`,
  // F57: a wikilink typed as the value.
  `[[Hostile Page]]`,
  `[[Hostile Page|Q 2 > x]]`,
  `a<b>c</b> & 'd' &quot;e&quot;`,
  `see [x](https://example.com/a>b) L12 file.ts:12`,
  `Q-16`,
  F55_FILL,
  F53_FILL,
  F56_FILL,
  F29_FILL,
] as const;

type Mode = "views" | "plain" | "ask";
const MODES: Mode[] = ["views", "plain", "ask"];

// ── Setups ──────────────────────────────────────────────────────────────────

/** A value per setup: a string, the fill made into one, or absent. */
type Val = string | ((fill: string) => string) | undefined;

/** One way to write the component: each attribute's value (absent ones
 *  omitted) and, for Chart, the table it wraps. */
interface Setup {
  name: string;
  attrs: Record<string, Val>;
  table?: (fill: string) => string[];
}

const typedValue = (spec: AttrSpec): string | undefined =>
  spec.type === "iso-date" || spec.type === "date" ? "2026-10-01" : spec.type === "number" ? "3" : spec.type === "positive-number" ? "5" : undefined;

/**
 * The values a valid setup cycles through for an attribute the spec calls
 * text but a renderer checks (a path, a list grammar, a switch). An attribute
 * absent here and in the spec's `enum`/`type` is free text: it takes the fill.
 */
const VALID: Partial<Record<ComponentName, Record<string, readonly Val[]>>> = {
  Callout: { resolved: [undefined, "2026-10-01"] },
  Fact: { n: ["1"] },
  FactCheck: { date: ["2026-10-01"], ok: ["2"], warn: ["1"], bad: ["1"], unknown: ["1"] },
  Embed: { src: ["x.html", "sub/x.html"], height: ["400", undefined] },
  Fold: { open: ["true", undefined], for: [undefined, "dev", "agent"] },
  AnnotatedCode: { lang: ["ts", (f) => f] },
  Lane: { role: [undefined] },
  Query: { csv: ["q.csv"], sql: ["q.sql"], run: ["2026-10-01"] },
  CaseBoard: { src: ["cases.yaml"], labels: [(f) => `hold:${f},wait:${f}`, undefined] },
  DeltaTable: { src: ["runs.csv", "runs.csv", undefined], better: ["lower", "higher", (f) => `${f}=lower`], decimal: ["dot", "comma", undefined] },
  StatusRows: { tones: [(f) => `Status=good;${f}=warn`, "Status=info;Owner=muted"] },
  Diagram: { src: ["x.architecture.json", "x.workflow.json", "x.lifecycle.json"] },
  Steps: { src: ["x.lifecycle.json", "x.architecture.json"] },
  Check: { env: ["FOO_BAR"], migration: ["086"], checkout: ["muninn"], pushed: ["muninn"], restart: ["3010"], on: ["mini"] },
};

/** Chart: one setup per kind over a table that kind reads. The column
 *  attributes name plain headers (a fill there is a missing column, the
 *  table fallback the hostile setup covers); the fill is the caption and the
 *  first-column labels. */
const CHART_SETUPS: Setup[] = ([
  {
    name: "gap",
    attrs: { kind: "gap", value: "Value", target: "Target", gap: "Gap", mark: "Mark" },
    table: (f) => ["| Item | Value | Target | Gap | Mark |", "|---|---|---|---|---|", `| ${f} | 3 | 5 | 2 | 4 |`, "| B | 1 | 2 | 1 | 1 |"],
  },
  {
    name: "gate",
    attrs: { kind: "gate", bar: "Bar", pass: "Pass", hold: "Hold" },
    table: (f) => ["| Item | Bar | Pass | Hold |", "|---|---|---|---|", `| ${f} | 5 | 6 | 1 |`, "| B | 5 | 4 | 2 |"],
  },
  {
    name: "steps",
    attrs: { kind: "steps", x: "Step", ref: "Base", normalize: "none" },
    table: (f) => ["| Step | A | B |", "|---|---|---|", "| Base | 10 | 20 |", `| ${f} | 5 | 6 |`, "| C | 7 | 8 |"],
  },
  {
    name: "steps-ref",
    attrs: { kind: "steps", x: "Step", ref: "Base", normalize: "ref" },
    table: (f) => ["| Step | A | B |", "|---|---|---|", "| Base | 10 | 20 |", `| ${f} | 5 | 6 |`, "| C | 7 | 8 |"],
  },
  {
    name: "funnel",
    attrs: { kind: "funnel", value: "Count" },
    table: (f) => ["| Stage | Count | Of |", "|---|---|---|", "| All | 10 | |", `| ${f} | 5 | 10 |`, "| C | 2 | 5 |"],
  },
  {
    name: "bars",
    attrs: { kind: "bars", value: "Count" },
    table: (f) => ["| Item | Count |", "|---|---|", `| ${f} | 5 |`, "| B | 3 |"],
  },
  {
    name: "range",
    attrs: { kind: "range", value: "Range" },
    table: (f) => ["| Item | Range |", "|---|---|", `| ${f} | 1–3 |`, "| B | 2–4 |"],
  },
] satisfies Setup[]).map((s) => ({ ...s, attrs: { ...s.attrs, caption: (f: string) => f } }));

/** Every attribute the fill: the renderer's fallbacks. */
const hostileSetup = (name: ComponentName): Setup => ({
  name: "hostile",
  attrs: Object.fromEntries(Object.keys(COMPONENT_SPEC[name].attrs).map((a) => [a, (f: string) => f])),
});

/** The valid setups: setup k gives each enumerated or checked attribute its
 *  k-th valid value (cycling), each typed one a valid value, the rest the fill. */
function validSetups(name: ComponentName): Setup[] {
  if (name === "Chart") return CHART_SETUPS;
  const specs = Object.entries(COMPONENT_SPEC[name].attrs) as [string, AttrSpec][];
  const valuesOf = (a: string, spec: AttrSpec): readonly Val[] =>
    VALID[name]?.[a] ?? spec.enum ?? (typedValue(spec) !== undefined ? [typedValue(spec)] : [(f: string) => f]);
  const n = Math.max(1, ...specs.map(([a, s]) => valuesOf(a, s).length));
  return Array.from({ length: n }, (_, k) => ({
    name: `valid-${k}`,
    attrs: Object.fromEntries(specs.map(([a, s]) => {
      const vs = valuesOf(a, s);
      return [a, vs[k % vs.length]];
    })),
  }));
}

const setupsFor = (name: ComponentName): Setup[] => (Object.keys(COMPONENT_SPEC[name].attrs).length ? [hostileSetup(name), ...validSetups(name)] : validSetups(name));

// ── Pages ───────────────────────────────────────────────────────────────────

// One target resolves (a live link); every other one is a missing link.
const pages = (target: string): WikiPageMeta | undefined =>
  target.trim() === "Hostile Page" ? ({ name: "Hostile Page", relPath: `plans/h"<x>.mdx`, title: "Hostile" } as WikiPageMeta) : undefined;

const yamlString = (s: string) => JSON.stringify(s);
const htmlEscape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The diagram files, each kind carrying the fill in every text field. */
function diagramJson(file: string, fill: string): string {
  const views = [{ id: "v1", label: fill, focus: ["a"], note: fill }, { id: "v2", label: "Two", focus: ["b"], note: "" }];
  if (file.endsWith(".architecture.json")) {
    return JSON.stringify({
      meta: { title: fill, views, legend: { entries: { backend: { label: fill } } } },
      components: [{ id: "a", label: fill, sublabel: fill, type: "backend" }, { id: "b", label: "B", type: "database" }],
      connections: [{ from: "a", to: "b", label: fill }],
      boundaries: [{ kind: "zone", label: fill, wraps: ["a", "b"] }],
    });
  }
  if (file.endsWith(".workflow.json")) {
    return JSON.stringify({
      meta: { title: fill, views },
      lanes: [{ id: "l1", label: fill }],
      nodes: [{ id: "a", label: fill, lane: "l1" }, { id: "b", label: "B", lane: "l1" }],
      edges: [{ from: "a", to: "b", label: fill }],
      groups: [{ id: "g", lane: "l1", label: fill, from: "a", to: "b" }],
    });
  }
  return JSON.stringify({
    meta: { title: fill, views },
    states: [{ id: "a", label: fill, sublabel: fill }, { id: "b", label: "B" }],
    transitions: [{ from: "a", to: "b", label: fill }],
  });
}

/** The sanitized picture of each fill's diagram, as the loader hands it over. */
const SVGS = new Map(
  await Promise.all(
    [...FILLS, BENIGN_FILL].map(async (fill) => {
      const e = htmlEscape(fill);
      const html = `<!doctype html><body><svg viewBox="0 0 100 100"><g data-node-id="a" aria-label="${e}"><rect width="5" height="5"></rect><text x="1" y="10">${e}</text></g><g data-node-id="b"><text x="1" y="30">B</text></g></svg></body>`;
      return [fill, await diagramSvgFromHtml(html)] as const;
    }),
  ),
);

/** The page's sibling files, each of the type its component reads, with the
 *  fill in every field it has. */
function files(fill: string): PageFiles {
  const yaml = [
    `- id: ${yamlString(fill)}`,
    `  status: ${yamlString(fill)}`,
    `  owner: ${yamlString(fill)}`,
    `  note: ${yamlString(fill)}`,
    `  kort: ${yamlString(fill)}`,
    `  refs: [${yamlString(fill)}]`,
    ...["hold", "wait", "wrong", "none", "ok"].flatMap((s, i) => [`- id: ${String.fromCharCode(66 + i)}`, `  status: ${s}`, `  owner: ${yamlString(fill)}`, `  kort: ${yamlString(fill)}`]),
  ].join("\n");
  const cell = `"${fill.replaceAll('"', '""')}"`;
  return {
    get(ref: string): PageFileResult | undefined {
      if (ref.endsWith(".yaml")) return { ok: true, text: yaml };
      if (ref.endsWith(".csv")) return { ok: true, text: `Run,${cell},n\n${cell},1.5,3\nb,2.5,4\n` };
      if (ref.endsWith(".sql")) return { ok: true, text: `select '${fill}'` };
      if (ref.endsWith(".json")) return { ok: true, text: diagramJson(ref, fill), svg: SVGS.get(fill)! };
      return { ok: false, reason: "unavailable" };
    },
  };
}

function attrText(setup: Setup, fill: string): string {
  return Object.entries(setup.attrs)
    .flatMap(([a, v]) => {
      const s = typeof v === "function" ? v(fill) : v;
      return s === undefined ? [] : [`${a}="${s}"`];
    })
    .join(" ");
}

function body(name: ComponentName, fill: string, setup: Setup): string[] {
  if (setup.table) return setup.table(fill);
  switch (name) {
    case "Timeline":
    case "Tldr":
    case "RunChecklist":
    case "Checklist":
    case "RuleTree":
      return [`- **D1** — ${fill}`, `- **Q-1** — ${fill} 2026-10-01`, `  - nested ${fill}`];
    case "DecisionLog":
      // The fill as an item id too, the shape a Question's grid row reads.
      return [`- **D1** — ${fill}`, `- **Q-1** — ${fill} 2026-10-01`, `  - nested ${fill}`, `- **${fill}** — Hold it?`];
    case "StatusRows":
      return ["- **Status:** open", `- **Owner:** ${fill}`, `- **${fill}:** ${fill}`];
    case "Chart":
    case "ComparisonTable":
    case "SystemMap":
      return ["| From | To | Status |", "|---|---|---|", `| ${fill} | B | ok |`, "| B | C | 2 |"];
    case "DeltaTable":
      return ["| Run | A | B |", "|---|---|---|", `| ${fill} | 1 | 2 |`, "| b | 3 | 4 |"];
    case "Glossary":
      return [`- **Hold** — ${fill}`];
    case "CodeTabs":
      return [`<Tab label="${fill}">`, "", "```ts", fill, "```", "", "</Tab>"];
    case "NextMoves":
      return [`<Lane kind="waiting" who="${fill}" since="2026-10-01">`, "", `- ${fill} **O16**`, "", "</Lane>"];
    case "Query":
      return ["```sql", `select '${fill}'`, "```", "", fill];
    case "Steps":
      return [`1. ${fill} \`a\``, `2. Then ${fill} \`b\``];
    default:
      return [`Text ${fill} with Hold.`, "", `- item ${fill}`];
  }
}

function block(name: ComponentName, fill: string, setup: Setup): string[] {
  const attrs = attrText(setup, fill);
  const open = `<${name}${attrs ? ` ${attrs}` : ""}`;
  if (name === "Check") return [`- run it ${open} />`];
  if (name === "Lane") return ["<NextMoves>", "", `${open}>`, "", `- ${fill} **O17**`, "", `</${name}>`, "", "</NextMoves>"];
  if (name === "Tab") return ["<CodeTabs>", "", `${open}>`, "", "```ts", fill, "```", "", `</${name}>`, "", "</CodeTabs>"];
  // Steps and DeltaTable read a body when written; the rest self-close.
  if (SELF_CLOSING_ALLOWED.has(name) && name !== "Steps" && name !== "DeltaTable") return [`${open} />`];
  return [`${open}>`, "", ...body(name, fill, setup), "", `</${name}>`];
}

/** The page around the block: a StatusRows slot, three plain questions the
 *  DecisionLog names (so the grid draws), a line ref and a Glossary the text
 *  uses. Only a Question page names the fill in the log (its grid row): any
 *  other page holds the fill only where its component puts it. */
function page(name: ComponentName, fill: string, setup: Setup = hostileSetup(name)): string {
  return [
    "---",
    "title: Hostile",
    "type: plan",
    "code_at: abc1234",
    "---",
    "",
    "# Hostile",
    "",
    "<StatusRows>",
    "",
    "- **Status** — open",
    "",
    "</StatusRows>",
    "",
    ...block(name, fill, setup),
    "",
    ...["O16", "O17", "O18"].flatMap((id) => [`<Question id="${id}">`, "", "Hold it?", "", "</Question>", ""]),
    "We Hold the line in file.ts:12.",
    "",
    "<DecisionLog>",
    "",
    "- **D1** — Decided.",
    "- **O16** — Hold it?",
    "- **O17** — Hold it?",
    "- **O18** — Hold it?",
    ...(name === "Question" ? [`- **${fill}** — Hold it?`] : []),
    "",
    "</DecisionLog>",
    "",
    "<Glossary>",
    "",
    "- **Hold** — kept back",
    "",
    "</Glossary>",
    "",
  ].join("\n");
}

function render(md: string, mode: Mode, fill: string): string {
  if (mode === "ask") {
    return renderAskAnswerHtml(`${md}\nSee [1] and [2].\n`, [
      { n: 1, pageName: "Hostile", pageRelPath: "plans/h.mdx", title: fill } as never,
      { n: 2, pageName: fill, title: fill } as never,
    ]);
  }
  return renderWikiHtml(md, pages, {
    stripTitle: "Hostile",
    wiki: "w",
    files: files(fill),
    question: questionRenderOptionsFor(md, null, true, "Owner Person"),
    today: "2026-11-22",
    ...(mode === "views" ? { views: true, readerShapes: true } : {}),
  });
}

// ── The scanner ─────────────────────────────────────────────────────────────

const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/y;
const ATTR_RE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
const RAW_TEXT = new Set(["script", "style"]);

type ViolationKind = "nul" | "unparsable" | "raw-lt" | "value-lt-gt" | "injected-attr" | "injected-element";

/** One break of the contract: what, on which element (name and `class`) and
 *  which attribute, and the page from there on. */
interface Violation {
  kind: ViolationKind;
  tag: string;
  cls: string;
  attr: string;
  /** The attribute's value, or for a NUL the text around it. */
  value: string;
  at: string;
}

const show = (v: Violation) => `${v.kind} <${v.tag}${v.cls ? `.${v.cls.split(/\s+/)[0]}` : ""}>${v.attr ? `[${v.attr}]` : ""} ${JSON.stringify(v.value.slice(0, 80))} at ${v.at.slice(0, 200)}`;

interface Scan {
  violations: Violation[];
  /** Every element name the page opens. */
  elements: Set<string>;
}

/** Every place `html` breaks the attribute contract, every NUL included. */
export function scanHtml(html: string): Scan {
  const violations: Violation[] = [];
  const elements = new Set<string>();
  const add = (kind: ViolationKind, i: number, tag = "", cls = "", attr = "", value = "") =>
    violations.push({ kind, tag, cls, attr, value, at: html.slice(i, i + 400) });
  // The element open at each NUL: the last open tag before it.
  let lastOpen = { tag: "", cls: "" };
  let nulFrom = 0;
  const nulsUpTo = (end: number) => {
    for (let k = html.indexOf("\0", nulFrom); k >= 0 && k < end; k = html.indexOf("\0", k + 1)) add("nul", Math.max(0, k - 80), lastOpen.tag, lastOpen.cls, "", html.slice(Math.max(0, k - 40), k + 41));
    nulFrom = Math.max(nulFrom, end);
  };
  for (let i = html.indexOf("<"); i >= 0; i = html.indexOf("<", i)) {
    nulsUpTo(i);
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) {
      const head = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(i, i + 64));
      if (head) {
        // The attribute whose value the tag breaks in: the last `name="` before
        // the first `<` inside the tag.
        const rest = html.slice(i + 1, i + 2000);
        const cut = rest.indexOf("<");
        const before = cut < 0 ? rest : rest.slice(0, cut);
        const attr = [...before.matchAll(/\s([^\s"'<>/=]+)="/g)].at(-1)?.[1] ?? "";
        const cls = /\sclass="([^"<]*)"/.exec(before)?.[1] ?? "";
        add("unparsable", i, head[1]!.toLowerCase(), cls, attr);
      } else add("raw-lt", i, lastOpen.tag, lastOpen.cls);
      i++;
      continue;
    }
    const name = m[1]!.toLowerCase();
    const closing = m[0].startsWith("</");
    const attrs = [...m[2]!.matchAll(ATTR_RE)].map((a) => ({ name: a[1]!.toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? "" }));
    const cls = attrs.find((a) => a.name === "class")?.value ?? "";
    if (!closing) {
      elements.add(name);
      lastOpen = { tag: name, cls };
    }
    for (const a of attrs) {
      if (/[<>]/.test(a.value)) add("value-lt-gt", i, name, cls, a.name, a.value);
      if (/^on/.test(a.name) || a.name === "data-pwn") add("injected-attr", i, name, cls, a.name, a.value);
    }
    i = TAG_RE.lastIndex;
    if (!closing && RAW_TEXT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      i = end < 0 ? html.length : end;
    }
  }
  nulsUpTo(html.length);
  return { violations, elements };
}

/** The violations' lines, the shape the first tests read. */
export const attributeViolations = (html: string): string[] => scanHtml(html).violations.map(show);

/** Elements a fill's own markdown legitimately makes (a link, emphasis, a code
 *  span, a citation, a wikilink, an inline `<Pill>`, a paragraph or list a
 *  blank line starts, a line-ref chip), which a benign fill does not. */
const FILL_MARKDOWN_ELEMENTS = new Set(["a", "strong", "em", "code", "sup", "span", "br", "p", "ul", "ol", "li", "del"]);

// ── Known gaps ──────────────────────────────────────────────────────────────

/**
 * Findings the next PR (A2) fixes. A violation is excused only by a gap whose
 * fill, mode and component match and whose kind, element, class and attribute
 * are the violation's own, so a gap never excuses another element or another
 * attribute of the same case; and each gap must still match on every component
 * it names, so its fix fails the last test until the entry (or that component)
 * is deleted. Only F53, F55, F56 and F29 belong here: any other failure is a
 * new finding.
 */
interface KnownGap {
  finding: "F53" | "F55" | "F56" | "F29";
  fill: string;
  modes: readonly Mode[];
  components: readonly ComponentName[];
  kind: ViolationKind;
  /** The element, and its `class` attribute matched whole; absent for a NUL,
   *  which `near` places instead. */
  tag?: string;
  cls?: RegExp;
  /** The attributes it may break, and the value's shape. */
  attrs?: readonly string[];
  value?: RegExp;
  /** For a NUL: the text around it (40 chars each side). */
  near?: RegExp;
}
/** The components whose body, cells or file fields render the fill as inline
 *  markdown, where F53 and F29 trip (measured on this guard's pages). */
const F53_COMPONENTS: readonly ComponentName[] = [
  "AnnotatedCode", "Callout", "CaseBoard", "Chart", "Checklist", "ComparisonTable", "DecisionLog", "DeltaTable", "Diff",
  "FactCheck", "Figure", "FileTree", "Fold", "Glossary", "Historic", "Meter", "More", "Query", "Question", "RuleTree",
  "RunChecklist", "StatusRows", "Steps", "SystemMap", "Timeline", "Tldr",
];
const F29_COMPONENTS: readonly ComponentName[] = [...F53_COMPONENTS, "Lane", "NextMoves"];

const KNOWN_GAPS: KnownGap[] = [
  // A markdown link's href re-processed by the emphasis pass (web-format.ts): a plain `<a>`'s href only.
  {
    finding: "F53", fill: F53_FILL, modes: ["views", "plain", "ask"], components: F53_COMPONENTS,
    kind: "value-lt-gt", tag: "a", cls: /^$/, attrs: ["href"], value: /^https:\/\/example\.com\/<\/?strong>b<\/?strong><em>e<\/em>\/file\.ts:12$/,
  },
  // The Ask tab restores a citation's `<sup>` inside an attribute value (ask-render.ts): these three values.
  { finding: "F55", fill: F55_FILL, modes: ["ask"], components: ["Question"], kind: "unparsable", tag: "section", cls: /^question\b/, attrs: ["data-question-id"] },
  { finding: "F55", fill: F55_FILL, modes: ["ask"], components: ["Lane", "NextMoves"], kind: "unparsable", tag: "div", cls: /^nm-lane\b/, attrs: ["data-who"] },
  { finding: "F55", fill: F55_FILL, modes: ["ask"], components: ["Embed"], kind: "unparsable", tag: "figure", cls: /^embed$/, attrs: ["data-embed-title"] },
  // `paragraphGaps` writes `<br><br>` into a value holding a blank line (render.ts): CaseBoard's status pill
  // and, in dots view, the square's three values.
  { finding: "F56", fill: F56_FILL, modes: ["views", "plain"], components: ["CaseBoard"], kind: "value-lt-gt", tag: "span", cls: /^cb-pill\b/, attrs: ["title"], value: /^status: x<br><br>y$/ },
  {
    finding: "F56", fill: F56_FILL, modes: ["views"], components: ["CaseBoard"],
    kind: "value-lt-gt", tag: "button", cls: /^cb-dot cb-dot-unknown$/, attrs: ["title", "aria-label", "data-cb-say"], value: /^x<br><br>y(: | — )/,
  },
  // Two adjacent sentinels with a marker word between forge a third (markdown-core.ts): a NUL at the forged pair's edge.
  { finding: "F29", fill: F29_FILL, modes: ["views", "plain", "ask"], components: F29_COMPONENTS, kind: "nul", near: /\0INLINECMP0<code>c<\/code>|<code>c<\/code>INLINE0\0/ },
];

interface Case {
  component: ComponentName;
  setup: Setup;
  fill: string;
  mode: Mode;
}

function* cases(): Generator<Case> {
  for (const component of COMPONENT_NAMES) {
    for (const setup of setupsFor(component)) {
      for (const fill of FILLS) {
        for (const mode of MODES) yield { component, setup, fill, mode };
      }
    }
  }
}

const benignElements = new Map<string, Set<string>>();
/** The elements the case's setup renders with the benign fill. */
function benign(c: Case): Set<string> {
  const key = `${c.component} ${c.setup.name} ${c.mode}`;
  let set = benignElements.get(key);
  if (!set) {
    set = scanHtml(render(page(c.component, BENIGN_FILL, c.setup), c.mode, BENIGN_FILL)).elements;
    benignElements.set(key, set);
  }
  return set;
}

/** The elements a hostile render opens that its benign render does not and
 *  the fill's own markdown cannot make. */
const injectedElements = (hostile: Set<string>, known: Set<string>) => [...hostile].filter((e) => !known.has(e) && !FILL_MARKDOWN_ELEMENTS.has(e));

/** Every violation of `c`: the scanner's, and each element the hostile render
 *  opens that the benign one does not and the fill's markdown cannot make. */
function violationsOf(c: Case): Violation[] {
  const html = render(page(c.component, c.fill, c.setup), c.mode, c.fill);
  const scan = scanHtml(html);
  const extra = injectedElements(scan.elements, benign(c))
    .map((e): Violation => {
      const i = Math.max(0, html.search(new RegExp(`<${e}[\\s/>]`, "i")));
      return { kind: "injected-element", tag: e, cls: "", attr: "", value: "", at: html.slice(i, i + 400) };
    });
  return [...scan.violations, ...extra];
}

const excuses = (g: KnownGap, c: Case, v: Violation) =>
  g.fill === c.fill &&
  g.modes.includes(c.mode) &&
  g.components.includes(c.component) &&
  g.kind === v.kind &&
  (g.kind === "nul"
    ? g.near!.test(v.value)
    : g.tag === v.tag && g.cls!.test(v.cls) && g.attrs!.includes(v.attr) && (!g.value || g.value.test(v.value)));

/** `c`'s violations no gap excuses, and the gaps that excused one. */
function judge(c: Case): { left: Violation[]; excusedBy: KnownGap[] } {
  const excusedBy: KnownGap[] = [];
  const left = violationsOf(c).filter((v) => {
    const gap = KNOWN_GAPS.find((g) => excuses(g, c, v));
    if (gap) excusedBy.push(gap);
    return !gap;
  });
  return { left, excusedBy };
}

const label = (c: Case) => `${c.component} ${c.setup.name} ${c.mode} ${JSON.stringify(c.fill)}`;

/** What a setup's real view renders on the reader (views on, benign fill). */
function realViewMarks(name: ComponentName, setup: Setup): string[] {
  const a = (k: string) => {
    const v = setup.attrs[k];
    return typeof v === "function" ? v(BENIGN_FILL) : v;
  };
  switch (name) {
    case "Chart":
      return [`<section class="vc vc-kind-${a("kind")}"`];
    case "CaseBoard":
      return a("view") === "dots" ? ['<div class="cb-dots"', '<div class="cb-row"'] : ['<div class="cb-row"'];
    case "StatusRows":
      return a("view") === "tiles" ? ['<section class="status-rows sr-tiles">', '<span class="sr-big">'] : ['<div class="sr-grid">'];
    case "Meter":
      return [`<div class="meter${a("tone") === "default" ? "" : ` meter-${a("tone")}`}"`];
    case "Callout":
      return a("resolved") ? ["callout-resolved-row"] : [`<div class="callout callout-${a("tone")}">`];
    case "Pill":
      return [`<span class="pill${a("tone") === "default" ? "" : ` pill-${a("tone")}`}">`];
    case "Verdict":
      return [`<span class="verdict verdict-${a("value")}`];
    case "Fact":
      return [`class="fc-chip fc-chip-${a("v")}"`];
    case "Lane":
      return [`<details class="nm-lane nm-${a("kind")}"`];
    case "Embed":
      return [`<figure class="embed" data-embed-src="${a("src")}"`];
    case "Diagram":
      return ["dgm-has-svg"];
    case "Steps":
      return ['class="stp', "dgm-has-svg"];
    case "DeltaTable":
      return ['class="dt-table'];
    case "Query":
      return ['class="query-table', "language-sql"];
    default:
      return [];
  }
}

const FALLBACK_RE = /-unavailable"|embed-invalid|File type not allowed|invalid embed/;

describe("rendered attribute values (F58)", () => {
  test("the scanner catches F26's shape, every NUL, a stray quote and an injected handler, and passes clean tags", () => {
    expect(attributeViolations(`<section id="qcard-q-1><img src=x data-pwn>"><p>x</p></section>`)).not.toEqual([]);
    expect(attributeViolations(`<p>a\u0000b\u0000c</p><p>\u0000</p>`)).toHaveLength(3);
    expect(attributeViolations(`<span a="x" b="y"z">t</span>`)).not.toEqual([]);
    expect(attributeViolations(`<p>a < b</p>`)).not.toEqual([]);
    expect(attributeViolations(`<span class="cb-owner"><img src=x data-pwn onerror=alert(1)></span>`).map((v) => v.split(" ")[0])).toEqual(["injected-attr", "injected-attr"]);
    expect(attributeViolations(`<span title="x" onmouseover="y">t</span>`)).toHaveLength(1);
    expect(attributeViolations(`<section id="a" data-x="q &gt; 1"><p>x &lt; y</p><br><img src="x" alt=""/></section>`)).toEqual([]);
  });

  test("the real views render: each valid setup draws its view, never a fallback", () => {
    const missing: string[] = [];
    for (const name of COMPONENT_NAMES) {
      for (const setup of validSetups(name)) {
        const html = render(page(name, BENIGN_FILL, setup), "views", BENIGN_FILL);
        for (const mark of realViewMarks(name, setup)) if (!html.includes(mark)) missing.push(`${name} ${setup.name}: ${mark}`);
        const fallback = FALLBACK_RE.exec(html);
        if (fallback) missing.push(`${name} ${setup.name}: fallback ${fallback[0]}`);
      }
    }
    expect(missing).toEqual([]);
    // Every enumerated value of every component is some valid setup's.
    for (const name of COMPONENT_NAMES) {
      const setups = validSetups(name);
      for (const [attr, spec] of Object.entries(COMPONENT_SPEC[name].attrs) as [string, AttrSpec][]) {
        for (const v of spec.enum ?? []) expect(setups.some((s) => s.attrs[attr] === v)).toBe(true);
      }
    }
  });

  test("an element the benign render never opens fails; the fill's own markdown does not", () => {
    const known = scanHtml(`<div class="callout"><p>Benign Hold</p></div>`).elements;
    const hostile = scanHtml(`<div class="callout"><p><strong>b</strong> <a href="x">x</a> <b>c</b><img src="x"></p></div>`).elements;
    expect(injectedElements(hostile, known)).toEqual(["b", "img"]);
  });

  test("F26's page reaches the passes the guard is for: a card anchor, the grid and a glossary mark", () => {
    const html = render(page("Question", FILLS[0]), "views", FILLS[0]);
    expect(html).toContain('id="qcard-o16"');
    expect(html).toContain('href="#qcard-o16"');
    expect(html).toContain('class="gl-mark"');
    expect(html).toContain('data-question-id="Q-1&gt;Hold &lt;img src=x data-pwn onerror=alert(1)&gt;"');
    // A waiting lane naming a question takes its card.
    expect(render(page("NextMoves", FILLS[1]), "views", FILLS[1])).toContain('<div class="nm-qcard" id="nm-q-o16">');
  });

  test("F57: a wikilink typed as a Question or Query id anchors on its link text", () => {
    const md = page("Query", "Q-16").replace('<Question id="O18">', '<Question id="[[Hostile Page]]">') + '\n<Query id="[[Hostile Page|Q 2]]">\n\nx\n\n</Query>\n';
    const views = render(md, "views", "Q-16");
    expect(views).toContain('id="qcard-hostile-page"');
    expect(views).toContain('<section class="query" id="q-2">');
    expect(views).toContain('<a class="query-id" href="#q-2">');
    // The Query's anchor needs no reader options to leak.
    expect(render(md, "plain", "Q-16")).toContain('<section class="query" id="q-2">');
  });

  /** A page of `<Question>` cards with these ids, a DecisionLog naming the
   *  three plain ones (so the grid draws), `extra` blocks before them and
   *  `items` more log items. */
  const cardsPage = (ids: string[], extra: string[] = [], items: string[] = []) =>
    [
      "---", "title: Hostile", "type: plan", "code_at: abc1234", "---", "", "# Hostile", "",
      "<StatusRows>", "", "- **Status** — open", "", "</StatusRows>", "",
      ...extra,
      ...ids.flatMap((id) => [`<Question id="${id}">`, "", "Hold it?", "", "</Question>", ""]),
      "<DecisionLog>", "", "- **O16** — Hold it?", "- **O17** — Hold it?", "- **O18** — Hold it?", ...items, "", "</DecisionLog>", "",
    ].join("\n");
  const cardIds = (html: string) =>
    [...html.matchAll(/<section class="question[^"]*"(?: id="([^"]*)")?[^>]*? data-question-id="([^"]*)"/g)].map((m) => [m[2]!, m[1] ?? null]);
  const idCount = (html: string, id: string) => html.split(` id="${id}"`).length - 1;

  test("a safe id keeps its anchor, and a slugged one never takes a safe id's", () => {
    const html = render(cardsPage(["(O16)", "Q.1", "O 2", "O16'", "O16", "Q-1", "O17", "O18"]), "views", "x");
    expect(cardIds(html)).toEqual([
      ["(O16)", "qcard-(o16)"],
      ["Q.1", "qcard-q.1"],
      ["O 2", "qcard-o 2"],
      ["O16'", "qcard-o16-2"],
      ["O16", "qcard-o16"],
      ["Q-1", "qcard-q-1"],
      ["O17", "qcard-o17"],
      ["O18", "qcard-o18"],
    ]);
    for (const [, anchor] of cardIds(html)) expect(idCount(html, anchor!)).toBe(1);
    // The grid's row for O16 lands on the card whose id is O16.
    expect(html).toContain('<a class="qg-card" href="#qcard-o16">');
    expect(html).toMatch(/<section class="question[^"]*" id="qcard-o16" data-question-id="O16"/);
  });

  test("the grid row of a slugged card links the suffixed anchor it took", () => {
    const md = cardsPage(["o19", "[[Hostile Page|O19]]", "O16", "O17", "O18"], [], ["- **[[Hostile Page|O19]]** — Hold it?"]);
    const html = render(md, "views", "x");
    expect(idCount(html, "qcard-o19")).toBe(1);
    expect(idCount(html, "qcard-o19-2")).toBe(1);
    expect(html).toContain('<a class="qg-card" href="#qcard-o19-2">');
  });

  test("a slugged id yields to a Query card's anchor too", () => {
    const html = render(cardsPage(["qcard-O16'", "O16", "O17", "O18"], ['<Query id="qcard-qcard-o16">', "", "x", "", "</Query>", ""]), "views", "x");
    expect(cardIds(html)[0]).toEqual(["qcard-O16'", "qcard-qcard-o16-2"]);
    expect(html).toContain('<section class="query" id="qcard-qcard-o16">');
  });

  test("a Query whose id is a wikilink yields its slug to a plain Query id", () => {
    const queries = ['<Query id="[[Hostile Page|Q 2]]">', "", "x", "", "</Query>", "", '<Query id="Q-2">', "", "y", "", "</Query>", ""];
    const html = render(cardsPage(["O16", "O17", "O18"], queries), "views", "x");
    expect(html).toMatch(/<section class="query" id="q-2-2">[\s\S]*?<a class="query-id" href="#q-2-2">[\s\S]*?<section class="query" id="q-2">[\s\S]*?<a class="query-id" href="#q-2">Q-2</);
  });

  test("an unsafe id that slugs to nothing takes no anchor and no link", () => {
    const html = render(cardsPage(["'&'", "O16", "O17", "O18"]), "views", "x");
    expect(cardIds(html)[0]).toEqual(["'&amp;'", null]);
    expect(html).not.toMatch(/ id="qcard-"|href="#qcard-"/);
  });

  test("a lane's card: a safe id keeps nm-q-o16 and the unsafe one's moved line follows its suffix", () => {
    const lane = ["<NextMoves>", "", '<Lane kind="waiting" who="Owner Person" since="2026-10-01">', "", "- answer **O16'** and **O16**", "", "</Lane>", "", "</NextMoves>", ""];
    const md = cardsPage(["O17", "O18"], lane) + ["", "Between.", "", `<Question id="O16'">`, "", "Hold it?", "", "</Question>", "", "Between.", "", `<Question id="O16">`, "", "Hold it?", "", "</Question>", ""].join("\n");
    const html = render(md, "views", "x");
    expect(html).toMatch(/<div class="nm-qcard" id="nm-q-o16"><section class="question[^"]*"[^>]* data-question-id="O16"/);
    expect(html).toMatch(/<div class="nm-qcard" id="nm-q-o16-2"><section class="question[^"]*"[^>]* data-question-id="O16'"/);
    expect(html).toContain('<a class="q-moved-link" href="#nm-q-o16-2">Question O16\' is');
    expect(html).toContain('<a class="q-moved-link" href="#nm-q-o16">Question O16 is');
    expect(idCount(html, "nm-q-o16")).toBe(1);
    expect(idCount(html, "nm-q-o16-2")).toBe(1);
  });

  test("an unsafe lane id that slugs to nothing takes nm-q-card, never the bare nm-q-", () => {
    const lane = ["<NextMoves>", "", '<Lane kind="waiting" who="Owner Person" since="2026-10-01">', "", "- answer **'&'**", "", "</Lane>", "", "</NextMoves>", ""];
    const html = render(cardsPage(["'&'", "O16", "O17", "O18"], lane), "views", "x");
    expect(html).toContain('<div class="nm-qcard" id="nm-q-card">');
    expect(html).not.toContain('id="nm-q-"');
  });

  /** Every id the page's elements carry, with each repeat listed. */
  const repeatedIds = (html: string) => {
    const seen = new Set<string>();
    const repeats: string[] = [];
    for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) {
      if (seen.has(id!)) repeats.push(id!);
      seen.add(id!);
    }
    return repeats;
  };
  const query = (id: string, body = "x") => [`<Query id="${id}">`, "", body, "", "</Query>", ""];

  describe("every anchor on the page is unique: Question, Query after its renumbering, lane", () => {
    test("a slugged Question never shares a renumbered Query's -2", () => {
      const html = render(cardsPage(["O16'", "O17", "O18"], [...query("qcard-o16"), ...query("qcard-o16", "y")]), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(cardIds(html)[0]).toEqual(["O16'", "qcard-o16-2"]);
      expect(html).toMatch(/<section class="query" id="qcard-o16">[\s\S]*?<section class="query" id="qcard-o16-3">[\s\S]*?<a class="query-id" href="#qcard-o16-3">/);
    });

    test("nor a wikilink Query's, which yields last", () => {
      const html = render(cardsPage(["O16'", "O17", "O18"], [...query("[[Hostile Page|qcard-o16]]"), ...query("qcard-o16", "y")]), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(cardIds(html)[0]).toEqual(["O16'", "qcard-o16-2"]);
      expect(html).toMatch(/<section class="query" id="qcard-o16-3">[\s\S]*?<section class="query" id="qcard-o16">/);
    });

    test("a Query yields to a safe Question's anchor and to a lane's", () => {
      const lane = ["<NextMoves>", "", '<Lane kind="waiting" who="Owner Person" since="2026-10-01">', "", "- answer **O17**", "", "</Lane>", "", "</NextMoves>", ""];
      const html = render(cardsPage(["O16", "O17", "O18"], [...lane, ...query("qcard-o16"), ...query("nm-q-o17", "y")]), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(cardIds(html)).toContainEqual(["O16", "qcard-o16"]);
      expect(html).toContain('<div class="nm-qcard" id="nm-q-o17">');
      expect(html).toContain('<section class="query" id="qcard-o16-2">');
      expect(html).toContain('<section class="query" id="nm-q-o17-2">');
    });

    test("two safe ids one case apart: the second is suffixed", () => {
      const html = render(cardsPage(["O16", "o16", "O17", "O18"]), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(cardIds(html).slice(0, 2)).toEqual([["O16", "qcard-o16"], ["o16", "qcard-o16-2"]]);
    });

    test("two slugged ids with one slug take -2 and -3, never one anchor", () => {
      const html = render(cardsPage(["[[A|O16]]", "[[B|O16]]", "O16", "O17", "O18"]), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(cardIds(html).map(([, a]) => a)).toEqual(["qcard-o16-2", "qcard-o16-3", "qcard-o16", "qcard-o17", "qcard-o18"]);
    });

    test("the O16 grid row links the O16 card, though a wikilink card above it reads O16 too", () => {
      const html = render(cardsPage(["[[X|O16]]", "O16", "O17", "O18"]), "views", "x");
      expect(cardIds(html).slice(0, 2)).toEqual([["[[X|O16]]", "qcard-o16-2"], ["O16", "qcard-o16"]]);
      expect(html).toContain('<a class="qg-card" href="#qcard-o16">');
      expect(html).not.toContain('href="#qcard-o16-2"');
    });

    test("a DecisionLog item still yields to a Query card, which keeps its slug", () => {
      const html = render(cardsPage(["O17", "O18"], query("O16")), "views", "x");
      expect(repeatedIds(html)).toEqual([]);
      expect(html).toContain('<section class="query" id="o16">');
      expect(html).toMatch(/<li class="dl-item[^"]*"(?: value="\d+")? id="o16-2"[ >]/);
    });
  });

  const results = [...cases()].map((c) => ({ c, ...judge(c) }));

  test("every component, setup and hostile fill keeps the contract", () => {
    const failures = results
      .filter((r) => r.left.length)
      .map((r) => `${label(r.c)}\n  ${r.left.slice(0, 3).map(show).join("\n  ")}`);
    expect(failures).toEqual([]);
  });

  test("every known gap still breaks on every component it names (delete the entry or the component with its fix)", () => {
    const dead: string[] = [];
    for (const g of KNOWN_GAPS) {
      for (const component of g.components) {
        if (!results.some((r) => r.c.component === component && r.excusedBy.includes(g))) dead.push(`${g.finding} ${g.tag ?? g.kind} ${component}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

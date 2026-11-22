import { describe, expect, test } from "bun:test";
import { COMPONENT_NAMES, COMPONENT_SPEC, SELF_CLOSING_ALLOWED, type ComponentName } from "../format/component-spec.ts";
import type { PageFiles } from "../format/query-block.ts";
import { renderAskAnswerHtml } from "./ask-render.ts";
import { questionRenderOptionsFor, renderWikiHtml } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";

/**
 * F58 (architecture review 2026-11-16): the finished-HTML passes after the
 * render (glossary marks, line-ref chips, callout upgrades, paragraph gaps, the
 * sentinel restores) split and rewrite the page as a string, so each needs
 * every attribute value to hold no raw `<`, `>` or `"`. One page per component
 * and hostile fill goes through `renderWikiHtml` (views on and off) and
 * `renderAskAnswerHtml`; the output is parsed quote-aware, and a tag that does
 * not parse, a value holding `<` or `>`, a raw `<` in text or a NUL fails.
 */

const F53_FILL = `[x](https://example.com/**b**_e_/file.ts:12)`;
const F55_FILL = "**bold** _em_ `code` [1] Hold";
const F56_FILL = "x\n\ny";
const F29_FILL = "<Pill>p</Pill>INLINE0`c`";

const FILLS = [
  // F26: a `>` and markup in an id, with a glossary term after the `>` and without.
  `Q-1>Hold <img src=x data-pwn onerror=alert(1)>`,
  `Q-1><img src=x data-pwn onerror=alert(1)>`,
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

/**
 * Findings the next PR (A2) fixes: the fill that trips each and the shape of
 * its violation. A violation is excused only by a gap whose fill, mode and
 * `shape` all match, so a gap never hides another fault in the same case; and
 * each gap must still match somewhere, so its fix fails the last test until
 * the entry is deleted. Only F53, F55, F56 and F29 belong here: any other
 * failure is a new finding.
 */
interface KnownGap {
  finding: "F53" | "F55" | "F56" | "F29";
  fill: string;
  modes: readonly Mode[];
  shape: RegExp;
}
const KNOWN_GAPS: KnownGap[] = [
  // A markdown link's href re-processed by the emphasis pass (web-format.ts).
  { finding: "F53", fill: F53_FILL, modes: ["views", "plain", "ask"], shape: /^raw < or > in an attribute value \(https:\/\/example\.com\/<\/?strong>/ },
  // The Ask tab restores a citation's `<sup>` inside an attribute value (ask-render.ts).
  { finding: "F55", fill: F55_FILL, modes: ["ask"], shape: /^tag does not parse: <[a-z]+ [^>]*="[^"]*<sup class="wiki-ask-cite"/ },
  // `paragraphGaps` writes `<br><br>` into a value holding a blank line (render.ts), here CaseBoard's yaml.
  { finding: "F56", fill: F56_FILL, modes: ["views", "plain"], shape: /^raw < or > in an attribute value \([^)]*<br><br>/ },
  // Two adjacent sentinels with a marker word between forge a third (markdown-core.ts): a NUL is served.
  { finding: "F29", fill: F29_FILL, modes: ["views", "plain", "ask"], shape: /^NUL served/ },
];

type Variant = "attrs" | "files";
const FILE_ATTRS = new Set(["src", "csv", "sql"]);
const fileName = (attr: string) => (attr === "src" ? "cases.yaml" : attr === "csv" ? "q.csv" : "q.sql");

// One target resolves (a live link); every other one is a missing link.
const pages = (target: string): WikiPageMeta | undefined =>
  target.trim() === "Hostile Page" ? ({ name: "Hostile Page", relPath: `plans/h"<x>.mdx`, title: "Hostile" } as WikiPageMeta) : undefined;

/** The page's sibling files, each carrying the fill in every field it has. */
function files(fill: string): PageFiles {
  const yaml = [
    `- id: ${JSON.stringify(fill)}`,
    `  status: ${JSON.stringify(fill)}`,
    `  owner: ${JSON.stringify(fill)}`,
    `  note: ${JSON.stringify(fill)}`,
    `  kort: ${JSON.stringify(fill)}`,
    `- id: B`,
    `  status: hold`,
  ].join("\n");
  const cell = `"${fill.replaceAll('"', '""')}"`;
  return {
    get(ref: string) {
      if (ref.endsWith(".yaml")) return { ok: true, text: yaml };
      if (ref.endsWith(".csv")) return { ok: true, text: `${cell},n\n${cell},1\nb,2\n` };
      if (ref.endsWith(".sql")) return { ok: true, text: `select '${fill}'` };
      return { ok: false, reason: "unavailable" };
    },
  };
}

function body(name: ComponentName, fill: string): string[] {
  switch (name) {
    case "DecisionLog":
    case "Timeline":
    case "Tldr":
    case "RunChecklist":
    case "Checklist":
    case "RuleTree":
    case "StatusRows":
      return [`- **D1** — ${fill}`, `- **Q-1** — ${fill} 2026-10-01`, `  - nested ${fill}`];
    case "Chart":
    case "ComparisonTable":
    case "SystemMap":
      return ["| From | To | Status |", "|---|---|---|", `| ${fill} | B | ok |`, "| B | C | 2 |"];
    case "Glossary":
      return [`- **Hold** — ${fill}`];
    case "CodeTabs":
      return [`<Tab label="${fill}">`, "", "```ts", fill, "```", "", "</Tab>"];
    case "NextMoves":
      return [`<Lane kind="waiting" who="${fill}" since="2026-10-01">`, "", `- ${fill} **O16**`, "", "</Lane>"];
    case "Query":
      return ["```sql", `select '${fill}'`, "```", "", fill];
    default:
      return [`Text ${fill} with Hold.`, "", `- item ${fill}`];
  }
}

function block(name: ComponentName, fill: string, variant: Variant): string[] {
  // `files`: only the file attributes, named, so the fill reaches the render
  // through the file's content and cannot break the tag's line.
  const attrs = Object.keys(COMPONENT_SPEC[name].attrs)
    .filter((a) => variant === "attrs" || FILE_ATTRS.has(a))
    .map((a) => `${a}="${variant === "files" ? fileName(a) : fill}"`)
    .join(" ");
  const open = `<${name}${attrs ? ` ${attrs}` : ""}`;
  if (name === "Check") return [`- run it ${open} />`];
  if (name === "Lane") return ["<NextMoves>", "", `${open}>`, "", `- ${fill} **O17**`, "", `</${name}>`, "", "</NextMoves>"];
  if (name === "Tab") return ["<CodeTabs>", "", `${open}>`, "", "```ts", fill, "```", "", `</${name}>`, "", "</CodeTabs>"];
  if (SELF_CLOSING_ALLOWED.has(name)) return [`${open} />`];
  return [`${open}>`, "", ...body(name, fill), "", `</${name}>`];
}

/** The page around the block: a StatusRows slot, three plain questions the
 *  DecisionLog names (so the grid draws), an item whose id is the fill, a line
 *  ref and a Glossary the text uses. */
function page(name: ComponentName, fill: string, variant: Variant): string {
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
    ...block(name, fill, variant),
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
    `- **${fill}** — Hold it?`,
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

const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/y;
const VALUE_RE = /=\s*(?:"([^"]*)"|'([^']*)')/g;
const RAW_TEXT = new Set(["script", "style"]);

/** Every place `html` breaks the attribute contract: the reason, then the
 *  page from the offending tag on (the gaps' `shape`s read it). */
export function attributeViolations(html: string): string[] {
  const out: string[] = [];
  const at = (i: number, why: string) => out.push(`${why}: ${html.slice(i, i + 400)}`);
  if (html.includes("\0")) at(Math.max(0, html.indexOf("\0") - 80), "NUL served");
  for (let i = html.indexOf("<"); i >= 0; i = html.indexOf("<", i)) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) {
      at(i, /^<\/?[A-Za-z]/.test(html.slice(i, i + 3)) ? "tag does not parse" : "raw < in text");
      i++;
      continue;
    }
    for (const v of m[2]!.matchAll(VALUE_RE)) {
      const value = v[1] ?? v[2] ?? "";
      if (/[<>]/.test(value)) at(i, `raw < or > in an attribute value (${value.slice(0, 80)})`);
    }
    i = TAG_RE.lastIndex;
    const name = m[1]!.toLowerCase();
    if (!m[0].startsWith("</") && RAW_TEXT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      i = end < 0 ? html.length : end;
    }
  }
  return out;
}

interface Case {
  component: ComponentName;
  fill: string;
  variant: Variant;
  mode: Mode;
}

function* cases(): Generator<Case> {
  for (const component of COMPONENT_NAMES) {
    const hasFileAttr = Object.keys(COMPONENT_SPEC[component].attrs).some((a) => FILE_ATTRS.has(a));
    for (const fill of FILLS) {
      for (const variant of hasFileAttr ? (["attrs", "files"] as const) : (["attrs"] as const)) {
        for (const mode of MODES) yield { component, fill, variant, mode };
      }
    }
  }
}

/** `c`'s violations no applicable gap excuses, and the gaps that excused one. */
function judge(c: Case): { left: string[]; excusedBy: KnownGap[] } {
  const gaps = KNOWN_GAPS.filter((g) => g.fill === c.fill && g.modes.includes(c.mode));
  const excusedBy: KnownGap[] = [];
  const left = attributeViolations(render(page(c.component, c.fill, c.variant), c.mode, c.fill)).filter((v) => {
    const gap = gaps.find((g) => g.shape.test(v));
    if (gap) excusedBy.push(gap);
    return !gap;
  });
  return { left, excusedBy };
}

const label = (c: Case) => `${c.component} ${c.variant} ${c.mode} ${JSON.stringify(c.fill)}`;

describe("rendered attribute values (F58)", () => {
  test("the scanner catches F26's shape, a NUL and a stray quote, and passes clean tags", () => {
    expect(attributeViolations(`<section id="qcard-q-1><img src=x data-pwn>"><p>x</p></section>`)).not.toEqual([]);
    expect(attributeViolations(`<p>a\u0000b</p>`)).not.toEqual([]);
    expect(attributeViolations(`<span a="x" b="y"z">t</span>`)).not.toEqual([]);
    expect(attributeViolations(`<p>a < b</p>`)).not.toEqual([]);
    expect(attributeViolations(`<section id="a" data-x="q &gt; 1"><p>x &lt; y</p><br><img src="x" alt=""/></section>`)).toEqual([]);
  });

  test("F26's page reaches the passes the guard is for: a card anchor, the grid and a glossary mark", () => {
    const html = render(page("Question", FILLS[0], "attrs"), "views", FILLS[0]);
    expect(html).toContain('id="qcard-o16"');
    expect(html).toContain('href="#qcard-o16"');
    expect(html).toContain('class="gl-mark"');
    expect(html).toContain('data-question-id="Q-1&gt;Hold &lt;img src=x data-pwn onerror=alert(1)&gt;"');
    // A waiting lane naming a question takes its card.
    expect(render(page("NextMoves", FILLS[1], "attrs"), "views", FILLS[1])).toContain('<div class="nm-qcard" id="nm-q-o16">');
  });

  test("F57: a wikilink typed as a Question or Query id anchors on its link text", () => {
    const md = page("Query", "Q-16", "attrs").replace('<Question id="O18">', '<Question id="[[Hostile Page]]">') + '\n<Query id="[[Hostile Page|Q 2]]">\n\nx\n\n</Query>\n';
    const views = render(md, "views", "Q-16");
    expect(views).toContain('id="qcard-hostile-page"');
    expect(views).toContain('<section class="query" id="q-2">');
    expect(views).toContain('<a class="query-id" href="#q-2">');
    // The Query's anchor needs no reader options to leak.
    expect(render(md, "plain", "Q-16")).toContain('<section class="query" id="q-2">');
  });

  const results = [...cases()].map((c) => ({ c, ...judge(c) }));

  test("no component and hostile fill breaks an attribute value", () => {
    const failures = results
      .filter((r) => r.left.length)
      .map((r) => `${label(r.c)}\n  ${r.left.slice(0, 3).map((v) => v.slice(0, 240)).join("\n  ")}`);
    expect(failures).toEqual([]);
  });

  test("every known gap still breaks somewhere (delete the entry with its fix)", () => {
    const alive = new Set(results.flatMap((r) => r.excusedBy));
    expect(KNOWN_GAPS.filter((g) => !alive.has(g)).map((g) => g.finding)).toEqual([]);
  });
});

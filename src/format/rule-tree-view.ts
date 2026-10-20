/**
 * The reader's `<RuleTree>` view: the tree's list rendered as written, with
 * classes that draw it as a tree, each leaf toned by its outcome, its case ids
 * as chips, and a case picker over the cases. `renderWikiHtml` passes it to
 * `formatWebHtml` as the `ruleTreeView` option, so the chat bundle never
 * carries it. Every label the source does not hold (the title, the picker,
 * the `kort:` lines) carries `READER_ONLY_ATTR`; the list's own text stays the
 * source's, so a peek, print and an Explain selection read the list.
 *
 * The reader's stylesheet shows the picker only once `wiki-visuals.ts` has
 * installed its listener (`rt-js` on the document root), so without a script the tree
 * shows its case chips and no dead control.
 */
import { escapeHtml } from "./markdown-core.ts";
import type { ListBlock } from "./markdown-ast.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import type { RuleNode, RuleTreeViewInput, RuleUnder } from "./rule-tree.ts";

/** The classes the reader adds; `wiki-ref-links.ts` strips these from a peek
 *  (`PEEK_RULE_TREE_CHROME`, pinned equal by a test). */
export const RULE_TREE_CHROME_CLASSES = ["rt-head"] as const;

const WORDS: Record<QuestionLanguage, { tree: string; caseLabel: string; all: string }> = {
  en: { tree: "Rule tree", caseLabel: "Case", all: "All cases" },
  no: { tree: "Regeltre", caseLabel: "Sak", all: "Alle saker" },
};

const RO = `${READER_ONLY_ATTR}=""`;

/** The case id a chip's source names: the longest of the leaf's ids that
 *  stands as a whole token in it, struck text and link destinations aside.
 *  The picker matches chips on this, never on their text, which the reader
 *  extends (an `idLabels` noun). */
function chipCase(core: string, ids: readonly string[]): string | undefined {
  const text = core.replace(/~~[\s\S]*?~~/g, "").replace(/\]\([^)\n]*\)/g, "]");
  const token = (id: string) => {
    for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
      const before = text[at - 1] ?? " ";
      const after = text[at + id.length] ?? " ";
      if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)) return true;
    }
    return false;
  };
  return [...ids].sort((a, b) => b.length - a.length).find(token);
}

/** One item's own text: lead and case ids wrapped when the pieces render as
 *  the whole item does, else the item as one run. */
function rowHtml(n: RuleNode, input: RuleTreeViewInput): string {
  const split = n.leaf?.caseSplit ?? null;
  if (!n.lead && !split) return input.inline(n.raw);
  const body = split ? split.body : n.rest;
  const caseParts = split ? [split.dash, ...split.pieces.flatMap((p, i) => (i ? [",", p] : [p]))] : [];
  if (!input.same([n.lead?.raw ?? "", body, ...caseParts], n.raw)) return input.inline(n.raw);
  const lead = n.lead ? `<span class="rt-edge">${input.inline(n.lead.raw)}</span>` : "";
  const ids = n.leaf?.cases ?? [];
  const chips = split ? split.pieces.filter((p) => p.replace(/~~[\s\S]*?~~/g, "").trim()).length : 0;
  let k = 0;
  const cases = split
    ? input.inline(split.dash) +
      split.pieces
        .map((p) => {
          const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(p);
          const core = m?.[2] ?? p;
          if (!core.replace(/~~[\s\S]*?~~/g, "").trim()) return input.inline(p);
          const id = chipCase(core, ids) ?? (chips === ids.length ? ids[k] : undefined);
          k++;
          const attr = id === undefined ? "" : ` data-rt-case="${escapeHtml(id)}"`;
          return `${m?.[1] ?? ""}<span class="rt-case"${attr}>${input.inline(core)}</span>${m?.[3] ?? ""}`;
        })
        .join(",")
    : "";
  return lead + input.inline(body) + cases;
}

function underHtml(u: RuleUnder, input: RuleTreeViewInput): string {
  return u.kind === "list" ? listHtml(u.list, u.nodes, input) : input.child(u.child);
}

function nodeHtml(n: RuleNode, value: number | undefined, input: RuleTreeViewInput): string {
  const leaf = n.leaf;
  const cls = ["rt-node", leaf ? "rt-leaf" : "", leaf?.tone ? `rt-tone-${leaf.tone}` : ""].filter(Boolean).join(" ");
  const cases = leaf?.cases.length ? ` data-rt-cases="${escapeHtml(JSON.stringify(leaf.cases))}"` : "";
  const v = value === undefined ? "" : ` value="${value}"`;
  return `<li class="${cls}"${v}${cases}><span class="rt-row">${rowHtml(n, input)}</span>${n.under.map((u) => underHtml(u, input)).join("")}</li>`;
}

function listHtml(list: ListBlock, nodes: readonly RuleNode[], input: RuleTreeViewInput): string {
  const items = nodes.map((n, k) => nodeHtml(n, list.type === "ol" ? list.values?.[k] : undefined, input)).join("");
  if (list.type === "ul") return `<ul class="rt-list">${items}</ul>`;
  return `<ol class="rt-list"${list.start !== 1 ? ` start="${list.start}"` : ""}>${items}</ol>`;
}

/** The picker: one option per case, in first-seen order. */
function pickerHtml(input: RuleTreeViewInput): string {
  const w = WORDS[input.language];
  const { cases } = input.read;
  if (!cases.length) return "";
  const options = cases.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
  const korts = cases
    .filter((id) => input.korts.has(id))
    .map((id) => `<span class="rt-kort" data-rt-kort="${escapeHtml(id)}" hidden>${escapeHtml(id)} · ${input.korts.get(id)}</span>`)
    .join("");
  return (
    `<label class="rt-pick"><span class="rt-pick-label">${w.caseLabel}</span>` +
    `<select class="rt-select" data-rt-select><option value="">${w.all}</option>${options}</select></label>` +
    (korts ? `<p class="rt-korts" aria-live="polite">${korts}</p>` : "")
  );
}

/** The reader's `<RuleTree>`: a figure named by its title, the head (title,
 *  picker, `kort:` lines), and the list as a tree between the blocks around it. */
export function ruleTreeViewHtml(input: RuleTreeViewInput): string {
  const w = WORDS[input.language];
  const title = input.title.trim();
  const name = input.titleText.trim() || w.tree;
  const head = (title ? `<p class="rt-title">${input.inline(title)}</p>` : "") + pickerHtml(input);
  return (
    `<section class="rt" role="figure" aria-label="${escapeHtml(name)}">` +
    (head ? `<div class="rt-head" ${RO}>${head}</div>` : "") +
    input.blocks(input.read.before) +
    listHtml(input.read.list, input.read.nodes, input) +
    input.blocks(input.read.after) +
    `</section>`
  );
}

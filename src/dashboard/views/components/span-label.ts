import { escAttr, escHtml } from "./escape.ts";
import { normalizeToolName, TOOL_NAME_PREFIX_RE } from "./tool-helpers.ts";
import { collectionsFor, sortCollectionsByPriority, summarizeSearchTrace } from "./search-helpers.ts";

interface SpanLike {
  name?: string;
  attributes?: {
    toolName?: unknown;
    toolId?: unknown;
    input?: unknown;
    output?: unknown;
    searchTrace?:
      | {
          collections?: Array<{
            name?: unknown;
            candidates?: unknown[];
            confidence?: { lowConfidence?: unknown };
            timingsMs?: { total?: unknown };
          }>;
          candidates?: unknown[];
          timingsMs?: { total?: unknown };
          totalMs?: unknown;
          tool?: unknown;
        }
      | unknown;
  };
}

/** Render the tool span label as a chip cluster: verb + per-collection chips
 *  for search tools, OR verb + tool-specific extras (repo / id / path tail)
 *  for non-search tools we recognise (graph_node, symbol_context, list_files,
 *  read_source, search_pattern). Returns null when nothing useful can be
 *  extracted, so the caller falls back to the plain tool name. */
export function deriveSpanLabelHtml(span: SpanLike): { html: string; tooltip: string } | null {
  if (!span || !span.name) return null;
  const attrs = span.attributes ?? {};

  // span.name is the display-formatted name for claude-cli; the raw form is on attrs.toolName.
  const rawName = typeof attrs.toolName === "string" && attrs.toolName.length > 0
    ? attrs.toolName
    : span.name;
  const canonName = normalizeToolName(rawName);
  const verb = (canonName.replace(TOOL_NAME_PREFIX_RE, "").split(/[_-]/)[0] || "").toLowerCase();
  const verbClass = /^[a-z]+$/.test(verb) ? verb : "other";
  const verbChip = verb
    ? `<span class="wf-chip wf-verb wf-verb-${escAttr(verbClass)}">${escHtml(verb)}</span>`
    : '';

  // Whether the search actually returned anything usable *to the model* —
  // distinct from "how many candidates the pipeline kept". A search can keep
  // hundreds of candidates yet hand the model "No results found / low
  // confidence", which the candidate-count chip alone hides.
  const resultSignal = searchResultSignal(attrs);

  // Search-tool path: collection chips + counts chip, derived from searchTrace
  // or input.collection.
  let collections = collectionsFor(attrs);
  if (collections && collections.length > 0) {
    collections = sortCollectionsByPriority(collections);
    const summary = summarizeSearchTrace(attrs.searchTrace);
    const firstChip = collChip(collections[0]!);
    const moreChip = collections.length > 1
      ? `<span class="wf-chip wf-coll-more" title="${escAttr(collections.slice(1).join(", "))}">+${collections.length - 1}</span>`
      : '';
    const lowConf = !!(summary?.lowConfidence) || resultSignal === "weak";
    let countsChip = "";
    if (resultSignal === "empty") {
      // The model got "No results found" — the kept/fetched count is candidate
      // pipeline noise here, so show the honest outcome instead.
      countsChip = `<span class="wf-chip wf-no-hits" title="search returned no results to the model${summary ? ` (${summary.fetched} candidates were fetched and filtered out)` : ""}">0 hits</span>`;
    } else if (summary) {
      const cls = lowConf ? "wf-chip wf-counts wf-low-conf" : "wf-chip wf-counts";
      const scope = collections.length > 1 ? ` (summed across ${collections.length} collections)` : "";
      const tip = lowConf
        ? `${summary.kept} kept / ${summary.fetched} fetched${scope} · low confidence`
        : `${summary.kept} kept / ${summary.fetched} fetched${scope}`;
      countsChip = `<span class="${cls}" title="${escAttr(tip)}">${summary.kept}/${summary.fetched}</span>`;
    }
    const tooltipLines = [span.name, "collections: " + collections.join(", ")];
    if (resultSignal === "empty") tooltipLines.push("⚠ no results returned to the model");
    else if (resultSignal === "weak") tooltipLines.push("⚠ low-confidence results (Huginn flagged a weak match)");
    if (summary) {
      tooltipLines.push(`candidates: ${summary.kept} kept / ${summary.fetched} fetched`);
      if (summary.topTitle) tooltipLines.push("top: " + summary.topTitle);
      if (summary.totalMs != null) tooltipLines.push("total: " + summary.totalMs + "ms");
      if (summary.lowConfidence) tooltipLines.push("⚠ low confidence");
    }
    return {
      html: verbChip + firstChip + moreChip + countsChip,
      tooltip: tooltipLines.join("\n"),
    };
  }

  // Per-tool extras path: graph_node / symbol_context / list_files /
  // read_source / search_pattern.
  const extras = toolLabelExtras(canonName, attrs);
  if (extras) {
    return {
      html: verbChip + extras.chips,
      tooltip: [span.name, ...extras.tooltipLines].join("\n"),
    };
  }
  return null;
}

/** Whether a search-tool span's result was actually usable *by the model*:
 *  `"empty"` ("No results found" / `noConfidentResults`), `"weak"` (a
 *  `*Weak match*` / `*No confident match*` footer), or `null` (looks fine).
 *  Reads the captured tool output first (ground truth of what the model saw),
 *  falling back to the Huginn trace's Phase-0 `response` block.
 *
 *  Self-contained on purpose: this file is in the dashboard layer and avoids
 *  importing from `src/ai/`. The regexes mirror Huginn's MCP-adapter rendering. */
function searchResultSignal(attrs: NonNullable<SpanLike["attributes"]>): "empty" | "weak" | null {
  const out = typeof attrs.output === "string" ? attrs.output : null;
  if (out) {
    if (/(^|\n)\s*No results found for /.test(out)) return "empty";
    if (/(^|\n)\s*\*(?:No confident match|Weak match)\b/.test(out)) return "weak";
    return null;
  }
  const trace = attrs.searchTrace;
  if (trace && typeof trace === "object") {
    const resp = (trace as { response?: { noConfidentResults?: unknown; bestScore?: unknown } }).response;
    if (resp) {
      if (resp.noConfidentResults === true) return "empty";
      // Huginn's WEAK_RESULT_RELEVANCE threshold.
      if (typeof resp.bestScore === "number" && resp.bestScore < 0.45) return "weak";
    }
  }
  return null;
}

interface ToolLabelExtras { chips: string; tooltipLines: string[]; }

type ExtrasRecipe = {
  match: RegExp;
  build: (
    input: Record<string, unknown>,
    attrs: NonNullable<SpanLike["attributes"]>,
  ) => ToolLabelExtras | null;
};

/** Recipes for non-search tools. Each entry pairs a tool-name pattern with
 *  a builder that pulls the most distinguishing fields out of the tool's
 *  input and shapes them into chip HTML + tooltip lines. Adding a new tool
 *  is a single recipe entry. */
const EXTRAS_RECIPES: ExtrasRecipe[] = [
  {
    match: /get_graph_node$/,
    build: (input) => {
      const id = strField(input, "node_id") || strField(input, "tag");
      if (!id) return null;
      const colonIdx = id.indexOf(":");
      const kind = colonIdx > 0 ? id.slice(0, colonIdx) : "";
      const tail = colonIdx > 0 ? id.slice(colonIdx + 1) : id;
      return {
        chips: (kind ? collChip(kind, "kind: " + kind) : "") + extraChip(tail, id),
        tooltipLines: ["node: " + id],
      };
    },
  },
  {
    match: /yggdrasil-symbol_context$/,
    build: (input) => {
      const repo = strField(input, "repo");
      const qn = strField(input, "qualified_name") || strField(input, "qualifiedName");
      if (!repo && !qn) return null;
      const short = qn ? lastSegment(qn, ".") : "";
      return {
        chips: collChip(repo) + (short ? extraChip(short, qn || short) : ""),
        tooltipLines: tipLines({ repo, symbol: qn }),
      };
    },
  },
  // list_files and read_source share the exact same shape: repo + path,
  // chip = (repo, last path segment), tooltip = (repo, full path).
  { match: /yggdrasil-list_files$/,  build: buildRepoPathExtras },
  { match: /yggdrasil-read_source$/, build: buildRepoPathExtras },
  { match: /yggdrasil-search_pattern$/,   build: (input) => buildTwoFieldExtras(input, "repo", "pattern") },
  { match: /yggdrasil-analyze_ticket$/,   build: buildAnalyzeTicketExtras },
  // Fallback when collectionsFor() returns null (no searchTrace and no input.collection).
  { match: /knowledge-search_knowledge$/, build: (input) => buildTwoFieldExtras(input, "collection", "query") },
];

function buildTwoFieldExtras(
  input: Record<string, unknown>,
  primaryField: string,
  secondaryField: string,
): ToolLabelExtras | null {
  const primary = strField(input, primaryField);
  const secondary = strField(input, secondaryField);
  if (!primary && !secondary) return null;
  return {
    chips: collChip(primary) + (secondary ? extraChip(truncate(secondary, 28), secondary) : ""),
    tooltipLines: tipLines({ [primaryField]: primary, [secondaryField]: secondary }),
  };
}

function toolLabelExtras(name: string, attrs: NonNullable<SpanLike["attributes"]>): ToolLabelExtras | null {
  const input = parseInputObject(attrs.input);
  if (!input) return null;
  for (const r of EXTRAS_RECIPES) {
    if (r.match.test(name)) return r.build(input, attrs);
  }
  return null;
}

/** analyze_ticket inputs are large enough that the 500-char abbreviation
 *  often drops the trailing `repo` field. Recover it from the response's
 *  `summary.repos` so the row keeps a colored repo chip — matching the
 *  symbol_context / list_files rows that always have one. */
function buildAnalyzeTicketExtras(
  input: Record<string, unknown>,
  attrs: NonNullable<SpanLike["attributes"]>,
): ToolLabelExtras | null {
  let repo = strField(input, "repo");
  if (!repo) {
    const out = parseInputObject(attrs.output);
    const repos = (out?.summary as { repos?: unknown } | undefined)?.repos;
    if (Array.isArray(repos) && typeof repos[0] === "string") repo = repos[0];
  }
  return buildTwoFieldExtras({ ...input, repo }, "repo", "ticket");
}

function buildRepoPathExtras(input: Record<string, unknown>): ToolLabelExtras | null {
  const repo = strField(input, "repo");
  const path = strField(input, "path");
  if (!repo && !path) return null;
  const tail = path ? lastSegment(path, "/") : "";
  return {
    chips: collChip(repo) + (tail ? extraChip(tail, path || tail) : ""),
    tooltipLines: tipLines({ repo, path }),
  };
}

/** Build "key: value" tooltip lines, dropping any pair whose value is empty. */
function tipLines(pairs: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(pairs)) {
    if (v) out.push(`${k}: ${v}`);
  }
  return out;
}

function parseInputObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.length > 0) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch {
      return recoverTruncatedJson(raw);
    }
  }
  return null;
}

/** Tool inputs are abbreviated to 500 chars upstream (copilot-sdk's
 *  `abbreviateInput`) and end with `…`. Strip the marker and append likely
 *  closers so a string truncated mid-value still parses. */
function recoverTruncatedJson(raw: string): Record<string, unknown> | null {
  const stripped = raw.replace(/…$/, "");
  for (const closer of ['"}', '}']) {
    try { return JSON.parse(stripped + closer) as Record<string, unknown>; } catch { /* try next */ }
  }
  return null;
}
function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}
function lastSegment(s: string, sep: string): string {
  const trimmed = s.replace(new RegExp(escapeRegex(sep) + "+$"), "");
  const idx = trimmed.lastIndexOf(sep);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/** Color-by-hash chip used for both collection names and repo names. The
 *  optional tooltipOverride lets callers prefix with a label (e.g. "kind: …")
 *  while keeping the same visual treatment. */
function collChip(name: string, tooltipOverride?: string): string {
  if (!name) return "";
  const abbr = abbreviateCollection(name);
  const title = tooltipOverride ?? (abbr === name ? name : `${name} (${abbr})`);
  return `<span class="wf-chip wf-coll" style="${collStyle(name)}" title="${escAttr(title)}">${escHtml(abbr)}</span>`;
}
function extraChip(text: string, tooltip: string): string {
  return `<span class="wf-chip wf-extra wf-mono" title="${escAttr(tooltip)}">${escHtml(text)}</span>`;
}

/**
 * Abbreviate a collection name for chip display when it's longer than the
 * threshold: take the first letter of each dash-separated segment and append
 * any trailing version-like token verbatim. The full name lives in the chip's
 * `title` attribute for hover.
 *
 *   "melosys-confluence-v3"   → "mc-v3"
 *   "jira-issues"             → "jira-issues"  (≤12 chars, kept)
 *   "very-long-collection"    → "vlc"
 */
export function abbreviateCollection(name: string): string {
  if (!name) return "";
  if (name.length <= 12) return name;
  const parts = name.split("-");
  if (parts.length <= 1) return name;
  const trailing: string[] = [];
  while (parts.length > 1 && /^v?\d+$/.test(parts[parts.length - 1]!)) {
    trailing.unshift(parts.pop()!);
  }
  const initials = parts.map((p) => p[0] || "").join("");
  return trailing.length > 0 ? initials + "-" + trailing.join("-") : initials;
}

function collHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function collStyle(name: string): string {
  const h = collHue(name);
  return `background:hsl(${h} 32% 18%);color:hsl(${h} 60% 75%);border:1px solid hsl(${h} 35% 32%)`;
}

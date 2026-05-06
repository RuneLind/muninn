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
 *  extracted, so the caller falls back to the plain tool name. Exposed for
 *  testing — kept in sync with the JS twin in {@link deriveSpanLabelScript}. */
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
    let countsChip = "";
    if (summary) {
      const cls = summary.lowConfidence ? "wf-chip wf-counts wf-low-conf" : "wf-chip wf-counts";
      const scope = collections.length > 1
        ? ` (summed across ${collections.length} collections)`
        : "";
      const tip = summary.lowConfidence
        ? `${summary.kept} kept / ${summary.fetched} fetched${scope} · low confidence`
        : `${summary.kept} kept / ${summary.fetched} fetched${scope}`;
      countsChip = `<span class="${cls}" title="${escAttr(tip)}">${summary.kept}/${summary.fetched}</span>`;
    }
    const tooltipLines = [span.name, "collections: " + collections.join(", ")];
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
 *  is a single recipe entry — keep this in sync with the JS twin's
 *  EXTRAS_RECIPES table. */
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
 *  `summary.repos` (the canonical list of repos hit during analysis) so the
 *  row keeps a colored repo chip — matching the symbol_context / list_files
 *  rows that always have one. */
function buildAnalyzeTicketExtras(
  input: Record<string, unknown>,
  attrs: NonNullable<SpanLike["attributes"]>,
): ToolLabelExtras | null {
  const ticket = strField(input, "ticket");
  let repo = strField(input, "repo");
  if (!repo) {
    const out = parseInputObject(attrs.output);
    const summary = out && typeof out.summary === "object" && out.summary !== null
      ? (out.summary as Record<string, unknown>)
      : null;
    const repos = summary && Array.isArray(summary.repos) ? summary.repos : null;
    if (repos && repos.length > 0 && typeof repos[0] === "string") repo = repos[0];
  }
  if (!repo && !ticket) return null;
  return {
    chips: collChip(repo) + (ticket ? extraChip(truncate(ticket, 28), ticket) : ""),
    tooltipLines: tipLines({ repo, ticket }),
  };
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
      // Tool inputs are abbreviated to 500 chars upstream (see copilot-sdk's
      // abbreviateInput) and end with `…` — strict JSON.parse fails on the
      // unterminated string. Recover what we can via regex so recipes that
      // only need a couple of fields (repo, ticket, …) still produce chips.
      return recoverTruncatedJson(raw);
    }
  }
  return null;
}

function recoverTruncatedJson(raw: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  // String values: match key + quoted value with an optional closing quote.
  // The value capture stops at the first unescaped quote OR end of input —
  // so a truncated final value is still recovered up to the cutoff.
  const strRe = /"([^"\\]+)"\s*:\s*"((?:\\.|[^"\\])*)"?/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(raw)) !== null) {
    out[m[1]!] = m[2]!.replace(/…$/, "");
  }
  const scalarRe = /"([^"\\]+)"\s*:\s*(-?\d+(?:\.\d+)?|true|false)/g;
  while ((m = scalarRe.exec(raw)) !== null) {
    if (out[m[1]!] === undefined) {
      const v = m[2]!;
      out[m[1]!] = v === "true" ? true : v === "false" ? false : Number(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
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

/** Inline JS twin of {@link deriveSpanLabelHtml} for the dashboard waterfall.
 *  Keep in sync with the TS function — both must produce identical HTML.
 *  Helpers and the EXTRAS_RECIPES table are hoisted out of the per-row
 *  function so they're built once at script load instead of on every span. */
export function deriveSpanLabelScript(): string {
  return `
    function _wfCollHue(name) {
      var h = 0;
      for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
      return Math.abs(h) % 360;
    }
    function _wfCollStyle(name) {
      var h = _wfCollHue(name);
      return 'background:hsl(' + h + ' 32% 18%);color:hsl(' + h + ' 60% 75%);border:1px solid hsl(' + h + ' 35% 32%)';
    }
    function _wfAbbreviate(name) {
      if (!name) return '';
      if (name.length <= 12) return name;
      var parts = name.split('-');
      if (parts.length <= 1) return name;
      var trailing = [];
      while (parts.length > 1 && /^v?\\d+$/.test(parts[parts.length - 1])) {
        trailing.unshift(parts.pop());
      }
      var initials = parts.map(function (p) { return p[0] || ''; }).join('');
      return trailing.length > 0 ? initials + '-' + trailing.join('-') : initials;
    }
    function _wfCollChip(name, tooltipOverride) {
      if (!name) return '';
      var abbr = _wfAbbreviate(name);
      var title = tooltipOverride != null ? tooltipOverride : (abbr === name ? name : name + ' (' + abbr + ')');
      return '<span class="wf-chip wf-coll" style="' + _wfCollStyle(name) + '" title="' + esc(title) + '">' + esc(abbr) + '</span>';
    }
    function _wfExtraChip(text, tooltip) {
      return '<span class="wf-chip wf-extra wf-mono" title="' + esc(tooltip) + '">' + esc(text) + '</span>';
    }
    function _wfLastSegment(s, sep) {
      var trimmed = s;
      while (trimmed.length > 1 && trimmed.charAt(trimmed.length - 1) === sep) {
        trimmed = trimmed.slice(0, -1);
      }
      var idx = trimmed.lastIndexOf(sep);
      return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
    }
    function _wfTruncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function _wfStrField(obj, key) {
      var v = obj && obj[key];
      return typeof v === 'string' ? v : '';
    }
    function _wfParseInput(raw) {
      if (raw && typeof raw === 'object') return raw;
      if (typeof raw === 'string' && raw.length > 0) {
        try { return JSON.parse(raw); } catch (e) { return _wfRecoverTruncated(raw); }
      }
      return null;
    }
    /* Tool inputs are abbreviated to 500 chars upstream and end with '…'.
       Strict JSON.parse fails — recover what we can via regex so recipes that
       only need a couple of fields (repo, ticket, …) still produce chips. */
    function _wfRecoverTruncated(raw) {
      var out = {};
      var strRe = /"([^"\\\\]+)"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"?/g;
      var m;
      while ((m = strRe.exec(raw)) !== null) {
        out[m[1]] = m[2].replace(/\\u2026$/, '');
      }
      var scalarRe = /"([^"\\\\]+)"\\s*:\\s*(-?\\d+(?:\\.\\d+)?|true|false)/g;
      while ((m = scalarRe.exec(raw)) !== null) {
        if (out[m[1]] === undefined) {
          var v = m[2];
          out[m[1]] = v === 'true' ? true : v === 'false' ? false : Number(v);
        }
      }
      return Object.keys(out).length > 0 ? out : null;
    }
    function _wfTipLines(pairs) {
      var out = [];
      var keys = Object.keys(pairs);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = pairs[k];
        if (v) out.push(k + ': ' + v);
      }
      return out;
    }

    function _wfBuildRepoPathExtras(input) {
      var repo = _wfStrField(input, 'repo');
      var path = _wfStrField(input, 'path');
      if (!repo && !path) return null;
      var tail = path ? _wfLastSegment(path, '/') : '';
      return {
        chips: _wfCollChip(repo) + (tail ? _wfExtraChip(tail, path || tail) : ''),
        tooltipLines: _wfTipLines({ repo: repo, path: path }),
      };
    }

    /* Recipes table — must mirror EXTRAS_RECIPES in the TS twin. */
    var _wfExtrasRecipes = [
      { match: /get_graph_node$/, build: function (input) {
          var id = _wfStrField(input, 'node_id') || _wfStrField(input, 'tag');
          if (!id) return null;
          var colonIdx = id.indexOf(':');
          var kind = colonIdx > 0 ? id.slice(0, colonIdx) : '';
          var tail = colonIdx > 0 ? id.slice(colonIdx + 1) : id;
          return {
            chips: (kind ? _wfCollChip(kind, 'kind: ' + kind) : '') + _wfExtraChip(tail, id),
            tooltipLines: ['node: ' + id],
          };
      } },
      { match: /yggdrasil-symbol_context$/, build: function (input) {
          var repo = _wfStrField(input, 'repo');
          var qn = _wfStrField(input, 'qualified_name') || _wfStrField(input, 'qualifiedName');
          if (!repo && !qn) return null;
          var shortName = qn ? _wfLastSegment(qn, '.') : '';
          return {
            chips: _wfCollChip(repo) + (shortName ? _wfExtraChip(shortName, qn || shortName) : ''),
            tooltipLines: _wfTipLines({ repo: repo, symbol: qn }),
          };
      } },
      { match: /yggdrasil-list_files$/,  build: _wfBuildRepoPathExtras },
      { match: /yggdrasil-read_source$/, build: _wfBuildRepoPathExtras },
      { match: /yggdrasil-search_pattern$/,   build: function (input) { return _wfBuildTwoFieldExtras(input, 'repo', 'pattern'); } },
      { match: /yggdrasil-analyze_ticket$/,   build: _wfBuildAnalyzeTicketExtras },
      // Fallback when neither searchTrace nor input.collection is present.
      { match: /knowledge-search_knowledge$/, build: function (input) { return _wfBuildTwoFieldExtras(input, 'collection', 'query'); } },
    ];

    function _wfBuildTwoFieldExtras(input, primaryField, secondaryField) {
      var primary = _wfStrField(input, primaryField);
      var secondary = _wfStrField(input, secondaryField);
      if (!primary && !secondary) return null;
      var tip = {};
      tip[primaryField] = primary;
      tip[secondaryField] = secondary;
      return {
        chips: _wfCollChip(primary) + (secondary ? _wfExtraChip(_wfTruncate(secondary, 28), secondary) : ''),
        tooltipLines: _wfTipLines(tip),
      };
    }

    function _wfNormalizeToolName(name) {
      if (!name || !name.startsWith('mcp__')) return name;
      var rest = name.slice(5);
      var idx = rest.lastIndexOf('__');
      if (idx === -1) return name;
      return rest.slice(0, idx) + '-' + rest.slice(idx + 2);
    }

    function _wfToolLabelExtras(name, attrs) {
      var input = _wfParseInput(attrs.input);
      if (!input) return null;
      var canon = _wfNormalizeToolName(name);
      for (var i = 0; i < _wfExtrasRecipes.length; i++) {
        if (_wfExtrasRecipes[i].match.test(canon)) return _wfExtrasRecipes[i].build(input, attrs);
      }
      return null;
    }

    /* analyze_ticket: recover repo from output.summary.repos when the
       500-char-truncated input dropped the repo field. */
    function _wfBuildAnalyzeTicketExtras(input, attrs) {
      var ticket = _wfStrField(input, 'ticket');
      var repo = _wfStrField(input, 'repo');
      if (!repo) {
        var out = _wfParseInput(attrs && attrs.output);
        var summary = out && typeof out.summary === 'object' && out.summary !== null ? out.summary : null;
        var repos = summary && Array.isArray(summary.repos) ? summary.repos : null;
        if (repos && repos.length > 0 && typeof repos[0] === 'string') repo = repos[0];
      }
      if (!repo && !ticket) return null;
      return {
        chips: _wfCollChip(repo) + (ticket ? _wfExtraChip(_wfTruncate(ticket, 28), ticket) : ''),
        tooltipLines: _wfTipLines({ repo: repo, ticket: ticket }),
      };
    }

    function deriveSpanLabelHtml(span) {
      if (!span || !span.name) return null;
      var attrs = span.attributes || {};

      // span.name is the display-formatted name for claude-cli; the raw form is on attrs.toolName.
      var rawName = (typeof attrs.toolName === 'string' && attrs.toolName.length > 0)
        ? attrs.toolName
        : span.name;
      var canonName = _wfNormalizeToolName(rawName);
      var verb = (canonName.replace(/^(knowledge|huginn|yggdrasil)[-_]/, '').split(/[_-]/)[0] || '').toLowerCase();
      var verbClass = /^[a-z]+$/.test(verb) ? verb : 'other';
      var verbChip = verb ? '<span class="wf-chip wf-verb wf-verb-' + esc(verbClass) + '">' + esc(verb) + '</span>' : '';

      // Search-tool path
      var collections = null;
      var trace = attrs.searchTrace;
      if (trace && Array.isArray(trace.collections) && trace.collections.length > 0) {
        var names = [];
        for (var i = 0; i < trace.collections.length; i++) {
          var c = trace.collections[i];
          if (c && typeof c.name === 'string' && c.name.length > 0) names.push(c.name);
        }
        if (names.length > 0) collections = names;
      }
      if (!collections && trace && typeof trace.tool === 'string' && trace.tool.length > 0) {
        collections = ['yggdrasil'];
      }
      if (!collections) {
        var inp = _wfParseInput(attrs.input);
        if (inp && typeof inp.collection === 'string' && inp.collection.length > 0) {
          collections = [inp.collection];
        }
      }

      if (collections && collections.length > 0) {
        // Sort by priority — wiki collections lead so they become the primary chip.
        var COLLECTION_PRIORITY = ['wiki'];
        var sorted = [];
        var rest = [];
        var buckets = COLLECTION_PRIORITY.map(function () { return []; });
        for (var i = 0; i < collections.length; i++) {
          var name = collections[i];
          var lower = name.toLowerCase();
          var placed = false;
          for (var j = 0; j < COLLECTION_PRIORITY.length; j++) {
            if (lower.indexOf(COLLECTION_PRIORITY[j]) !== -1) { buckets[j].push(name); placed = true; break; }
          }
          if (!placed) rest.push(name);
        }
        for (var k = 0; k < buckets.length; k++) sorted = sorted.concat(buckets[k]);
        collections = sorted.concat(rest);

        var firstChip = _wfCollChip(collections[0]);
        var moreChip = collections.length > 1
          ? '<span class="wf-chip wf-coll-more" title="' + esc(collections.slice(1).join(', ')) + '">+' + (collections.length - 1) + '</span>'
          : '';

        var summary = summarizeSearchTrace(trace);
        var countsChip = '';
        if (summary) {
          var countsCls = summary.lowConfidence ? 'wf-chip wf-counts wf-low-conf' : 'wf-chip wf-counts';
          var scope = collections.length > 1
            ? ' (summed across ' + collections.length + ' collections)'
            : '';
          var countsTip = summary.lowConfidence
            ? summary.kept + ' kept / ' + summary.fetched + ' fetched' + scope + ' · low confidence'
            : summary.kept + ' kept / ' + summary.fetched + ' fetched' + scope;
          countsChip = '<span class="' + countsCls + '" title="' + esc(countsTip) + '">' +
            summary.kept + '/' + summary.fetched + '</span>';
        }

        var tooltipLines = [span.name, 'collections: ' + collections.join(', ')];
        if (summary) {
          tooltipLines.push('candidates: ' + summary.kept + ' kept / ' + summary.fetched + ' fetched');
          if (summary.topTitle) tooltipLines.push('top: ' + summary.topTitle);
          if (summary.totalMs != null) tooltipLines.push('total: ' + summary.totalMs + 'ms');
          if (summary.lowConfidence) tooltipLines.push('\\u26A0 low confidence');
        }

        return {
          html: verbChip + firstChip + moreChip + countsChip,
          tooltip: tooltipLines.join('\\n'),
        };
      }

      // Per-tool extras path — graph_node / symbol_context / list_files /
      // read_source / search_pattern. Driven by the _wfExtrasRecipes table.
      var extras = _wfToolLabelExtras(canonName, attrs);
      if (extras) {
        return {
          html: verbChip + extras.chips,
          tooltip: ([span.name].concat(extras.tooltipLines)).join('\\n'),
        };
      }
      return null;
    }

    function summarizeSearchTrace(trace) {
      if (!trace || typeof trace !== 'object') return null;
      var buckets, isKept, titleFields, totalMs = null;
      if (Array.isArray(trace.collections) && trace.collections.length > 0) {
        buckets = trace.collections.map(function (c) {
          return {
            candidates: c && Array.isArray(c.candidates) ? c.candidates : [],
            lowConfidence: !!(c && c.confidence && c.confidence.lowConfidence === true),
          };
        });
        isKept = function (c) { return c.kept !== false; };
        titleFields = ['docTitle', 'documentId'];
        if (typeof trace.totalMs === 'number') totalMs = trace.totalMs;
      } else if (Array.isArray(trace.candidates)) {
        buckets = [{ candidates: trace.candidates, lowConfidence: false }];
        isKept = function (c) { return !!(c.stages && c.stages.final); };
        titleFields = ['qualifiedName'];
        if (trace.timingsMs && typeof trace.timingsMs.total === 'number') totalMs = trace.timingsMs.total;
      } else {
        return null;
      }
      var kept = 0, fetched = 0, lowConfidence = false, bestRank = Infinity, bestCand = null;
      for (var i = 0; i < buckets.length; i++) {
        if (buckets[i].lowConfidence) lowConfidence = true;
        var cands = buckets[i].candidates;
        for (var j = 0; j < cands.length; j++) {
          var c = cands[j];
          fetched++;
          if (!c || typeof c !== 'object') continue;
          if (isKept(c)) kept++;
          var rank = c.stages && c.stages.final && typeof c.stages.final.rank === 'number'
            ? c.stages.final.rank : Infinity;
          if (rank < bestRank) { bestRank = rank; bestCand = c; }
        }
      }
      if (fetched === 0) return null;
      var topTitle = null;
      if (bestCand) {
        for (var k = 0; k < titleFields.length; k++) {
          var v = bestCand[titleFields[k]];
          if (typeof v === 'string' && v) { topTitle = v; break; }
        }
      }
      return { kept: kept, fetched: fetched, topTitle: topTitle, lowConfidence: lowConfidence, totalMs: totalMs };
    }
  `;
}

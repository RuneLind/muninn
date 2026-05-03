/** Inline JS: HTML-escape a string (null-safe, handles &<>"') */
export function escScript(): string {
  return `
    function esc(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
  `;
}

const TOOL_INPUT_PRIORITY_KEYS = ['query', 'pattern', 'prompt', 'text', 'command', 'url', 'file_path', 'path', 'subject', 'q', 'search', 'message', 'name', 'skill'];
const TOOL_INPUT_MAX_LENGTH = 140;

/** Extract a short readable summary from tool input (JSON string or object). Exported for testing. */
export function extractToolInputLabel(input: unknown): string {
  if (!input) return '';
  try {
    const obj = typeof input === 'object' ? input as Record<string, unknown> : JSON.parse(input as string);
    for (const key of TOOL_INPUT_PRIORITY_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        return v.length > TOOL_INPUT_MAX_LENGTH ? v.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : v;
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.length > TOOL_INPUT_MAX_LENGTH ? val.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : val;
      }
    }
  } catch { /* invalid JSON — return empty */ }
  return '';
}

/** Strip the redundant MCP-server prefix from a tool span's display name when
 *  we're going to append a more specific identifier (e.g. a collection name). */
const TOOL_NAME_PREFIX_RE = /^(knowledge|huginn|yggdrasil)[-_]/;

interface SpanLike {
  name?: string;
  attributes?: {
    toolName?: unknown;
    toolId?: unknown;
    input?: unknown;
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

/** Render the tool span label as a verb chip + per-collection chips with a
 *  stable color-by-hash, plus a "trace available" dot when the span carries a
 *  Huginn searchTrace. Returns null when no collection is discoverable, so the
 *  caller falls back to the plain text path. Exposed for testing. */
export function deriveSpanLabelHtml(span: SpanLike): { html: string; tooltip: string } | null {
  if (!span || !span.name) return null;
  const attrs = span.attributes ?? {};
  let collections = collectionsFor(attrs);
  if (!collections || collections.length === 0) return null;
  collections = sortCollectionsByPriority(collections);

  const verb = (span.name.replace(TOOL_NAME_PREFIX_RE, "").split(/[_-]/)[0] || "").toLowerCase();
  const verbClass = /^[a-z]+$/.test(verb) ? verb : "other";
  const summary = summarizeSearchTrace(attrs.searchTrace);

  const verbChip = verb
    ? `<span class="wf-chip wf-verb wf-verb-${escAttr(verbClass)}">${escHtml(verb)}</span>`
    : '';
  const first = collections[0]!;
  const firstAbbr = abbreviateCollection(first);
  const firstTitle = firstAbbr === first ? first : `${first} (${firstAbbr})`;
  const firstChip = `<span class="wf-chip wf-coll" style="${collStyle(first)}" title="${escAttr(firstTitle)}">${escHtml(firstAbbr)}</span>`;
  const moreChip = collections.length > 1
    ? `<span class="wf-chip wf-coll-more" title="${escAttr(collections.slice(1).join(", "))}">+${collections.length - 1}</span>`
    : '';

  let countsChip = "";
  if (summary) {
    const cls = summary.lowConfidence ? "wf-chip wf-counts wf-low-conf" : "wf-chip wf-counts";
    const tip = summary.lowConfidence
      ? `${summary.kept} kept / ${summary.fetched} fetched · low confidence`
      : `${summary.kept} kept / ${summary.fetched} fetched`;
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

interface SearchTraceSummary {
  kept: number;
  fetched: number;
  topTitle: string | null;
  lowConfidence: boolean;
  totalMs: number | null;
}

/** Compress a v1 searchTrace blob into the bits we surface in the waterfall
 *  row: candidate counts, top-ranked hit, low-confidence flag, total ms.
 *  Single pass over candidates regardless of producer shape (Huginn collections[]
 *  or Yggdrasil flat candidates[]). Returns null when there's nothing useful. */
export function summarizeSearchTrace(trace: unknown): SearchTraceSummary | null {
  if (!trace || typeof trace !== "object") return null;
  const t = trace as {
    collections?: Array<{
      candidates?: unknown[];
      confidence?: { lowConfidence?: unknown };
    }>;
    candidates?: unknown[];
    timingsMs?: { total?: unknown };
    totalMs?: unknown;
  };

  let buckets: Array<{ candidates: unknown[]; lowConfidence: boolean }>;
  let isKept: (c: { kept?: unknown; stages?: { final?: unknown } }) => boolean;
  let titleFields: readonly string[];
  let totalMs: number | null = null;

  if (Array.isArray(t.collections) && t.collections.length > 0) {
    buckets = t.collections.map((c) => ({
      candidates: Array.isArray(c?.candidates) ? c.candidates : [],
      lowConfidence: !!(c?.confidence && (c.confidence as { lowConfidence?: unknown }).lowConfidence === true),
    }));
    isKept = (c) => c.kept !== false;
    titleFields = ["docTitle", "documentId"];
    if (typeof t.totalMs === "number") totalMs = t.totalMs;
  } else if (Array.isArray(t.candidates)) {
    buckets = [{ candidates: t.candidates, lowConfidence: false }];
    isKept = (c) => !!(c.stages && c.stages.final);
    titleFields = ["qualifiedName"];
    const total = (t.timingsMs as { total?: unknown } | undefined)?.total;
    if (typeof total === "number") totalMs = total;
  } else {
    return null;
  }

  let kept = 0;
  let fetched = 0;
  let lowConfidence = false;
  let bestRank = Infinity;
  let bestCand: Record<string, unknown> | null = null;

  for (const b of buckets) {
    if (b.lowConfidence) lowConfidence = true;
    for (const cand of b.candidates) {
      if (!cand || typeof cand !== "object") { fetched++; continue; }
      const c = cand as { kept?: unknown; stages?: { final?: { rank?: unknown } } };
      fetched++;
      if (isKept(c)) kept++;
      const rank = c.stages?.final?.rank;
      if (typeof rank === "number" && rank < bestRank) {
        bestRank = rank;
        bestCand = cand as Record<string, unknown>;
      }
    }
  }

  if (fetched === 0) return null;

  let topTitle: string | null = null;
  if (bestCand) {
    for (const f of titleFields) {
      const v = bestCand[f];
      if (typeof v === "string" && v) { topTitle = v; break; }
    }
  }

  return { kept, fetched, topTitle, lowConfidence, totalMs };
}

function collectionsFor(attrs: NonNullable<SpanLike["attributes"]>): string[] | null {
  const trace = attrs.searchTrace as
    | { collections?: Array<{ name?: unknown }>; tool?: unknown }
    | undefined;
  if (trace && Array.isArray(trace.collections) && trace.collections.length > 0) {
    const names = trace.collections
      .map((c) => (c && typeof c.name === "string" ? c.name : null))
      .filter((n): n is string => !!n);
    if (names.length > 0) return names;
  }
  // Yggdrasil traces are flatter — no collections, but a `tool` discriminator.
  // Synthesize a single producer chip so the trace dot still shows in the row.
  if (trace && typeof trace.tool === "string" && trace.tool.length > 0) {
    return ["yggdrasil"];
  }
  const raw = attrs.input;
  let input: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") input = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try { input = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (input && typeof input.collection === "string" && input.collection.length > 0) {
    return [input.collection];
  }
  return null;
}

/**
 * Reorder collections so the highest-priority one becomes the primary chip
 * (shown verbatim) instead of getting rolled into "+N". Priority is matched
 * as a case-insensitive substring; ties keep original order. Wiki content is
 * usually the most authoritative source for "how does X work" questions, so
 * it ranks first by default.
 */
const COLLECTION_PRIORITY: readonly string[] = ["wiki"];

export function sortCollectionsByPriority(collections: string[]): string[] {
  const buckets: string[][] = COLLECTION_PRIORITY.map(() => []);
  const rest: string[] = [];
  for (const name of collections) {
    const lower = name.toLowerCase();
    let placed = false;
    for (let i = 0; i < COLLECTION_PRIORITY.length; i++) {
      if (lower.includes(COLLECTION_PRIORITY[i]!)) {
        buckets[i]!.push(name);
        placed = true;
        break;
      }
    }
    if (!placed) rest.push(name);
  }
  return buckets.flat().concat(rest);
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escAttr(s: string): string { return escHtml(s); }

/** Inline JS twin of {@link deriveSpanLabelHtml} for the dashboard waterfall. */
export function deriveSpanLabelScript(): string {
  return `
    function deriveSpanLabelHtml(span) {
      if (!span || !span.name) return null;
      var attrs = span.attributes || {};
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
        var input = null;
        var raw = attrs.input;
        if (raw && typeof raw === 'object') input = raw;
        else if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch (e) {} }
        if (input && typeof input.collection === 'string' && input.collection.length > 0) {
          collections = [input.collection];
        }
      }
      if (!collections || collections.length === 0) return null;
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

      var verb = (span.name.replace(/^(knowledge|huginn|yggdrasil)[-_]/, '').split(/[_-]/)[0] || '').toLowerCase();
      var verbClass = /^[a-z]+$/.test(verb) ? verb : 'other';

      function collHue(name) {
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
        return Math.abs(h) % 360;
      }
      function collStyle(name) {
        var h = collHue(name);
        return 'background:hsl(' + h + ' 32% 18%);color:hsl(' + h + ' 60% 75%);border:1px solid hsl(' + h + ' 35% 32%)';
      }
      function abbreviateCollection(name) {
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

      var verbChip = verb ? '<span class="wf-chip wf-verb wf-verb-' + esc(verbClass) + '">' + esc(verb) + '</span>' : '';
      var first = collections[0];
      var firstAbbr = abbreviateCollection(first);
      var firstTitle = firstAbbr === first ? first : first + ' (' + firstAbbr + ')';
      var firstChip = '<span class="wf-chip wf-coll" style="' + collStyle(first) + '" title="' + esc(firstTitle) + '">' + esc(firstAbbr) + '</span>';
      var moreChip = collections.length > 1
        ? '<span class="wf-chip wf-coll-more" title="' + esc(collections.slice(1).join(', ')) + '">+' + (collections.length - 1) + '</span>'
        : '';

      var summary = summarizeSearchTrace(trace);
      var countsChip = '';
      if (summary) {
        var countsCls = summary.lowConfidence ? 'wf-chip wf-counts wf-low-conf' : 'wf-chip wf-counts';
        var countsTip = summary.lowConfidence
          ? summary.kept + ' kept / ' + summary.fetched + ' fetched · low confidence'
          : summary.kept + ' kept / ' + summary.fetched + ' fetched';
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

/** Inline JS: extract a short readable summary from tool input JSON */
export function toolInputLabelScript(): string {
  return `
    function toolInputLabel(input) {
      if (!input) return '';
      try {
        var obj = typeof input === 'object' ? input : JSON.parse(input);
        var keys = ${JSON.stringify(TOOL_INPUT_PRIORITY_KEYS)};
        for (var i = 0; i < keys.length; i++) {
          var v = obj[keys[i]];
          if (typeof v === 'string' && v.length > 0) return v.length > ${TOOL_INPUT_MAX_LENGTH} ? v.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : v;
        }
        var allKeys = Object.keys(obj);
        for (var j = 0; j < allKeys.length; j++) {
          var val = obj[allKeys[j]];
          if (typeof val === 'string' && val.length > 0) return val.length > ${TOOL_INPUT_MAX_LENGTH} ? val.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : val;
        }
      } catch (e) {}
      return '';
    }
  `;
}

/** Shared JS helper functions used by multiple dashboard components */
export function helpersScript(): string {
  return `
    ${escScript()}

    function escapeHtml(text) {
      return esc(text);
    }

    function escapeAttr(text) {
      return esc(text);
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(ts).toLocaleDateString();
    }

    function deadlineText(ts) {
      if (!ts) return '';
      const diff = ts - Date.now();
      const days = Math.floor(diff / 86400000);
      if (days < 0) return Math.abs(days) + 'd overdue';
      if (days === 0) return 'due today';
      if (days === 1) return 'due tomorrow';
      return 'in ' + days + 'd';
    }

    function fmtMs(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }

    function fmtTokens(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n;
    }

    ${toolInputLabelScript()}

    function formatSchedule(task) {
      if (task.scheduleIntervalMs) {
        const mins = Math.round(task.scheduleIntervalMs / 60000);
        if (mins < 60) return 'Every ' + mins + 'min';
        return 'Every ' + (mins / 60).toFixed(1) + 'h';
      }
      const h = String(task.scheduleHour).padStart(2, '0');
      const m = String(task.scheduleMinute).padStart(2, '0');
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      let days = '';
      if (task.scheduleDays && task.scheduleDays.length < 7) {
        days = ' on ' + task.scheduleDays.map(d => dayNames[d]).join(', ');
      }
      return h + ':' + m + days;
    }
  `;
}

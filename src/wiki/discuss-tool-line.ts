/**
 * A Discuss turn's tool call as a reader reads it: `{label, detail}` in place
 * of `research-wiki_grep {"pattern":…}`. The pane, the inline card and /chat's
 * mirror of a wiki thread all draw it, so it is pure and dependency-free (the
 * /wiki client bundle imports it).
 *
 * The engine runs it on the full input and ships `label`/`detail` with each
 * call; the client runs it only on a call stored before that, whose input was
 * cut at 300 chars, so a field is read by JSON.parse first and by a per-field
 * regex when that fails.
 * Never throws: an unreadable input gives the tool's name and no detail.
 */

export interface DiscussToolLine {
  label: string;
  detail: string;
}

type Fields = Record<string, string>;

const DETAIL_MAX = 160;

function cut(s: string, n = DETAIL_MAX): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The indexes where a string opens at brace depth 1: where a top-level key can start. */
function topLevelStringStarts(s: string): Set<number> {
  const out = new Set<number>();
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      if (depth === 1) out.add(i);
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return out;
}

/** The input's top-level string and number fields. */
function readFields(input: string): Fields {
  const out: Fields = {};
  try {
    const v = JSON.parse(input) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = String(x);
      }
      return out;
    }
  } catch {
    /* cut or not JSON: the regex below */
  }
  // Only a key that opens a string at depth 1 counts: neither a nested key nor
  // a quote escaped inside another string passes for a top-level field.
  const starts = topLevelStringStarts(input);
  const re = /"([A-Za-z_][\w]*)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"?|(-?\d+(?:\.\d+)?|true|false))/g;
  for (const m of input.matchAll(re)) {
    const key = m[1]!;
    if (!starts.has(m.index) || Object.hasOwn(out, key)) continue;
    if (m[2] !== undefined) {
      let s = m[2];
      try {
        s = JSON.parse(`"${s}"`) as string;
      } catch {
        /* a cut escape: keep the raw text */
      }
      out[key] = s;
    } else if (m[3] !== undefined && !input.startsWith("…", m.index + m[0].length)) {
      // A number the cut reached (`"offset":12…`) would read as a smaller one.
      out[key] = m[3];
    }
  }
  return out;
}

/** An absolute path (a snapshot's, a repo's) shows only its last three segments. */
function tail(p: string): string {
  if (!p.startsWith("/") && !p.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(p)) return p;
  const segs = p.split(/[\\/]+/).filter(Boolean);
  return segs.length <= 3 ? p : `…/${segs.slice(-3).join("/")}`;
}

function lines(f: Fields): string {
  const off = Number(f.offset);
  const lim = Number(f.limit);
  const hasOff = f.offset !== undefined && Number.isFinite(off) && off > 0;
  const hasLim = f.limit !== undefined && Number.isFinite(lim) && lim > 0;
  if (hasOff && hasLim) return `lines ${off}–${off + lim - 1}`;
  if (hasOff) return `from line ${off}`;
  if (hasLim) return `lines 1–${lim}`;
  return "";
}

const join = (...parts: string[]) => parts.filter(Boolean).join(", ");
const quoted = (s: string | undefined) => (s ? `"${s}"` : "");
const within = (s: string | undefined) => (s ? ` in ${tail(s)}` : "");

type Rule = (f: Fields) => DiscussToolLine;

const RULES: Record<string, Rule> = {
  "research/wiki_grep": (f) => ({ label: "Searching the wiki", detail: `${quoted(f.pattern)}${within(f.glob ?? f.path)}`.trim() }),
  "research/wiki_read": (f) => ({ label: "Reading", detail: join(f.path ? tail(f.path) : "", lines(f)) }),
  "research/wiki_history": (f) => ({ label: "Reading the wiki's history", detail: `${quoted(f.term)}${within(f.path)}`.trim() }),
  "builtin/Read": (f) => ({ label: "Reading", detail: join(f.file_path ? tail(f.file_path) : f.path ? tail(f.path) : "", lines(f)) }),
  "builtin/Grep": (f) => ({ label: "Searching files", detail: `${quoted(f.pattern)}${within(f.glob ?? f.path)}`.trim() }),
  "builtin/Glob": (f) => ({ label: "Listing files", detail: `${f.pattern ?? ""}${within(f.path)}`.trim() }),
  "yggdrasil/search": (f) => ({ label: "Searching code", detail: `${f.query ?? f.pattern ?? ""}${f.repo ? ` in ${f.repo}` : ""}` }),
  "yggdrasil/file_outline": (f) => ({ label: "Outlining", detail: [f.repo ?? "", f.path ? tail(f.path) : f.file ? tail(f.file) : ""].filter(Boolean).join(": ") }),
  "yggdrasil/symbol_context": (f) => ({ label: "Looking up a symbol", detail: f.symbol ?? f.name ?? f.query ?? "" }),
  "yggdrasil/impact": (f) => ({ label: "Checking impact", detail: f.symbol ?? f.name ?? f.target ?? f.query ?? "" }),
  "yggdrasil/list_repos": () => ({ label: "Listing repos", detail: "" }),
  "yggdrasil/list_files": (f) => ({ label: "Listing files", detail: `${f.repo ?? ""}${f.path ? `${f.repo ? ": " : ""}${tail(f.path)}` : ""}` }),
  "knowledge/search_knowledge": (f) => ({ label: "Searching knowledge", detail: f.query ?? "" }),
};

/** `mcp__server__tool` (claude-cli) and `server-tool` (copilot-sdk) to
 *  `server/tool`; a bare built-in (`Read`) to `builtin/Read`. */
function normalize(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}/${mcp[2]}`;
  const dash = name.indexOf("-");
  if (dash > 0) return `${name.slice(0, dash)}/${name.slice(dash + 1)}`;
  return `builtin/${name}`;
}

function fallback(name: string, f: Fields): DiscussToolLine {
  const label = name.replace(/_/g, " ").trim() || "tool";
  const detail = Object.entries(f)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${cut(v, 60)}`)
    .join(", ");
  return { label, detail };
}

export function discussToolLine(name: string, input: string): DiscussToolLine {
  try {
    const n = typeof name === "string" ? name : "";
    const f = typeof input === "string" && input ? readFields(input) : {};
    const rule = RULES[normalize(n)];
    const line = rule ? rule(f) : fallback(n, f);
    return { label: line.label, detail: cut(line.detail.trim()) };
  } catch {
    return { label: typeof name === "string" && name ? name : "tool", detail: "" };
  }
}

/** One line of text: `label: detail`, or the label alone (/chat's tool line splits it back). */
export function toolLineText(l: DiscussToolLine): string {
  return l.detail ? `${l.label}: ${l.detail}` : l.label;
}

export function discussToolText(name: string, input: string): string {
  return toolLineText(discussToolLine(name, input));
}

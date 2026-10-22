/**
 * `<SystemMap>`: an edge table read as a map of systems (wiki visuals v2,
 * PR 4). Pure and browser-safe: the reader's view (`system-map-view.ts`), the
 * page-text lint (`system-map`) and the drift lint (`system-map-drift`, both in
 * `src/wiki/lint-system-map.ts`) read a block through {@link readSystemMap},
 * so the three cannot disagree about rows, nodes or columns.
 *
 * - Columns are named in either language: From/Fra, To/Til,
 *   Protocol/Protokoll, Status, Evidence/Bevis (any case). From and To are
 *   required.
 * - `Status` is `ok` or `wrong` (any case); a `wrong` row gives its reason in
 *   the evidence column (D10). Any other value reads as no status.
 * - A node is a name in a From or To cell, matched case-free. `external=`
 *   declares the names that have no `repos/` page (`PDL;Sigrun`); the rest
 *   resolve to a `repos/` page stem.
 * - No coordinates are stored (D11). A node's column is its group:
 *   `groups="web=frontend;api=core"`, else `repos` (or `external` for a
 *   declared external). Columns run in the order `groups=` first names them,
 *   then `repos`, then `external`; nodes and rows run in order of first
 *   appearance.
 */

export type SystemMapStatus = "ok" | "wrong";

export interface SystemMapRow {
  /** Row index in the table's data rows (0-based). */
  row: number;
  from: string;
  to: string;
  protocol: string;
  status: SystemMapStatus | null;
  /** The status cell as written, for a finding. */
  statusRaw: string;
  evidence: string;
}

export interface SystemMapNode {
  /** The case-free key (`nodeKey`). */
  key: string;
  /** The first spelling the table uses. */
  name: string;
  external: boolean;
  group: string;
}

export interface SystemMapFinding {
  message: string;
  /** The data row the finding is about, when it is about one. */
  row?: number;
  /** The map cannot be drawn: the reader shows the table as written. */
  fatal?: boolean;
}

export interface SystemMapRead {
  rows: SystemMapRow[];
  /** Every node, in order of first appearance. */
  nodes: SystemMapNode[];
  /** Column order (group names). */
  columns: string[];
  findings: SystemMapFinding[];
  /** False when a fatal finding stops the map. */
  drawable: boolean;
}

/** A table as `chartTable` reads it: visible text, struck text removed. */
export interface SystemMapTable {
  headers: string[];
  rows: string[][];
}

export const SYSTEM_MAP_COLUMNS = {
  from: ["from", "fra"],
  to: ["to", "til"],
  protocol: ["protocol", "protokoll"],
  status: ["status"],
  evidence: ["evidence", "bevis"],
} as const;

export const SYSTEM_MAP_DEFAULT_GROUP = "repos";
export const SYSTEM_MAP_EXTERNAL_GROUP = "external";

/** A node name's case-free key: NFC, trimmed, white space collapsed, lower case. */
export function nodeKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A cell's node name: a `[[repos/x]]` link reads as its text, so a leading
 *  `repos/` or `integrations/` folder and a `.md`/`.mdx` extension are dropped. */
export function nodeName(cell: string): string {
  return cell
    .trim()
    .replace(/^(?:repos|integrations)\//i, "")
    .replace(/\.mdx?$/i, "")
    .trim();
}

/** `external="PDL;Sigrun"`: names split on `;`, blanks dropped. */
export function parseExternalList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface GroupsRead {
  /** node key → group, in the attribute's order. */
  groups: Map<string, string>;
  /** Group names in order of first mention. */
  order: string[];
  /** The node names as written, keyed like `groups`. */
  names: Map<string, string>;
  /** Entries with no `name=group` shape. */
  bad: string[];
}

/** `groups="web=frontend;api=core"`: `name=group` pairs split on `;`. A later
 *  entry for the same name wins. */
export function parseGroups(raw: string | undefined): GroupsRead {
  const groups = new Map<string, string>();
  const names = new Map<string, string>();
  const order: string[] = [];
  const bad: string[] = [];
  for (const entry of (raw ?? "").split(";")) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.lastIndexOf("=");
    const name = eq > 0 ? e.slice(0, eq).trim() : "";
    const group = eq > 0 ? e.slice(eq + 1).trim() : "";
    if (!name || !group) {
      bad.push(e);
      continue;
    }
    groups.set(nodeKey(name), group);
    names.set(nodeKey(name), name);
    if (!order.includes(group)) order.push(group);
  }
  return { groups, order, names, bad };
}

function columnIndex(headers: readonly string[], names: readonly string[]): number[] {
  const out: number[] = [];
  headers.forEach((h, i) => {
    if (names.includes(h.trim().toLowerCase())) out.push(i);
  });
  return out;
}

/** The status cell's reading: `ok` or `wrong` in any case, else null. */
export function readStatus(cell: string): SystemMapStatus | null {
  const s = cell.trim().toLowerCase();
  return s === "ok" || s === "wrong" ? s : null;
}

/**
 * Read one block's table and attributes. `table` null ⇒ the block holds no
 * pipe table (fatal). Every finding is a warning; `fatal` ones stop the map.
 */
export function readSystemMap(attrs: Readonly<Record<string, string>>, table: SystemMapTable | null): SystemMapRead {
  const findings: SystemMapFinding[] = [];
  const empty = (): SystemMapRead => ({ rows: [], nodes: [], columns: [], findings, drawable: false });
  if (!table) {
    findings.push({ message: "holds no pipe table", fatal: true });
    return empty();
  }
  const col: Record<keyof typeof SYSTEM_MAP_COLUMNS, number> = { from: -1, to: -1, protocol: -1, status: -1, evidence: -1 };
  for (const k of Object.keys(SYSTEM_MAP_COLUMNS) as (keyof typeof SYSTEM_MAP_COLUMNS)[]) {
    const hits = columnIndex(table.headers, SYSTEM_MAP_COLUMNS[k]);
    if (hits.length > 1) findings.push({ message: `has ${hits.length} ${SYSTEM_MAP_COLUMNS[k].join("/")} columns; the first is read` });
    col[k] = hits[0] ?? -1;
  }
  for (const k of ["from", "to"] as const) {
    if (col[k] < 0) findings.push({ message: `has no ${SYSTEM_MAP_COLUMNS[k].map(cap).join("/")} column`, fatal: true });
  }
  if (col.from < 0 || col.to < 0) return empty();
  if (col.status < 0) findings.push({ message: "has no Status column; no row is ok or wrong, so drift is not checked" });

  const cell = (r: string[], i: number) => (i < 0 ? "" : (r[i] ?? "").trim());
  const rows: SystemMapRow[] = [];
  table.rows.forEach((r, row) => {
    const from = nodeName(cell(r, col.from));
    const to = nodeName(cell(r, col.to));
    if (!from || !to) {
      findings.push({ message: `row ${row + 1} has no ${!from ? "From" : "To"} name and is not drawn`, row });
      return;
    }
    const statusRaw = cell(r, col.status);
    const status = readStatus(statusRaw);
    const evidence = cell(r, col.evidence);
    if (col.status >= 0 && status === null) {
      findings.push({ message: `row ${from} → ${to} has Status "${statusRaw}"; write ok or wrong`, row });
    }
    if (status === "wrong" && !evidence) {
      findings.push({ message: `row ${from} → ${to} is wrong and gives no reason in the Evidence column`, row });
    }
    rows.push({ row, from, to, protocol: cell(r, col.protocol), status, statusRaw, evidence });
  });
  if (rows.length === 0) {
    findings.push({ message: "has no rows", fatal: true });
    return empty();
  }

  const externals = new Set(parseExternalList(attrs.external).map(nodeKey));
  const g = parseGroups(attrs.groups);
  for (const b of g.bad) findings.push({ message: `groups= entry "${b}" is not name=group` });

  const nodes: SystemMapNode[] = [];
  const seen = new Map<string, SystemMapNode>();
  const add = (name: string) => {
    const key = nodeKey(name);
    if (seen.has(key)) return;
    const external = externals.has(key);
    const node: SystemMapNode = {
      key,
      name,
      external,
      group: g.groups.get(key) ?? (external ? SYSTEM_MAP_EXTERNAL_GROUP : SYSTEM_MAP_DEFAULT_GROUP),
    };
    seen.set(key, node);
    nodes.push(node);
  };
  for (const r of rows) {
    add(r.from);
    add(r.to);
  }
  for (const name of parseExternalList(attrs.external)) {
    if (!seen.has(nodeKey(name))) findings.push({ message: `external= names "${name}", which no row names` });
  }
  for (const [key, name] of g.names) {
    if (!seen.has(key)) findings.push({ message: `groups= names "${name}", which no row names` });
  }

  const columns: string[] = [];
  const used = new Set(nodes.map((n) => n.group));
  for (const c of [...g.order, SYSTEM_MAP_DEFAULT_GROUP, SYSTEM_MAP_EXTERNAL_GROUP]) {
    if (used.has(c) && !columns.includes(c)) columns.push(c);
  }
  return { rows, nodes, columns, findings, drawable: true };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What a page lookup answers: the page's relPath and name. */
export interface NodePageRef {
  relPath: string;
  name: string;
}

export type NodeResolution =
  | { kind: "repo"; page: NodePageRef }
  | { kind: "external"; page: NodePageRef | null }
  | { kind: "unresolved" };

/**
 * Where a node name points. A declared external links its `integrations/`
 * page when one exists; any other name resolves to a `repos/` page stem or to
 * nothing. `resolve` is the wiki index's wikilink resolver (path form:
 * `repos/<name>` tries `.md`, then `.mdx`, case-free).
 */
export function resolveSystemNode(node: Pick<SystemMapNode, "name" | "external">, resolve: (target: string) => NodePageRef | undefined): NodeResolution {
  if (node.external) return { kind: "external", page: resolve(`integrations/${node.name}`) ?? null };
  const page = resolve(`repos/${node.name}`);
  return page ? { kind: "repo", page } : { kind: "unresolved" };
}

/** A node's link on the reader: where a click goes. */
export interface SystemMapNodeLink {
  href: string;
  relPath: string;
  name: string;
}

/** What the reader's view gets for one block (`systemMapView` in
 *  `formatWebHtml`'s options). */
export interface SystemMapViewInput {
  read: SystemMapRead;
  /** The caption as visible text. */
  caption: string;
  tableHtml: string;
  beforeHtml: string;
  afterHtml: string;
  /** Prefix for the block's SVG ids (`sm<n>-`), unique per page. */
  prefix: string;
  /** A node's resolution plus its link, or null where nothing resolves. */
  resolveNode: (node: SystemMapNode) => { kind: NodeResolution["kind"]; link: SystemMapNodeLink | null };
}

export type SystemMapViewRenderer = (input: SystemMapViewInput) => string;

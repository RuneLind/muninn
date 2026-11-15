/**
 * The scan behind `spawn-group.test.ts`: a child that may be killed gets its own
 * process group, because a kill reaches only the direct child otherwise.
 *
 * Like `temp-dir-scan.ts` it parses with the TypeScript compiler and refuses a
 * name, never an import path. Every value-position `runProc` or `spawn` (an
 * identifier, a property name, or a string that is exactly the name) is a site,
 * unless it is the callee of a call whose options object literal carries a
 * top-level `processGroup: true` (runProc's fourth argument) or `detached: true`
 * (spawn's last argument). The child_process module may be imported only for
 * `spawn`, `*Sync` names and types.
 *
 * Out of scope: the sync forms (they return on time and leak with or without
 * `detached`, so no option fixes them in place), `Bun.$`, `e2e/`, callers of a
 * listed alias, wrapper or injected dependency, module access built to avoid the
 * names (`createRequire`, a concatenated module string, `node:cluster`), and
 * whether a kill targets `-pid`. A tripwire for the forms the code uses, not a
 * sandbox.
 */
import path from "node:path";
import ts from "typescript";
import { parseAllowlist } from "./layer-allowlist.ts";
import { sourceFiles } from "./layers.ts";

export const ALLOWLIST = "scripts/spawn-group-allowlist.txt";
export const RUN_PROC_FILE = "src/utils/run-proc.ts";

export type SiteKind = "spawn" | "runProc" | "spread" | "value" | "module" | "parse";
export interface Site {
  path: string;
  line: number;
  kind: SiteKind;
  what: string;
}

const KEY = { spawn: "detached", runProc: "processGroup" } as const;
type Name = keyof typeof KEY;
const NAME = /^(spawn|runProc)$/;
const isName = (t: string): t is Name => NAME.test(t);
// Spelled once, as KEY's keys, so the scan does not flag its own source.
const [SPAWN, RUN_PROC] = Object.keys(KEY) as Name[];
const MODULE = /^(node:)?child_process$/;
const OR = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);
const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ".tsx": ts.ScriptKind.TSX,
  ".jsx": ts.ScriptKind.JSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/** Non-test TS/JS files under the layer guard's roots plus `scripts/`, minus run-proc.ts itself. */
export function scannedFiles(root: string): string[] {
  return sourceFiles(root, ["src", "scripts", "db"], /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/).filter((f) => f !== RUN_PROC_FILE);
}

/** Type positions hold no value; a class's `extends` clause is an expression, though. */
function inType(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    const h = p.parent;
    if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(h) && h.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(h.parent)) return false;
    if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
  }
  return false;
}

function declaredName(n: ts.Node): boolean {
  const p = n.parent;
  const decl = ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p) || ts.isParameter(p)
    || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p);
  return decl && p.name === n;
}

/** An identifier `runProc`/`spawn`, or a property access ending in one, with no other wrapping. */
function simpleName(e: ts.Expression): Name | null {
  if (ts.isIdentifier(e) && isName(e.text)) return e.text;
  if (ts.isPropertyAccessExpression(e) && isName(e.name.text)) return e.name.text;
  return null;
}

/** The name a call's callee is checked under: a simple name, or `(a ?? b)` / `(a || b)` of two runProc names. */
function calleeName(e: ts.Expression): Name | null {
  if (!ts.isParenthesizedExpression(e)) return simpleName(e);
  const b = e.expression;
  return ts.isBinaryExpression(b) && OR.has(b.operatorToken.kind) && simpleName(b.left) === RUN_PROC && simpleName(b.right) === RUN_PROC
    ? RUN_PROC
    : null;
}

/** The call `n` is the checked callee of. Its name is `n`'s: `calleeName` takes only identifiers, and its `??`/`||` form only two runProc names. */
function calleeCall(n: ts.Node): ts.CallExpression | null {
  let e: ts.Node = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
  if (ts.isBinaryExpression(e.parent) && ts.isParenthesizedExpression(e.parent.parent)) e = e.parent.parent;
  const c = e.parent;
  return ts.isCallExpression(c) && c.expression === e && calleeName(c.expression) ? c : null;
}

const optionsArg = (c: ts.CallExpression, name: Name) => (name === RUN_PROC ? c.arguments[3] : c.arguments.at(-1));

/** The initializer of a top-level, non-exported `const`, past an `as const`; `callVerdict` checks it is an object literal. */
function topConstInit(id: ts.Identifier): ts.Expression | null {
  const d = id.parent;
  if (!ts.isVariableDeclaration(d) || d.name !== id || !d.initializer) return null;
  const stmt = d.parent.parent;
  if (!(d.parent.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) return null;
  if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return null;
  return ts.isAsExpression(d.initializer) && ts.isConstTypeReference(d.initializer.type) ? d.initializer.expression : d.initializer;
}

/** `X`'s initializer, when its one declaration is a qualifying top-level const and every other `X` is a checked call's options. */
function constInit(id: ts.Identifier, ids: Map<string, ts.Identifier[]>): ts.Expression | null {
  let lit: ts.Expression | null = null;
  for (const u of ids.get(id.text) ?? []) {
    const decl = topConstInit(u);
    if (decl && lit) return null;
    if (decl) lit = decl;
    else {
      const c = u.parent;
      const name = ts.isCallExpression(c) ? calleeName(c.expression) : null;
      if (!name || optionsArg(c as ts.CallExpression, name) !== u) return null;
    }
  }
  return lit;
}

type Verdict = "ok" | "spread" | "missing";

/** The last property that could set `key` must be `key: true`, with no spread after it. */
function keyVerdict(o: ts.ObjectLiteralExpression, key: string): Verdict {
  let v: Verdict = "missing";
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (v === "ok") v = "spread";
    } else if (ts.isComputedPropertyName(p.name) || (p.name as { text: string }).text === key) {
      v = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.initializer.kind === ts.SyntaxKind.TrueKeyword ? "ok" : "missing";
    }
  }
  return v;
}

function callVerdict(c: ts.CallExpression, name: Name, ids: Map<string, ts.Identifier[]>): Verdict {
  const arg = optionsArg(c, name);
  if (!arg || c.arguments.some(ts.isSpreadElement)) return "missing";
  const lit = ts.isIdentifier(arg) ? constInit(arg, ids) : arg;
  return lit && ts.isObjectLiteralExpression(lit) ? keyVerdict(lit, KEY[name]) : "missing";
}

/** Sites in one file, in source order. */
export function scanSource(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, SCRIPT_KIND[path.extname(file)] ?? ts.ScriptKind.TS);
  if ((sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
    return [{ path: file, line: 1, kind: "parse", what: "TypeScript parse errors" }];
  }
  const ids = new Map<string, ts.Identifier[]>();
  const nodes: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    nodes.push(n);
    if (ts.isIdentifier(n)) ids.set(n.text, [...(ids.get(n.text) ?? []), n]);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const sites = new Map<ts.Node, Site>();
  // Keyed by node: a renamed child_process import is one site under both rules, and so is a call
  // with both runProc names in its callee.
  const add = (at: ts.Node, kind: SiteKind, what: string, key: ts.Node = at): void => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    if (!sites.has(key)) sites.set(key, { path: file, line, kind, what });
  };
  for (const n of nodes) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && MODULE.test(n.moduleSpecifier.text)) {
      const clause = n.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      if (!named?.length || clause!.name) {
        add(n.moduleSpecifier, "module", `a default, namespace or bare import of "${n.moduleSpecifier.text}"`);
        continue;
      }
      for (const s of named) {
        const keeps = !s.propertyName || s.propertyName.text === s.name.text;
        if (s.isTypeOnly || (keeps && (s.name.text === SPAWN || s.name.text.endsWith("Sync")))) continue;
        add(s, "module", `\`${s.getText(sf)}\` imported from "${n.moduleSpecifier.text}"`);
      }
    } else if (ts.isStringLiteralLike(n) && MODULE.test(n.text) && !ts.isImportDeclaration(n.parent) && !inType(n)) {
      add(n, "module", `"${n.text}" used other than as a named import`);
    }
    if (!(ts.isIdentifier(n) || ts.isStringLiteralLike(n)) || !isName(n.text) || inType(n) || declaredName(n)) continue;
    const name = n.text;
    const spec = n.parent;
    if (ts.isImportSpecifier(spec) || ts.isExportSpecifier(spec)) {
      const typeOnly = spec.isTypeOnly || spec.parent.parent.isTypeOnly;
      if (!typeOnly && spec.propertyName && spec.propertyName.text !== spec.name.text) add(spec, "value", `\`${name}\` renamed in \`${spec.getText(sf)}\``);
      continue;
    }
    const call = calleeCall(n);
    if (!call) add(n, "value", `\`${name}\` used as a value, not called`);
    else {
      const v = callVerdict(call, name, ids);
      if (v !== "ok") add(n, v === "spread" ? "spread" : name, `\`${call.expression.getText(sf)}(…)\``, call);
    }
  }
  return [...sites.values()].sort((a, b) => a.line - b.line);
}

const HARM = "a kill (timeout, abort, `.kill()`) reaches only the direct child: grandchildren survive it, and a caller reading the child's pipes waits for them.";
const GROUP = "Use `runProc(…, { processGroup: true })` (src/utils/run-proc.ts), which registers the group so muninn's shutdown and Ctrl-C reach it; a raw `spawn` with `detached: true` is the alternative and then needs its own kill of `-proc.pid` and its own exit handling.";
const WAY_OUT = `If the site is correct as it stands (never killed, or grouped in a way this scan cannot read), add or raise \`<path> <count>\` in ${ALLOWLIST} and say why in the PR.`;

const BODY: Record<SiteKind, string> = {
  spawn: `no top-level \`detached: true\` in its last argument, which must be an object literal or a same-file const; ${HARM} ${GROUP}`,
  runProc: `no top-level \`processGroup: true\` in its options (fourth) argument, which must be an object literal or a same-file const; ${HARM} Pass \`{ processGroup: true }\`: runProc then registers the group so muninn's shutdown and Ctrl-C reach it.`,
  spread: `a spread follows \`detached: true\` / \`processGroup: true\` and may override it; ${HARM} Move the spread before the key.`,
  value: `the scan can check only a direct call with its options literal; ${HARM} Call it directly with the literal, or list the line.`,
  module: `\`exec\` and \`execFile\` ignore \`detached\`, and other child_process forms cannot be checked; ${HARM} Use \`spawn\` or \`runProc\`. ${GROUP}`,
  parse: "the scan does not trust a tree recovered from a syntax error. Fix the syntax.",
};

export function siteMessage(s: Site): string {
  return `${s.path}:${s.line} ${s.what}: ${BODY[s.kind]}${s.kind === "parse" ? "" : ` ${WAY_OUT}`}`;
}

/** `<path> <count>` lines; malformed, duplicate and unsorted lines go to `format`. */
export function parseCounts(text: string): { counts: Map<string, number>; format: string[] } {
  const counts = new Map<string, number>();
  const format: string[] = [];
  let prev = "";
  for (const line of parseAllowlist(text)) {
    const m = /^(\S+) ([1-9]\d*)$/.exec(line);
    if (!m) {
      format.push(`malformed (want "<path> <count>", count 1 or more): ${line}`);
      continue;
    }
    if (counts.has(m[1]!)) format.push(`duplicate entry: ${m[1]}`);
    else counts.set(m[1]!, Number(m[2]));
    if (m[1]! < prev) format.push(`out of order: ${m[1]} after ${prev}`);
    prev = m[1]!;
  }
  return { counts, format };
}

export interface CountCheck {
  /** Files with more live sites than listed, each with its sites. */
  over: string[];
  /** Listed counts above the live count. */
  stale: string[];
}

export function checkCounts(sites: readonly Site[], counts: ReadonlyMap<string, number>): CountCheck {
  const byFile = new Map<string, Site[]>();
  for (const s of sites) byFile.set(s.path, [...(byFile.get(s.path) ?? []), s]);
  const over: string[] = [];
  for (const [file, list] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const n = counts.get(file) ?? 0;
    if (list.length <= n) continue;
    const head = n === 0
      ? `${file}: ${list.length} site(s), not listed in ${ALLOWLIST}`
      : `${file}: ${list.length} sites, listed ${n}: one of them is new (the list is keyed by file and count, so it cannot say which)`;
    over.push([head, ...list.map((s) => `  ${siteMessage(s)}`)].join("\n"));
  }
  const stale: string[] = [];
  for (const [file, n] of counts) {
    const live = byFile.get(file)?.length ?? 0;
    if (live === 0) stale.push(`${file}: listed ${n}, no sites left: remove the line from ${ALLOWLIST}`);
    else if (live < n) stale.push(`${file}: listed ${n}, live ${live}: lower the count to ${live} in ${ALLOWLIST}`);
  }
  return { over, stale };
}

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
  /** Why this form is refused and what to do, before the shared way out. */
  why: string;
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

/**
 * Type positions hold no value. TypeScript counts every `ExpressionWithTypeArguments` as a type node, but only
 * an `implements` clause is erased (an interface's `extends` is, through the interface): a class's `extends`
 * and an instantiation expression (`Bun.spawn<…>`) are values.
 */
function inType(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p)) {
      if (ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ImplementsKeyword) return true;
    } else if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
  }
  return false;
}

const UNWRAP = (e: ts.Node) => ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e);

/** An object or array literal that is a destructuring assignment's target, directly or nested in one. */
function assignTarget(lit: ts.Node): boolean {
  for (let e = lit; ;) {
    let p = e.parent;
    while (UNWRAP(p)) [e, p] = [p, p.parent];
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left === e;
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === e;
    if (ts.isArrayLiteralExpression(p)) e = p;
    else if (ts.isPropertyAssignment(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) e = p.parent;
    else return false;
  }
}

/** A name that declares something. A key in a destructuring assignment's target reads the property instead. */
function declaredName(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isPropertyAssignment(p)) return p.name === n && !assignTarget(p.parent);
  const decl = ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p) || ts.isParameter(p)
    || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p);
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

/**
 * The call or `new` whose callee holds `n` in a shape `calleeCall` does not read: under parentheses, `!`, a
 * cast, `satisfies`, type arguments, `??`/`||`/`&&`/comma or a ternary branch, or directly under `new`.
 */
function unreadCallee(n: ts.Node): ts.CallExpression | ts.NewExpression | null {
  let e: ts.Node = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
  for (;;) {
    const p = e.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === e) return p;
    const through = UNWRAP(p) || ts.isExpressionWithTypeArguments(p)
      || (ts.isBinaryExpression(p) && (OR.has(p.operatorToken.kind) || p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || p.operatorToken.kind === ts.SyntaxKind.CommaToken))
      || (ts.isConditionalExpression(p) && p.condition !== e);
    if (!through) return null;
    e = p;
  }
}

const optionsArg = (c: ts.CallExpression, name: Name) => (name === RUN_PROC ? c.arguments[3] : c.arguments.at(-1));

/**
 * For a declaration of `id`: the initializer of a top-level, non-exported `const`, past an `as const`
 * (`callVerdict` checks it is an object literal), or why it does not qualify. Null when `id` declares no variable.
 */
function topConstInit(id: ts.Identifier): ts.Expression | string | null {
  const d = id.parent;
  if (!ts.isVariableDeclaration(d) || d.name !== id) return null;
  if (!d.initializer) return "has no initializer";
  const stmt = d.parent.parent;
  if (!(d.parent.flags & ts.NodeFlags.Const)) return "is declared with `let` or `var`, not `const`";
  if (!ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) return "is not declared at the top level of the file";
  if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return "is exported";
  return ts.isAsExpression(d.initializer) && ts.isConstTypeReference(d.initializer.type) ? d.initializer.expression : d.initializer;
}

/** A name that declares something other than a variable: a parameter, a destructured binding, a function, class or import. */
function declaresOther(u: ts.Identifier): boolean {
  const p = u.parent;
  return (ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isImportSpecifier(p)
    || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) && p.name === u;
}

/**
 * `X`'s initializer, when its one declaration is a qualifying top-level const and every other `X` is a checked
 * call's options; otherwise the condition that failed.
 */
function constInit(id: ts.Identifier, ids: Map<string, ts.Identifier[]>, sf: ts.SourceFile): { lit: ts.Expression } | { why: string } {
  const uses = ids.get(id.text) ?? [];
  const x = `\`${id.text}\``;
  const vars = uses.filter((u) => ts.isVariableDeclaration(u.parent) && u.parent.name === u).length;
  // Two variable declarations never qualify (two qualifying ones, or one that is a non-option use), so naming that first changes no verdict.
  if (vars > 1) return { why: `${x} is declared more than once in this file` };
  let lit: ts.Expression | null = null;
  for (const u of uses) {
    const decl = topConstInit(u);
    if (typeof decl === "string") return { why: `${x} ${decl}` };
    if (decl) lit = decl;
    else {
      const c = u.parent;
      const name = ts.isCallExpression(c) ? calleeName(c.expression) : null;
      if (!name || optionsArg(c as ts.CallExpression, name) !== u) {
        if (!declaresOther(u)) return { why: `${x} also appears on line ${sf.getLineAndCharacterOfPosition(u.getStart(sf)).line + 1} other than as these options` };
        return { why: vars ? `${x} is declared more than once in this file` : `${x} is not declared in this file as a \`const\`` };
      }
    }
  }
  return lit ? { lit } : { why: `${x} is not declared in this file as a \`const\`` };
}

/** `unread`: the options slot holds something other than an object literal, which may be the command itself. */
type Verdict = { v: "ok" } | { v: "spread" } | { v: "missing"; why?: string; unread?: { shown: string; reason: string } };

/** The last property that could set `key` must be `key: true`, with no spread after it. */
function keyVerdict(o: ts.ObjectLiteralExpression, key: string): Verdict {
  let v: Verdict["v"] = "missing";
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (v === "ok") v = "spread";
    } else if (ts.isComputedPropertyName(p.name) || (p.name as { text: string }).text === key) {
      v = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.initializer.kind === ts.SyntaxKind.TrueKeyword ? "ok" : "missing";
    }
  }
  if (v === "missing" && o.properties.some(ts.isSpreadAssignment)) {
    return { v, why: `its options hold a spread and no \`${key}: true\` of their own, and the scan does not look inside a spread` };
  }
  return { v };
}

const WRAPPER: [(e: ts.Node) => boolean, string][] = [
  [(e) => ts.isAsExpression(e) && ts.isConstTypeReference(e.type), "`as const`"],
  [ts.isSatisfiesExpression, "`satisfies`"],
  [ts.isParenthesizedExpression, "parentheses"],
  [(e) => ts.isAsExpression(e) || ts.isTypeAssertionExpression(e), "a type assertion"],
];

/** A verdict without `why` on a missing key means the options were read and hold no `key: true`. */
function callVerdict(c: ts.CallExpression, name: Name, ids: Map<string, ts.Identifier[]>, sf: ts.SourceFile): Verdict {
  const arg = optionsArg(c, name);
  if (c.arguments.some(ts.isSpreadElement)) return { v: "missing", why: "a spread argument hides which argument holds the options" };
  if (!arg) return { v: "missing" };
  const text = arg.getText(sf).replace(/\s+/g, " ");
  const unread = (reason: string): Verdict => ({ v: "missing", unread: { shown: text.length > 40 ? `${text.slice(0, 40)}…` : text, reason } });
  let lit: ts.Expression = arg;
  if (ts.isIdentifier(arg)) {
    const r = constInit(arg, ids, sf);
    if ("why" in r) return unread(r.why);
    lit = r.lit;
    if (!ts.isObjectLiteralExpression(lit)) return unread(`\`${arg.text}\`'s initializer is not a plain object literal`);
  }
  if (ts.isObjectLiteralExpression(lit)) return keyVerdict(lit, KEY[name]);
  // A command array or string in the last slot is a call with no options at all.
  if (ts.isArrayLiteralExpression(lit) || ts.isStringLiteralLike(lit)) return { v: "missing" };
  let inner = lit;
  while (WRAPPER.some(([is]) => is(inner))) inner = (inner as ts.ParenthesizedExpression).expression;
  if (!ts.isObjectLiteralExpression(inner)) return unread("it is not an object literal");
  return { v: "missing", why: `its options are wrapped in ${WRAPPER.find(([is]) => is(lit))![1]}` };
}

/** Sites in one file, in source order. */
export function scanSource(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, SCRIPT_KIND[path.extname(file)] ?? ts.ScriptKind.TS);
  const diag = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics[0];
  if (diag) {
    const line = sf.getLineAndCharacterOfPosition(diag.start ?? 0).line + 1;
    const text = ts.flattenDiagnosticMessageText(diag.messageText, " ");
    return [{ path: file, line, kind: "parse", what: `TypeScript parse error "${text}"`, why: "the scan does not trust a tree recovered from a syntax error. Fix the syntax." }];
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
  const add = (at: ts.Node, kind: SiteKind, what: string, why: string, key: ts.Node = at): void => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    if (!sites.has(key)) sites.set(key, { path: file, line, kind, what, why });
  };
  for (const n of nodes) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && MODULE.test(n.moduleSpecifier.text)) {
      const clause = n.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      if (!named?.length || clause!.name) {
        add(n.moduleSpecifier, "module", `a default, namespace or bare import of "${n.moduleSpecifier.text}"`, WHY.moduleImport);
        continue;
      }
      for (const s of named) {
        const keeps = !s.propertyName || s.propertyName.text === s.name.text;
        if (s.isTypeOnly || (keeps && (s.name.text === SPAWN || s.name.text.endsWith("Sync")))) continue;
        add(s, "module", `\`${s.getText(sf)}\` imported from "${n.moduleSpecifier.text}"`, moduleNameWhy(s.propertyName?.text ?? s.name.text));
      }
    } else if (ts.isStringLiteralLike(n) && MODULE.test(n.text) && !ts.isImportDeclaration(n.parent) && !inType(n)) {
      add(n, "module", `"${n.text}" used other than as a named import`, WHY.moduleImport);
    }
    if (!(ts.isIdentifier(n) || ts.isStringLiteralLike(n)) || !isName(n.text) || inType(n) || declaredName(n)) continue;
    const name = n.text;
    const spec = n.parent;
    if (ts.isImportSpecifier(spec) || ts.isExportSpecifier(spec)) {
      const typeOnly = spec.isTypeOnly || spec.parent.parent.isTypeOnly;
      // The only rename site. `n` is the original name (a spawner renamed away) or the new one (a binding renamed
      // to a spawner's name); `runProc as spawn` is both and is one site, reported as the first, a rename away.
      if (!typeOnly && spec.propertyName && spec.propertyName.text !== spec.name.text) {
        const from = spec.propertyName.text;
        if (n === spec.propertyName) add(spec, "value", `\`${name}\` renamed in \`${spec.getText(sf)}\``, WHY.rename(from));
        else add(spec, "value", `\`${from}\` renamed to \`${name}\` in \`${spec.getText(sf)}\``, WHY.renameTo(from, name));
      }
      continue;
    }
    const call = calleeCall(n);
    if (!call) {
      const through = ts.isStringLiteralLike(n) ? null : unreadCallee(n);
      if (ts.isStringLiteralLike(n)) add(n, "value", `the string "${name}"`, WHY.string);
      else if (through) {
        const callee = `${ts.isNewExpression(through) ? "new " : ""}${through.expression.getText(sf)}`;
        add(n, "value", `\`${name}\` called through \`${callee}\``, WHY.calledThrough[name]);
      } else add(n, "value", `\`${name}\` used as a value, not called`, WHY.value[name]);
    } else {
      const v = callVerdict(call, name, ids, sf);
      const what = `\`${call.expression.getText(sf)}(…)\``;
      if (v.v === "spread") add(n, "spread", what, WHY.spread(KEY[name]), call);
      else if (v.v === "missing" && v.unread) add(n, name, what, WHY.unread[name](v.unread.shown, v.unread.reason), call);
      else if (v.v === "missing") add(n, name, what, v.why ? `${v.why}. ${WHY.need[name]}` : WHY.missing[name], call);
    }
  }
  return [...sites.values()].sort((a, b) => a.line - b.line);
}

const HARM = "a kill (timeout, abort, `.kill()`) reaches only the direct child: grandchildren survive it, and a caller reading the child's pipes waits for them.";
const FIT = "For a child that runs to completion, use `runProc(…, { processGroup: true })` (src/utils/run-proc.ts), which registers the group so muninn's shutdown and Ctrl-C reach it. "
  + "For a long-lived or streaming child, end the `spawn` call with an options literal holding `detached: true`; that child is outside runProc's shutdown registry, so it needs its own kill of `-proc.pid` and its own exit handling.";
const RP_FIT = "Pass `{ processGroup: true }`: runProc then registers the group so muninn's shutdown and Ctrl-C reach it.";
const HELD = "a top-level, unexported `const` holding that literal, declared once in the file and used only as such options.";
// Two consts, not one object: a `.spawn` property access would be a site of the scan's own.
const NEED_END_SPAWN = "The scan reads the group only from options that end the call: if that argument is the command, add an options literal holding `detached: true` after it; "
  + `if it is the options, put \`detached: true\` in a literal there (\`{ ...opts, detached: true }\`), or in ${HELD}`;
const NEED_END_RP = `The scan reads the group only from runProc's fourth argument: put \`processGroup: true\` in a literal there (\`{ ...opts, processGroup: true }\`), or in ${HELD}`;
const UNREAD = (slot: string, shown: string, reason: string, key: string) =>
  `its ${slot} argument is \`${shown}\` and the scan cannot read options from it (${reason}), so it finds no \`${key}: true\`, and ${HARM}`;
const CALLED_THROUGH = (shapes: string, typed: string, options: string) =>
  `the scan reads a call's options only when its callee is ${shapes}, called without \`new\`, so it cannot check this call. `
  + `Call it in one of those shapes, with no parentheses, \`!\`, cast, \`satisfies\` or operator around the name (type arguments go on the call itself: \`${typed}\`), ${options}.`;
const ALLOWED = "Import from child_process only `spawn`, names ending in `Sync`, and types, each as a named, un-renamed import (`import { execFileSync } from \"node:child_process\"`).";
const NEED = (key: string, slot: string) =>
  `The scan reads \`${key}: true\` only in a bare object literal that is the call's ${slot} argument, or in a top-level, unexported \`const\` declared once in the file and used only as such options.`;
const WAY_OUT = `If the code is right as it stands (never killed, data and not code, or grouped in a way the scan cannot read), add or raise \`<path> <count>\` in ${ALLOWLIST} and give the reason in the PR.`;

const WHY = {
  missing: {
    spawn: `no top-level \`detached: true\` in its last argument, so ${HARM} ${FIT}`,
    runProc: `no top-level \`processGroup: true\` in its options (fourth) argument, so ${HARM} ${RP_FIT}`,
  },
  need: { spawn: NEED("detached", "last"), runProc: NEED("processGroup", "fourth") },
  unread: {
    spawn: (shown: string, reason: string) => `${UNREAD("last", shown, reason, "detached")} ${FIT} ${NEED_END_SPAWN}`,
    runProc: (shown: string, reason: string) => `${UNREAD("fourth", shown, reason, "processGroup")} ${RP_FIT} ${NEED_END_RP}`,
  },
  calledThrough: {
    spawn: CALLED_THROUGH("`spawn` or `x.spawn`", "Bun.spawn<T>(…)", "ending the call with an options literal holding `detached: true`"),
    runProc: CALLED_THROUGH("`runProc`, `x.runProc`, or `(a ?? b)` / `(a || b)` in parentheses with a runProc name on each side", "runProc<T>(…)", "with `{ processGroup: true }` as its fourth argument"),
  },
  spread: (key: string) => `a spread follows \`${key}: true\` and may override it. Move the spread before the key.`,
  value: {
    spawn: "the scan cannot follow a name used as a value to its calls, so it cannot tell whether they are grouped. Call `spawn` directly, with an options literal holding `detached: true` as its last argument.",
    runProc: "the scan cannot follow a name used as a value to its calls, so it cannot tell whether they are grouped. For an injected dependency, call it in the shape the scan reads: `(deps.runProc ?? runProc)(…, { processGroup: true })`.",
  },
  string: "a string spelled exactly like a spawner's name can reach it unchecked, as in `x[\"spawn\"](…)`, so the scan refuses every such string. Call a spawner by its plain name (`x.spawn(…)`); a string that is data, such as an error code, is listed.",
  rename: (from: string) =>
    `the scan follows \`runProc\` and \`spawn\` only under their own names, so it cannot check the calls behind a rename. Import or export the name un-renamed (\`{ ${from} }\`), and give no other binding that name.`,
  renameTo: (from: string, to: string) =>
    `\`${to}\` is reserved for the real spawner: the scan would hold \`${from}\`'s calls to \`${to}\`'s rule, and a reader would take them for the real \`${to}\`. Pick another name for \`${from}\`.`,
  moduleImport: `the scan checks child_process only through named imports. ${ALLOWED}`,
};

/** A refused named import from child_process, by the name it imports. */
function moduleNameWhy(imported: string): string {
  if (imported === SPAWN || imported.endsWith("Sync")) return `the scan follows child_process names only un-renamed. Import it as \`{ ${imported} }\`.`;
  if (imported === "exec" || imported === "execFile") {
    return `\`${imported}\` ignores \`detached\`, so its child stays in muninn's process group and a kill misses the child's own children. ${FIT}`;
  }
  if (imported === "fork") return `the scan does not model \`fork\` (it honours \`detached\`, but the scan does not check its options). ${FIT}`;
  return `the scan does not model \`${imported}\`. ${ALLOWED}`;
}

export function siteMessage(s: Site): string {
  return `${s.path}:${s.line} ${s.what}: ${s.why} ${WAY_OUT}`;
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

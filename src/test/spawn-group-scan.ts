/**
 * The scan behind `src/test/spawn-group.test.ts`: a child that may be killed
 * gets its own process group.
 *
 * A timeout, abort or `.kill()` on a child in this process's group reaches only
 * that child; its own children (git's ssh, a CLI's helpers) keep the pipes open
 * and outlive it. The remedy is `runProc(..., { processGroup: true })`, or
 * `detached: true` plus a kill of `-proc.pid`.
 *
 * It parses each file with the TypeScript compiler, so comments, strings,
 * templates and regex literals are never read as code, and type positions are
 * skipped. A call passes only when the scan can see the group: an object
 * literal (or a same-file top-level `const` bound to one) with a top-level
 * `detached: true` (`processGroup: true` for `runProc`) and no spread or other
 * spelling of the key after it. Any reference to a spawner it cannot resolve to
 * such a call is reported as a site too. `Bun.spawnSync` and the node `*Sync`
 * forms are out of scope: they return no handle to kill.
 */

import * as ts from "typescript";
import { parseAllowlist } from "./layer-allowlist.ts";
import { sourceFiles } from "./layers.ts";

export type SiteKind = "spawn" | "runProc" | "reference";

export interface Site {
  path: string;
  line: number;
  kind: SiteKind;
  /** The call form or the reference, e.g. `Bun.spawn`, `child_process.execFile`, `runProc`. */
  form: string;
}

const CHILD_PROCESS = new Set(["node:child_process", "child_process"]);
const ASYNC_SPAWNERS = new Set(["spawn", "execFile", "exec", "fork"]);
const SYNC_SPAWNERS = new Set(["spawnSync", "execFileSync", "execSync"]);
const RUN_PROC_MODULE = /(^|\/)run-proc(\.ts)?$/;

export const SCANNED_TOPS = ["src", "scripts", "db"] as const;
export const SCANNED_NAME = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const EXEMPT = new Set(["src/utils/run-proc.ts"]);

function scriptKind(path: string): ts.ScriptKind {
  if (/\.(tsx)$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.(jsx)$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function stripParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** True when the literal's last word on `key` is a plain `key: true` with no spread after it. */
export function literalTrue(obj: ts.ObjectLiteralExpression, key: string): boolean {
  let on = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      on = false;
    } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key) {
      on = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
    } else {
      // Shorthand, a quoted or computed key, a method or accessor: not a literal true.
      const n = p.name;
      if (n && (ts.isComputedPropertyName(n) || ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === key))) on = false;
    }
  }
  return on;
}

/** Top-level `const NAME = { ... }` (optionally `as const`) in one file. */
function constObjects(file: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const st of file.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      let init = stripParens(d.initializer);
      if (ts.isAsExpression(init) && ts.isConstTypeReference(init.type)) init = stripParens(init.expression);
      if (ts.isObjectLiteralExpression(init)) out.set(d.name.text, init);
    }
  }
  return out;
}

/** The node is a call's callee itself (a parenthesized callee is not resolved). */
function isCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/** A position that names a binding or a property, not a read of it. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if ((ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === id) return true;
  if (ts.isQualifiedName(p)) return true;
  return false;
}

function isStringNamed(e: ts.Expression, names: (s: string) => boolean): boolean {
  return ts.isStringLiteralLike(e) && names(e.text);
}

/** Every site in one file: unprotected async spawns, `runProc` calls without a group, unresolved references. */
export function scanSource(path: string, source: string): Site[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const consts = constObjects(file);
  const sites: Site[] = [];
  const add = (node: ts.Node, kind: SiteKind, form: string) =>
    sites.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, kind, form });

  // Bindings, by local name.
  const cpNamed = new Map<string, string>(); // local -> imported spawner name
  const cpNamespaces = new Set<string>(); // `import * as cp` / `import cp`
  const bunNamespaces = new Set<string>(["Bun"]);
  const runProcNames = new Set<string>();
  const runProcNamespaces = new Set<string>();

  const optionsSet = (arg: ts.Expression | undefined, key: string): boolean => {
    if (!arg) return false;
    const e = stripParens(arg);
    if (ts.isObjectLiteralExpression(e)) return literalTrue(e, key);
    if (ts.isIdentifier(e)) {
      const bound = consts.get(e.text);
      return bound !== undefined && literalTrue(bound, key);
    }
    return false;
  };

  for (const st of file.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (CHILD_PROCESS.has(spec)) {
        if (clause.name) cpNamespaces.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) cpNamespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (ASYNC_SPAWNERS.has(imported)) cpNamed.set(el.name.text, imported);
          }
        }
      } else if (spec === "bun") {
        if (clause.name) bunNamespaces.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) bunNamespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!el.isTypeOnly && (el.propertyName ?? el.name).text === "spawn") add(el, "reference", `import { spawn } from "bun"`);
          }
        }
      } else if (RUN_PROC_MODULE.test(spec)) {
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) runProcNamespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!el.isTypeOnly && (el.propertyName ?? el.name).text === "runProc") runProcNames.add(el.name.text);
          }
        }
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      if (CHILD_PROCESS.has(st.moduleSpecifier.text)) add(st, "reference", `re-export from "${st.moduleSpecifier.text}"`);
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference)) {
      const e = st.moduleReference.expression;
      if (isStringNamed(e, (s) => CHILD_PROCESS.has(s))) add(st, "reference", `import = require("${(e as ts.StringLiteral).text}")`);
    }
  }

  /** The options test for a spawner call; `Bun.spawn` takes `(cmd, opts)` or `({ cmd, ...opts })`. */
  const spawnProtected = (call: ts.CallExpression, bun: boolean): boolean => {
    const args = call.arguments;
    if (bun) {
      const first = args[0] && stripParens(args[0]);
      return first && args.length === 1 && ts.isObjectLiteralExpression(first) ? optionsSet(first, "detached") : optionsSet(args[1], "detached");
    }
    return args.slice(1).some((a) => optionsSet(a, "detached"));
  };

  /** `runProc(...)`, `(deps.runProc ?? runProc)(...)` or `ns.runProc(...)`: the callee names runProc directly. */
  const runProcCallee = (callee: ts.Expression): boolean => {
    const e = stripParens(callee);
    if (ts.isIdentifier(e)) return runProcNames.has(e.text);
    if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.expression) && runProcNamespaces.has(e.expression.text) && e.name.text === "runProc";
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return runProcCallee(e.left) || runProcCallee(e.right);
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    // Handled above; a local `export { name }` is still visited, as a use of the binding.
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier) || ts.isImportEqualsDeclaration(node)) return;

    if (ts.isCallExpression(node)) {
      const callee = stripParens(node.expression);
      // require("child_process") / import("child_process")
      const arg0 = node.arguments[0];
      if (arg0 && isStringNamed(arg0, (s) => CHILD_PROCESS.has(s))) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, "reference", `import("${(arg0 as ts.StringLiteral).text}")`);
        else if (ts.isIdentifier(callee) && callee.text === "require") add(node, "reference", `require("${(arg0 as ts.StringLiteral).text}")`);
      }
      if (runProcCallee(node.expression)) {
        if (!optionsSet(node.arguments[3], "processGroup")) add(node, "runProc", "runProc");
        // Visit the arguments only: the callee's runProc name is resolved.
        node.arguments.forEach(visit);
        return;
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const obj = stripParens(node.expression);
      const name = node.name.text;
      const onBun = (ts.isIdentifier(obj) && bunNamespaces.has(obj.text)) || (ts.isPropertyAccessExpression(obj) && obj.name.text === "Bun");
      if (onBun && name === "spawn") {
        if (isCallee(node)) {
          const call = node.parent as ts.CallExpression;
          if (!spawnProtected(call, true)) add(call, "spawn", "Bun.spawn");
        } else {
          add(node, "reference", "Bun.spawn used as a value");
        }
        return;
      }
      if (ts.isIdentifier(obj) && cpNamespaces.has(obj.text)) {
        if (isCallee(node)) {
          const call = node.parent as ts.CallExpression;
          if (ASYNC_SPAWNERS.has(name) && !spawnProtected(call, false)) add(call, "spawn", `child_process.${name}`);
          else if (!ASYNC_SPAWNERS.has(name) && !SYNC_SPAWNERS.has(name)) add(node, "reference", `${obj.text}.${name} (child_process)`);
        } else {
          add(node, "reference", `${obj.text}.${name} (child_process) used as a value`);
        }
        return;
      }
      if (ts.isIdentifier(obj) && runProcNamespaces.has(obj.text) && name === "runProc") {
        add(node, "reference", "runProc used as a value");
        return;
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const obj = stripParens(node.expression);
      const arg = node.argumentExpression;
      const onBun = (ts.isIdentifier(obj) && bunNamespaces.has(obj.text)) || (ts.isPropertyAccessExpression(obj) && obj.name.text === "Bun");
      if (onBun && (!ts.isStringLiteralLike(arg) || arg.text === "spawn")) add(node, "reference", "Bun[...] element access");
      else if (ts.isIdentifier(obj) && cpNamespaces.has(obj.text)) add(node, "reference", `${obj.text}[...] (child_process)`);
    }

    // const { spawn } = Bun
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const init = stripParens(node.initializer);
      if (ts.isIdentifier(init) && bunNamespaces.has(init.text)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (el.dotDotDotToken || !ts.isIdentifier(key) || key.text === "spawn") add(el, "reference", "spawn destructured from Bun");
        }
      }
    }

    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const t = node.text;
      const parent = node.parent;
      const isObjectOf = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      if (cpNamed.has(t)) {
        if (isCallee(node)) {
          const call = node.parent as ts.CallExpression;
          if (!spawnProtected(call, false)) add(call, "spawn", `child_process.${cpNamed.get(t)}`);
        } else {
          add(node, "reference", `${cpNamed.get(t)} (child_process) used as a value`);
        }
      } else if (cpNamespaces.has(t) && !isObjectOf) {
        add(node, "reference", `${t} (child_process) used as a value`);
      } else if (runProcNames.has(t) || (runProcNamespaces.has(t) && !isObjectOf)) {
        add(node, "reference", "runProc used as a value");
      } else if (bunNamespaces.has(t) && !isObjectOf && !(ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name))) {
        add(node, "reference", `${t} used as a value`);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites.sort((a, b) => a.line - b.line);
}

/** The remedy line a failure message gives for one site. */
export function remedy(site: Site): string {
  if (site.kind === "runProc") return "pass `processGroup: true` in runProc's options (a literal, or a same-file const object)";
  if (site.kind === "spawn") return "pass `detached: true` and kill `-proc.pid`, or spawn through `runProc(..., { processGroup: true })` (src/utils/run-proc.ts)";
  return "call the spawner directly with `detached: true` and kill `-proc.pid`, or use `runProc(..., { processGroup: true })`";
}

export function siteMessage(site: Site): string {
  return `${site.path}:${site.line} ${site.form}: if this code kills the child (timeout, abort, .kill), the kill reaches only the direct child. Fix: ${remedy(site)}.`;
}

/** The scanned files under `root`: non-test TS/JS source in `SCANNED_TOPS`, minus `EXEMPT`. */
export function scannedFiles(root: string): string[] {
  return sourceFiles(root, SCANNED_TOPS, SCANNED_NAME).filter((f) => !EXEMPT.has(f));
}

export interface AllowlistParse {
  counts: Map<string, number>;
  /** Malformed, unsorted, duplicate or zero-count lines. */
  format: string[];
}

/** `<path> <count>` per line; `#` comments and blank lines skipped. */
export function parseCountAllowlist(text: string): AllowlistParse {
  const counts = new Map<string, number>();
  const format: string[] = [];
  let prev = "";
  for (const line of parseAllowlist(text)) {
    const m = /^(\S+) ([1-9]\d*)$/.exec(line);
    if (!m) {
      format.push(`malformed (want "<path> <count>", count >= 1): ${line}`);
      continue;
    }
    const [, file, n] = m as unknown as [string, string, string];
    if (counts.has(file)) format.push(`duplicate: ${file}`);
    else if (file < prev) format.push(`unsorted: ${file} after ${prev}`);
    counts.set(file, Number(n));
    prev = file;
  }
  return { counts, format };
}

export interface AllowlistCheck {
  /** One message per site in a file whose live count exceeds its listed count. */
  unlisted: string[];
  /** One message per listed file whose count exceeds its live count. */
  stale: string[];
}

export function checkSites(sites: readonly Site[], counts: ReadonlyMap<string, number>): AllowlistCheck {
  const byFile = new Map<string, Site[]>();
  for (const s of sites) byFile.set(s.path, [...(byFile.get(s.path) ?? []), s]);
  const unlisted: string[] = [];
  for (const [file, list] of byFile) {
    const allowed = counts.get(file) ?? 0;
    if (list.length > allowed) {
      unlisted.push(...list.map((s) => `${siteMessage(s)} (${file}: ${list.length} site(s), allowlist allows ${allowed})`));
    }
  }
  const stale: string[] = [];
  for (const [file, allowed] of counts) {
    const live = byFile.get(file)?.length ?? 0;
    if (live < allowed) {
      stale.push(
        live === 0
          ? `${file}: listed ${allowed}, live 0 — remove the line from scripts/spawn-group-allowlist.txt`
          : `${file}: listed ${allowed}, live ${live} — lower the count to ${live} in scripts/spawn-group-allowlist.txt`,
      );
    }
  }
  return { unlisted, stale };
}

/** The allowlist body that matches `sites` exactly, sorted. */
export function allowlistLines(sites: readonly Site[]): string[] {
  const n = new Map<string, number>();
  for (const s of sites) n.set(s.path, (n.get(s.path) ?? 0) + 1);
  return [...n].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, c]) => `${f} ${c}`);
}

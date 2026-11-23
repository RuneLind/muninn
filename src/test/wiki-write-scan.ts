/**
 * The scan behind `wiki-write-guard.test.ts`: every raw filesystem write in the code
 * that can hold a wiki root is a counted site, and `scripts/wiki-write-allowlist.txt`
 * carries each file's count. A new write starts red and gets a reviewed reason.
 *
 * Scanned (`WIKI_SIDE`): `src/wiki/`, `src/gardener/`, `src/share/`, `src/plans/`,
 * `src/sync/`, the five wiki watchers in `src/watchers/` and the `src/dashboard/routes/`
 * files named `wiki-*` or `plans-*`: the code that resolves a wiki root and writes under it.
 *
 * A site, found on the TypeScript AST (comments and strings never count):
 * - `Bun.write` (also `globalThis.Bun.write`, `Bun["write"]`, `const { write } = Bun`), and
 *   `.writer()` / `.write()` / `.delete()` / `.unlink()` on a `Bun.file(…)` call, by property
 *   or quoted key, and a computed key on one;
 * - every use of Bun's shell: `Bun.$` (also `Bun["$"]`, `const { $ } = Bun`). The scan cannot
 *   read what a command does;
 * - every reference to the `"bun"` module that brings in a value: an import with a default,
 *   namespace or named value binding, `export … from`, `import()`, `require`, `import = require`
 *   (type-only forms are not). Its bindings are then read like `Bun`: a default or namespace
 *   binding as `Bun` itself, a named `$` or `write` counted per use, renamed or not, and a named
 *   `file` as `Bun.file`;
 * - every use of a write name (`WRITE_NAMES`) imported by name from `fs`, `node:fs`,
 *   `fs/promises` or `node:fs/promises`: a call, or the name used as a value. The names:
 *   `write`, `writev`, `writeFile`, `appendFile`, `rename`, `rm`, `rmdir`, `unlink`, `mkdir`,
 *   `mkdtemp`, `copyFile`, `cp`, `truncate`, `ftruncate`, `symlink`, `link`, `chmod`, `fchmod`,
 *   `lchmod`, `chown`, `fchown`, `lchown`, `utimes`, `futimes`, `lutimes`, each with its `*Sync`
 *   form, and `createWriteStream`;
 * - a write name read off an fs namespace (`import * as fs`, a default import, or
 *   `promises`): `fs.writeFile`, `fs.promises.rm`, `fs["rename"]`, a destructured write name;
 * - an evasion: a write name renamed on import, an fs namespace used other than by a
 *   property read, a computed key on one, `require`/`import()`/`export … from` of an fs module.
 *
 * NOT proven: that a listed site runs inside `runWikiWriteExclusive` (`src/wiki/queue.ts`).
 * A site on the list was reviewed, not verified to be queued; the count only stops an
 * unreviewed new write from landing, and a write swapped for another in one file keeps
 * its count. Nothing compares the list with the base branch: a raised count is caught in
 * review, not by a ratchet.
 *
 * Not seen:
 * - a write done for this code by a helper outside the scanned files, or by a subprocess
 *   (`git` through `runGit`, `Bun.spawn`);
 * - a write through a file handle from `open()`, and a `Bun.file` held in a variable
 *   before `.write()`;
 * - `Bun` used as a value or behind a cast (`const B = Bun`, `globalThis["Bun"]`,
 *   `(Bun as any).write`), `import.meta.require("bun")`, and a module specifier that is
 *   not a plain string literal (held in a variable, parenthesized or cast);
 * - an fs namespace re-exported (`export { fs }`) or imported as `{ default as fs }`;
 * - property access built to avoid the names (a key in a variable on a non-fs object,
 *   `createRequire`, `Reflect.get`).
 *
 * Counted although no write: names are matched by spelling, not by scope, so a parameter
 * or local that shadows an imported write name, the shell's `$`, `file` or a `bun` alias
 * counts, and so does a type-only re-export of a binding from `"bun"` (`export type { $ }`).
 */
import ts from "typescript";
import { sourceFiles } from "./layers.ts";
import { parseCounts } from "./spawn-group-scan.ts";

export { parseCounts };
export const ALLOWLIST = "scripts/wiki-write-allowlist.txt";

/** Directories (trailing slash) and single files whose code can hold a wiki root. */
export const WIKI_SIDE: readonly string[] = [
  "src/wiki/",
  "src/gardener/",
  "src/share/",
  "src/plans/",
  "src/sync/",
  "src/watchers/consolidation-gardener.ts",
  "src/watchers/wiki-committer.ts",
  "src/watchers/wiki-drafting.ts",
  "src/watchers/wiki-gardener.ts",
  "src/watchers/wiki-linter.ts",
];
/** Route files under `src/dashboard/routes/` that are wiki-side by name. */
const ROUTE = /^src\/dashboard\/routes\/(wiki|plans)-[^/]*$/;

// Built, so the temp-dir guard (src/test/temp-dir-scan.ts) does not read this list as a direct use.
const MKDTEMP = ["mk", "dtemp"].join("");
const BASE = ["write", "writev", "writeFile", "appendFile", "rename", "rm", "rmdir", "unlink", "mkdir", MKDTEMP, "copyFile", "cp", "truncate", "ftruncate", "symlink", "link",
  "chmod", "fchmod", "lchmod", "chown", "fchown", "lchown", "utimes", "futimes", "lutimes"];
export const WRITE_NAMES: ReadonlySet<string> = new Set([...BASE, ...BASE.map((n) => `${n}Sync`), "createWriteStream"]);
const FS_MODULE = /^(node:)?fs(\/promises)?$/;
const BUN_FILE_WRITES = new Set(["writer", "write", "delete", "unlink"]);
/** The module whose default export is `Bun`; any value reference to it is a site. */
const BUN_MODULE = "bun";
/** Bun's shell: `Bun.$`, or `$` imported from `BUN_MODULE`. */
const SHELL = "$";
/** Named bindings from `BUN_MODULE` the scan follows: counted per use (`$`, `write`), or read as `Bun.file`. */
const BUN_FOLLOWED = new Set([SHELL, "write", "file"]);

export type SiteKind = "write" | "value" | "rename" | "namespace" | "module" | "parse";
export interface Site {
  path: string;
  line: number;
  kind: SiteKind;
  what: string;
}

export function isWikiSide(file: string): boolean {
  return ROUTE.test(file) || WIKI_SIDE.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/** Non-test TS files on the wiki side. */
export function scannedFiles(root: string): string[] {
  return sourceFiles(root, ["src"], /\.(ts|tsx|mts|cts)$/).filter(isWikiSide);
}

/** Type positions hold no value (`typeof writeFile`, an implements clause). */
function inType(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p)) {
      if (ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ImplementsKeyword) return true;
    } else if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
  }
  return false;
}

const UNWRAP = (e: ts.Node) => ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e);

/** The expression `e` sits in once parentheses, casts and `!` are peeled off. */
function outer(e: ts.Node): ts.Node {
  while (UNWRAP(e.parent)) e = e.parent;
  return e;
}

/** `e` is the callee of a call (through parentheses, casts and `!`). */
function isCallee(e: ts.Node): boolean {
  const o = outer(e);
  return ts.isCallExpression(o.parent) && o.parent.expression === o;
}

/** `e` is the callee of a call or the tag of a tagged template. */
function isInvoked(e: ts.Node): boolean {
  const o = outer(e);
  return isCallee(e) || (ts.isTaggedTemplateExpression(o.parent) && o.parent.tag === o);
}

/** The text of a string-literal key, or null for any other expression. */
function keyText(e: ts.Expression): string | null {
  let k: ts.Node = e;
  while (UNWRAP(k)) k = (k as ts.ParenthesizedExpression).expression;
  return ts.isStringLiteralLike(k) ? k.text : null;
}

/** An import declaration of `BUN_MODULE` that binds a value: a default, a namespace or a named value. */
function bunValueImport(n: ts.ImportDeclaration): boolean {
  const c = n.importClause;
  if (!c || c.isTypeOnly) return false;
  const b = c.namedBindings;
  return !!c.name || (!!b && (ts.isNamespaceImport(b) || b.elements.some((s) => !s.isTypeOnly)));
}

/** `export … from` `BUN_MODULE` that exports a value: `export *`, `export * as`, or a named value. */
function bunValueExport(n: ts.ExportDeclaration): boolean {
  const c = n.exportClause;
  return !n.isTypeOnly && (!c || ts.isNamespaceExport(c) || c.elements.some((s) => !s.isTypeOnly));
}

/** Sites in one file, in source order. */
export function scanSource(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const diag = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics[0];
  if (diag) {
    const line = sf.getLineAndCharacterOfPosition(diag.start ?? 0).line + 1;
    return [{ path: file, line, kind: "parse", what: `TypeScript parse error "${ts.flattenDiagnosticMessageText(diag.messageText, " ")}": fix the syntax` }];
  }
  const nodes: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    nodes.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const sites: Site[] = [];
  const add = (at: ts.Node, kind: SiteKind, what: string) => sites.push({ path: file, line: lineOf(at), kind, what });

  // Local names bound by the fs imports: write functions, and namespaces (default, `* as`, `promises`).
  const writeLocals = new Set<string>();
  const namespaces = new Set<string>();
  // Locals bound from "bun": aliases of `Bun` (default, namespace, `import = require`), and followed names by local.
  const bunAliases = new Set<string>();
  const bunLocals = new Map<string, string>();
  const declNames = new Set<ts.Node>();
  for (const n of nodes) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === BUN_MODULE) {
      if (!bunValueImport(n)) continue;
      add(n, "module", `an import from "${BUN_MODULE}"`);
      const c = n.importClause!;
      if (c.name) bunAliases.add(c.name.text);
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) bunAliases.add(b.name.text);
      else if (b) {
        for (const s of b.elements) {
          const imported = (s.propertyName ?? s.name).text;
          if (s.isTypeOnly || !BUN_FOLLOWED.has(imported)) continue;
          bunLocals.set(s.name.text, imported);
          declNames.add(s.name);
        }
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === BUN_MODULE) {
      if (bunValueExport(n)) add(n, "module", `a re-export from "${BUN_MODULE}"`);
    } else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && FS_MODULE.test(n.moduleSpecifier.text)) {
      const c = n.importClause;
      if (!c || c.isTypeOnly) continue;
      if (c.name) {
        namespaces.add(c.name.text);
        declNames.add(c.name);
      }
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) {
        namespaces.add(b.name.text);
        declNames.add(b.name);
      } else if (b) {
        for (const s of b.elements) {
          if (s.isTypeOnly) continue;
          const imported = s.propertyName?.text ?? s.name.text;
          declNames.add(s.name);
          if (imported === "promises") namespaces.add(s.name.text);
          else if (WRITE_NAMES.has(imported)) {
            if (imported !== s.name.text) add(s, "rename", `\`${s.getText(sf)}\`: a write function renamed on import`);
            else writeLocals.add(imported);
          }
        }
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && FS_MODULE.test(n.moduleSpecifier.text) && !n.isTypeOnly) {
      add(n, "module", `a re-export from "${n.moduleSpecifier.text}"`);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e) && FS_MODULE.test(e.text)) add(n, "module", `\`import … = require("${e.text}")\``);
      else if (ts.isStringLiteral(e) && e.text === BUN_MODULE && !n.isTypeOnly) {
        add(n, "module", `\`import … = require("${e.text}")\``);
        bunAliases.add(n.name.text);
      }
    } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
      && (FS_MODULE.test(n.arguments[0].text) || n.arguments[0].text === BUN_MODULE)
      && ((ts.isIdentifier(n.expression) && n.expression.text === "require") || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      add(n, "module", `\`${n.expression.getText(sf)}("${n.arguments[0].text}")\`: the scan follows a module only through static imports`);
    }
  }

  /** `Bun`, `globalThis.Bun`, or a default/namespace binding of "bun". */
  const isBun = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && (e.text === "Bun" || bunAliases.has(e.text)))
    || (ts.isPropertyAccessExpression(e) && e.name.text === "Bun" && ts.isIdentifier(e.expression) && e.expression.text === "globalThis");

  /** A `Bun.file(…)` call (or `file(…)` imported from "bun"), through parentheses, casts and `!`. */
  const isBunFileCall = (e: ts.Expression): boolean => {
    let o: ts.Node = e;
    while (UNWRAP(o)) o = (o as ts.ParenthesizedExpression).expression;
    if (!ts.isCallExpression(o)) return false;
    const f = o.expression;
    return (ts.isPropertyAccessExpression(f) && f.name.text === "file" && isBun(f.expression)) || (ts.isIdentifier(f) && bunLocals.get(f.text) === "file");
  };

  /** A read off an fs namespace node `ns` (an identifier, or `ns.promises`). */
  const namespaceUse = (ns: ts.Node, label: string): void => {
    const o = outer(ns);
    const p = o.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === o) {
      const name = p.name.text;
      if (name === "promises") namespaceUse(p, `${label}.promises`);
      else if (WRITE_NAMES.has(name)) add(p.name, isCallee(p) ? "write" : "value", `\`${label}.${name}\`${isCallee(p) ? "" : " used as a value"}`);
      return;
    }
    if (ts.isElementAccessExpression(p) && p.expression === o) {
      const k = keyText(p.argumentExpression);
      if (k === "promises") namespaceUse(p, `${label}.promises`);
      else if (k === null) add(p, "namespace", `\`${p.getText(sf)}\`: a computed key on an fs namespace`);
      else if (WRITE_NAMES.has(k)) add(p, "value", `\`${label}["${k}"]\`: a quoted write name`);
      return;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === o && ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
        if (el.dotDotDotToken || key === null) add(el, "namespace", `\`${el.getText(sf)}\` destructured from an fs namespace`);
        else if (WRITE_NAMES.has(key) || key === "promises") add(el, "value", `\`${key}\` destructured from \`${label}\``);
      }
      return;
    }
    add(o, "namespace", `\`${label}\` used other than by a property read, so the scan cannot see its writes`);
  };

  for (const n of nodes) {
    if (ts.isIdentifier(n) && !declNames.has(n) && !inType(n)) {
      const p = n.parent;
      // A property name, a declared name or an object key is not a use of the binding.
      const isRef = !((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p)) && p.name === n)
        || (ts.isBindingElement(p) && p.propertyName === n) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isQualifiedName(p));
      if (isRef && writeLocals.has(n.text)) add(n, isCallee(n) ? "write" : "value", `\`${n.text}\`${isCallee(n) ? "" : " used as a value"}`);
      else if (isRef && namespaces.has(n.text)) namespaceUse(n, n.text);
      else if (isRef && (bunLocals.get(n.text) === SHELL || bunLocals.get(n.text) === "write")) {
        add(n, isInvoked(n) ? "write" : "value", `\`${n.text}\` (\`Bun.${bunLocals.get(n.text)}\` from "${BUN_MODULE}")${isInvoked(n) ? "" : " used as a value"}`);
      }
      if (ts.isExportSpecifier(p) && p.name === n) {
        const local = (p.propertyName ?? p.name).text;
        // A local re-export (no `from`): `export … from` is a module site of its own.
        const isLocal = !(p.parent.parent as ts.ExportDeclaration).moduleSpecifier;
        if (writeLocals.has(local) || (isLocal && bunLocals.has(local))) add(p, "value", `\`${p.getText(sf)}\` re-exported`);
      }
    }
    // Bun.write, Bun.$ and their spellings.
    if (ts.isPropertyAccessExpression(n) && (n.name.text === "write" || n.name.text === SHELL) && isBun(n.expression)) {
      add(n.name, isInvoked(n) ? "write" : "value", `\`${n.getText(sf)}\`${isInvoked(n) ? "" : " used as a value"}`);
    } else if (ts.isElementAccessExpression(n) && isBun(n.expression)) {
      const k = keyText(n.argumentExpression);
      if (k === null || k === "write" || k === SHELL) add(n, "value", `\`${n.getText(sf)}\`: a quoted or computed key on Bun`);
    } else if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name) && isBun(n.initializer)) {
      for (const el of n.name.elements) {
        const key = (el.propertyName ?? el.name).getText(sf).replace(/^["']|["']$/g, "");
        if (key === "write" || key === SHELL || el.dotDotDotToken) add(el, "value", `\`${el.getText(sf)}\` destructured from Bun`);
      }
    }
    // Bun.file(…).writer() / .write() / .delete() / .unlink(), by property or quoted key.
    if (ts.isPropertyAccessExpression(n) && BUN_FILE_WRITES.has(n.name.text) && isBunFileCall(n.expression)) {
      add(n.name, "write", `\`Bun.file(…).${n.name.text}\``);
    } else if (ts.isElementAccessExpression(n) && isBunFileCall(n.expression)) {
      const k = keyText(n.argumentExpression);
      if (k === null) add(n, "value", `\`${n.getText(sf)}\`: a computed key on \`Bun.file(…)\``);
      else if (BUN_FILE_WRITES.has(k)) add(n, "write", `\`Bun.file(…)["${k}"]\``);
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

const WAY_OUT = `Writes under a wiki root run inside \`runWikiWriteExclusive\` (src/wiki/queue.ts) with the section spanning read→CAS→write→log.md and the commit tail outside it (src/wiki/CLAUDE.md). If this write is right as it stands (a queued writer, or a target that is not a wiki: a temp dir, a cache, a ledger), add or raise \`<path> <count>\` in ${ALLOWLIST} and give the reason in the PR.`;

export function siteMessage(s: Site): string {
  return `${s.path}:${s.line} ${s.what}.${s.kind === "parse" ? "" : ` ${WAY_OUT}`}`;
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
    // A parse site is never covered by a count: listing the file would hide every site in it.
    const n = list.some((s) => s.kind === "parse") ? 0 : counts.get(file) ?? 0;
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

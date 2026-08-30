/**
 * Server-side syntax highlighting for fenced code blocks.
 *
 * Emits `<span class="tok-*">` around a handful of token classes; the colors
 * themselves live in CSS (`--tok-*` in `shared-styles.ts` and the chat's own
 * sheet), so a theme flip costs nothing here and both themes stay one palette.
 *
 * Deliberately hand-rolled rather than a highlighter dependency:
 *  - muninn is server-rendered, so this runs on the server for `/wiki` (via
 *    `src/wiki/render.ts`) and inside the chat's client bundle for a streaming
 *    bubble — one implementation, no CDN, no second bundle;
 *  - the seven token classes below are all the CSS distinguishes, so a
 *    500-rule grammar would be thrown away at paint time anyway.
 *
 * ⚠️ The chat re-render passes this HTML through `sanitizeHtml`, which strips
 * `class` off a `<span>` unless the value is allowlisted. The `tok-*` names are
 * in `COMPONENT_CLASS_ALLOW` (`chat/views/components/component-class-allow.ts`)
 * for exactly that reason —
 * a new token class added here without a matching entry there renders colorless
 * in chat while looking perfect in `/wiki`.
 *
 * The languages are the ones the three wikis actually use (measured 2026-08-30
 * across melosys-kode-wiki, mimir and huginn-jarvis: ts/js ~1600 fences, shell
 * ~516, kotlin 243, json 94, java 89, sql 84, yaml 23). `html` (247 in mimir)
 * needs a markup tokenizer rather than a token-stream one and is left plain —
 * as is `mermaid`, which the reader upgrades to an SVG diagram instead.
 */

import { escapeHtml } from "./markdown-core.ts";

/**
 * The token classes, in ONE place. `TokenClass` is derived from this array and
 * the exported class names are derived from it too, so a rule using a class the
 * chat sanitizer has never heard of is a COMPILE error rather than a fence that
 * renders colored in /wiki and gray in chat. The previous shape — a hand-kept
 * array beside a hand-kept union — could drift, and the test that would have
 * caught it only sees classes the samples happen to produce.
 */
const TOKEN_CLASSES = ["com", "str", "kw", "num", "fn", "typ", "pun"] as const;

type TokenClass = (typeof TOKEN_CLASSES)[number];

/** Every class this module can emit. Spread into `COMPONENT_CLASS_ALLOW`. */
export const HIGHLIGHT_TOKEN_CLASSES: readonly string[] = TOKEN_CLASSES.map((c) => `tok-${c}`);

/**
 * Fences longer than this render plain. Highlighting is linear, but a wiki page
 * carrying a 100k dump is a paste, not code someone reads token by token.
 */
const MAX_HIGHLIGHT_CHARS = 100_000;

/** `null` = matched but unstyled (plain identifiers), which is most of a file. */
type Rule = readonly [TokenClass | null, RegExp];

/**
 * ⚠️ FIRST rule in every grammar, and it must stay first.
 *
 * `src/wiki/render.ts` and `src/wiki/ask-render.ts` park a `[[wikilink]]` / a
 * `[n]` citation as a \u0000-delimited sentinel BEFORE calling `formatWebHtml`, and
 * restore it with a regex over the RENDERED HTML. A fence body can contain one —
 * `arr[1]` inside an Ask answer's citation range, `[[1,2,3]]` in a nested-array
 * literal — and any rule that matches part of it (the C-family capitalized-type
 * heuristic matches `WIKIPAGELINK0`) SPLITS it across a span, so the restore
 * misses, a raw U+0000 is served, and the source text is destroyed rather than
 * merely mis-colored. Matching the whole sentinel with a `null` class keeps it in
 * one plain run, byte-identical, where the restore regex can still find it.
 */
/**
 * ⚠️ Must precede any rule with a VARIABLE-LENGTH LOOKBEHIND.
 *
 * A lookbehind like `(?<=(?:^|\n)[ \t]*)` is re-evaluated at every offset the
 * scanner visits, and inside a run of spaces it walks backwards over the whole
 * run each time — Theta(run^2). Measured before this rule existed: 32k of
 * indentation took 6.8 s in YAML and 1.0 s in shell, i.e. ~68 s at the 100k
 * fence cap, blocking the Bun.serve() loop and freezing the chat tab that runs
 * the same code. Consuming a whitespace run in ONE unstyled match means the
 * lookbehind is only ever attempted at a token, where it walks back to the start
 * of that token's own indentation and no further: linear overall.
 *
 * The rule is harmless in a grammar that has no lookbehind, but it is only
 * ADDED where one exists, so its presence marks the hazard.
 */
const LINE_INDENT: Rule = [null, /[ \t]+/y];

const SENTINEL: Rule = [null, /\u0000[^\u0000\n]*\u0000/y];

// Keyword sets. C-family is the UNION of TS/JS, Kotlin and Java rather than
// three near-identical lists: over-matching a keyword in a sibling language
// colors one word slightly wrong, while three lists drift apart for real.
const C_KEYWORDS = [
  // TS / JS
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "keyof", "let", "new",
  "of", "readonly", "return", "satisfies", "set", "static", "switch", "this",
  "throw", "try", "type", "typeof", "var", "void", "while", "yield",
  // Kotlin
  "by", "companion", "constructor", "crossinline", "data", "fun", "init",
  "inline", "internal", "is", "lateinit", "object", "open", "operator", "out",
  "override", "private", "protected", "public", "reified", "sealed", "suspend",
  "tailrec", "val", "vararg", "when", "where",
  // Java
  "boolean", "byte", "char", "double", "final", "float", "int", "long",
  "native", "package", "record", "short", "strictfp", "super", "synchronized",
  "throws", "transient", "volatile",
  // Literals, shared
  "true", "false", "null", "undefined", "nil",
];

const SQL_KEYWORDS = [
  "add", "all", "alter", "and", "any", "as", "asc", "begin", "between", "by",
  "case", "cast", "coalesce", "column", "commit", "constraint", "create",
  "cross", "delete", "desc", "distinct", "drop", "else", "end", "except",
  "exists", "from", "full", "group", "having", "in", "index", "inner", "insert",
  "intersect", "into", "is", "join", "left", "like", "limit", "not", "null",
  "offset", "on", "or", "order", "outer", "over", "partition", "primary",
  "references", "right", "rollback", "select", "set", "table", "then", "union",
  "unique", "update", "using", "values", "when", "where", "with",
];

const SHELL_KEYWORDS = [
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
  "function", "if", "in", "local", "readonly", "return", "set", "shift",
  "source", "then", "unset", "until", "while",
];

/** `\b(?:a|b|c)\b`, longest-first so `interface` cannot be eaten by `in`. */
function keywordRe(words: string[], flags: string): RegExp {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${sorted.join("|")})\\b`, flags);
}

/**
 * C-family: TypeScript, JavaScript, Kotlin, Java.
 *
 * Order is the grammar. Comments and strings come first (they may contain
 * anything), keywords before the capitalized-identifier heuristic, and that
 * before the call heuristic — so `Foo(` reads as a constructor (`typ`) rather
 * than a function, which is what it is in three of the four languages.
 */
const C_FAMILY: readonly Rule[] = [
  SENTINEL,
  // The block-comment half is UNROLLED (`[^*] | *(?!/)`) rather than the obvious
  // lazy `/\*[\s\S]*?\*\//`. With sticky matching, the lazy form re-scans to
  // end-of-input from EVERY `/*` when no `*/` exists — O(n^2), measured at ~0.9 s
  // for one 99k fence of commented-out code, blocking the whole Bun.serve() loop
  // (and MAX_HIGHLIGHT_CHARS bounds a FENCE, not a page). The unrolled form
  // consumes to the closer or to EOF in one pass; same 99k body, ~2 ms.
  //
  // It also CHANGES BEHAVIOUR, deliberately: the lazy form matched nothing at an
  // unterminated `/*`, which then fell through to the punctuation rule and left
  // the rest of the fence uncolored. This one runs the comment to end-of-input,
  // which is what an editor does. Cosmetic either way — the round-trip and the
  // sentinel restore hold in both — but it is a decision, not a side effect.
  ["com", /\/\/[^\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/)?/y],
  // Kotlin's triple-quoted string first: `"""` would otherwise close instantly
  // as an empty `""` followed by a stray quote.
  ["str", /"""[\s\S]*?"""|`(?:[^`\\]|\\[\s\S])*`?|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?/y],
  ["typ", /@[A-Za-z_$][\w$]*/y], // Java/Kotlin annotations
  ["num", /\b0[xXbBoO][\da-fA-F_]+[lLuUfF]*|\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?[lLfFdD]*\b/y],
  ["kw", keywordRe(C_KEYWORDS, "y")],
  ["typ", /\b[A-Z][\w$]*\b/y],
  ["fn", /\b[a-z_$][\w$]*(?=\s*[(<])/y],
  [null, /\b[\w$]+\b/y],
  ["pun", /[{}()[\]<>,;.:=+\-*/%!&|^~?@#]+/y],
];

/**
 * SQL. Keywords are case-insensitive; `--` is a comment, which is why the
 * punctuation rule can never see a leading `--`.
 */
const SQL: readonly Rule[] = [
  SENTINEL,
  // Unrolled for the same reason as C_FAMILY above.
  ["com", /--[^\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/)?/y],
  // Doubled `''` is SQL's escape, so it must be consumed inside the literal.
  ["str", /'(?:[^']|'')*'?/y],
  ["typ", /"(?:[^"]|"")*"?/y], // quoted identifier
  ["num", /\b\d[\d_]*(?:\.\d+)?\b/y],
  ["kw", keywordRe(SQL_KEYWORDS, "iy")],
  ["fn", /\b[A-Za-z_]\w*(?=\s*\()/y],
  [null, /\b[\w$]+\b/y],
  ["pun", /[(),;.*=<>+\-/|:%!]+/y],
];

/**
 * Shell. The first word of a line is the command, which is the token a reader
 * scans for — so it gets `fn` even though it is not a function anywhere.
 */
const SHELL: readonly Rule[] = [
  SENTINEL,
  ["com", /#[^\n]*/y],
  ["str", /"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?/y],
  ["typ", /\$\{[^}\n]*\}?|\$[\w@*#?$!-]+/y], // variable expansion
  ["kw", keywordRe(SHELL_KEYWORDS, "y")],
  LINE_INDENT, // before the lookbehind below — see LINE_INDENT's header
  ["fn", /(?<=(?:^|\n|\||;|&&)[ \t]*)[\w./-]+/y],
  ["num", /\b\d+\b/y],
  [null, /[\w./-]+/y],
  ["pun", /[|&;()<>{}[\]=$!*?~]+/y],
];

const JSON_RULES: readonly Rule[] = [
  SENTINEL,
  ["typ", /"(?:[^"\\]|\\[\s\S])*"(?=\s*:)/y], // object key
  ["str", /"(?:[^"\\]|\\[\s\S])*"?/y],
  ["kw", /\b(?:true|false|null)\b/y],
  ["num", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
  [null, /\b\w+\b/y],
  ["pun", /[{}[\],:]+/y],
];

const YAML_RULES: readonly Rule[] = [
  SENTINEL,
  ["com", /#[^\n]*/y],
  LINE_INDENT, // before the lookbehind below — see LINE_INDENT's header
  ["typ", /(?<=(?:^|\n)[ \t]*(?:-[ \t]+)?)[\w.$-]+(?=\s*:)/y], // key
  ["str", /"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?/y],
  ["kw", /\b(?:true|false|null|yes|no|on|off|~)\b/y],
  ["num", /-?\b\d+(?:\.\d+)?\b/y],
  [null, /[\w.$-]+/y],
  ["pun", /[:[\]{},|>*&!-]+/y],
];

/** Fence language (lowercased, already trimmed) → grammar. */
const GRAMMARS: Record<string, readonly Rule[]> = {
  typescript: C_FAMILY, ts: C_FAMILY, tsx: C_FAMILY,
  javascript: C_FAMILY, js: C_FAMILY, jsx: C_FAMILY, mjs: C_FAMILY, cjs: C_FAMILY,
  kotlin: C_FAMILY, kt: C_FAMILY, kts: C_FAMILY,
  java: C_FAMILY,
  sql: SQL, postgresql: SQL, psql: SQL, plsql: SQL,
  bash: SHELL, sh: SHELL, shell: SHELL, zsh: SHELL, console: SHELL,
  json: JSON_RULES, jsonc: JSON_RULES,
  yaml: YAML_RULES, yml: YAML_RULES,
};

function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase();
}

/**
 * Escaped, span-wrapped HTML for one fence body.
 *
 * Total by construction: an unknown language, an oversized body, or a stretch
 * of input no rule matches all fall through to plain `escapeHtml`, so the
 * rendered text is always byte-for-byte the source. `highlight.test.ts` pins
 * that as a property over every grammar.
 */
export function highlightCode(code: string, lang: string): string {
  const rules = GRAMMARS[normalizeLang(lang)];
  if (!rules || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);

  let out = "";
  let i = 0;
  // Plain runs are buffered so a 40-character identifier stretch is one
  // escapeHtml call and zero spans, not one per character.
  let plainFrom = 0;

  const flushPlain = (to: number): void => {
    if (to > plainFrom) out += escapeHtml(code.slice(plainFrom, to));
  };

  scan: while (i < code.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      // Sticky (`y`) anchors the match at lastIndex, so a match here is a match
      // AT i. A zero-length match would spin forever, hence the length check.
      if (m && m[0].length > 0) {
        if (cls) {
          flushPlain(i);
          out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
          plainFrom = i + m[0].length;
        }
        i += m[0].length;
        continue scan;
      }
    }
    i++; // whitespace and anything no rule claims
  }
  flushPlain(code.length);
  return out;
}

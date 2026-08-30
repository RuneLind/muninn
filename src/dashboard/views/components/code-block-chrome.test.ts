import { afterEach, test, expect, describe } from "bun:test";
import {
  COMPONENT_FENCE_CHROME,
  copyText,
  fenceLanguage,
  ownChromeSelector,
  shouldEnhanceFence,
} from "./code-block-chrome.ts";
import { COMPONENT_NAMES, type ComponentName } from "../../../format/markdown-ast.ts";
import { COMPONENT_CLASS_ALLOW } from "../../../chat/views/components/component-class-allow.ts";
import { OWN_CHROME_FIXTURES } from "../../../test/own-chrome-fixtures.ts";
import { formatWebHtml } from "../../../web/web-format.ts";

/**
 * The repo has no browser test env (no jsdom/happy-dom), so — like the
 * `code-tabs` and mermaid enhancers — the DOM wiring, the clipboard write and
 * the hover reveal are left to `e2e/wiki-code-highlight.spec.ts`, which drives a
 * real browser against a real page.
 *
 * What is worth pinning here is the SKIP DECISION, because each of its three
 * clauses prevents a visible defect and none of them is obvious from the call
 * site: a mermaid fence wrapped before the diagram enhancer runs leaves an empty
 * header bar around an SVG, a `.code-tabs` fence would get a second bar stacked
 * on the one it already has, and a missing idempotency check double-wraps on
 * every streaming delta.
 */

/** The two Element methods the predicate touches, and nothing else. */
function fakeEl(opts: {
  classes?: string[];
  attrs?: Record<string, string>;
  ancestorSelectors?: string[];
  text?: string;
}): Element {
  const attrs = opts.attrs ?? {};
  const classes = opts.classes ?? [];
  return {
    // Shaped like a real DOMTokenList, not a bare array: `fenceLanguage` happens
    // to work on an array via Array.from, so an array-backed fake would stay
    // green if the implementation switched to `contains`/`value`.
    classList: {
      [Symbol.iterator]: () => classes[Symbol.iterator](),
      contains: (c: string) => classes.includes(c),
      value: classes.join(" "),
      length: classes.length,
    },
    textContent: opts.text ?? "code",
    getAttribute: (n: string) => attrs[n] ?? null,
    // `closest` is called on the PRE, and a selector list must match any of its
    // parts — the real DOM behaviour the skip clause now relies on.
    closest: (sel: string) =>
      sel.split(",").map((s) => s.trim()).some((s) => (opts.ancestorSelectors ?? []).includes(s))
        ? fakeEl({})
        : null,
  } as unknown as Element;
}

describe("fenceLanguage", () => {
  test("reads the language-* class the markdown renderer emits", () => {
    expect(fenceLanguage(fakeEl({ classes: ["language-sql"] }))).toBe("sql");
    expect(fenceLanguage(fakeEl({ classes: ["language-typescript"] }))).toBe("typescript");
  });

  test("a fence with no info string has no language, and that is not an error", () => {
    // The bar still renders — it carries the copy button — with an empty label.
    expect(fenceLanguage(fakeEl({}))).toBe("");
    expect(fenceLanguage(fakeEl({ classes: ["something-else"] }))).toBe("");
  });
});

describe("shouldEnhanceFence", () => {
  test("an ordinary fence is enhanced", () => {
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({ classes: ["language-sql"] }))).toBe(true);
    // …including one with no language at all.
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({}))).toBe(true);
  });

  test("an already-wrapped fence is skipped, so a repaint cannot double-wrap", () => {
    const pre = fakeEl({ attrs: { "data-fence-enhanced": "1" } });
    expect(shouldEnhanceFence(pre, fakeEl({ classes: ["language-sql"] }))).toBe(false);
  });

  test("a mermaid fence is skipped — the reader replaces that pre with a diagram", () => {
    // Belt-and-braces beside running after enhanceMermaid: a FAILED mermaid load
    // leaves the pre in place, and wrapping it then strands a header bar reading
    // "MERMAID" above what is still raw diagram source.
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({ classes: ["language-mermaid"] }))).toBe(false);
  });

  test("a fence inside a component that owns its own chrome is skipped", () => {
    // All three block components in the shared vocabulary wrap a pre/code in
    // chrome of their own: CodeTabs has a tab bar, AnnotatedCode a file-name
    // header, FileTree a bordered tree box. A second header bar stacks inside
    // the first — measured on a real mimir page as a bar reading "ts Kopier"
    // directly under the AnnotatedCode file header, in a nested rounded box.
    for (const sel of [".code-tabs", ".annotated-code", ".filetree"]) {
      const pre = fakeEl({ ancestorSelectors: [sel] });
      expect(shouldEnhanceFence(pre, fakeEl({ classes: ["language-ts"] }))).toBe(false);
    }
  });

  test("an empty fence gets no chrome — a copy button there would clear the clipboard", () => {
    // navigator.clipboard.writeText("") RESOLVES, so the button reported
    // "Copied" while silently emptying whatever the reader had on the
    // clipboard. An empty fence has nothing to copy, so it gets no button.
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({ text: "" }))).toBe(false);
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({ text: "   \n\t " }))).toBe(false);
    expect(shouldEnhanceFence(fakeEl({}), fakeEl({ text: "SELECT 1;" }))).toBe(true);
  });
});

/**
 * The `execCommand` path is not a legacy fallback here — `navigator.clipboard`
 * is unavailable on a page served over plain HTTP to anything but localhost,
 * which is exactly how this dashboard is reached over a tailnet. So it is the
 * PRIMARY path on the deployment that matters, and the e2e (which runs on
 * 127.0.0.1, a secure context) can never reach it.
 */
describe("copyText", () => {
  const g = globalThis as unknown as {
    navigator?: unknown;
    document?: unknown;
  };
  const realNavigator = g.navigator;
  const realDocument = g.document;

  function withEnv(opts: {
    clipboard?: { writeText: (t: string) => Promise<void> };
    execCommandResult?: boolean | (() => never);
  }): { appended: number; removed: number; value: () => string } {
    let value = "";
    const box = { appended: 0, removed: 0 };
    g.navigator = opts.clipboard ? { clipboard: opts.clipboard } : {};
    g.document = {
      createElement: () => ({
        set value(v: string) {
          value = v;
        },
        get value() {
          return value;
        },
        setAttribute: () => {},
        style: {},
        select: () => {},
      }),
      body: {
        appendChild: () => {
          box.appended++;
        },
        removeChild: () => {
          box.removed++;
        },
      },
      execCommand: () => {
        const r = opts.execCommandResult;
        if (typeof r === "function") return r();
        return r ?? true;
      },
    };
    return { ...box, value: () => value, get appended() { return box.appended; }, get removed() { return box.removed; } } as never;
  }

  afterEach(() => {
    g.navigator = realNavigator;
    g.document = realDocument;
  });

  test("uses the async clipboard when it is available", async () => {
    // Collected into an array rather than a `let`: TS narrows a `string | null`
    // local to `null` when the only assignment is inside a callback it cannot
    // see running, and `bun test` strips types so only tsc catches it.
    const written: string[] = [];
    withEnv({
      clipboard: {
        writeText: async (t: string) => {
          written.push(t);
        },
      },
    });
    expect(await copyText("SELECT 1;")).toBe(true);
    expect(written).toEqual(["SELECT 1;"]);
  });

  test("falls back to the textarea path when the clipboard API is absent", async () => {
    const env = withEnv({ execCommandResult: true });
    expect(await copyText("SELECT 1;")).toBe(true);
    // The value really was staged for the copy, and the node was cleaned up.
    expect(env.value()).toBe("SELECT 1;");
    expect(env.appended).toBe(1);
    expect(env.removed).toBe(1);
  });

  test("falls back when the clipboard API REJECTS (permission denied)", async () => {
    const env = withEnv({
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
      execCommandResult: true,
    });
    expect(await copyText("SELECT 1;")).toBe(true);
    expect(env.value()).toBe("SELECT 1;");
  });

  test("reports failure rather than throwing when both paths fail", async () => {
    withEnv({ execCommandResult: false });
    expect(await copyText("SELECT 1;")).toBe(false);
    // …including when execCommand has been removed outright.
    withEnv({
      execCommandResult: () => {
        throw new Error("execCommand is not a function");
      },
    });
    expect(await copyText("SELECT 1;")).toBe(false);
  });
});

/**
 * The enumeration this module keeps getting WRONG, closed structurally.
 *
 * Which block components wrap a fence in chrome of their own was hand-listed
 * twice and was incomplete both times — first `.code-tabs` alone (so
 * AnnotatedCode and FileTree rendered a doubled header bar on real mimir
 * pages), then those three (so a standalone `<Tab>` still did). It is a
 * `Record<ComponentName, …>` now, which is a COMPILE error until a new
 * component is classified; these tests close the other half — that the classes
 * named are the ones the renderer actually emits, since a typo'd selector
 * matches nothing and fails exactly as silently as a missing entry.
 */
describe("COMPONENT_FENCE_CHROME", () => {
  /** The SHARED map. This was the THIRD hand-listed copy, and it is why the
   *  consolidation had to finish: dropping a component from the shared map left
   *  this test green over its own duplicate — the drift that module exists to
   *  end, surviving inside the file that documents the rule. */
  const withFence = OWN_CHROME_FIXTURES;

  test("every component in the vocabulary is classified", () => {
    // The Record type already makes this a compile error; asserted at runtime
    // too so the failure names the component rather than a type position.
    for (const name of COMPONENT_NAMES) {
      expect(Object.hasOwn(COMPONENT_FENCE_CHROME, name)).toBe(true);
    }
    expect(Object.keys(COMPONENT_FENCE_CHROME).sort()).toEqual([...COMPONENT_NAMES].sort());
  });

  test("each chrome-owning component really emits the class it is mapped to", () => {
    const entries = Object.entries(COMPONENT_FENCE_CHROME) as [ComponentName, string | null][];
    for (const [name, selector] of entries) {
      if (!selector) continue;
      const md = withFence[name];
      expect(md, `no fixture for chrome-owning component ${name}`).toBeTruthy();
      const html = formatWebHtml(md!);
      // It wraps a fence…
      expect(html).toContain("<pre>");
      // …in the wrapper the enhancer will look for. A typo here matches
      // nothing and reintroduces the doubled bar silently.
      expect(html).toContain(`class="${selector.slice(1)}"`);
    }
  });

  test("a component classified as owning NO chrome emits none of those wrappers", () => {
    const chromeClasses = Object.values(COMPONENT_FENCE_CHROME).filter(Boolean) as string[];
    const html = formatWebHtml("<Callout>\n```ts\nconst x = 1;\n```\n</Callout>");
    expect(html).toContain("<pre>"); // a callout CAN hold a fence…
    for (const cls of chromeClasses) {
      expect(html).not.toContain(`class="${cls.slice(1)}"`); // …and owns no chrome for it
    }
  });

  test("the derived selector is a comma list of the non-null entries", () => {
    expect(ownChromeSelector({ A: ".a", B: null, C: ".c" })).toBe(".a, .c");
    // The case no module-level const can reach, and the reason this is
    // injectable: an all-null map yields the EMPTY selector.
    expect(ownChromeSelector({ A: null, B: null })).toBe("");
    expect(ownChromeSelector({})).toBe("");
  });

  test("an empty selector is skipped, not passed to closest()", () => {
    // `closest("")` throws a SyntaxError — verified in Chromium — which escapes
    // enhanceCodeBlocks at the first fence and takes the statements chained
    // after it at several call sites with it. An all-null Record is a legal,
    // compile-clean, tsc-clean edit of the map above, so the guard has to hold.
    let asked: string | null = null;
    const pre = {
      getAttribute: () => null,
      closest: (sel: string) => {
        asked = sel;
        if (sel === "") throw new SyntaxError("The provided selector is empty.");
        return null;
      },
    } as unknown as Element;
    const code = { classList: ["language-ts"], textContent: "x" } as unknown as Element;

    expect(() => shouldEnhanceFence(pre, code, "")).not.toThrow();
    expect(shouldEnhanceFence(pre, code, "")).toBe(true);
    expect(asked).toBeNull(); // closest() was never called at all
  });

  test("a standalone <Tab> is skipped — the fourth component, missed twice", () => {
    const pre = { getAttribute: () => null, closest: (sel: string) =>
      sel.split(",").map((x) => x.trim()).includes(".code-tab-standalone") ? {} : null } as unknown as Element;
    const code = { classList: ["language-ts"], textContent: "const x = 1;" } as unknown as Element;
    expect(shouldEnhanceFence(pre, code)).toBe(false);
  });
});

/**
 * `sanitizeHtml`'s rule, mirrored: a `class` attribute survives only when EVERY
 * space-separated token is allowlisted, and `<code>` is exempt by TAG.
 *
 * ⚠️ **By TAG, not by the class containing a `language-*` token.** The two
 * coincide only because `codeFenceHtml` is the sole emitter of that prefix and
 * only ever on a `<code>` — and the content-keyed form really did miss a case;
 * the test below is that case.
 *
 * ⚠️ `[^>]*?` cannot cross a `>`, so an UNESCAPED `>` inside an EARLIER attribute
 * value makes this skip that element's class silently — it fails OPEN. Not
 * reachable today, and for a stronger reason than "the attribute is escaped":
 * measured, a component's `file`/`label` never becomes an HTML ATTRIBUTE at all —
 * it is emitted as escaped TEXT CONTENT (`<div class="annotated-code-file">a&gt;b.ts</div>`),
 * so there is no author-controlled attribute value on these wrappers to carry a
 * `>` in the first place. Written down because the failure direction is the quiet
 * one, and because the earlier spelling of this note named the wrong mechanism.
 */
function strippedClassAttributes(label: string, html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sclass="([^"]*)"/g)) {
    if (m[1]!.toLowerCase() === "code") continue;
    const tokens = m[2]!.trim().split(/\s+/).filter(Boolean);
    // An empty class attribute is stripped too; stripping nothing breaks nothing.
    if (tokens.length === 0) continue;
    const bad = tokens.filter((t) => !COMPONENT_CLASS_ALLOW.has(t));
    if (bad.length > 0) out.push(`${label}: class="${m[2]}" (unlisted: ${bad.join(", ")})`);
  }
  return out;
}

/**
 * The THIRD leg of the own-chrome contract, and the one that had no guard.
 *
 * A component is skipped when `pre.closest(COMPONENT_FENCE_CHROME[name])`
 * matches. Two things already have tests: the Record is exhaustive over
 * `ComponentName` (a compile error otherwise), and each chrome-owning component
 * really emits the class it is mapped to. The third — that the class SURVIVES
 * the chat sanitizer — did not, and `annotated-code`/`filetree` were missing from
 * `COMPONENT_CLASS_ALLOW` from #494 until the PR this test arrived with, so the
 * skip was inert in chat and those blocks grew a second bar there while `/wiki`
 * was correct.
 *
 * Derived over the Record rather than re-listing the four components:
 * classifying a fifth (`Diff` is the obvious next one — `web-format.ts` already
 * emits `class="diff"`) must fail HERE until its class is allowlisted, not
 * silently in a browser nobody is looking at. Same default-deny reason
 * `COMPONENT_FENCE_CHROME` is a `Record` and not a list.
 */
test("componentClassAllowCoversOwnChrome: every own-chrome class SURVIVES the chat sanitizer", () => {
  // `Object.entries` widens the key to `string`; the fixture map is keyed by
  // `ComponentName` on purpose (a typo'd key must be a compile error, not a
  // silent coverage hole), so the narrowing happens once, here.
  const owners = (Object.entries(COMPONENT_FENCE_CHROME) as [ComponentName, string | null][])
    .filter(([, sel]) => sel !== null);

  // Every chrome-owning component has a fixture. Derived from the RECORD, which
  // is the half that can fail: the e2e sibling built its expectation from the
  // fixture map itself and was a tautology — measured, dropping `Tab` left it
  // green over three components.
  expect(
    owners.map(([name]) => name).filter((name) => !Object.hasOwn(OWN_CHROME_FIXTURES, name)),
  ).toEqual([]);

  const stripped = owners.flatMap(([name]) =>
    strippedClassAttributes(name, formatWebHtml(OWN_CHROME_FIXTURES[name]!)),
  );
  // Named in the failure: `AnnotatedCode: class="annotated-code-file"` is the
  // whole diagnosis, and a bare length assertion would withhold it.
  expect(stripped).toEqual([]);
});

/**
 * The exemption AXIS, pinned on synthetic markup rather than through the renderer.
 *
 * ⚠️ This is the case the round-4 commit said it could not isolate — WRONGLY. It
 * only tried stamping a `language-*` token on the MAPPED wrapper, which also
 * breaks the sibling "emits the class it is mapped to" assertion, so both forms
 * went red and the difference stayed invisible. Put the token on a NON-mapped
 * INNER wrapper and the sibling never notices: measured by making `web-format.ts`
 * emit `<div class="annotated-code-file language-bash">`, the tag-keyed form
 * fails and the content-keyed form passes 18/18. So the axis change is a real
 * behaviour change with a demonstrable red, not the "analytical" one that commit
 * claimed — and this test is the demonstration, kept so the claim cannot rot.
 *
 * It matters because `classIsComponent` requires EVERY token: that class would be
 * stripped whole in chat, unstyling a header the block still renders.
 */
test("the exemption is keyed on the TAG — a non-code element carrying language-* is still checked", () => {
  const html =
    '<div class="annotated-code"><div class="annotated-code-file language-bash">a.ts</div>' +
    '<pre><code class="language-ts">x</code></pre></div>';
  // The `<code>` is exempt by tag; the div carrying the same prefix is not.
  expect(strippedClassAttributes("probe", html)).toEqual([
    'probe: class="annotated-code-file language-bash" (unlisted: language-bash)',
  ]);
});

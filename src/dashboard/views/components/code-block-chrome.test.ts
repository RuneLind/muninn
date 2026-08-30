import { afterEach, test, expect, describe } from "bun:test";
import {
  COMPONENT_FENCE_CHROME,
  copyText,
  fenceLanguage,
  ownChromeSelector,
  shouldEnhanceFence,
} from "./code-block-chrome.ts";
import { COMPONENT_NAMES } from "../../../format/markdown-ast.ts";
import { COMPONENT_CLASS_ALLOW } from "../../../chat/views/components/web-format-browser.ts";
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
  /** A component wrapping one fence, in the shape its parser expects. */
  const withFence: Partial<Record<string, string>> = {
    CodeTabs: '<CodeTabs>\n<Tab label="A">\n```ts\nconst x = 1;\n```\n</Tab>\n</CodeTabs>',
    Tab: '<Tab label="A">\n```ts\nconst x = 1;\n```\n</Tab>',
    AnnotatedCode: '<AnnotatedCode file="a.ts" lang="ts">\n```ts\nconst x = 1;\n```\n\nNote.\n</AnnotatedCode>',
    FileTree: "<FileTree>\n```\nsrc/\n```\n</FileTree>",
  };

  test("every component in the vocabulary is classified", () => {
    // The Record type already makes this a compile error; asserted at runtime
    // too so the failure names the component rather than a type position.
    for (const name of COMPONENT_NAMES) {
      expect(Object.hasOwn(COMPONENT_FENCE_CHROME, name)).toBe(true);
    }
    expect(Object.keys(COMPONENT_FENCE_CHROME).sort()).toEqual([...COMPONENT_NAMES].sort());
  });

  test("each chrome-owning component really emits the class it is mapped to", () => {
    for (const [name, selector] of Object.entries(COMPONENT_FENCE_CHROME)) {
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
 * The THIRD leg of the own-chrome contract, and the one that had no guard.
 *
 * A component is skipped when `pre.closest(COMPONENT_FENCE_CHROME[name])`
 * matches. Two things already have tests: the Record is exhaustive over
 * `ComponentName` (a compile error otherwise), and each chrome-owning component
 * really emits the class it is mapped to. The third — that the class SURVIVES
 * the chat sanitizer — did not, and `annotated-code`/`filetree` were missing
 * from `COMPONENT_CLASS_ALLOW` from #494 until the PR this test arrived with, so
 * the skip was inert in chat and those blocks grew a second bar there while
 * `/wiki` was correct.
 *
 * Derived over the Record, deliberately, rather than re-listing the four
 * components: classifying a fifth (`Diff: ".diff"` is the obvious next one —
 * `web-format.ts` already emits `class="diff"`) must fail HERE until its class is
 * allowlisted, not silently in a browser nobody is looking at. That is the same
 * default-deny reason `COMPONENT_FENCE_CHROME` is a `Record` and not a list.
 */
test("componentClassAllowCoversOwnChrome: every own-chrome selector survives the chat sanitizer", () => {
  const missing = Object.entries(COMPONENT_FENCE_CHROME)
    .filter(([, sel]) => sel !== null)
    .flatMap(([name, sel]) =>
      // A selector is `.class` today; split on `,` and strip the dot so a future
      // multi-class entry is checked rather than silently skipped.
      sel!
        .split(",")
        .map((s) => s.trim().replace(/^\./, ""))
        .filter((cls) => !COMPONENT_CLASS_ALLOW.has(cls))
        .map((cls) => `${name} -> .${cls}`),
    );
  // Named in the failure: "AnnotatedCode -> .annotated-code" is the whole
  // diagnosis, and a bare length assertion would withhold it.
  expect(missing).toEqual([]);
});

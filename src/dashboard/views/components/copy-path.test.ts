import { afterEach, test, expect, describe } from "bun:test";
import { copyText, wikiPagePath } from "./copy-path.ts";

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
    selectThrows?: boolean;
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
        select: () => {
          if (opts.selectThrows) throw new Error("select is not a function");
        },
        // The cleanup the implementation calls. Counted on the ELEMENT, not on
        // `body.removeChild`: `ta.remove()` is what runs in the `finally`, and a
        // fake that only counted the body method would report zero removals for
        // a correct implementation.
        remove: () => {
          box.removed++;
        },
      }),
      body: {
        appendChild: () => {
          box.appended++;
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

  /**
   * The reason this function has one home instead of two.
   *
   * The fence copy button's copy of it removed the staged `<textarea>` in the
   * statement AFTER `execCommand`, so any throw from `select()`/`execCommand` —
   * a CSP sandbox, a browser that has finished removing the API — left a hidden
   * but FOCUSABLE node in the document of a page the reader keeps using and
   * keeps tabbing through. The plan drawer's copy had the `finally`; the
   * fence's did not. Both of these fail against that shape.
   */
  test("removes the staged textarea even when execCommand throws", async () => {
    const env = withEnv({
      execCommandResult: () => {
        throw new Error("execCommand is not a function");
      },
    });
    expect(await copyText("SELECT 1;")).toBe(false);
    expect(env.appended).toBe(1);
    expect(env.removed).toBe(1);
  });

  test("…and when select() throws before it", async () => {
    const env = withEnv({ selectThrows: true });
    expect(await copyText("SELECT 1;")).toBe(false);
    expect(env.appended).toBe(1);
    expect(env.removed).toBe(1);
  });
});


/**
 * The path the two ⧉ Copy path buttons put on the clipboard. Pure, and the only
 * thing about them a unit test can reach — the click itself is e2e
 * (`wiki-copy-path.spec.ts`, `plans-write.spec.ts`).
 */
describe("wikiPagePath", () => {
  test("joins the wiki root and the page's relPath", () => {
    expect(wikiPagePath("/Users/rune/source/private/mimir", "plans/muninn-x.mdx")).toBe(
      "/Users/rune/source/private/mimir/plans/muninn-x.mdx",
    );
  });

  test("degrades to the relPath alone when the root is unknown", () => {
    // Shorter, but still TRUE — the alternative shapes ("undefined/plans/x.mdx",
    // "/plans/x.mdx") are paths that name a file nobody has.
    for (const root of [null, undefined, "", "   "]) {
      expect(wikiPagePath(root, "plans/muninn-x.mdx")).toBe("plans/muninn-x.mdx");
    }
  });

  test("does not double the separator on a root that carries a trailing slash", () => {
    expect(wikiPagePath("/wiki/root/", "a/b.md")).toBe("/wiki/root/a/b.md");
    expect(wikiPagePath("/wiki/root///", "a/b.md")).toBe("/wiki/root/a/b.md");
  });

  test("a root that is nothing but slashes keeps one", () => {
    // The degenerate case the trailing-slash strip creates: stripping to "" and
    // then falling into the unknown-root branch would drop the one thing the
    // caller did know.
    expect(wikiPagePath("/", "a/b.md")).toBe("/a/b.md");
  });
});

import { afterEach, test, expect, describe } from "bun:test";
import {
  COPY_PATH_FAIL,
  COPY_PATH_IDLE,
  COPY_PATH_OK,
  copyPathAriaLabel,
  copyText,
  flashCopyResult,
  wikiPagePath,
} from "./copy-path.ts";

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
        // Cleanup, counted on the ELEMENT…
        remove: () => {
          box.removed++;
        },
      }),
      body: {
        appendChild: () => {
          box.appended++;
        },
        // …and on the BODY, both. The property under test is "the staged node
        // left the document", not "you called `.remove()`": counting only the
        // element's method makes the suite reject a correct refactor back to
        // `document.body.removeChild(ta)`, which is what this code shipped as
        // and is identical in a real DOM. Either spelling passes; neither
        // passes.
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

  test("a blank relPath answers NOTHING, not the directory it lives in", () => {
    // Both arguments degrade the same way. `<root>/` is a directory, not the
    // page, and `<root>/undefined` is worse than nothing precisely because it is
    // path-shaped — the caller renders "" as a refusal.
    for (const rel of [null, undefined, "", "   "]) {
      expect(wikiPagePath("/wiki/root", rel)).toBe("");
      expect(wikiPagePath(null, rel)).toBe("");
    }
  });

  test("a root that is nothing but slashes keeps one", () => {
    // The degenerate case the trailing-slash strip creates: stripping to "" and
    // then falling into the unknown-root branch would drop the one thing the
    // caller did know.
    expect(wikiPagePath("/", "a/b.md")).toBe("/a/b.md");
  });
});

/**
 * The two defects the shipped copy buttons had, both found by review and both
 * invisible to a test that only checks the clipboard.
 *
 * A fake button rather than a DOM: the helper touches exactly three members, so
 * naming them is the test's own documentation of its blast radius. `timeoutMs`
 * is threaded through so these run in milliseconds instead of 1.6 s.
 */
describe("flashCopyResult", () => {
  function fakeBtn(idleAria: string, connected = true) {
    const attrs: Record<string, string> = { "aria-label": idleAria };
    return {
      textContent: "⧉ Copy path" as string | null,
      get isConnected() {
        return connected;
      },
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      aria: () => attrs["aria-label"],
    };
  }
  /** The LABELLED shape (the plan drawer's): no okText/failText, so the
   *  verdict words are what the button shows. */
  const IDLE = { text: "⧉ Copy path", ariaLabel: "Copy this page's file path: /w/a.md" };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a SECOND click's verdict is not erased by the first click's timer", async () => {
    // The measured defect: click, click again 1.2 s later, and ~300 ms after the
    // second copy the label is back to "⧉ Copy path" — a copy that DID happen
    // reading as a dead control, which is what provokes a third click.
    const b = fakeBtn(IDLE.ariaLabel);
    flashCopyResult(b, true, IDLE, 60);
    await wait(40);
    flashCopyResult(b, true, IDLE, 60);
    await wait(40); // the FIRST timer's deadline has now passed
    expect(b.textContent).toBe("Copied");
    expect(b.aria()).toBe(`Copied — ${IDLE.ariaLabel}`);
    await wait(45); // …and the second timer's has too
    expect(b.textContent).toBe("⧉ Copy path");
    expect(b.aria()).toBe(IDLE.ariaLabel);
  });

  test("the ACCESSIBLE NAME carries the verdict, on success and on failure", async () => {
    // An aria-label OVERRIDES the button's text, so a static one makes
    // textContent invisible to a screen reader — silencing the only feedback a
    // clipboard write can give, hardest on the execCommand path that fails.
    const ok = fakeBtn(IDLE.ariaLabel);
    flashCopyResult(ok, true, IDLE, 30);
    expect(ok.aria()).toBe(`Copied — ${IDLE.ariaLabel}`);

    const bad = fakeBtn(IDLE.ariaLabel);
    flashCopyResult(bad, false, IDLE, 30);
    expect(bad.textContent).toBe("Copy failed");
    expect(bad.aria()).toBe(`Copy failed — ${IDLE.ariaLabel}`);

    await wait(50);
    expect(ok.aria()).toBe(IDLE.ariaLabel);
    expect(bad.aria()).toBe(IDLE.ariaLabel);
  });

  test("a DETACHED button is not written to when the timer fires", async () => {
    const b = fakeBtn(IDLE.ariaLabel, false);
    flashCopyResult(b, true, IDLE, 20);
    await wait(40);
    expect(b.textContent).toBe("Copied");
  });
});

describe("copyPathAriaLabel", () => {
  test("names the path, and says nothing false when there is none", () => {
    expect(copyPathAriaLabel("/w/a.md")).toBe("Copy this page's file path: /w/a.md");
    // Not "…file path: " with a dangling colon and nothing after it.
    expect(copyPathAriaLabel("")).toBe("Copy this page's file path");
  });
});

/**
 * The breadcrumb's button is ICON-ONLY (the words cost the trail ~104px on a row
 * where the trail is the only shrinkable item), so it reports in glyphs. What
 * must NOT follow is that the report becomes inaudible: "✓" read aloud is not a
 * verdict, so the accessible name stays words on both buttons.
 */
describe("flashCopyResult — the icon-only shape", () => {
  function fakeBtn() {
    const attrs: Record<string, string> = {};
    return {
      textContent: COPY_PATH_IDLE as string | null,
      isConnected: true,
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      aria: () => attrs["aria-label"],
    };
  }
  const ICON = {
    text: COPY_PATH_IDLE,
    ariaLabel: "Copy this page's file path: /w/a.md",
    okText: COPY_PATH_OK,
    failText: COPY_PATH_FAIL,
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("swaps the GLYPH, and the accessible name still says the words", async () => {
    const ok = fakeBtn();
    flashCopyResult(ok, true, ICON, 30);
    expect(ok.textContent).toBe("✓");
    expect(ok.aria()).toBe("Copied — Copy this page's file path: /w/a.md");

    const bad = fakeBtn();
    flashCopyResult(bad, false, ICON, 30);
    expect(bad.textContent).toBe("✕");
    expect(bad.aria()).toBe("Copy failed — Copy this page's file path: /w/a.md");

    await wait(50);
    expect(ok.textContent).toBe("⧉");
    expect(bad.textContent).toBe("⧉");
  });

  test("all three states are ONE character, so the row cannot shift under a click", () => {
    // The CSS reserves a fixed 30px; that only holds the neighbours still if the
    // three labels are the same size to begin with.
    expect([...COPY_PATH_IDLE]).toHaveLength(1);
    expect([...COPY_PATH_OK]).toHaveLength(1);
    expect([...COPY_PATH_FAIL]).toHaveLength(1);
  });

  test("a button with no okText/failText still reports in WORDS", () => {
    // The plan drawer's shape — the default must not follow the reader's.
    const b = fakeBtn();
    flashCopyResult(b, true, { text: "⧉ Copy path", ariaLabel: "x" }, 30);
    expect(b.textContent).toBe("Copied");
  });
});

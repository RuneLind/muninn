/**
 * The `/jira` archive bundle, driven through a stubbed DOM in a vm context —
 * the `traces-waterfall-browser.test.ts` precedent, for the same reason: the
 * IIFE is named as a STRING by `jira-archive-client.ts`, so tsc sees none of it
 * and no pure test can reach a timer that lives inside the closure.
 *
 * What it pins is the restore-timer SUPERSEDE. Two copies two seconds apart used
 * to leave the first «restore the label» timer running under the second copy's
 * «✓ Kopiert», resetting the label while the second copy was the freshest thing
 * that had happened. The fix is one line (`clearTimeout` before re-arming) and
 * it is invisible to every other surface.
 *
 * Synthetic markdown only — muninn is a public repo.
 */

import { beforeAll, beforeEach, expect, test } from "bun:test";
import vm from "node:vm";
import { jiraArchiveClientScript } from "./jira-archive-client.ts";
import {
  JA_COPY_ID,
  JA_COPY_LABEL,
  JA_PREVIEW_ID,
  JA_RAW_ID,
  JA_ROOT_ID,
  JA_VIEW_ATTR,
} from "./jira-archive-pure.ts";

interface Stub {
  id: string;
  hidden: boolean;
  textContent: string;
  value?: string;
  closest(sel: string): Stub | null;
}

/** Pending `window.setTimeout` callbacks, keyed by the id the stub handed out —
 *  `clearTimeout` deletes, so "was the first timer superseded?" is just
 *  membership. */
const timers = new Map<number, () => void>();
let nextTimerId = 1;
let copied: string[] = [];
let clipboardFails = false;

let ctx: Record<string, unknown>;
let els: Record<string, Stub>;
let clickRoot: (ev: { target: Stub }) => void;

function el(id: string, over: Partial<Stub> = {}): Stub {
  const stub: Stub = {
    id,
    hidden: false,
    textContent: "",
    closest(sel: string) {
      // The two selectors the bundle asks for, answered by identity.
      if (sel === `#${JA_COPY_ID}` && this.id === JA_COPY_ID) return this;
      if (sel === `[${JA_VIEW_ATTR}]` && this.id.startsWith("view:")) return this;
      return null;
    },
    ...over,
  };
  return stub;
}

/** A fresh page's worth of stubs — the copy test hides panes and the fallback
 *  test monkeypatches `focus`/`select`, so the set is rebuilt, not patched. */
function freshEls(): Record<string, Stub> {
  return {
    [JA_PREVIEW_ID]: el(JA_PREVIEW_ID),
    [JA_RAW_ID]: el(JA_RAW_ID, { hidden: true, value: "## Syntetisk\n\nutkast" }),
    [JA_COPY_ID]: el(JA_COPY_ID, { textContent: JA_COPY_LABEL }),
  };
}

/**
 * Every test starts on a fresh page.
 *
 * The bundle is evaluated ONCE (its `restoreTimer` closure is the thing under
 * test), but the DOM stubs and the three module-level spies are not shared
 * state to inherit: the supersede test used to read
 * `[...timers.keys()][0]` out of whatever the copy test above it had left
 * pending, so running it alone threw. A stale id still held by the closure is
 * harmless — `clearTimeout` on an id no longer in the map is a no-op.
 */
beforeEach(() => {
  timers.clear();
  copied = [];
  clipboardFails = false;
  els = freshEls();
});

beforeAll(async () => {
  els = freshEls();
  const root = {
    id: JA_ROOT_ID,
    addEventListener(evt: string, fn: (ev: { target: Stub }) => void) {
      if (evt === "click") clickRoot = fn;
    },
  };

  ctx = {
    document: {
      readyState: "complete",
      addEventListener() {},
      getElementById: (id: string) => (id === JA_ROOT_ID ? root : (els[id] ?? null)),
      querySelectorAll: () => [],
    },
    window: {
      setTimeout(fn: () => void) {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
    navigator: {
      clipboard: {
        async writeText(text: string) {
          if (clipboardFails) throw new Error("no permission");
          copied.push(text);
        },
      },
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(await jiraArchiveClientScript(), ctx);
});

test("the bundle wires the archive root's click delegate", () => {
  expect(typeof clickRoot).toBe("function");
});

test("copying puts the RAW markdown on the clipboard and confirms on the button", async () => {
  clickRoot({ target: els[JA_COPY_ID]! });
  await Promise.resolve();
  await Promise.resolve();
  expect(copied).toEqual(["## Syntetisk\n\nutkast"]);
  expect(els[JA_COPY_ID]!.textContent).toBe("✓ Kopiert");
  expect(timers.size).toBe(1);
});

test("a second copy SUPERSEDES the first restore timer instead of racing it", async () => {
  // Both copies are this test's own — reading the first timer out of the test
  // above made the whole thing depend on file order (`-t "supersedes"` threw).
  clickRoot({ target: els[JA_COPY_ID]! });
  await Promise.resolve();
  await Promise.resolve();
  expect(timers.size).toBe(1);
  const firstTimer = [...timers.keys()][0]!;

  clickRoot({ target: els[JA_COPY_ID]! });
  await Promise.resolve();
  await Promise.resolve();

  // The first timer is gone, not merely outnumbered: left pending it fires two
  // seconds into the SECOND copy's confirmation and resets the label under it.
  expect(timers.has(firstTimer)).toBe(false);
  expect(timers.size).toBe(1);
  expect(els[JA_COPY_ID]!.textContent).toBe("✓ Kopiert");

  // …and the surviving timer still restores the label exactly once.
  for (const fire of [...timers.values()]) fire();
  timers.clear();
  expect(els[JA_COPY_ID]!.textContent).toBe(JA_COPY_LABEL);
});

test("no clipboard permission falls back to the raw pane, selected", async () => {
  clipboardFails = true;
  const raw = els[JA_RAW_ID]!;
  let focused = false;
  let selected = false;
  Object.assign(raw, { focus: () => (focused = true), select: () => (selected = true) });

  clickRoot({ target: els[JA_COPY_ID]! });
  await Promise.resolve();
  await Promise.resolve();

  expect(copied).toEqual([]);
  expect(raw.hidden).toBe(false);
  expect(els[JA_PREVIEW_ID]!.hidden).toBe(true);
  expect(focused).toBe(true);
  expect(selected).toBe(true);
  expect(els[JA_COPY_ID]!.textContent).toBe("Kopier selv (merket)");
});

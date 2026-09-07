/**
 * The YouTube extension popup's SETTLE PATH, driven against a stub
 * `document`/`chrome`.
 *
 * The extension is unpackaged JavaScript with no browser harness, so the rules
 * it runs on live in `extension-options-rules.ts` beside this file. What that
 * split could not cover is the popup's own state machine: two reads that can
 * each answer, fail, or never answer, and a paint that can throw. Two fix
 * rounds patched one of those leaves at a time and each round's reader found
 * the same class through the next door, so the state space is enumerated here,
 * one case per leaf:
 *
 * | options read  | storage read | paint       | case                          |
 * |---------------|--------------|-------------|-------------------------------|
 * | still pending | —            | —           | disabled, Settings live        |
 * | answers       | answers      | ok          | restored kind + tick submitted |
 * | error         | answers      | ok          | fallback + unreachable note    |
 * | never answers | answers      | ok          | bounded, fallback + note       |
 * | answers       | hangs        | ok          | defaults + a note saying so    |
 * | answers       | rejects      | ok          | defaults + a note saying so    |
 * | answers       | answers      | throws once | fallback painted, enabled      |
 * | answers       | answers      | throws      | disabled, with a note          |
 * | answers       | answers      | ok, no #lbl-frames | module still evaluates  |
 *
 * `popup.js` is a browser module and holds state at module scope, so each case
 * imports its OWN copy: Bun caches a module by resolved path (a `?v=` query
 * does NOT produce a second instance — measured), so the file and the rules
 * module it imports are copied into a fresh temp directory per case.
 *
 * Time is stubbed rather than waited on: `globalThis.setTimeout` is replaced
 * with one that records the delay it was ASKED for and schedules a near-instant
 * real timer, so a 5s bound is asserted by the number requested rather than by
 * a 5s test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = join(import.meta.dir, "..", "..", "extensions", "youtube");
const POPUP_JS = join(EXT_DIR, "popup.js");
const RULES_JS = join(EXT_DIR, "capture-rules.js");

/** The real timer, captured before any case replaces the global. */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(() => r(), ms));

const SERVER_OPTIONS = {
  kinds: [
    { id: "standard", label: "Standard" },
    { id: "deep", label: "Deep" },
  ],
  default_kind: "standard",
  frames: { supported: true },
  visual_detail: {
    supported: true,
    default: "selected",
    options: [
      { id: "selected", label: "Selected" },
      { id: "detailed", label: "Detailed" },
    ],
  },
};

const LABEL_TITLE = "Pull one frame per cadence tick and quote the slides.";

interface StubEl {
  id: string;
  textContent: string;
  innerHTML: string;
  className: string;
  title: string;
  value: string;
  disabled: boolean;
  checked: boolean;
  children: StubEl[];
  classes: Set<string>;
  listeners: Record<string, Array<(ev: unknown) => void>>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string, on?: boolean): void;
  };
  replaceChildren(...kids: StubEl[]): void;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
  /** A real browser dispatches no click on a disabled form control. */
  fire(type: string): boolean;
}

function makeEl(id: string): StubEl {
  // The ids `popup.html` renders with `class="hidden"`.
  const classes = new Set<string>(
    ["video-info", "not-video", "lbl-visual"].includes(id) ? ["hidden"] : [],
  );
  const el: StubEl = {
    id,
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    value: "",
    disabled: false,
    checked: false,
    children: [],
    classes,
    listeners: {},
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => void (on ? classes.add(c) : classes.delete(c)),
    },
    replaceChildren(...kids) {
      el.children = kids;
    },
    addEventListener(type, cb) {
      (el.listeners[type] ||= []).push(cb);
    },
    fire(type) {
      if (type === "click" && el.disabled) return false;
      for (const cb of el.listeners[type] ?? []) cb({ preventDefault() {} });
      return true;
    },
  };
  return el;
}

const NODE_IDS = [
  "btn-summarize",
  "open-options",
  "sel-kind",
  "chk-frames",
  "lbl-frames",
  "sel-visual",
  "lbl-visual",
  "options-note",
  "frames-note",
  "video-info",
  "video-title",
  "not-video",
  "status",
];

interface DriveOptions {
  /** How the worker answers `GET_OPTIONS`. */
  options: "server" | "error" | "never" | "throws";
  /** How `chrome.storage.sync.get` behaves. */
  storage: "answers" | "hangs" | "rejects";
  /** What this browser remembered. */
  stored?: Record<string, unknown>;
  /** Whether the summarizer bot's connector can read frames. */
  framesSupported?: boolean;
  /** Answer without the visual-detail capability — a Muninn from before it existed. */
  noVisualDetail?: boolean;
  /** Ids to leave OFF the page. */
  missing?: string[];
  /**
   * Which `document.createElement` calls throw, 1-based, counting EVERY option
   * element a paint builds — the kind rows and then the visual-detail rows. The
   * synchronous fallback paint runs first (1 kind + 2 visual = calls 1-3), the
   * settle paint next, and the retry after that. Adding a picker moves these
   * indices, which is why the cases below say which paint they mean.
   */
  throwOnCreateCalls?: number[];
}

interface Driven {
  node(id: string): StubEl;
  /** Every message the popup sent the worker. */
  sent: Array<Record<string, unknown>>;
  /** Every `chrome.storage.sync.set` the popup made. */
  saved: Array<Record<string, unknown>>;
  /** Every delay `setTimeout` was asked for, in ms. */
  delays: number[];
  /** Run pending microtasks only — no timer fires. */
  microtasks(): Promise<void>;
  /** Let the compressed timers run. */
  settleTimers(): Promise<void>;
  fireDomReady(): void;
}

const savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

function installGlobal(name: string, value: unknown) {
  savedGlobals.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  // The popup is a browser module: it reads `document`, `chrome`, `window` and
  // `setTimeout` off the global. Every case restores them, because this file
  // shares a process with the rest of its `bun test` link.
  while (savedGlobals.length > 0) {
    const [name, descriptor] = savedGlobals.pop()!;
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

async function drivePopup(opts: DriveOptions): Promise<Driven> {
  const nodes = new Map<string, StubEl>();
  for (const id of NODE_IDS) {
    if (opts.missing?.includes(id)) continue;
    nodes.set(`#${id}`, makeEl(id));
  }
  const label = nodes.get("#lbl-frames");
  if (label) label.title = LABEL_TITLE;

  let createCalls = 0;
  let domReady: (() => void) | null = null;
  const sent: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];
  const delays: number[] = [];

  installGlobal("document", {
    querySelector: (sel: string) => nodes.get(sel) ?? null,
    createElement: () => {
      createCalls += 1;
      if (opts.throwOnCreateCalls?.includes(createCalls)) {
        throw new Error(`createElement failed on call ${createCalls}`);
      }
      return makeEl("option");
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === "DOMContentLoaded") domReady = cb;
    },
  });
  installGlobal("window", { close: () => {} });
  installGlobal("setTimeout", (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    // Compressed: the bound is asserted by the delay ASKED for, above.
    return realSetTimeout(fn, 1);
  });

  const serverPayload: Record<string, unknown> = {
    ...SERVER_OPTIONS,
    frames: { supported: opts.framesSupported ?? true },
  };
  if (opts.noVisualDetail) delete serverPayload.visual_detail;

  installGlobal("chrome", {
    runtime: {
      lastError: undefined,
      openOptionsPage: () => {},
      sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
        sent.push(msg);
        if (msg.type === "GET_STATE") {
          return cb?.({ videoId: "dQw4w9WgXcQ", title: "A talk", url: "https://youtu.be/x" });
        }
        if (msg.type === "GET_OPTIONS") {
          if (opts.options === "never") return undefined;
          if (opts.options === "throws") throw new Error("Extension context invalidated.");
          if (opts.options === "error") return cb?.({ error: "The operation timed out" });
          return cb?.({ options: serverPayload });
        }
        if (msg.type === "SUMMARIZE") return cb?.({ ok: true });
        return undefined;
      },
    },
    tabs: {
      query: (_q: unknown, cb: (tabs: unknown[]) => void) =>
        cb([{ id: 7, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]),
      sendMessage: (_id: number, _msg: unknown, cb: (info: unknown) => void) =>
        cb({ videoId: "dQw4w9WgXcQ", title: "A talk", url: "https://youtu.be/x" }),
    },
    storage: {
      sync: {
        get: () => {
          if (opts.storage === "hangs") return new Promise(() => {});
          if (opts.storage === "rejects") return Promise.reject(new Error("sync backend refused"));
          return Promise.resolve({ frames: false, summaryKind: null, ...(opts.stored ?? {}) });
        },
        set: async (patch: Record<string, unknown>) => {
          saved.push(patch);
        },
      },
    },
  });

  // A fresh module instance per case: Bun caches by resolved path.
  const dir = mkdtempSync(join(tmpdir(), "muninn-popup-"));
  copyFileSync(POPUP_JS, join(dir, "popup.js"));
  copyFileSync(RULES_JS, join(dir, "capture-rules.js"));
  await import(pathToFileURL(join(dir, "popup.js")).href);

  return {
    node: (id) => {
      const el = nodes.get(`#${id}`);
      if (!el) throw new Error(`no stub node #${id}`);
      return el;
    },
    sent,
    saved,
    delays,
    microtasks: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    settleTimers: () => sleep(40),
    fireDomReady: () => {
      if (!domReady) throw new Error("popup.js registered no DOMContentLoaded listener");
      domReady();
    },
  };
}

/** The ids the picker is offering, in order. */
const offered = (d: Driven) => d.node("sel-kind").children.map((o) => o.value);
const noteText = (d: Driven) => d.node("options-note").textContent;

describe("the popup settles onto controls that match what a click submits", () => {
  test("module evaluation registers the listeners even with #lbl-frames off the page", async () => {
    const d = await drivePopup({ options: "server", storage: "answers", missing: ["lbl-frames"] });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").listeners.click?.length).toBe(1);
    expect(d.node("open-options").listeners.click?.length).toBe(1);
    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard", "deep"]);
  });

  test("while the options read is outstanding: disabled, Settings live, no submit", async () => {
    const d = await drivePopup({ options: "never", storage: "answers" });
    d.fireDomReady();
    await d.microtasks();

    expect(d.node("btn-summarize").disabled).toBe(true);
    // Settings is live from the first tick — it is what fixes a wrong URL.
    expect(d.node("open-options").listeners.click?.length).toBe(1);
    expect(d.node("open-options").fire("click")).toBe(true);
    expect(d.node("btn-summarize").fire("click")).toBe(false);
    await d.microtasks();
    expect(d.sent.filter((m) => m.type === "SUMMARIZE")).toEqual([]);
  });

  test("a worker that never answers settles onto the fallback within a bound", async () => {
    const d = await drivePopup({ options: "never", storage: "answers" });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard"]);
    expect(noteText(d)).toContain("Could not reach Muninn options");
    // The bound sits above the worker's own 4s fetch budget, so the worker
    // reports the failure when it can and this only catches a lost response.
    expect(d.delays.some((ms) => ms >= 4000 && ms <= 15000)).toBe(true);
  });

  test("an options error paints the fallback picker and says so", async () => {
    const d = await drivePopup({ options: "error", storage: "answers", stored: { summaryKind: "deep" } });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard"]);
    expect(d.node("sel-kind").value).toBe("standard");
    expect(noteText(d)).toContain("Could not reach Muninn options");
    expect(d.node("options-note").classes.has("hidden")).toBe(false);
  });

  test("a sendMessage that throws lands in the same place", async () => {
    const d = await drivePopup({ options: "throws", storage: "answers" });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard"]);
    expect(noteText(d)).toContain("Could not reach Muninn options");
  });

  test("success restores the remembered kind and tick, and submits them", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      stored: { summaryKind: "deep", frames: true },
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard", "deep"]);
    expect(d.node("sel-kind").value).toBe("deep");
    expect(d.node("chk-frames").checked).toBe(true);
    expect(noteText(d)).toBe("");

    d.node("btn-summarize").fire("click");
    await d.settleTimers();
    const submit = d.sent.find((m) => m.type === "SUMMARIZE");
    expect(submit).toMatchObject({ kind: "deep", frames: true });
  });

  test("a remembered kind this instance dropped is restored to the default WITH a note", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      stored: { summaryKind: "exhaustive" },
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("sel-kind").value).toBe("standard");
    expect(noteText(d)).toContain("exhaustive");
    expect(d.node("btn-summarize").disabled).toBe(false);
  });

  test("a storage read that hangs shows the defaults and SAYS the remembered choice is not shown", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "hangs",
      stored: { summaryKind: "deep", frames: true },
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(d.node("sel-kind").value).toBe("standard");
    expect(d.node("chk-frames").checked).toBe(false);
    // The picker is NOT showing what this browser remembered, so it says so —
    // otherwise Standard runs silently over a storage holding Deep.
    expect(noteText(d)).toContain("Could not read the remembered");
    expect(d.node("options-note").classes.has("hidden")).toBe(false);
  });

  test("a storage read that rejects lands in the same place", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "rejects",
      stored: { summaryKind: "deep" },
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(d.node("sel-kind").value).toBe("standard");
    expect(noteText(d)).toContain("Could not read the remembered");
  });

  test("a paint that throws is repainted from the fallback, enabled, with a note", async () => {
    // Calls 1-3 are the synchronous fallback paint (Standard + the two visual
    // rows); call 4 is the settle paint's first option element.
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      stored: { summaryKind: "deep" },
      throwOnCreateCalls: [4],
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("btn-summarize").disabled).toBe(false);
    expect(offered(d)).toEqual(["standard"]);
    expect(d.node("sel-kind").value).toBe("standard");
    expect(noteText(d)).toContain("Could not render the capture controls");
  });

  test("a paint that cannot be repainted keeps Summarize disabled, with a note", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      throwOnCreateCalls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    d.fireDomReady();
    await d.settleTimers();

    // The one leaf that stays disabled: the popup cannot show what a click
    // would submit, which is the whole point of enabling it. Settled, not hung.
    expect(d.node("btn-summarize").disabled).toBe(true);
    expect(noteText(d)).toContain("Could not render the capture controls");
    expect(d.node("open-options").listeners.click?.length).toBe(1);
  });

  test("the pre-settle picker persists nothing — a remembered kind survives a stray change", async () => {
    const d = await drivePopup({
      options: "never",
      storage: "answers",
      stored: { summaryKind: "deep" },
    });
    d.fireDomReady();
    await d.microtasks();

    // The fallback picker is on screen but not yet live: a change on it must
    // not write `standard` over the stored `deep`.
    d.node("sel-kind").fire("change");
    await d.microtasks();
    expect(d.saved).toEqual([]);

    await d.settleTimers();
    d.node("sel-kind").value = "standard";
    d.node("sel-kind").fire("change");
    await d.microtasks();
    expect(d.saved).toEqual([{ summaryKind: "standard" }]);
  });

  test("a connector that cannot read frames dims the tick and explains it", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      stored: { frames: true },
      framesSupported: false,
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("chk-frames").disabled).toBe(true);
    expect(d.node("chk-frames").checked).toBe(false);
    expect(d.node("frames-note").textContent).toContain("cannot read frames");
    expect(d.node("lbl-frames").title).toContain("cannot read frames");
  });

  test("the Visuals row is hidden until Slides is ticked, and revealed the moment it is", async () => {
    const d = await drivePopup({ options: "server", storage: "answers" });
    d.fireDomReady();
    await d.settleTimers();

    // Slides default OFF, so there is nothing to choose between yet.
    expect(d.node("chk-frames").checked).toBe(false);
    expect(d.node("lbl-visual").classes.has("hidden")).toBe(true);
    expect(d.node("sel-visual").children.map((o) => o.value)).toEqual(["selected", "detailed"]);

    d.node("chk-frames").checked = true;
    d.node("chk-frames").fire("change");
    expect(d.node("lbl-visual").classes.has("hidden")).toBe(false);
  });

  test("a remembered visual detail is restored and SUBMITTED", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      stored: { frames: true, visualDetail: "detailed" },
    });
    d.fireDomReady();
    await d.settleTimers();

    expect(d.node("sel-visual").value).toBe("detailed");
    // Slides came back ticked, so the row that explains itself is on screen.
    expect(d.node("lbl-visual").classes.has("hidden")).toBe(false);

    d.node("btn-summarize").fire("click");
    await d.settleTimers();
    expect(d.sent.find((m) => m.type === "SUMMARIZE")).toMatchObject({
      frames: true,
      visualDetail: "detailed",
    });
  });

  test("an instance that offers no such choice renders no row and submits no value", async () => {
    const d = await drivePopup({
      options: "server",
      storage: "answers",
      noVisualDetail: true,
      stored: { frames: true, visualDetail: "detailed" },
    });
    d.fireDomReady();
    await d.settleTimers();

    // Ticked Slides and a remembered policy, and still no row: that Muninn would
    // ignore the field, so a control here is a choice nothing acts on.
    expect(d.node("chk-frames").checked).toBe(true);
    expect(d.node("lbl-visual").classes.has("hidden")).toBe(true);

    d.node("btn-summarize").fire("click");
    await d.settleTimers();
    expect(d.sent.find((m) => m.type === "SUMMARIZE")).toMatchObject({ visualDetail: null });
  });

  test("changing the Visuals picker is remembered, and only after the reads settle", async () => {
    const d = await drivePopup({
      options: "never",
      storage: "answers",
      stored: { visualDetail: "detailed" },
    });
    d.fireDomReady();
    await d.microtasks();

    // Pre-settle the picker is this instance's default, so a stray change must
    // not write it over the remembered value — the kind rule, same reason.
    d.node("sel-visual").fire("change");
    await d.microtasks();
    expect(d.saved).toEqual([]);

    await d.settleTimers();
    d.node("sel-visual").value = "detailed";
    d.node("sel-visual").fire("change");
    await d.microtasks();
    expect(d.saved).toEqual([{ visualDetail: "detailed" }]);
  });
});

test("the popup and its rules module are both on disk to drive", () => {
  expect(existsSync(POPUP_JS)).toBe(true);
  expect(existsSync(RULES_JS)).toBe(true);
});

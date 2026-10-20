/**
 * The «Felles: N changed» client (`initFellesSync`) driven over a stubbed DOM
 * and a stubbed `fetch` — the repo has no browser test env, so this is the
 * `jira-entry.test.ts` precedent: the real module runs, and only `document` and
 * `fetch` are fakes. It pins the client half of architecture review 2026-10:
 *
 *  - finding 67: the status refreshes on the reader's own refetch triggers
 *    (`refresh()`), never during a run, and the ok-state chip click reloads the
 *    dialog's view instead of opening it on the boot-time answer;
 *  - finding 79: a sync dry run reloads the view and judges exit 1 on that
 *    fresh status, not on the one the dialog opened with.
 *
 * Globals are restored after every test: this file shares a `bun test`
 * process with the rest of the directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FELLES_SYNC_SLOT_ID, initFellesSync, type FellesSync, type FellesSyncStatus } from "./wiki-felles-publish.ts";

type Listener = (e: unknown) => void;

class FakeEl {
  hidden = false;
  disabled = false;
  checked = false;
  inert = false;
  textContent = "";
  className = "";
  id = "";
  attributes: { name: string; value: string }[] = [];
  content = { firstElementChild: null as FakeEl | null };
  private html = "";
  private sel = new Map<string, FakeEl>();
  private listeners = new Map<string, Listener[]>();
  set innerHTML(v: string) {
    this.html = v;
    this.sel.clear();
    if (v.startsWith("<button")) this.content.firstElementChild = new FakeEl();
  }
  get innerHTML(): string {
    return this.html;
  }
  querySelector(s: string): FakeEl {
    let el = this.sel.get(s);
    if (!el) {
      el = new FakeEl();
      // The dialog's checkbox renders checked.
      if (s.includes('"ident"')) el.checked = this.html.includes('data-felles="ident" checked');
      this.sel.set(s, el);
    }
    return el;
  }
  addEventListener(t: string, f: Listener): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  dispatch(t: string, e: unknown): void {
    for (const f of this.listeners.get(t) ?? []) f(e);
  }
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {}
  hasAttribute(): boolean {
    return false;
  }
  removeAttribute(): void {}
  replaceChildren(): void {}
  appendChild(): void {}
  showModal(): void {}
  close(): void {
    this.dispatch("close", {});
  }
  remove(): void {}
}

const status = (over: Partial<FellesSyncStatus> = {}): FellesSyncStatus => ({
  bucket: "b",
  pages: [],
  orphans: [],
  maybeOrphans: [],
  changed: 0,
  ...over,
});
const refusedPage = { relPath: "plans/r.mdx", masked: false, state: "refused" as const, changedFiles: [], refusals: ["ident"], warnings: [] };
const changedPage = (n: number) => ({ relPath: `plans/c${n}.mdx`, masked: false, state: "changed" as const, changedFiles: [], refusals: [], warnings: [] });

interface Harness {
  sync: FellesSync;
  statusCalls: () => number;
  /** Queue the next status answers, in order; the last one repeats. */
  answers: FellesSyncStatus[];
  /** Hold the next sync POST open until `settlePost` answers it. */
  holdPost: () => void;
  settlePost: (body: unknown) => Promise<void>;
  postBody: unknown;
  slot: FakeEl;
  dialog: () => FakeEl | null;
}

const saved = { document: globalThis.document, fetch: globalThis.fetch };
let h: Harness;

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  const slot = new FakeEl();
  let dialog: FakeEl | null = null;
  let statusCalls = 0;
  let held: ((r: Response) => void) | null = null;
  let hold = false;
  const harness = {
    answers: [status()],
    postBody: { exitCode: 0, output: "" } as unknown,
  } as Partial<Harness> & { answers: FellesSyncStatus[]; postBody: unknown };
  globalThis.document = {
    getElementById: (id: string) => (id === FELLES_SYNC_SLOT_ID ? slot : null),
    createElement: (tag: string) => {
      const el = new FakeEl();
      if (tag === "dialog") dialog = el;
      return el;
    },
    body: new FakeEl(),
  } as unknown as Document;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/wiki/felles-status")) {
      statusCalls++;
      const next = harness.answers.length > 1 ? harness.answers.shift()! : harness.answers[0]!;
      return new Response(JSON.stringify(next), { status: 200 });
    }
    if (init?.method === "POST") {
      if (hold) {
        hold = false;
        return new Promise<Response>((r) => (held = r));
      }
      return new Response(JSON.stringify(harness.postBody), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const sync = initFellesSync({ wiki: "kode", hrefFor: (r) => `/wiki?relPath=${r}`, openPage: () => {}, onStatus: () => {} });
  h = Object.assign(harness, {
    sync,
    slot,
    statusCalls: () => statusCalls,
    dialog: () => dialog,
    holdPost: () => {
      hold = true;
    },
    settlePost: async (body: unknown) => {
      held?.(new Response(JSON.stringify(body), { status: 200 }));
      for (let i = 0; i < 5; i++) await tick();
    },
  }) as Harness;
});

afterEach(() => {
  globalThis.document = saved.document;
  globalThis.fetch = saved.fetch;
});

/** Click the chip in its ok state, as the slot's delegated listener sees it. */
function clickChip(): void {
  const btn = { getAttribute: (n: string) => (n === "data-state" ? "ok" : null) };
  h.slot.dispatch("click", { target: { closest: () => btn } });
}

/** Click a `data-felles` control in the open sync dialog. */
function clickDialog(action: string): void {
  const control = { getAttribute: () => action };
  h.dialog()!.dispatch("click", { target: { closest: (s: string) => (s === "[data-felles]" ? control : null) } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

describe("finding 67 — the status follows the reader's refetch triggers", () => {
  test("refresh() reads the status again", async () => {
    await h.sync.load();
    expect(h.statusCalls()).toBe(1);
    h.sync.refresh();
    await settle();
    expect(h.statusCalls()).toBe(2);
  });

  test("refresh() is a no-op while a run is in flight", async () => {
    h.answers = [status({ changed: 1, pages: [changedPage(1)] })];
    await h.sync.load();
    clickChip();
    await settle();
    const before = h.statusCalls();
    h.holdPost();
    clickDialog("sync-dry");
    await settle();
    h.sync.refresh();
    await settle();
    expect(h.statusCalls()).toBe(before);
    await h.settlePost({ exitCode: 0, output: "" });
    // Once the run ended, refresh() reads the status again.
    const afterRun = h.statusCalls();
    h.sync.refresh();
    await settle();
    expect(h.statusCalls()).toBe(afterRun + 1);
  });

  test("the ok-state chip click reloads the dialog's view", async () => {
    await h.sync.load();
    const before = h.statusCalls();
    clickChip();
    await settle();
    expect(h.statusCalls()).toBe(before + 1);
  });
});

describe("finding 79 — a dry run is judged on a fresh status", () => {
  test("exit 1 with no refused page left reads red, though the dialog opened with one", async () => {
    // Opened on a view holding a refused page; the fresh status has none, so
    // the exit 1 is a crash, not the refusal.
    h.answers = [status({ changed: 2, pages: [refusedPage, changedPage(1), changedPage(2)] })];
    await h.sync.load();
    h.answers = [
      status({ changed: 2, pages: [refusedPage, changedPage(1), changedPage(2)] }),
      status({ changed: 2, pages: [changedPage(1), changedPage(2)] }),
    ];
    clickChip();
    await settle();
    h.postBody = { exitCode: 1, output: "" };
    clickDialog("sync-dry");
    await settle();
    const line = h.dialog()!.querySelector(".wiki-felles-status");
    expect(line.textContent).not.toContain("would be published");
    expect(line.className).toContain("err");
  });
});

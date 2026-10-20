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
import { FELLES_SYNC_BTN_ID, FELLES_SYNC_SLOT_ID, initFellesSync, type FellesSync, type FellesSyncStatus } from "./wiki-felles-publish.ts";

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
  /** How many times `innerHTML` was assigned: a re-render swaps every node. */
  htmlSets = 0;
  private html = "";
  private sel = new Map<string, FakeEl>();
  private listeners = new Map<string, Listener[]>();
  set innerHTML(v: string) {
    this.html = v;
    this.htmlSets++;
    this.sel.clear();
    if (v.startsWith("<button")) {
      // The chip template: its text is what `paint` copies onto the button.
      this.content.firstElementChild = new FakeEl();
      this.content.firstElementChild.textContent = v.replace(/<[^>]*>/g, "");
    }
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
  /** The sync POST's HTTP status (200 unless a test sets it). */
  postStatus: number;
  onStatusCalls: () => number;
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
  let onStatusCalls = 0;
  let held: ((r: Response) => void) | null = null;
  let hold = false;
  const harness = {
    answers: [status()],
    postBody: { exitCode: 0, output: "" } as unknown,
    postStatus: 200,
  } as Partial<Harness> & { answers: FellesSyncStatus[]; postBody: unknown; postStatus: number };
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
      return new Response(JSON.stringify(harness.postBody), { status: harness.postStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const sync = initFellesSync({
    wiki: "kode",
    hrefFor: (r) => `/wiki?relPath=${r}`,
    openPage: () => {},
    onStatus: () => {
      onStatusCalls++;
    },
  });
  h = Object.assign(harness, {
    sync,
    slot,
    statusCalls: () => statusCalls,
    onStatusCalls: () => onStatusCalls,
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

describe("finding 80 — the client wires the remove command into the dialog", () => {
  test("with bin set, a page missing locally carries its command", async () => {
    const missing = { relPath: "gone.md", masked: false, state: "missing-locally" as const, changedFiles: [], refusals: [], warnings: [] };
    h.answers = [status({ pages: [missing] })];
    const sync = initFellesSync({
      wiki: "kode",
      hrefFor: (r) => r,
      openPage: () => {},
      onStatus: () => {},
      bin: "/x/publiser.ts",
      bucket: "felles",
    } as Parameters<typeof initFellesSync>[0]);
    await sync.load();
    h.slot.dispatch("click", { target: { closest: () => ({ getAttribute: (n: string) => (n === "data-state" ? "ok" : null) }) } });
    await settle();
    expect(h.dialog()!.innerHTML).toContain("<code>FELLES_WIKI_BUCKET=felles bun --no-env-file /x/publiser.ts --fjern -- gone.md</code>");
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

/** The dialog's lists element, as `openDialog` looked it up. */
const lists = () => h.dialog()!.querySelector(".wiki-felles-lists");
/** The chip button, as `paint` updates it in place. */
const chip = () => h.slot.querySelector(`#${FELLES_SYNC_BTN_ID}`);

describe("fix round 1 — the chip click's fresh read", () => {
  // The fresh read that lands while the user (or a spec) points at a link
  // must not swap the lists' nodes when nothing changed: the e2e specs
  // «links read at 4.5:1» and «links do nothing while a sync runs» lost
  // their link to exactly that swap on CI.
  test("an identical fresh status leaves the dialog's lists alone", async () => {
    const s = status({ changed: 1, pages: [changedPage(1)] });
    h.answers = [s];
    await h.sync.load();
    clickChip();
    await settle();
    expect(h.statusCalls()).toBe(2);
    expect(lists().htmlSets).toBe(0);
  });

  test("a fresh status that differs re-renders the lists", async () => {
    h.answers = [status({ changed: 1, pages: [changedPage(1)] })];
    await h.sync.load();
    h.answers = [status({ changed: 2, pages: [changedPage(1), changedPage(2)] })];
    clickChip();
    await settle();
    expect(lists().htmlSets).toBe(1);
    expect(lists().innerHTML).toContain("plans/c2.mdx");
  });

  test("the fresh read updates the chip and the page markers, in one request", async () => {
    await h.sync.load();
    expect(chip().textContent).toBe("Felles: 0 changed");
    const onStatusBefore = h.onStatusCalls();
    h.answers = [status({ changed: 3, pages: [changedPage(1), changedPage(2), changedPage(3)] })];
    clickChip();
    await settle();
    expect(h.statusCalls()).toBe(2);
    expect(chip().textContent).toBe("Felles: 3 changed");
    expect(h.sync.markFor("plans/c1.mdx")).toBe("stale");
    expect(h.onStatusCalls()).toBe(onStatusBefore + 1);
  });

  test("a run the route refused before spawning starts no status request", async () => {
    h.answers = [status({ changed: 1, pages: [changedPage(1)] })];
    await h.sync.load();
    clickChip();
    await settle();
    const afterOpen = h.statusCalls();
    expect(afterOpen).toBe(2);
    h.postStatus = 409;
    h.postBody = { error: "A publish, remove or sync is already running.", reason: "running" };
    clickDialog("sync");
    await settle();
    expect(h.statusCalls()).toBe(afterOpen);
  });
});

describe("fix round 1 — a crashed dry run with a refused page reads red", () => {
  test("exit 1 without the script's summary is a crash, though the status holds a refused page", async () => {
    const s = status({ changed: 1, pages: [refusedPage, changedPage(1)] });
    h.answers = [s];
    await h.sync.load();
    clickChip();
    await settle();
    h.postBody = { exitCode: 1, output: "error: Cannot read properties of undefined\n    at publiser (publiser-felles-wiki.ts:1500:3)" };
    clickDialog("sync-dry");
    await settle();
    const line = h.dialog()!.querySelector(".wiki-felles-status");
    expect(line.textContent).not.toContain("would be published");
    expect(line.className).toContain("err");
  });

  test("exit 1 whose summary reports the refusal reads ok", async () => {
    const s = status({ changed: 1, pages: [refusedPage, changedPage(1)] });
    h.answers = [s];
    await h.sync.load();
    clickChip();
    await settle();
    h.postBody = { exitCode: 1, output: "OK      plans/c1.mdx\n\nOppsummering: 1 klar(e), 1 avvist, 0 mangler lokalt." };
    clickDialog("sync-dry");
    await settle();
    const line = h.dialog()!.querySelector(".wiki-felles-status");
    expect(line.textContent).toContain("would be published");
    expect(line.className).toContain("ok");
  });
});

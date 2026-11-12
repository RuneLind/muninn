/**
 * The reader's step-check chips on the real render: `renderWikiHtml` output in
 * a happy-dom `Window` of the test's own (no globals installed), the route's
 * answer computed by the real `answerStepChecks` over faked probes, then
 * `enhanceStepChecks` with an injected fetch. Pins: chips only on rows the
 * route answered, paired by Done's rule; none on a hash mismatch, an error or
 * a bad answer; no request when the page has no slot; the chip stays inside
 * the reader-only slot; the popover's wiring (attributes, Escape, what it
 * listens to while open and lets go of, the fallback without the popover API).
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import { sha256 } from "../../../utils/date-hash.ts";
import { answerStepChecks, ProbeCache, type StepChecksAnswer } from "../../../wiki/step-checks/answer.ts";
import type { ProbeDeps } from "../../../wiki/step-checks/probes.ts";
import { checkChip, enhanceStepChecks } from "./wiki-step-done.ts";

const PAGE = [
  "---",
  "title: T",
  "---",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="you">',
  "",
  '1. Add the key <Check env="HAVE" />',
  "2. Plain step.",
  '3. Migrate <Check migration="087" />',
  '4. Two machines <Check env="HAVE" on="laptop,mini" />',
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
].join("\n");

const probes: ProbeDeps = {
  git: async () => {
    throw new Error("no git");
  },
  roots: null,
  readEnvFile: async () => ({ bytes: new TextEncoder().encode("HAVE=1\n") }),
  processHasEnv: () => true,
  appliedMigrations: async () => new Set(["086"]),
};

const answer = () => answerStepChecks(PAGE, { probes, machine: "laptop", cache: new ProbeCache() });

type Fake = { frames: Set<number>; listeners: Map<string, number>; open: Set<Element> };
/**
 * happy-dom has the `popover` attribute but no `showPopover` (21.0.4), so the
 * reader takes its fallback there. `popover: true` stands the platform's half
 * in: `showPopover`/`hidePopover` firing `beforetoggle` and `toggle` as an
 * engine does; the test counts the window listeners added and not yet removed,
 * per type, and the animation frames asked for and not yet run or cancelled.
 */
function platform(win: Window): Fake {
  const w = win as unknown as Record<string, unknown> & typeof globalThis;
  const fake: Fake = { frames: new Set(), listeners: new Map(), open: new Set() };
  const proto = w.HTMLElement.prototype as unknown as Record<string, unknown>;
  const fire = (el: HTMLElement, type: string, newState: string) => el.dispatchEvent(Object.assign(new w.Event(type), { newState, oldState: newState === "open" ? "closed" : "open" }));
  proto.showPopover = function (this: HTMLElement) {
    if (fake.open.has(this)) return;
    fire(this, "beforetoggle", "open");
    fake.open.add(this);
    fire(this, "toggle", "open");
  };
  proto.hidePopover = function (this: HTMLElement) {
    if (!fake.open.has(this)) return;
    fire(this, "beforetoggle", "closed");
    fake.open.delete(this);
    fire(this, "toggle", "closed");
  };
  let n = 0;
  w.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++n;
    fake.frames.add(id);
    setTimeout(() => fake.frames.delete(id) && cb(0), 5);
    return id;
  }) as never;
  w.cancelAnimationFrame = ((id: number) => void fake.frames.delete(id)) as never;
  const add = w.addEventListener.bind(w);
  const remove = w.removeEventListener.bind(w);
  const seen = new Set<unknown>();
  w.addEventListener = ((type: string, fn: EventListener, o?: unknown) => {
    if (!seen.has(fn)) fake.listeners.set(type, (fake.listeners.get(type) ?? 0) + 1);
    seen.add(fn);
    add(type, fn, o as never);
  }) as never;
  w.removeEventListener = ((type: string, fn: EventListener, o?: unknown) => {
    if (seen.delete(fn)) fake.listeners.set(type, (fake.listeners.get(type) ?? 0) - 1);
    remove(type, fn, o as never);
  }) as never;
  return fake;
}
/** The platform stand-in of the last `mount`, or null when it mounted without one. */
let fake: Fake | null = null;
/** Window listeners the reader added and has not removed, all types. */
const live = () => Array.from(fake!.listeners.values()).reduce((a, b) => a + b, 0);

function mount(md = PAGE, opts: { popover?: boolean } = {}) {
  const win = new Window();
  fake = opts.popover === false ? null : platform(win);
  // happy-dom's element classes are shared by its windows: a stand-in another mount installed is taken off again.
  if (!fake) for (const k of ["showPopover", "hidePopover"]) delete (win.HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  const doc = win.document;
  const article = doc.createElement("div");
  article.className = "wiki-article";
  article.innerHTML = renderWikiHtml(md, () => undefined);
  doc.body.appendChild(article);
  return article as unknown as HTMLElement;
}

const ctx = (hash: string | null) => ({ wiki: "w", relPath: "plans/p.mdx", hash: () => hash, reload: () => {}, current: () => true });
const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Each row's chip text, "" where the row has none. */
const chips = (a: HTMLElement) => Array.from(a.querySelectorAll(".nm-lane .nm-body > ol > li")).map((li) => li.querySelector(".step-check > .step-chip")?.textContent ?? "");

describe("step-check chips", () => {
  test("each answered row gets its chip, per machine when the check names several; the unanswered row none", async () => {
    const a = mount();
    const urls: string[] = [];
    await enhanceStepChecks(a, ctx(sha256(PAGE)), async (u) => (urls.push(u), respond(await answer())()));
    expect(urls).toEqual(["/api/wiki/step-checks?wiki=w&relPath=plans%2Fp.mdx"]);
    expect(chips(a)).toEqual(["✓", "", "○", "?"]);
    const chip = a.querySelector<HTMLElement>(".step-chip")!;
    expect(chip.dataset.state).toBe("ok");
    expect(chip.title).toBe("env=HAVE: HAVE is set in .env and in the running process");
    // Inside the reader-only slot, which Done's row text and name leave out.
    expect(chip.parentElement!.hasAttribute("data-reader-only")).toBe(true);
  });

  test("a step the route did not answer stays empty, whatever its slot says", async () => {
    const a = mount();
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond({ ...full, steps: full.steps.filter((s) => s.row === 2) }));
    expect(chips(a)).toEqual(["", "", "○", ""]);
  });

  test("an answer for other page bytes, an error, a thrown fetch or a malformed answer: no chips", async () => {
    const full = await answer();
    for (const [hash, get] of [
      [sha256(PAGE), respond({ ...full, hash: "other" })],
      [null, respond(full)],
      [sha256(PAGE), respond({ error: "x" }, 500)],
      // A non-2xx carrying a well-formed answer still draws nothing.
      [sha256(PAGE), respond(full, 502)],
      [sha256(PAGE), async () => Promise.reject(new Error("offline"))],
      [sha256(PAGE), respond({ hash: sha256(PAGE), steps: "nope", laneRows: [4] })],
    ] as [string | null, () => Promise<Response>][]) {
      const a = mount();
      await enhanceStepChecks(a, ctx(hash), get);
      expect(chips(a)).toEqual(["", "", "", ""]);
    }
  });

  test("a lane that renders another number of rows than the route counted gets no chips (Done's pairing)", async () => {
    const a = mount();
    const full: StepChecksAnswer = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond({ ...full, laneRows: [5] }));
    expect(chips(a)).toEqual(["", "", "", ""]);
  });

  test("a page with no slot makes no request", async () => {
    let asked = 0;
    const a = mount(PAGE.replace(/ <Check [^>]*\/>/g, ""));
    await enhanceStepChecks(a, ctx("h"), async () => (asked++, new Response("{}")));
    expect(asked).toBe(0);
  });
});

const rowLi = (a: HTMLElement, i: number) => a.querySelectorAll<HTMLElement>(".nm-lane .nm-body > ol > li")[i]!;
const HOSTILE = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script><b>b</b>';

describe("step-check chips: what a route string can do", () => {
  test("HTML in every route string field renders as literal text and creates no element", async () => {
    const a = mount();
    const full = await answer();
    const machine = (name: string, state: string) => ({ name: `${name}${HOSTILE}`, state, why: `why ${HOSTILE}`, probes: [{ kind: `kind${HOSTILE}`, value: `value${HOSTILE}`, state, why: `probe why ${HOSTILE}` }] });
    const steps = full.steps.map((s) => ({ ...s, machines: s.row === 3 ? [machine("laptop", "ok"), machine("mini", "unknown")] : [machine("here", s.state)], problems: [`problem ${HOSTILE}`] }));
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond({ ...full, steps }));
    expect(a.querySelectorAll("img, script, b").length).toBe(0);
    expect(a.querySelectorAll(".step-chip").length).toBe(3);
    const many = rowLi(a, 3).querySelector<HTMLElement>(".step-chip")!;
    expect(many.textContent).toBe("?");
    expect(Array.from(a.ownerDocument.getElementById(many.getAttribute("aria-controls")!)!.querySelectorAll(".step-chip-machine")).map((m) => m.textContent)).toEqual([`laptop${HOSTILE}: checked`, `mini${HOSTILE}: unknown`]);
    expect(many.getAttribute("aria-label")).toBe(`Check: unknown (laptop${HOSTILE} checked, mini${HOSTILE} unknown)`);
    expect(many.title).toBe([`laptop${HOSTILE}: kind${HOSTILE}=value${HOSTILE}: probe why ${HOSTILE}`, `mini${HOSTILE}: kind${HOSTILE}=value${HOSTILE}: probe why ${HOSTILE}`, `problem ${HOSTILE}`].join("\n"));
    // Every node the slot holds is the chip's own: its text and the reasons, as text.
    for (const slot of Array.from(a.querySelectorAll<HTMLElement>(".step-check"))) {
      for (const el of Array.from(slot.querySelectorAll("*"))) expect(["step-chip", "step-chip-pop", "step-chip-state", "step-chip-machine", "step-chip-why"]).toContain(el.className);
    }
  });

  test("the reasons node the chip points at holds the same strings as text", async () => {
    const a = mount();
    const full = await answer();
    const steps = full.steps.map((s) => ({ ...s, machines: [{ name: `here${HOSTILE}`, state: s.state, why: HOSTILE, probes: [{ kind: `k${HOSTILE}`, value: `v${HOSTILE}`, state: s.state, why: `w${HOSTILE}` }] }], problems: [`p${HOSTILE}`] }));
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond({ ...full, steps }));
    const chip = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    const why = a.ownerDocument.getElementById(chip.getAttribute("aria-describedby") ?? "")!;
    expect(why.textContent).toBe(`k${HOSTILE}=v${HOSTILE}: w${HOSTILE}\np${HOSTILE}`);
    expect(why.children.length).toBe(0);
    expect(a.querySelectorAll("img, script, b").length).toBe(0);
  });
});

describe("step-check chips: state, name and placement", () => {
  test("a step with several machines takes the step's overall state, never its first machine's", async () => {
    const a = mount();
    const full = await answer();
    // The real answer: laptop ok, mini unknown, the step unknown.
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(full));
    expect(rowLi(a, 3).querySelector<HTMLElement>(".step-chip")!.dataset.state).toBe("unknown");
    // Shaped: the first machine ok, the step not yet.
    const b = mount();
    const steps = full.steps.map((s) => (s.row === 3 ? { ...s, state: "not-yet", machines: [{ ...s.machines[0]!, state: "ok" }, { ...s.machines[1]!, state: "not-yet" }] } : s));
    await enhanceStepChecks(b, ctx(sha256(PAGE)), respond({ ...full, steps }));
    expect(rowLi(b, 3).querySelector<HTMLElement>(".step-chip")!.dataset.state).toBe("not-yet");
  });

  test("a second pass over the same page adds no second chip", async () => {
    const a = mount();
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(full));
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(full));
    expect(Array.from(a.querySelectorAll(".step-check")).map((s) => s.querySelectorAll(".step-chip").length)).toEqual([1, 1, 1]);
  });

  test("the chip names its state in words apart from the step's text, describes its reasons and shows them on activation, asking nothing", async () => {
    const a = mount();
    let asked = 0;
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), async () => (asked++, respond(full)()));
    const one = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    expect(one.getAttribute("aria-label")).toBe("Check: checked");
    expect(rowLi(a, 2).querySelector(".step-chip")!.getAttribute("aria-label")).toBe("Check: not yet");
    expect(rowLi(a, 3).querySelector(".step-chip")!.getAttribute("aria-label")).toBe("Check: unknown (laptop checked, mini unknown)");
    // Reachable from the keyboard and by touch: a native button.
    expect(one.tagName).toBe("BUTTON");
    expect(one.getAttribute("type")).toBe("button");
    const why = a.ownerDocument.getElementById(one.getAttribute("aria-describedby") ?? "")!;
    expect(why.textContent).toBe("env=HAVE: HAVE is set in .env and in the running process");
    const pop = a.ownerDocument.getElementById(one.getAttribute("aria-controls") ?? "")!;
    expect(pop.contains(why)).toBe(true);
    // The platform's popover, the chip its invoker: the browser opens and closes it.
    expect(pop.getAttribute("popover")).toBe("auto");
    expect(one.getAttribute("popovertarget")).toBe(pop.id);
    expect(one.getAttribute("aria-expanded")).toBe("false");
    pop.showPopover();
    expect(one.getAttribute("aria-expanded")).toBe("true");
    pop.hidePopover();
    expect(one.getAttribute("aria-expanded")).toBe("false");
    expect(asked).toBe(1);
    // Every chip's reasons node has an id of its own.
    const ids = Array.from(a.querySelectorAll(".step-chip")).map((c) => c.getAttribute("aria-describedby"));
    expect(new Set(ids).size).toBe(3);
  });

  // The chip after Done (Done moves the slot when it inserts itself) is pinned in e2e/wiki-step-checks.spec.ts.
  test("on a row without a Done, the chip stays after the step's text", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    expect(rowLi(a, 2).firstChild!.textContent!.startsWith("Migrate")).toBe(true);
    expect(rowLi(a, 2).lastElementChild!.className).toBe("step-check");
  });
});

describe("checkChip", () => {
  test("an unknown state reads unknown; problems join the title", () => {
    expect(checkChip({ key: "k", lane: 0, row: 0, state: "bogus" as never, machines: [], problems: ["p1"] })).toEqual({ state: "unknown", glyph: "?", name: "Check: unknown", head: "Check: unknown", machines: [], title: "p1" });
    // An inherited property name is no state either.
    const c = checkChip({ key: "k", lane: 0, row: 0, state: "toString" as never, machines: [{ name: "a", state: "constructor" as never, why: "", probes: [] }, { name: "b", state: "ok", why: "", probes: [] }] });
    expect([c.glyph, c.machines, c.name]).toEqual(["?", ["a: unknown", "b: checked"], "Check: unknown (a unknown, b checked)"]);
  });
});

describe("step-check chips: one glyph, and the reasons as a popover (fix round 2 batch 3)", () => {
  const popOf = (a: HTMLElement, chip: HTMLElement) => a.ownerDocument.getElementById(chip.getAttribute("aria-controls") ?? "");
  const key = (el: Element, k: string) => el.dispatchEvent(new (el.ownerDocument.defaultView as unknown as typeof globalThis).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  test("the chip shows one glyph and no words; the words are its name", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    expect(chips(a)).toEqual(["✓", "", "○", "?"]);
    expect(rowLi(a, 3).querySelector(".step-chip")!.getAttribute("aria-label")).toBe("Check: unknown (laptop checked, mini unknown)");
  });

  test("the popover holds the state in words, one line per machine and the reasons, as text", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    const chip = rowLi(a, 3).querySelector<HTMLElement>(".step-chip")!;
    const pop = popOf(a, chip)!;
    expect(pop).not.toBeNull();
    expect(chip.parentElement!.contains(pop)).toBe(true);
    expect(pop.hasAttribute("hidden")).toBe(false);
    expect(fake!.open.size).toBe(0);
    expect(pop.querySelector(".step-chip-state")!.textContent).toBe("Check: unknown");
    expect(Array.from(pop.querySelectorAll(".step-chip-machine")).map((m) => m.textContent)).toEqual(["laptop: checked", "mini: unknown"]);
    const why = a.ownerDocument.getElementById(chip.getAttribute("aria-describedby") ?? "")!;
    expect(pop.contains(why)).toBe(true);
    expect(why.textContent).toBe(chip.title);
    // One machine: no machine lines.
    const one = popOf(a, rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!)!;
    expect(one.querySelector(".step-chip-state")!.textContent).toBe("Check: checked");
    expect(one.querySelectorAll(".step-chip-machine").length).toBe(0);
  });

  test("ids are unique per row and the same on a fresh render of the same page", async () => {
    const full = await answer();
    const idsOf = async () => {
      const a = mount();
      await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(full));
      return Array.from(a.querySelectorAll(".step-chip")).map((c) => [c.getAttribute("aria-controls"), c.getAttribute("aria-describedby")]);
    };
    const first = await idsOf();
    expect(new Set(first.flat()).size).toBe(6);
    expect(await idsOf()).toEqual(first);
  });

  test("Escape while one is open closes it, puts focus on the chip and reaches no other listener; with none open it goes on", async () => {
    const a = mount();
    let asked = 0;
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), async () => (asked++, respond(full)()));
    const doc = a.ownerDocument;
    const reached: string[] = [];
    doc.addEventListener("keydown", (e) => reached.push(`key:${(e as KeyboardEvent).key}`));
    a.addEventListener("click", () => reached.push("click"));
    const c0 = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    const p0 = popOf(a, c0)!;
    // WebKit focuses no button on click: focus is elsewhere when Escape comes.
    doc.body.focus();
    p0.showPopover();
    key(doc.body, "Escape");
    expect(fake!.open.has(p0)).toBe(false);
    expect(doc.activeElement).toBe(c0);
    expect(c0.getAttribute("aria-expanded")).toBe("false");
    expect(reached).toEqual([]);
    key(c0, "Escape");
    expect(reached).toEqual(["key:Escape"]);
    // Another key while open is not ours.
    p0.showPopover();
    key(c0, "v");
    expect(fake!.open.has(p0)).toBe(true);
    expect(reached).toEqual(["key:Escape", "key:v"]);
    // A click on the chip goes no further than the chip.
    c0.click();
    expect(reached.filter((r) => r === "click")).toEqual([]);
    expect(asked).toBe(1);
  });

  test("what it listens to while open it adds on open and removes on close: fifty cycles leave nothing", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    const base = live();
    const p0 = popOf(a, rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!)!;
    const p2 = popOf(a, rowLi(a, 2).querySelector<HTMLElement>(".step-chip")!)!;
    p0.showPopover();
    expect(live()).toBeGreaterThan(base);
    expect(fake!.listeners.get("scroll")).toBe(1);
    expect(fake!.listeners.get("resize")).toBe(1);
    expect(fake!.frames.size).toBe(1);
    p0.hidePopover();
    for (let i = 0; i < 50; i++) {
      (i % 2 ? p0 : p2).showPopover();
      (i % 2 ? p0 : p2).hidePopover();
    }
    expect(live()).toBe(base);
    expect(fake!.frames.size).toBe(0);
  });

  test("a row removed while its popover is open (the platform fires no toggle then) leaves no listener a frame later", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    const base = live();
    const li = rowLi(a, 0);
    const p0 = popOf(a, li.querySelector<HTMLElement>(".step-chip")!)!;
    p0.showPopover();
    expect(live()).toBeGreaterThan(base);
    li.remove();
    await new Promise((r) => setTimeout(r, 30));
    expect(live()).toBe(base);
    expect(fake!.frames.size).toBe(0);
  });

  test("a scroll anywhere closes it, a scroll inside it does not; a resize closes it", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    const win = a.ownerDocument.defaultView as unknown as typeof globalThis;
    const p0 = popOf(a, rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!)!;
    p0.showPopover();
    p0.dispatchEvent(new win.Event("scroll"));
    expect(fake!.open.has(p0)).toBe(true);
    a.dispatchEvent(new win.Event("scroll"));
    expect(fake!.open.has(p0)).toBe(false);
    p0.showPopover();
    win.dispatchEvent(new win.Event("resize"));
    expect(fake!.open.has(p0)).toBe(false);
  });

  test("ids are unique across two lanes and two NextMoves blocks", async () => {
    const block = (n: number) => ["<NextMoves>", "", '<Lane kind="you">', "", `1. Lane ${n}a step <Check env="HAVE" />`, "", "</Lane>", "", '<Lane kind="you">', "", `1. Lane ${n}b step <Check env="HAVE" />`, "", "</Lane>", "", "</NextMoves>", ""];
    const md = ["---", "title: T", "---", "", ...block(1), ...block(2)].join("\n");
    const a = mount(md);
    await enhanceStepChecks(a, ctx(sha256(md)), respond(await answerStepChecks(md, { probes, machine: "laptop", cache: new ProbeCache() })));
    const ids = Array.from(a.querySelectorAll(".step-chip")).flatMap((c) => [c.getAttribute("popovertarget"), c.getAttribute("aria-describedby")]);
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(8);
    for (const id of ids) expect(a.ownerDocument.querySelectorAll(`[id="${id}"]`).length).toBe(1);
  });

  test("a browser without the popover API gets a plain button with its name and title, and no popover", async () => {
    const a = mount(PAGE, { popover: false });
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    expect(chips(a)).toEqual(["✓", "", "○", "?"]);
    const c = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    expect(c.tagName).toBe("BUTTON");
    expect(c.getAttribute("aria-label")).toBe("Check: checked");
    expect(c.title).toBe("env=HAVE: HAVE is set in .env and in the running process");
    expect(c.hasAttribute("popovertarget")).toBe(false);
    expect(a.querySelectorAll(".step-chip-pop, [popover]").length).toBe(0);
    c.click();
    expect(a.querySelectorAll(".step-chip-pop").length).toBe(0);
  });
});

describe("a task-list step takes no check (item 2: the render, the route and lint agree)", () => {
  const TASKS = PAGE.replace('1. Add the key <Check env="HAVE" />', '1. [ ] Add the key <Check env="HAVE" />');
  test("the reader renders no slot on a task-list row, and the route answers no step for it", async () => {
    const a = mount(TASKS);
    expect(a.querySelectorAll(".step-check").length).toBe(0);
    expect(a.querySelector(".nm-body li.check-item")).not.toBeNull();
    const got = await answerStepChecks(TASKS, { probes, machine: "laptop", cache: new ProbeCache() });
    expect(got.steps).toEqual([]);
  });
});

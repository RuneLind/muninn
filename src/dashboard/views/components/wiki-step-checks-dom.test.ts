/**
 * The reader's step-check chips on the real render: `renderWikiHtml` output in
 * a happy-dom `Window` of the test's own (no globals installed), the route's
 * answer computed by the real `answerStepChecks` over faked probes, then
 * `enhanceStepChecks` with an injected fetch. Pins: chips only on rows the
 * route answered, paired by Done's rule; none on a hash mismatch, an error or
 * a bad answer; no request when the page has no slot; the chip stays inside
 * the reader-only slot; the chip is one glyph, named in words, its reasons in
 * its title, no control and no listener of its own.
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

/** Window and document listeners added, per type, counted from the mount on. */
let added: Map<string, number> = new Map();

function mount(md = PAGE) {
  const win = new Window();
  added = new Map();
  const doc = win.document;
  for (const t of [win, doc] as unknown as EventTarget[]) {
    const add = t.addEventListener.bind(t);
    t.addEventListener = ((type: string, fn: EventListener, o?: unknown) => {
      added.set(type, (added.get(type) ?? 0) + 1);
      add(type, fn, o as never);
    }) as never;
  }
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
    expect(many.getAttribute("aria-label")).toBe(`Check: unknown (laptop${HOSTILE} checked, mini${HOSTILE} unknown)`);
    expect(many.title).toBe([`laptop${HOSTILE}: kind${HOSTILE}=value${HOSTILE}: probe why ${HOSTILE}`, `mini${HOSTILE}: kind${HOSTILE}=value${HOSTILE}: probe why ${HOSTILE}`, `problem ${HOSTILE}`].join("\n"));
    // The slot holds the chip and nothing else; the chip holds only its glyph, as text.
    for (const slot of Array.from(a.querySelectorAll<HTMLElement>(".step-check"))) {
      expect(Array.from(slot.querySelectorAll("*")).map((el) => el.className)).toEqual(["step-chip"]);
      expect(slot.firstElementChild!.children.length).toBe(0);
    }
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

  test("the chip is an image named in words, its reasons its title; no control, no listener, and asking nothing", async () => {
    const a = mount();
    let asked = 0;
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), async () => (asked++, respond(full)()));
    const one = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    expect(one.getAttribute("aria-label")).toBe("Check: checked");
    expect(one.title).toBe("env=HAVE: HAVE is set in .env and in the running process");
    expect(rowLi(a, 2).querySelector(".step-chip")!.getAttribute("aria-label")).toBe("Check: not yet");
    expect(rowLi(a, 3).querySelector(".step-chip")!.getAttribute("aria-label")).toBe("Check: unknown (laptop checked, mini unknown)");
    // Activating it would do nothing, so it is no control and no tab stop.
    expect(one.tagName).toBe("SPAN");
    expect(one.getAttribute("role")).toBe("img");
    expect(one.hasAttribute("tabindex")).toBe(false);
    for (const attr of ["popover", "popovertarget", "aria-expanded", "aria-controls", "aria-describedby", "id"]) expect(a.querySelectorAll(`.step-check [${attr}]`).length).toBe(0);
    one.click();
    expect(added).toEqual(new Map());
    expect(asked).toBe(1);
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
    expect(checkChip({ key: "k", lane: 0, row: 0, state: "bogus" as never, machines: [], problems: ["p1"] })).toEqual({ state: "unknown", glyph: "?", name: "Check: unknown", title: "p1" });
    // An inherited property name is no state either.
    const c = checkChip({ key: "k", lane: 0, row: 0, state: "toString" as never, machines: [{ name: "a", state: "constructor" as never, why: "", probes: [] }, { name: "b", state: "ok", why: "", probes: [] }] });
    expect([c.glyph, c.name]).toEqual(["?", "Check: unknown (a unknown, b checked)"]);
  });
});

describe("step-check chips: one glyph", () => {
  test("the chip shows one glyph and no words; the words are its name, the reasons its title", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    expect(chips(a)).toEqual(["✓", "", "○", "?"]);
    const many = rowLi(a, 3).querySelector<HTMLElement>(".step-chip")!;
    expect(many.getAttribute("aria-label")).toBe("Check: unknown (laptop checked, mini unknown)");
    // One reason line per machine's probe, each named by its machine.
    expect(many.title.split("\n").map((l) => l.split(":")[0])).toEqual(["laptop", "mini"]);
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

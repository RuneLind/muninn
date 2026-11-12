/**
 * The reader's step-check chips on the real render: `renderWikiHtml` output in
 * a happy-dom `Window` of the test's own (no globals installed), the route's
 * answer computed by the real `answerStepChecks` over faked probes, then
 * `enhanceStepChecks` with an injected fetch. Pins: chips only on rows the
 * route answered, paired by Done's rule; none on a hash mismatch, an error or
 * a bad answer; no request when the page has no slot; the chip stays inside
 * the reader-only slot.
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

function mount(md = PAGE) {
  const doc = new Window().document;
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
    expect(pop.hidden).toBe(true);
    expect(one.getAttribute("aria-expanded")).toBe("false");
    one.click();
    expect(pop.hidden).toBe(false);
    expect(one.getAttribute("aria-expanded")).toBe("true");
    one.click();
    expect(pop.hidden).toBe(true);
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
    expect(pop.hidden).toBe(true);
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

  test("activation toggles it; Escape closes it with focus on the chip and goes no further; a click outside closes it; only one is open", async () => {
    const a = mount();
    let asked = 0;
    const full = await answer();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), async () => (asked++, respond(full)()));
    const doc = a.ownerDocument;
    const reached: string[] = [];
    doc.addEventListener("keydown", (e) => reached.push(`key:${(e as KeyboardEvent).key}`));
    a.addEventListener("click", () => reached.push("click"));
    const c0 = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    const c2 = rowLi(a, 2).querySelector<HTMLElement>(".step-chip")!;
    const p0 = popOf(a, c0)!;
    const p2 = popOf(a, c2)!;
    c0.click();
    expect(p0.hidden).toBe(false);
    expect(c0.getAttribute("aria-expanded")).toBe("true");
    c0.click();
    expect(p0.hidden).toBe(true);
    expect(c0.getAttribute("aria-expanded")).toBe("false");
    c0.click();
    key(c0, "Escape");
    expect(p0.hidden).toBe(true);
    expect(doc.activeElement).toBe(c0);
    // Escape with nothing open goes on to the shell.
    key(c0, "Escape");
    expect(reached).toEqual(["key:Escape"]);
    c0.click();
    c2.click();
    expect(p0.hidden).toBe(true);
    expect(c0.getAttribute("aria-expanded")).toBe("false");
    expect(p2.hidden).toBe(false);
    doc.body.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).PointerEvent("pointerdown", { bubbles: true }));
    expect(p2.hidden).toBe(true);
    // A pointerdown on the popover itself keeps it.
    c2.click();
    p2.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).PointerEvent("pointerdown", { bubbles: true }));
    expect(p2.hidden).toBe(false);
    expect(reached.filter((r) => r === "click")).toEqual([]);
    expect(asked).toBe(1);
  });

  test("focus leaving the chip and its popover closes it", async () => {
    const a = mount();
    await enhanceStepChecks(a, ctx(sha256(PAGE)), respond(await answer()));
    const c0 = rowLi(a, 0).querySelector<HTMLElement>(".step-chip")!;
    const c2 = rowLi(a, 2).querySelector<HTMLElement>(".step-chip")!;
    c0.focus();
    c0.click();
    expect(popOf(a, c0)!.hidden).toBe(false);
    c2.focus();
    expect(popOf(a, c0)!.hidden).toBe(true);
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

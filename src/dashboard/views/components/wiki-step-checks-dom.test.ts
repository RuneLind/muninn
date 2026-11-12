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
  readEnvFile: async () => ({ text: "HAVE=1\n" }),
  processHasEnv: () => true,
  hasMigration: async (v) => v === "086",
  dashboardPort: 3010,
  ownRepoDir: "/nowhere",
  processStartMs: 0,
  mtimeMs: async () => null,
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
    expect(chips(a)).toEqual(["✓ checked", "", "○ not yet", "laptop ✓ · mini ?"]);
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
    expect(chips(a)).toEqual(["", "", "○ not yet", ""]);
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

describe("checkChip", () => {
  test("an unknown state reads unknown; problems join the title", () => {
    expect(checkChip({ key: "k", lane: 0, row: 0, state: "bogus" as never, machines: [], problems: ["p1"] })).toEqual({ state: "unknown", text: "? unknown", title: "p1" });
    // An inherited property name is no state either.
    expect(checkChip({ key: "k", lane: 0, row: 0, state: "toString" as never, machines: [{ name: "a", state: "constructor" as never, why: "", probes: [] }, { name: "b", state: "ok", why: "", probes: [] }] }).text).toBe("a ? \u00B7 b \u2713");
  });
});

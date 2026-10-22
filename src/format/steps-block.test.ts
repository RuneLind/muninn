import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STEPS_CHROME_CLASSES, stepsViewHtml } from "./steps-block.ts";
import * as stepsFocus from "./steps-focus.ts";
const { stepFocusOf } = stepsFocus;
import { DIAGRAM_ID_MARK, type DiagramSvgResult, type PageFiles } from "./query-block.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { PEEK_STEPS_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { nextStepIndex } from "../dashboard/views/components/wiki-visuals.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { loadPageFiles } from "../wiki/page-files.ts";
import { checkPageText } from "../wiki/lint.ts";
import { checkSteps } from "../wiki/lint-steps.ts";
import { checkDiagrams } from "../wiki/lint-diagram.ts";
import { testTempDir } from "../test/temp-dir.ts";

const M = DIAGRAM_ID_MARK;
const LIFE = {
  meta: {
    title: "Case life",
    views: [
      { id: "start", label: "Start", focus: ["new"], note: "Opened." },
      { id: "end", label: "End", focus: ["done"] },
    ],
  },
  lanes: [{ id: "main", label: "Main" }],
  states: ["new", "work", "done"].map((id, i) => ({ id, label: id, lane: "main", col: i + 1 })),
};
const svgOf = (svg: string): DiagramSvgResult => ({ svg, unknownElements: [], unknownAttrs: [], unknownClasses: [] });
const PICTURE = `<svg viewBox="0 0 1 1"><defs><marker id="${M}arrowhead"/></defs><g data-node-id="new"/><path marker-end="url(#${M}arrowhead)" data-edge-from="new" data-edge-to="work"/></svg>`;
const files = (svg: string | null = PICTURE): PageFiles =>
  new Map([["./s.lifecycle.json", { ok: true, text: JSON.stringify(LIFE), svg: svg === null ? { ...svgOf(""), svg: null, problem: "missing" } : svgOf(svg) }]]);
const LIST = ['<Steps src="./s.lifecycle.json">', "", "1. Opened `new`", "2. Worked `new`, `work`", "3. Closed", "", "</Steps>"].join("\n");

describe("stepFocusOf", () => {
  const cases: [string, string[]][] = [
    ["Opened `new`", ["new"]],
    ["Worked `new`, `work`", ["new", "work"]],
    ["Worked `new, work`", ["new", "work"]],
    ["Worked `new work`  ", ["new", "work"]],
    ["Worked `a` `b`,`c`", ["a", "b", "c"]],
    ["Dup `a`, `a, b`", ["a", "b"]],
    ["Prose `a`.", []],
    ["`a` in the middle", []],
    ["No code at all", []],
    ["Two lines\nsecond `x`", ["x"]],
    ["First `x`\nsecond line", []],
    ["Double ``a`b``", ["a`b"]],
    ["Code then text ``a`` end", []],
  ];
  for (const [item, want] of cases) test(JSON.stringify(item), () => expect(stepFocusOf(item)).toEqual(want));
});

describe("nextStepIndex", () => {
  test("from Show all, Next is the first and Prev the last; both stop at the ends", () => {
    expect(nextStepIndex("next", -1, 3)).toBe(0);
    expect(nextStepIndex("prev", -1, 3)).toBe(2);
    expect(nextStepIndex("next", 2, 3)).toBe(2);
    expect(nextStepIndex("prev", 0, 3)).toBe(0);
    expect(nextStepIndex("next", 0, 3)).toBe(1);
    expect(nextStepIndex("next", -1, 0)).toBe(-1);
  });
});

describe("<Steps> on the reader", () => {
  test("an authored list: one li.stp-step per item with its focus, the figure without view buttons, the controls", () => {
    const html = renderWikiHtml(LIST, () => undefined, { views: true, files: files() });
    expect(html).toContain('<section class="stp" data-stp-count="3" data-stp-cur="-1">');
    expect([...html.matchAll(/data-stp-focus="([^"]*)"/g)].map((m) => m[1])).toEqual(["new", "new work", ""]);
    expect(html).not.toContain("data-dgm-view");
    expect([...html.matchAll(/data-stp-act="(\w+)"/g)].map((m) => m[1])).toEqual(["prev", "next", "play", "all"]);
    expect(html).toContain('id="dgm1-arrowhead"');
    // The item keeps its code span as written.
    expect(html).toContain("<code>new</code>");
  });

  test("no list: the steps are the file's views, reader-only", () => {
    const html = renderWikiHtml('<Steps src="./s.lifecycle.json" />', () => undefined, { views: true, files: files() });
    expect(html).toContain('data-stp-count="2"');
    expect(html).toMatch(/<ol class="stp-list stp-derived" data-reader-only/);
    expect([...html.matchAll(/data-stp-focus="([^"]*)"/g)].map((m) => m[1])).toEqual(["new", "done"]);
    expect(html).toContain("<strong>Start</strong> — Opened.");
  });

  test("a Diagram and a Steps on one file share no id", () => {
    const md = `${LIST}\n\n<Diagram src="./s.lifecycle.json" />\n`;
    const html = renderWikiHtml(md, () => undefined, { views: true, files: files() });
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toEqual(["dgm1-arrowhead", "dgm2-arrowhead"]);
  });

  test("no picture: the text form and the list, no controls", () => {
    const html = renderWikiHtml(LIST, () => undefined, { views: true, files: files(null) });
    expect(html).toContain("Picture not shown");
    expect(html).not.toContain("data-stp-act");
    expect(html).toContain('class="stp-step"');
  });

  test("an unreadable file keeps the list", () => {
    const html = stepsViewHtml({ ref: "./s.lifecycle.json", text: "[]", prefix: "dgm1-", bodyHtml: "<ol><li>x</li></ol>", authored: 1 });
    expect(html).toContain("Diagram file not readable");
    expect(html).toContain("<li>x</li>");
    expect(html).not.toContain("data-stp-act");
  });

  test("the peek strips exactly the steps chrome", () => {
    expect([...PEEK_STEPS_CHROME]).toEqual([...STEPS_CHROME_CLASSES]);
  });
});

describe("<Steps> everywhere else prints the list and a file line", () => {
  test("web chat: the list, then its not-loaded line", () => {
    const html = formatWebHtml(LIST);
    expect(html).toContain("Opened");
    expect(html).toContain("<code>new</code>");
    expect(html).toContain('class="stp-unavailable"');
    expect(html).not.toContain("stp-step");
  });
  test("telegram, slack and email: the list and the file line with its interactive sibling", () => {
    const md = LIST.replace("./s.lifecycle.json", "./flows/s.lifecycle.json");
    for (const out of [formatTelegramHtml(md), formatSlackMrkdwn(md), formatEmailHtml(md)]) {
      expect(out).toContain("Opened");
      expect(out).toContain("Closed");
      expect(out).toContain("s.lifecycle.json");
      expect(out).toContain("s.html");
    }
    expect(formatTelegramHtml(md)).toContain("Steps: s.lifecycle.json (interactive: s.html)");
    expect(formatEmailHtml(md)).toContain("Steps: s.lifecycle.json (interactive: s.html)");
  });
  test("no src", () => {
    expect(formatTelegramHtml("<Steps />")).toBe("Steps without src");
    expect(formatSlackMrkdwn("<Steps />")).toBe("Steps without src");
  });
});

describe("lint: steps-focus and the Steps file under diagram-svg", () => {
  let base = "";
  let root = "";
  const PAGE = "flows/page.mdx";
  beforeAll(async () => {
    base = await testTempDir(path.join(tmpdir(), "muninn-steps-"));
    root = path.join(base, "wiki");
    await mkdir(path.join(root, "flows"), { recursive: true });
    await writeFile(path.join(root, "flows", "s.lifecycle.json"), JSON.stringify(LIFE));
    await writeFile(path.join(root, "flows", "s.html"), `<svg viewBox="0 0 1 1"><g data-node-id="new" class="c-backend"/></svg>`);
    await writeFile(path.join(root, "flows", "v.lifecycle.json"), JSON.stringify({ ...LIFE, meta: { views: [{ id: "x", label: "X", focus: ["gone"] }] } }));
    await writeFile(path.join(root, "flows", "v.html"), `<svg viewBox="0 0 1 1"></svg>`);
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  const run = async (md: string) => {
    const f = await loadPageFiles(root, PAGE, md);
    return { steps: checkSteps({ relPath: PAGE }, md, f), diagram: checkDiagrams({ relPath: PAGE }, md, f) };
  };

  test("fires on an unknown id, on the item's own line, and not on a known one", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "1. Known `new`", "2. Unknown `new`, `nope`", "", "</Steps>", ""].join("\n");
    const { steps } = await run(md);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.message).toContain("step 2");
    expect(steps[0]!.message).toContain("nope");
    expect(steps[0]!.message).not.toContain("new,");
    expect(steps[0]!.line).toBe(6);
  });

  test("a known id alone is no finding; frontmatter shifts the line", async () => {
    const ok = ["---", "title: P", "---", '<Steps src="./s.lifecycle.json">', "", "- A `new`", "- B `work, done`", "", "</Steps>"].join("\n");
    expect((await run(ok)).steps).toEqual([]);
    const bad = ok.replace("`work, done`", "`work, x`");
    expect((await run(bad)).steps[0]!.line).toBe(7);
  });

  test("with no list, a view's unknown focus id is judged, on the tag's line", async () => {
    const md = '# P\n\n<Steps src="./v.lifecycle.json" />\n';
    const { steps } = await run(md);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.message).toContain("view 1");
    expect(steps[0]!.line).toBe(3);
  });

  test("a file that did not load is diagram-svg's finding, named <Steps>, not steps-focus's", async () => {
    const md = '# P\n\n<Steps src="./missing.lifecycle.json">\n\n1. A `x`\n\n</Steps>\n';
    const { steps, diagram } = await run(md);
    expect(steps).toEqual([]);
    expect(diagram).toHaveLength(1);
    expect(diagram[0]!.message).toStartWith('<Steps src="./missing.lifecycle.json"> file is missing');
    expect(diagram[0]!.line).toBe(3);
  });

  test("checkPageText runs it on an .mdx page", async () => {
    const md = '# P\n\n<Steps src="./s.lifecycle.json">\n\n1. A `zz`\n\n</Steps>\n';
    const f = await loadPageFiles(root, PAGE, md);
    const out = checkPageText({ relPath: PAGE, culled: false }, md, [], f);
    expect(out.filter((x) => x.check === "steps-focus")).toHaveLength(1);
  });
});

describe("fix round 1 batch 2: focus off the item's last paragraph, numbering on, one step", () => {
  const focusOf = (md: string) =>
    [...renderWikiHtml(md, () => undefined, { views: true, files: files() }).matchAll(/data-stp-focus="([^"]*)"/g)].map((m) => m[1]);
  const block = (...lines: string[]) => ['<Steps src="./s.lifecycle.json">', "", ...lines, "", "</Steps>"].join("\n");

  test("a continuation paragraph's closing spans are the focus", () => {
    expect(focusOf(block("1. First `new`", "2. Second", "", "   para two `work`"))).toEqual(["new", "work"]);
  });
  test("a nested list stays text: the focus is the last paragraph before it", () => {
    expect(focusOf(block("1. Opened", "", "   para `work`", "", "   - sub `done`"))).toEqual(["work"]);
    expect(focusOf(block("1. Opened `new`", "   - sub `done`"))).toEqual(["new"]);
  });
  test("a fence ending the item is skipped the same way", () => {
    expect(focusOf(block("1. Opened `new`", "", "   ```", "   code `done`", "   ```"))).toEqual(["new"]);
  });

  test("two lists number on: the later <ol> starts after the steps before it", () => {
    const md = block("1. A `new`", "2. B", "", "Between.", "", "1. C");
    const html = renderWikiHtml(md, () => undefined, { views: true, files: files() });
    expect(html).toMatch(/<ol class="stp-list" start="3">/);
    expect(formatTelegramHtml(md)).toContain("3. C");
    expect(formatSlackMrkdwn(md)).toContain("3. C");
    expect(formatWebHtml(md)).toMatch(/<ol[^>]* start="3"/);
  });
  test("the source numbers give way to the step's place: start and item values", () => {
    const md = block("4. A", "", "Between.", "", "5. B", "", "   more", "", "9. C");
    const html = renderWikiHtml(md, () => undefined, { views: true, files: files() });
    expect(html).toMatch(/<ol class="stp-list" start="2">/);
    expect(html).toMatch(/<ol class="stp-list">/);
    expect(html).not.toMatch(/ value="/);
    expect(formatTelegramHtml(md)).toContain("3. C");
    expect(formatTelegramHtml(md)).toContain("1. A");
  });

  test("one step reads «1 step»", () => {
    const html = renderWikiHtml(block("1. Only `new`"), () => undefined, { views: true, files: files() });
    expect(html).toContain('aria-live="polite">1 step</span>');
    expect(stepsFocus.stepsPosText(-1, 1)).toBe("1 step");
    expect(stepsFocus.stepsPosText(-1, 4)).toBe("4 steps");
    expect(stepsFocus.stepsPosText(0, 1)).toBe("Step 1 of 1");
  });
});

describe("fix round 1 batch 2: lint reads a continuation paragraph's focus", () => {
  let base = "";
  let root = "";
  const PAGE = "flows/page.mdx";
  beforeAll(async () => {
    base = await testTempDir(path.join(tmpdir(), "muninn-steps2-"));
    root = path.join(base, "wiki");
    await mkdir(path.join(root, "flows"), { recursive: true });
    await writeFile(path.join(root, "flows", "s.lifecycle.json"), JSON.stringify(LIFE));
    await writeFile(path.join(root, "flows", "s.html"), `<svg viewBox="0 0 1 1"><g data-node-id="new"/></svg>`);
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });
  test("an unknown id in a continuation paragraph fires, on the item's line", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "1. Known `new`", "2. Second", "", "   para `nope`", "", "</Steps>", ""].join("\n");
    const out = checkSteps({ relPath: PAGE }, md, await loadPageFiles(root, PAGE, md));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("step 2");
    expect(out[0]!.message).toContain("nope");
    expect(out[0]!.line).toBe(6);
  });
  test("a nested list's spans are not judged", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "1. Known `new`", "   - sub `nope`", "", "</Steps>", ""].join("\n");
    expect(checkSteps({ relPath: PAGE }, md, await loadPageFiles(root, PAGE, md))).toEqual([]);
  });
});

describe("fix round 1 batch 3: item lines, block names, a file with no nodes", () => {
  let base = "";
  let root = "";
  const PAGE = "flows/page.mdx";
  beforeAll(async () => {
    base = await testTempDir(path.join(tmpdir(), "muninn-steps3-"));
    root = path.join(base, "wiki");
    await mkdir(path.join(root, "flows"), { recursive: true });
    await writeFile(path.join(root, "flows", "s.lifecycle.json"), JSON.stringify(LIFE));
    await writeFile(path.join(root, "flows", "s.workflow.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
    await writeFile(path.join(root, "flows", "s.html"), `<svg viewBox="0 0 1 1"><g data-node-id="new"/></svg>`);
    await writeFile(path.join(root, "flows", "e.lifecycle.json"), JSON.stringify({ meta: { title: "E" }, stats: LIFE.states }));
    await writeFile(path.join(root, "flows", "e.html"), `<svg viewBox="0 0 1 1"></svg>`);
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });
  const steps = async (md: string) => checkSteps({ relPath: PAGE }, md, await loadPageFiles(root, PAGE, md));
  const NO_NODES = (list: string) =>
    `file defines no nodes (its ${list} list is missing or empty); the text form is empty and no focus id can light a node`;
  const diagrams = async (md: string) => checkDiagrams({ relPath: PAGE }, md, await loadPageFiles(root, PAGE, md));

  test("a nested sub-bullet does not push step 2's finding onto the tag line", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "- A `new`", "  - nested note", "- B `nope`", "", "</Steps>", ""].join("\n");
    const out = await steps(md);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("step 2");
    expect(out[0]!.line).toBe(7);
  });
  test("an `N)` line the parser reads as prose is not an item", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "1. A `new`", "2) prose", "2. B `nope`", "", "</Steps>", ""].join("\n");
    const out = await steps(md);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("step 2");
    expect(out[0]!.line).toBe(7);
  });

  test("web chat names a <Steps> file line «Steps», as the other platforms do", () => {
    const html = formatWebHtml(LIST);
    expect(html).toContain("Steps not loaded here: s.lifecycle.json");
    expect(html).not.toContain("Diagram not loaded here");
    // A file that loaded, on a render with no steps view (chat with page files).
    const loaded = formatWebHtml(LIST, { files: files() });
    expect(loaded).toContain("Steps not loaded here: s.lifecycle.json");
    expect(loaded).not.toContain("Diagram not loaded here");
  });
  test("check 21 names a <Steps> sharer by its own tag", async () => {
    const md = ["# P", "", '<Steps src="./s.lifecycle.json">', "", "1. A `new`", "", "</Steps>", "", '<Diagram src="./s.workflow.json" />', ""].join("\n");
    const shared = (await diagrams(md)).filter((f) => f.message.includes("shares picture"));
    expect(shared.map((f) => f.message)).toEqual([
      '<Steps src="./s.lifecycle.json"> shares picture ./s.html with <Diagram src="./s.workflow.json">; archify writes one picture per diagram file, so these blocks show the same drawing',
      '<Diagram src="./s.workflow.json"> shares picture ./s.html with <Steps src="./s.lifecycle.json">; archify writes one picture per diagram file, so these blocks show the same drawing',
    ]);
  });

  test("a file with no node list is check 21's finding, and check 22 stays quiet", async () => {
    const md = ["# P", "", '<Steps src="./e.lifecycle.json">', "", "1. A `new`", "2. B `work`", "", "</Steps>", ""].join("\n");
    expect(await steps(md)).toEqual([]);
    const d = await diagrams(md);
    expect(d.map((f) => [f.line, f.message])).toEqual([[3, `<Steps src="./e.lifecycle.json"> ${NO_NODES("states")}`]]);
  });
  test("a <Diagram> on a file whose node list is empty gets the same finding", async () => {
    await writeFile(path.join(root, "flows", "z.workflow.json"), JSON.stringify({ nodes: [] }));
    await writeFile(path.join(root, "flows", "z.html"), `<svg viewBox="0 0 1 1"></svg>`);
    const d = await diagrams('# P\n\n<Diagram src="./z.workflow.json" />\n');
    expect(d.map((f) => f.message)).toEqual([`<Diagram src="./z.workflow.json"> ${NO_NODES("nodes")}`]);
  });
});

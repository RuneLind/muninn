/**
 * The article pane's one view owner (`wiki-pane-view.ts`, architecture review
 * 2026-11-16 F22): the token semantics, and source pins that every view entry
 * goes through `enterView` and that the teardown it runs is written once, in the
 * shell's `leaveView`. The behaviour (a late response from a left view paints
 * nothing) is driven through the booted shell in `wiki-boot/`.
 */
import { describe, expect, test } from "bun:test";
import { beginPageEntry, enterView, setViewTeardown, viewIsLive, type PaneViewKind } from "./wiki-pane-view.ts";

const read = (f: string) => Bun.file(new URL(`./${f}`, import.meta.url)).text();
/** A top-level function's text, from its `function` line to its closing `}` line. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?function ${name}\\(`, "m"));
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}
/** Code lines only: comment lines dropped. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));

describe("enterView", () => {
  test("runs the teardown once per entry, with the kind and relPath, and outdates every older token", () => {
    const calls: string[] = [];
    setViewTeardown((kind: PaneViewKind, relPath) => calls.push(`${kind}:${relPath}`));
    const a = enterView("page");
    expect(viewIsLive(a)).toBe(true);
    const b = enterView("explainer", "x.html");
    expect(viewIsLive(a)).toBe(false);
    expect(viewIsLive(b)).toBe(true);
    const c = enterView("ask");
    expect([viewIsLive(a), viewIsLive(b), viewIsLive(c)]).toEqual([false, false, true]);
    expect(calls).toEqual(["page:null", "explainer:x.html", "ask:null"]);
  });
});

describe("beginPageEntry", () => {
  test("a page fetch leaves the shown view live until it enters; a later fetch or any entry outdates it", () => {
    const calls: string[] = [];
    setViewTeardown((kind: PaneViewKind) => calls.push(kind));
    const ask = enterView("ask");
    const first = beginPageEntry();
    expect(viewIsLive(ask)).toBe(true);
    const second = beginPageEntry();
    expect([first.superseded(), second.superseded()]).toEqual([true, false]);
    expect(calls).toEqual(["ask"]);
    const page = second.enter();
    expect([viewIsLive(ask), viewIsLive(page), second.superseded()]).toEqual([false, true, false]);
    expect(second.enter()).toBe(page); // entered once
    expect(calls).toEqual(["ask", "page"]);
    const third = beginPageEntry();
    enterView("effort");
    expect([third.superseded(), second.superseded()]).toEqual([true, true]);
  });
});

describe("every view entry goes through enterView (F22)", () => {
  const ENTRIES: [file: string, fn: string, kind: PaneViewKind][] = [
    ["wiki-browser.ts", "renderStart", "start"],
    ["wiki-browser.ts", "loadExplainer", "explainer"],
    ["wiki-browser.ts", "fetchAndRenderPage", "page"],
    ["wiki-browser.ts", "renderIssueGraph", "graph"],
    ["wiki-effort-controller.ts", "renderEffort", "effort"],
    ["wiki-ask-controller.ts", "showAskAnswer", "ask"],
  ];

  test("each of the six entries calls it with its kind, and nothing else does", async () => {
    // A page enters through `beginPageEntry`, whose `enter()` is the one `enterView("page")`.
    for (const [file, fn, kind] of ENTRIES) {
      expect(fnBody(await read(file), fn)).toContain(kind === "page" ? "beginPageEntry()" : `enterView("${kind}"`);
    }
    expect(fnBody(await read("wiki-pane-view.ts"), "beginPageEntry")).toContain('enterView("page")');
    const glob = new Bun.Glob("*.ts");
    let sites = 0;
    for await (const f of glob.scan({ cwd: new URL(".", import.meta.url).pathname })) {
      if (f.endsWith(".test.ts") || f === "wiki-pane-view.ts") continue;
      sites += code(await read(f)).join("\n").match(/\benterView\(/g)?.length ?? 0;
    }
    expect(sites).toBe(ENTRIES.length - 1);
  });

  test("the teardown is written once: the shown page's identity, hash, breadcrumb and agent runs are cleared only in leaveView", async () => {
    const shell = await read("wiki-browser.ts");
    const leave = fnBody(shell, "leaveView");
    const outside = code(shell.replace(leave, "")).join("\n");
    for (const call of [/currentPageHash = null/, /hideBreadcrumb\(\);/, /abortAgentRuns\(\);/, /setCurrentName\(null\);/]) {
      expect(leave).toMatch(call);
      expect(outside).not.toMatch(call);
    }
    // The page's own identity lands with its response, the one other writer.
    expect(outside.match(/\bsetCurrentRelPath\(/g)?.length).toBe(2); // its definition and the page response
    expect(fnBody(shell, "fetchAndRenderPage")).toContain("setCurrentRelPath(data.meta.relPath || null)");
    for (const f of ["wiki-effort-controller.ts", "wiki-ask-controller.ts"]) {
      const src = code(await read(f)).join("\n");
      expect(/\b(abortAgentRuns|setCurrentName|clearShownPage|consumeUrlLens|setAtlasFull)\(/.test(src)).toBe(false);
    }
  });

  test("no second liveness counter is left beside the token", async () => {
    for (const f of ["wiki-browser.ts", "wiki-effort-controller.ts", "wiki-ask-controller.ts"]) {
      expect(/\b(pageViewSeq|pageFetchSeq)\b/.test(await read(f))).toBe(false);
    }
  });
});

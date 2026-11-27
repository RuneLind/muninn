/**
 * Discuss's tab, the pure half (P3, `wiki-discuss-state.ts`): a turn moved by
 * the route's stream frames, the current turn by `seq` and not by finish, the
 * words for every refusal the route answers, the tab's markup and where a
 * passage sits in a rendered article (in a happy-dom Window of its own).
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  applyDiscussFrame,
  currentTurn,
  discussionLive,
  discussPhaseWords,
  discussRefusalMessage,
  discussTurnBodyParts,
  discussTurnHtml,
  discussTurnsHtml,
  findPassage,
  SAME_PASSAGE_CHARS,
  findSamePassage,
  holdPassage,
  newTurn,
  patchDiscussTurns,
  renderedPassageText,
  streamClosed,
  type DiscussionView,
} from "./wiki-discuss-state.ts";
import * as discussState from "./wiki-discuss-state.ts";
import { breakablePaths, renderStreamingBody } from "./wiki-ask-render.ts";
import { formatWebHtml } from "../../../web/web-format.ts";
import { plainSnippet } from "../../../wiki/find-everywhere.ts";
import { DISCUSS_TEXT_SKIP, discussContext } from "./wiki-discuss-text.ts";
import { STORED_EDIT_MARKER, extractProposedEdit, stripProposedEdit } from "../../../wiki/discuss-agent.ts";

const passage = { selection: "The summer route adds a stop.", before: "", after: "", atStart: true, atEnd: true, heading: "Design" };

describe("the status line for a phase", () => {
  test("a page turn that names a key says it reads the key's mentions, not «Working…»", () => {
    const t = newTurn("t1", "where else is MEL-1029036?", passage);
    applyDiscussFrame(t, "turn", { turnId: "id-1", discussionId: "d-1", seq: 1 });
    applyDiscussFrame(t, "status", { phase: "mentions" });
    expect(discussTurnBodyParts(t, true).join("")).toContain("Reading the key&#39;s mentions…");
  });
  test("an unknown phase, and a name every object has, fall back to «Working…»", () => {
    expect(discussPhaseWords("mentions")).toBe("Reading the key's mentions…");
    expect(discussPhaseWords("later-phase")).toBe("Working…");
    expect(discussPhaseWords("constructor")).toBe("Working…");
    expect(discussPhaseWords(null)).toBe("Working…");
  });
});

describe("a turn moved by the stream", () => {
  test("turn, status, deltas, a tool, then done: the answer replaces the streamed text", () => {
    const t = newTurn("t1", "Which stop?", passage);
    expect(applyDiscussFrame(t, "turn", { turnId: "id-1", discussionId: "d-1", seq: 1 })).toEqual({ discussionId: "d-1" });
    expect(t).toMatchObject({ turnId: "id-1", seq: 1, state: "running" });
    applyDiscussFrame(t, "status", { phase: "model" });
    applyDiscussFrame(t, "delta", { text: "The summer " });
    applyDiscussFrame(t, "delta", { text: "route" });
    expect(t.text).toBe("The summer route");
    applyDiscussFrame(t, "tool", { name: "Read", input: '{"file_path":"src/route.ts"}' });
    expect(t.tools).toEqual([{ name: "Read", input: '{"file_path":"src/route.ts"}' }]);
    applyDiscussFrame(t, "done", { answer: "It stops at Example Island.", proposedEdit: null });
    expect(t).toMatchObject({ state: "done", text: "It stops at Example Island.", phase: null, proposedEdit: false });
    // A late delta after the end changes nothing.
    applyDiscussFrame(t, "delta", { text: "x" });
    expect(t.text).toBe("It stops at Example Island.");
  });
  test("app_error carries the route's end state and message; a proposed edit is flagged", () => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "a", seq: 1 });
    applyDiscussFrame(t, "app_error", { endState: "timeout", message: "The turn ran past 5 minutes and was stopped." });
    expect(t).toMatchObject({ state: "timeout", message: "The turn ran past 5 minutes and was stopped." });
    const e = newTurn("t2", "q", null);
    applyDiscussFrame(e, "app_error", { endState: "weird", message: "The turn failed: the page changed on disk while the turn started; ask again" });
    expect(e.state).toBe("error");
    const d = newTurn("t3", "q", null);
    applyDiscussFrame(d, "turn", { turnId: "b", seq: 2 });
    applyDiscussFrame(d, "done", { answer: "a", proposedEdit: { edits: [] } });
    expect(d.proposedEdit).toBe(true);
  });
  test("a stream that closes mid-turn drops the reader, not the turn; an ended turn stays as it ended", () => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "a", seq: 1 });
    streamClosed(t);
    expect(t.state).toBe("dropped");
    expect(t.message).toContain("runs it to its end");
    const done = newTurn("t2", "q", null);
    applyDiscussFrame(done, "done", { answer: "x" });
    streamClosed(done);
    expect(done.state).toBe("done");
  });
});

describe("a dropped stream's words", () => {
  // Discuss v2 (PR 4): the tab reads the page's thread on a page load, so a
  // reload shows the stored turn once it has ended.
  test("point at a reload, which reads the turn back from the page's thread", () => {
    const withId = newTurn("t1", "q", null);
    applyDiscussFrame(withId, "turn", { turnId: "a", seq: 1 });
    streamClosed(withId);
    const noId = newTurn("t2", "q", null);
    streamClosed(noId);
    for (const t of [withId, noId]) expect(t.message).toMatch(/reload the page/i);
    expect(discussTurnHtml(withId)).toContain('data-discuss-continue="t1"');
    expect(noId.message).not.toContain("Continue in Claude Code");
    expect(discussTurnHtml(noId)).not.toContain("data-discuss-continue");
  });
});

describe("the current turn", () => {
  test("is the highest seq, never the last to finish", () => {
    const a = newTurn("a", "q1", null);
    const b = newTurn("b", "q2", null);
    applyDiscussFrame(b, "turn", { turnId: "B", seq: 2 });
    applyDiscussFrame(a, "turn", { turnId: "A", seq: 1 });
    applyDiscussFrame(b, "done", { answer: "two" });
    // The older turn finishes last.
    applyDiscussFrame(a, "done", { answer: "one" });
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [b, a] };
    expect(currentTurn(d)?.key).toBe("b");
    // A turn just sent (no seq yet) is the newest; a refused one never is.
    const c = newTurn("c", "q3", null);
    d.turns.push(c);
    expect(currentTurn(d)?.key).toBe("c");
    c.state = "refused";
    expect(currentTurn(d)?.key).toBe("b");
    // An older turn still running keeps the discussion live though it is not current.
    a.state = "running";
    expect(currentTurn(d)?.key).toBe("b");
    expect(discussionLive(d)).toBe(true);
  });

  test("a refused turn (no seq) does not hide a later numbered turn that runs", () => {
    const t1 = newTurn("t1", "q1", null);
    applyDiscussFrame(t1, "turn", { turnId: "A", seq: 1 });
    applyDiscussFrame(t1, "done", { answer: "one" });
    const t2 = newTurn("t2", "q2", null);
    t2.state = "refused"; // e.g. a 429: no row, no seq
    const t3 = newTurn("t3", "q3", null);
    applyDiscussFrame(t3, "turn", { turnId: "C", seq: 2 });
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [t1, t2, t3] };
    expect(currentTurn(d)?.key).toBe("t3");
    expect(currentTurn(d)?.state).toBe("running");
    expect(discussionLive(d)).toBe(true);
    applyDiscussFrame(t3, "done", { answer: "three" });
    expect(discussionLive(d)).toBe(false);
  });

  test("a turn dropped before its `turn` event (no seq) does not hide a later numbered turn", () => {
    const t1 = newTurn("t1", "q1", null);
    applyDiscussFrame(t1, "turn", { turnId: "A", seq: 1 });
    applyDiscussFrame(t1, "done", { answer: "one" });
    const t4 = newTurn("t4", "q4", null);
    streamClosed(t4);
    expect(t4).toMatchObject({ state: "dropped", seq: null });
    const t3 = newTurn("t3", "q3", null);
    applyDiscussFrame(t3, "turn", { turnId: "C", seq: 2 });
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [t1, t4, t3] };
    expect(currentTurn(d)?.key).toBe("t3");
    expect(discussionLive(d)).toBe(true);
  });
});

describe("refusal words", () => {
  test("each reason the route answers reads as what to do next", () => {
    expect(discussRefusalMessage(404, { reason: "no-agent", error: "x" })).toContain("Reload the page");
    expect(discussRefusalMessage(409, { reason: "busy", error: "x" })).toContain("still running");
    expect(discussRefusalMessage(429, { reason: "busy", error: "x" })).toContain("Four discuss turns");
    expect(discussRefusalMessage(503, { reason: "no-bot", error: "no bot is configured to answer on this wiki" })).toBe(
      "No bot can answer on this wiki here: no bot is configured to answer on this wiki.",
    );
    expect(discussRefusalMessage(503, { reason: "no-snapshot" })).toContain("not a git work tree");
    expect(discussRefusalMessage(422, { reason: "page-not-in-snapshot", error: "the wiki agent cannot read this page: its snapshot of the wiki leaves it out (git ignores it)" })).toBe(
      "The wiki agent cannot read this page: its snapshot of the wiki leaves it out (git ignores it).",
    );
    expect(discussRefusalMessage(403, { readonly: true, error: "Wiki w is read-only." })).toContain("read-only");
    expect(discussRefusalMessage(403, { error: "Discuss's wiki agent is for admins" })).toBe("Discuss's wiki agent is for admins");
    expect(discussRefusalMessage(500, null)).toBe("The turn could not start (500).");
  });

  // The rules file can change after the page loaded: each refusal the route
  // answers about it has its own words, never the generic fallback.
  test("the rules-file refusals: too large and unreadable (a symlink answers unreadable too)", () => {
    const large = discussRefusalMessage(422, { reason: "rules-too-large", error: "the wiki's .wiki-agent.md is 20000 bytes, over the 16384-byte bound" });
    const unreadable = discussRefusalMessage(503, { reason: "rules-unreadable", error: "the wiki's .wiki-agent.md cannot be read" });
    expect(large).toBe("This wiki's agent rules (.wiki-agent.md) are over their size bound since the page loaded (20000 bytes, over the 16384-byte bound), so the agent cannot run. Shorten the file, then reload the page.");
    expect(unreadable).toBe("This wiki's agent rules (.wiki-agent.md) cannot be read since the page loaded (a symlink, or a file muninn may not read), so the agent cannot run. Fix the file, then reload the page.");
    expect(large).not.toStartWith("The turn could not start");
    expect(unreadable).not.toStartWith("The turn could not start");
  });
});

describe("the tab's markup", () => {
  test("a streamed answer goes through the Ask tab's markdown function, its paths breakable; user text is escaped", () => {
    const t = newTurn("t1", "Is <b>this</b> right?", { ...passage, selection: "a <script> passage" });
    applyDiscussFrame(t, "turn", { turnId: "id", seq: 1 });
    applyDiscussFrame(t, "delta", { text: "**Yes**, see `src/route.ts`." });
    const html = discussTurnHtml(t);
    expect(html).toContain(breakablePaths(renderStreamingBody("**Yes**, see `src/route.ts`.")));
    expect(html).toContain("<code>src/<wbr>route.ts</code>");
    expect(html).toContain("Is &lt;b&gt;this&lt;/b&gt; right?");
    expect(html).toContain("a &lt;script&gt; passage");
    expect(html).toContain('data-discuss-chip="t1"');
    // Running: no Continue yet.
    expect(html).not.toContain("data-discuss-continue");
    applyDiscussFrame(t, "done", { answer: "Yes." });
    expect(discussTurnHtml(t)).toContain('data-discuss-continue="t1"');
  });
  test("a gone passage says so; a refused turn offers no Continue; an empty discussion a hint", () => {
    const t = newTurn("t1", "q", passage);
    t.passageGone = true;
    t.state = "refused";
    t.message = "x";
    const html = discussTurnHtml(t);
    expect(html).toContain("That passage is no longer in the page.");
    expect(html).not.toContain("data-discuss-continue");
    expect(discussTurnsHtml(null)).toContain("Ask here");
  });
});

describe("patching the turns list", () => {
  const listIn = () => {
    const win = new Window();
    const list = win.document.createElement("div");
    win.document.body.appendChild(list);
    return list as unknown as HTMLElement;
  };
  const done = (key: string, seq: number) => {
    const t = newTurn(key, `q${seq}`, passage);
    applyDiscussFrame(t, "turn", { turnId: `id-${seq}`, seq });
    applyDiscussFrame(t, "done", { answer: `answer ${seq}` });
    return t;
  };
  test("a finished turn's element is left alone while another turn streams; a changed turn is redrawn", () => {
    const list = listIn();
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [] };
    patchDiscussTurns(list, d);
    expect(list.textContent).toContain("Ask here");
    const t1 = done("t1", 1);
    const t2 = newTurn("t2", "q2", null);
    d.turns.push(t1, t2);
    patchDiscussTurns(list, d);
    expect(list.querySelector(".wiki-discuss-hint")).toBeNull();
    const first = list.querySelector('[data-turn-key="t1"]');
    expect(first).not.toBeNull();
    applyDiscussFrame(t2, "turn", { turnId: "id-2", seq: 2 });
    for (const piece of ["The ", "answer ", "streams."]) {
      applyDiscussFrame(t2, "delta", { text: piece });
      patchDiscussTurns(list, d);
      // The same node: a selection, focus or a pressed button in it survives.
      expect(list.querySelector('[data-turn-key="t1"]')).toBe(first);
    }
    expect(list.querySelector('[data-turn-key="t2"] .wiki-discuss-answer')?.textContent).toContain("The answer streams.");
    // Order by seq, one element per turn.
    expect(Array.from(list.children).map((c) => c.getAttribute("data-turn-key"))).toEqual(["t1", "t2"]);
    // The finished turn's own state changed: the part that changed is drawn
    // in, in the same turn element (compared by identity flag: a failing toBe
    // on a happy-dom node hangs its diff printer).
    t1.passageGone = true;
    patchDiscussTurns(list, d);
    expect(list.querySelector('[data-turn-key="t1"]') === first).toBe(true);
    expect(list.querySelector('[data-turn-key="t1"]')!.outerHTML).toBe(discussTurnHtml(t1));
    expect(list.querySelector('[data-turn-key="t1"] .wiki-discuss-gone')).not.toBeNull();
    expect(list.children.length).toBe(2);
    // Another page's discussion (or none): the list holds only what it has.
    patchDiscussTurns(list, null);
    expect(list.querySelectorAll(".wiki-discuss-turn").length).toBe(0);
    expect(list.textContent).toContain("Ask here");
  });
  test("a turn that gains a seq moves into place; nodes left by another page are dropped", () => {
    const list = listIn();
    const a = done("a", 1);
    const refused = newTurn("r", "q", null);
    refused.state = "refused";
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [a, refused] };
    patchDiscussTurns(list, d);
    const b = newTurn("b", "q2", null);
    d.turns.push(b);
    patchDiscussTurns(list, d);
    applyDiscussFrame(b, "turn", { turnId: "id-2", seq: 2 });
    patchDiscussTurns(list, d);
    expect(Array.from(list.children).map((c) => c.getAttribute("data-turn-key"))).toEqual(["a", "b", "r"]);
    const other: DiscussionView = { wiki: "w", relPath: "q.md", discussionId: "e", turns: [done("z", 1)] };
    patchDiscussTurns(list, other);
    expect(Array.from(list.children).map((c) => c.getAttribute("data-turn-key"))).toEqual(["z"]);
  });
});

function article(html: string) {
  const win = new Window();
  const el = win.document.createElement("div");
  el.className = "wiki-article";
  el.innerHTML = html;
  win.document.body.appendChild(el);
  return el as unknown as Element;
}

// Class check (round 3) of the selection menu's re-attach: the held passage
// and its surroundings are read off the live range in DOM order by the walk
// the search uses (`holdPassage`), and a copy after a render is taken only
// when its own surroundings are still there (`findSamePassage`). Every
// selection shape × every change to the page, one cell each: S = back under
// the same passage, N = none (the card goes to the top with the note), U = no
// copy to hold at all (the card goes to the top with the «cannot be searched
// for» note). Never under another copy.
describe("holdPassage × findSamePassage: the re-attach state space", () => {
  const LEAD = "Opening words of the filler sentence that runs on before";
  const TAIL = "and then closing words that carry the filler sentence on.";
  // The last word changed: within SAME_PASSAGE_CHARS of the passage's start.
  const LEAD_NEAR = "Opening words of the filler sentence that runs on BEFORE";
  // The first word changed: far outside SAME_PASSAGE_CHARS.
  const LEAD_FAR = "OPENING words of the filler sentence that runs on before";
  const OTHER_LEAD = "A wholly different lead-in wording precedes";
  const OTHER_TAIL = "followed by an unrelated ending of its own.";
  type Text3 = "keep" | "edit" | "remove";
  interface Block {
    lead: string;
    tail: string;
    text: Text3;
    own: boolean;
  }
  interface Shape {
    name: string;
    block(b: Block): string;
    select(root: Element): Range;
    /** The page around the block: the article (default), or the whole pane for a head selection. */
    pane?: boolean;
  }
  const own = (b: Block) => (b.own ? " data-own" : "");
  const pick = (b: Block, keep: string, edit: string, remove: string) => (b.text === "keep" ? keep : b.text === "edit" ? edit : remove);
  const ownEl = (root: Element) => root.querySelector("[data-own]")!;
  const textIn = (el: Element, want: string): { t: Text; i: number } => {
    const w = el.ownerDocument.createTreeWalker(el, 4);
    for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
      const i = t.data.indexOf(want);
      if (i !== -1) return { t, i };
    }
    throw new Error(want);
  };
  const span = (root: Element, el: Element, from: string, to: string): Range => {
    const a = textIn(el, from);
    const r = root.ownerDocument.createRange();
    r.setStart(a.t, a.i);
    const scope = el.tagName === "LI" || el.tagName === "P" ? (el.parentElement ?? el) : el;
    const b = textIn(scope.contains(el) && !el.textContent!.includes(to) ? scope : el, to);
    r.setEnd(b.t, b.i + to.length);
    return r;
  };
  const shapes: Shape[] = [
    {
      name: "within one text node",
      block: (b) => `<p${own(b)}>${b.lead} ${pick(b, "the harbour timetable", "the harbour schedule", "nothing of the sort")} ${b.tail}</p>`,
      select: (root) => span(root, ownEl(root), "the harbour", "timetable"),
    },
    {
      name: "across inline elements",
      block: (b) => `<p${own(b)}>${b.lead} <strong>the night</strong> ${pick(b, "route of", "path of", "nothing")} <em>the ferry</em> ${b.tail}</p>`,
      select: (root) => span(root, ownEl(root), "the night", "the ferry"),
    },
    {
      name: "across blocks",
      block: (b) => `<p${own(b)}>${b.lead} first block ${pick(b, "ends here.", "stops here.", "is gone.")}</p><p>Second block starts ${b.tail}</p>`,
      select: (root) => span(root, ownEl(root), "first block", "Second block starts"),
    },
    {
      name: "triple-click: ends at (next block, 0)",
      block: (b) => `<p>${b.lead}</p><p${own(b)}>${pick(b, "Whole paragraph passage words.", "Whole paragraph passage changed.", "Something else entirely.")}</p><p>${b.tail}</p>`,
      select: (root) => {
        const p = ownEl(root);
        const r = root.ownerDocument.createRange();
        r.setStart(p.firstChild!, 0);
        r.setEnd(p.nextElementSibling!, 0);
        return r;
      },
    },
    {
      name: "triple-click: a bare run ending at (container, k)",
      block: (b) => `<div${own(b)}>${b.lead}<br><br>${pick(b, "Bare run passage words.", "Bare run passage changed.", "Something else entirely.")}<br><br>${b.tail}</div>`,
      select: (root) => {
        const d = ownEl(root);
        const r = root.ownerDocument.createRange();
        r.setStart(d.childNodes[3]!, 0);
        r.setEnd(d, 4);
        return r;
      },
    },
    {
      name: "across two DecisionLog items shown newest first",
      block: (b) =>
        `<p>${b.lead}</p><section class="decision-log"><ul class="dl-list">` +
        `<li data-dl-order="1"${own(b)}>D2 — Keep the ${pick(b, "night", "day", "bus")} route as it is.</li>` +
        `<li data-dl-order="0">D1 — Use the flat file for berths.</li></ul></section><p>${b.tail}</p>`,
      select: (root) => {
        const li = ownEl(root);
        const a = textIn(li, "Keep the");
        const z = textIn(li.nextElementSibling!, "Use the flat");
        const r = root.ownerDocument.createRange();
        r.setStart(a.t, a.i);
        r.setEnd(z.t, z.i + "Use the flat".length);
        return r;
      },
    },
    {
      name: "the head's title, which the body repeats (triple-click)",
      pane: true,
      block: (b) =>
        `<div class="wiki-article-head"><div class="crumbs">${b.lead}</div><h1${own(b)}>${pick(b, "Ferry timetable plan", "Ferry schedule plan", "Harbour notes")}</h1><div class="meta">${b.tail}</div></div>`,
      select: (root) => {
        const h = ownEl(root);
        const r = root.ownerDocument.createRange();
        r.setStart(h.firstChild!, 0);
        r.setEnd(h.nextElementSibling!, 0);
        return r;
      },
    },
    {
      name: "inside a table cell",
      block: (b) => `<p>${b.lead}</p><table><tbody><tr><td>Row label</td><td${own(b)}>${pick(b, "cell passage text", "cell passage changed", "other cell words")}</td></tr></tbody></table><p>${b.tail}</p>`,
      select: (root) => span(root, ownEl(root), "cell passage", "text"),
    },
    {
      name: "a mermaid label (an svg's text)",
      block: (b) => `<p>${b.lead}</p><svg><text${own(b)}>${pick(b, "Node label text", "Node label changed", "Other node")}</text></svg><p>${b.tail}</p>`,
      select: (root) => span(root, ownEl(root), "Node label", "text"),
    },
  ];
  type Change = "unchanged" | "white space only" | "passage edited" | "passage removed" | "a copy elsewhere, original intact" | "a copy elsewhere, original removed" | "an edit within 16 characters" | "an edit beyond 16 characters";
  const changes: Change[] = ["unchanged", "white space only", "passage edited", "passage removed", "a copy elsewhere, original intact", "a copy elsewhere, original removed", "an edit within 16 characters", "an edit beyond 16 characters"];
  const expected: Record<Change, "S" | "N"> = {
    unchanged: "S",
    "white space only": "S",
    "passage edited": "N",
    "passage removed": "N",
    "a copy elsewhere, original intact": "S",
    "a copy elsewhere, original removed": "N",
    "an edit within 16 characters": "N",
    "an edit beyond 16 characters": "S",
  };
  function page(shape: Shape, change: Change): Element {
    const text: Text3 = change === "passage edited" ? "edit" : change === "passage removed" || change === "a copy elsewhere, original removed" ? "remove" : "keep";
    const lead = change === "an edit within 16 characters" ? LEAD_NEAR : change === "an edit beyond 16 characters" ? LEAD_FAR : LEAD;
    const mine = shape.block({ lead, tail: TAIL, text, own: true });
    const copy = change.startsWith("a copy") ? shape.block({ lead: OTHER_LEAD, tail: OTHER_TAIL, text: "keep", own: false }) : "";
    // The head's title is always repeated in the body, with other words around it.
    const repeat = shape.pane ? `<p>The body says Ferry timetable plan once more, in passing.</p>` : "";
    const body = `<h2>Section</h2><p>Opening paragraph of the page.</p>${shape.pane ? "" : mine}<p>Separator paragraph between the blocks.</p>${repeat}${shape.pane ? copy.replace(/<\/?div[^>]*>/g, "") : copy}<p>Closing paragraph of the page.</p>`;
    const win = new Window();
    const root = win.document.createElement("div");
    root.id = "articleWrap";
    root.innerHTML = shape.pane ? `${mine}<div class="wiki-article">${body}</div>` : `<div class="wiki-article">${body}</div>`;
    win.document.body.appendChild(root);
    if (change === "white space only") {
      const w = win.document.createTreeWalker(root, 4);
      for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) t.data = `\n  ${t.data.replace(/ /g, " \n   ")}  \n`;
    }
    return root as unknown as Element;
  }
  function outcome(shape: Shape, change: Change): "S" | "N" | "U" | "OTHER" {
    const before = page(shape, "unchanged");
    const held = holdPassage(before, shape.select(before));
    if (!held) return "U";
    const after = page(shape, change);
    const f = findSamePassage(after, held);
    if (!f) return "N";
    return f.range.startContainer.parentElement?.closest("[data-own]") ? "S" : "OTHER";
  }
  for (const shape of shapes) {
    for (const change of changes) {
      const want = shape.name.startsWith("a mermaid") ? "U" : expected[change];
      test(`${shape.name} × ${change}: ${want}`, () => {
        expect(outcome(shape, change)).toBe(want);
      });
    }
  }

  const P = "the harbour timetable";
  const at = (root: Element, el: string, from = P) => {
    const t = textIn(root.querySelector(el)!, from);
    const r = root.ownerDocument.createRange();
    r.setStart(t.t, t.i);
    r.setEnd(t.t, t.i + from.length);
    return r;
  };
  const parent = (f: ReturnType<typeof findSamePassage>) => (f ? (f.range.startContainer.parentElement?.id ?? "") : null);
  const pane = (html: string) => article(html);
  test("SAME_PASSAGE_CHARS on each side, at its boundary: 16 matching characters keep the copy, 15 do not", () => {
    // Twenty compact characters on each side of the passage; one of them changed
    // at distance k (k = 1 is the character next to the passage).
    const B = "abcdefghijklmnopqrst";
    const A = "ABCDEFGHIJKLMNOPQRST";
    const at16 = (s: string, k: number, before: boolean) => {
      const i = before ? s.length - k : k - 1;
      return s.slice(0, i) + "#" + s.slice(i + 1);
    };
    const src = pane(`<p id="own">${B} ${P} ${A}</p>`);
    const h = holdPassage(src, at(src, "#own"))!;
    expect(h.before.endsWith(B)).toBe(true);
    expect(h.after.startsWith(A)).toBe(true);
    for (const [k, want] of [[16, null], [17, "own"]] as const) {
      expect(parent(findSamePassage(pane(`<p id="own">${at16(B, k, true)} ${P} ${A}</p>`), h))).toBe(want);
      expect(parent(findSamePassage(pane(`<p id="own">${B} ${P} ${at16(A, k, false)}</p>`), h))).toBe(want);
    }
    expect(SAME_PASSAGE_CHARS).toBe(16);
  });
  test("a side that reached the root's edge must match whole and still reach it", () => {
    const src = pane(`<p id="own">Intro ${P} and a long tail that goes on and on.</p>`);
    const h = holdPassage(src, at(src, "#own"))!;
    expect(h.before).toBe("Intro");
    expect(parent(findSamePassage(pane(`<p id="own">Intro ${P} and a long tail that goes on and on.</p>`), h))).toBe("own");
    // The same five characters before it, but no longer at the edge.
    expect(findSamePassage(pane(`<p>Earlier text.</p><p id="own">Intro ${P} and a long tail that goes on and on.</p>`), h)).toBeNull();
    expect(findSamePassage(pane(`<p id="own">Outro ${P} and a long tail that goes on and on.</p>`), h)).toBeNull();
  });
  test("two copies both qualifying: the one matching more held characters wins, even when it comes later or lies farther from the held place", () => {
    const shared = "the shared twenty-char";
    const near = `<p id="near">Unrelated ${shared} ${P} after twenty shared Unrelated.</p>`;
    const mine = `<p id="own">The original long lead ${shared} ${P} after twenty shared and its long tail.</p>`;
    const src = pane(near + mine);
    const h = holdPassage(src, at(src, "#own"))!;
    expect(parent(findSamePassage(pane(near + mine), h))).toBe("own");
    // The lesser copy alone still qualifies (16+ characters each side): it is a real competitor.
    expect(parent(findSamePassage(pane(near), h))).toBe("near");
    // Held with its copy first; after the render the lesser copy sits at that place
    // and the original far below: the original still wins on what it matches.
    const first = pane(mine);
    const h2 = holdPassage(first, at(first, "#own"))!;
    const filler = `<p>${"Many filler words push the original far down the page. ".repeat(20)}</p>`;
    expect(parent(findSamePassage(pane(near + filler + mine), h2))).toBe("own");
  });
  test("copies matching every held character: the one nearest where the held copy started", () => {
    const filler = "Same words around it ".repeat(12);
    const html = `<p id="a">${filler}${P} ${filler}</p><p id="b">${filler}${P} ${filler}</p><p id="c">${filler}${P} ${filler}</p>`;
    for (const id of ["a", "b", "c"]) {
      const src = pane(html);
      const h = holdPassage(src, at(src, `#${id}`))!;
      expect(parent(findSamePassage(pane(html), h))).toBe(id);
    }
  });
  test("copies matching every held character and equally near the held place: the first", () => {
    const R = "Same words around it ";
    const block = `${R.repeat(12)}${P} ${R.repeat(12)}`;
    const src = pane(`<p id="a">${block}</p><p id="b">${block}</p>`);
    const h = holdPassage(src, at(src, "#b"))!;
    const cp = (x: string) => x.replace(/\s+/g, "").length;
    // Copy one lies as far before the held place as copy two lies after it:
    // copy two starts cp(P) + 13 × cp(R) after copy one.
    const gap = cp(P) + 13 * cp(R);
    expect(gap % 2).toBe(0);
    const spacer = h.at - gap / 2 - cp(R.repeat(12));
    expect(spacer).toBeGreaterThan(0);
    const after = pane(`<p id="sp">${"x".repeat(spacer)}</p><p id="one">${R.repeat(12)}${P} ${R.repeat(13)}</p><p id="two">${P} ${R.repeat(12)}</p>`);
    expect(parent(findSamePassage(after, h))).toBe("one");
  });
  test("holdPassage: none for a diagram's text; a triple-click's element end is read as its text", () => {
    const svg = pane(`<p>Lead.</p><svg><text id="t">Node label</text></svg>`);
    const r = svg.ownerDocument.createRange();
    r.selectNodeContents(svg.querySelector("#t")!);
    expect(holdPassage(svg, r)).toBeNull();
    const tc = pane(`<p id="own">Whole paragraph.</p><p id="next">Next one.</p>`);
    const t = tc.ownerDocument.createRange();
    t.setStart(tc.querySelector("#own")!.firstChild!, 0);
    t.setEnd(tc.querySelector("#next")!, 0);
    expect(holdPassage(tc, t)).toMatchObject({ passage: "Whole paragraph.", after: "Nextone." });
  });
  test("the surroundings leave out what the client redraws: a mermaid fence drawn or not reads the same", () => {
    const drawn = pane(`<p id="own">Lead ${P} tail.</p><div class="mermaid"><svg><text>A</text></svg></div><p>After the diagram comes this.</p>`);
    const h = holdPassage(drawn, at(drawn, "#own"))!;
    const undrawn = pane(`<p id="own">Lead ${P} tail.</p><pre><code class="language-mermaid">graph LR; A --> B</code></pre><p>After the diagram comes this.</p>`);
    expect(parent(findSamePassage(undrawn, h))).toBe("own");
  });
});

describe("findPassage", () => {
  test("a bullet: found across inline markup and line breaks, its block the list item", () => {
    const a = article("<h2>Brief</h2><ul><li><strong>R2, behind.</strong> The check reads <code>status_date</code>\nfrom the frontmatter.</li><li>Other.</li></ul>");
    const f = findPassage(a, "R2, behind. The check reads status_date from the frontmatter.");
    expect(f?.block?.tagName).toBe("LI");
    expect(f?.node.data).toBe("R2, behind.");
  });
  test("bare text under the article has no block; the reader's chips and buttons are not page text", () => {
    const a = article('The pier opens at six.<br><br>The ferry <span class="fact-chip">✓ 2026</span>leaves at nine.<button>Copy</button>');
    const f = findPassage(a, "The ferry leaves at nine.");
    expect(f).not.toBeNull();
    expect(f!.block).toBeNull();
    expect(findPassage(a, "nine.Copy")).toBeNull();
  });
  test("a passage edited away is not found, though its first words are still there", () => {
    const a = article("<p>The summer route adds a stop at Example Island and runs until August.</p>");
    expect(findPassage(a, "The summer route adds a stop at Example Island and runs until August.")).not.toBeNull();
    expect(findPassage(a, "The summer route adds a stop at Example Island and runs until September, every day.")).toBeNull();
    expect(findPassage(a, "")).toBeNull();
  });
  test("a passage on the page twice: the copy whose context the turn carries, else the first", () => {
    const dup = "The ferry leaves at nine on every weekday morning from the north pier.";
    const a = article(`<h2>First</h2><p id="one">${dup}</p><p>Line 3 says something about berths.</p><h2>Second</h2><p id="two">${dup}</p><p>After the second copy comes a closing note.</p>`);
    const ctx = (before: string, after: string, heading: string) => ({ selection: dup, before, after, atStart: false, atEnd: false, heading });
    expect(findPassage(a, dup, ctx("Second", "After the second copy comes a closing note.", "Second"))?.block?.id).toBe("two");
    expect(findPassage(a, dup, ctx("First", "Line 3 says something about berths.", "First"))?.block?.id).toBe("one");
    // Only one side of the context tells them apart: it still decides.
    expect(findPassage(a, dup, ctx("", "After the second copy", ""))?.block?.id).toBe("two");
    // Context that matches neither copy: the first in page order.
    expect(findPassage(a, dup, ctx("Nowhere", "Nothing like it", ""))?.block?.id).toBe("one");
    expect(findPassage(a, dup)?.block?.id).toBe("one");
  });
  test("the range is the passage's own text, not its run or its fold", () => {
    const lines = Array.from({ length: 60 }, (_, k) => `Line ${k} of the long run says something about berth ${k}.`);
    const paras = Array.from({ length: 44 }, (_, k) => `Paragraph ${k} in the fold talks about crossing ${k}.`);
    const a = article(`<h2>Long</h2>${lines.join("\n")}<details class="fold"><summary>Fold</summary><div class="fold-body">${paras.join("<br><br>")}</div></details>`);
    const deep = findPassage(a, lines[50]!);
    expect(deep!.range.toString()).toBe(lines[50]!);
    expect(deep!.block).toBeNull();
    // Deep in a fold's bare text: still only its text, and the fold is no block.
    const folded = findPassage(a, paras[40]!);
    expect(folded!.range.toString()).toBe(paras[40]!);
    expect(folded!.range.startContainer.parentElement!.className).toBe("fold-body");
    expect(folded!.block).toBeNull();
    // Across inline markup the range starts and ends on the passage's first and last characters.
    const b = article("<p>Before. <strong>R2, behind.</strong> The check reads <code>status_date</code> today. After.</p>");
    expect(findPassage(b, "R2, behind. The check reads status_date today.")!.range.toString()).toBe("R2, behind. The check reads status_date today.");
  });
  test("a selection over DecisionLog items shown newest first: found by its rendered text, not its authored one", () => {
    const a = article('<section class="decision-log"><ul class="dl-list"><li data-dl-order="1"><span class="dl-id">D5</span> The newest decision text moves the list.</li><li data-dl-order="0"><span class="dl-id">D4</span> The older decision text keeps the list.</li></ul></section>');
    const authored = "- D4 The older decision text keeps the list.\n- D5 The newest decision text moves the list.";
    expect(findPassage(a, authored)).toBeNull();
    const items = a.querySelectorAll("li");
    const r = a.ownerDocument.createRange();
    r.setStart(items[0]!, 0);
    r.setEnd(items[1]!, items[1]!.childNodes.length);
    const rendered = renderedPassageText(r);
    const f = findPassage(a, rendered);
    expect(f!.range.toString().replace(/\s+/g, " ")).toBe("D5 The newest decision text moves the list.D4 The older decision text keeps the list.");
    // The reader's controls in the range are not part of its text.
    items[0]!.insertAdjacentHTML("beforeend", "<button>mer</button>");
    expect(renderedPassageText(r)).not.toContain("mer");
  });
  test("both ends present but far apart is not the passage: the page grew text inside it", () => {
    const head = "The summer route adds a stop at Example Island on every weekday morning";
    const tail = "and the night ferry keeps its old timetable through the whole winter season";
    const filler = Array.from({ length: 20 }, (_, k) => `Inserted sentence ${k} about something else entirely.`).join(" ");
    const a = article(`<p>${head} ${filler} ${tail}</p>`);
    expect(findPassage(a, `${head} ${tail}`)).toBeNull();
    expect(findPassage(article(`<p>${head} ${tail}</p>`), `${head} ${tail}`)).not.toBeNull();
  });
});

describe("a passage on the page twice, next to text only the reader shows (fix round 2 batch 2)", () => {
  // The turn's before/after were read by `discussContext`, which leaves out
  // every reader-only element; the copies are scored on the same reading, so a
  // label next to the selected copy does not cost it the match.
  const dup = "The ferry leaves at nine on every weekday morning from the north pier.";
  const long = (lead: string) => `${lead} ${Array.from({ length: 8 }, (_, k) => `word${k} of a long paragraph that runs well past the context bound`).join(", ")}.`;
  const P = long("Pier paragraph:");
  const Q = long("Quay paragraph:");
  const R = long("Rest paragraph:");
  const R2 = long("Run paragraph:");
  const fold = `<h2>Ferries</h2><p>${Q}</p><p id="one">${dup}</p><p>${R}</p><p>${P}</p><details class="fold"><summary class="fold-summary"><span class="fold-label-default">Details</span></summary><div class="fold-body"><p id="two">${dup}</p><p>${R}</p></div></details>`;
  const figcaption = `<h2>Ferries</h2><p>${Q}</p><p id="one">${dup}</p><p>${R}</p><p>${P}</p><figure><figcaption>A map of the north pier.</figcaption></figure><p id="two">${dup}</p><p>${R}</p>`;
  const codeTab = `<h2>Ferries</h2><p>${P}</p><p id="one">${dup}</p><p>${R}</p><p>${P}</p><p id="two">${dup}</p><div class="code-tab-standalone"><div class="code-tab-label">shell</div><pre><code>${R2}</code></pre></div>`;
  for (const [name, html] of [["fold-default", fold], ["figcaption", figcaption], ["code-tab", codeTab]] as const) {
    test(`${name}: the selected second copy is the one found`, () => {
      const a = article(html);
      const two = a.querySelector("#two")!;
      const r = a.ownerDocument.createRange();
      r.selectNodeContents(two);
      const ctx = discussContext(a, r)!;
      expect(ctx).not.toBeNull();
      const f = findPassage(a, dup, { before: ctx.before, after: ctx.after });
      expect(f?.block?.id).toBe("two");
      // The first copy, selected, is still the one found.
      const r1 = a.ownerDocument.createRange();
      r1.selectNodeContents(a.querySelector("#one")!);
      const ctx1 = discussContext(a, r1)!;
      expect(findPassage(a, dup, { before: ctx1.before, after: ctx1.after })?.block?.id).toBe("one");
    });
  }
});

describe("a kept selection after the article is rendered anew (fix round 2 batch 2)", () => {
  test("the anchor holds no node of the old article, and the passage is still found by its rendered text", () => {
    const html = '<h2>Brief</h2><p>Before.</p><p id="p">The pier opens at <strong>six</strong> on weekdays.</p><p>After.</p>';
    const a = article(html);
    const p = a.querySelector("#p")!;
    const r = a.ownerDocument.createRange();
    r.selectNodeContents(p);
    const anchor = discussState.keepAnchor(r);
    // Still the reader's selection: the live range itself.
    expect(discussState.anchorRange(anchor, a)?.toString()).toBe("The pier opens at six on weekdays.");
    // Nothing in the anchor holds a node or a range strongly: only weak refs, offsets and text.
    const strong = (v: unknown): boolean => {
      if (v instanceof WeakRef || v === null || typeof v !== "object") return false;
      if ("nodeType" in (v as object) || "commonAncestorContainer" in (v as object)) return true;
      return Object.values(v as object).some(strong);
    };
    expect(strong(anchor)).toBe(false);
    // The article is rendered anew: the old tree is detached.
    a.innerHTML = html;
    expect(discussState.anchorRange(anchor, a)).toBeNull();
    for (const v of Object.values(anchor)) if (v instanceof WeakRef) expect(v.deref()).toBeUndefined();
    const f = findPassage(a, anchor.rendered, null);
    expect(f?.block?.id).toBe("p");
  });
  test("an old article nothing else holds is collected though the anchor is kept", async () => {
    const win = new Window();
    const wrap = win.document.createElement("div");
    win.document.body.appendChild(wrap);
    const html = '<div class="wiki-article"><p id="p">The pier opens at six on weekdays.</p></div>';
    wrap.innerHTML = html;
    const anchor = (() => {
      const r = win.document.createRange();
      r.selectNodeContents(wrap.querySelector("#p")!);
      return discussState.keepAnchor(r as unknown as Range);
    })();
    wrap.innerHTML = html;
    for (let i = 0; i < 5; i++) {
      Bun.gc(true);
      await new Promise((r) => setTimeout(r, 0));
    }
    const refs = Object.values(anchor).filter((v): v is WeakRef<object> => v instanceof WeakRef);
    expect(refs.length).toBeGreaterThan(0);
    for (const v of refs) expect(v.deref()).toBeUndefined();
  });
});

describe("the streaming turn's chip across repaints (fix round 2 batch 2)", () => {
  test("its chip and question are the same nodes frame after frame; the answer and status are redrawn", () => {
    const win = new Window();
    const list = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(list as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    const t = newTurn("t1", "Which stop?", passage);
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: null, turns: [t] };
    patchDiscussTurns(list, d);
    const chip = list.querySelector('[data-discuss-chip="t1"]');
    const q = list.querySelector(".wiki-discuss-q");
    expect(chip).not.toBeNull();
    applyDiscussFrame(t, "turn", { turnId: "id-1", seq: 1, discussionId: "d" });
    patchDiscussTurns(list, d);
    applyDiscussFrame(t, "status", { phase: "model" });
    for (const piece of ["The ", "summer ", "route."]) {
      applyDiscussFrame(t, "delta", { text: piece });
      patchDiscussTurns(list, d);
      expect(list.querySelector('[data-discuss-chip="t1"]') === chip).toBe(true);
      expect(list.querySelector(".wiki-discuss-q") === q).toBe(true);
    }
    const turnEl = list.querySelector('[data-turn-key="t1"]')!;
    expect(turnEl.getAttribute("data-turn-state")).toBe("running");
    expect(turnEl.getAttribute("data-turn-seq")).toBe("1");
    expect(turnEl.querySelector(".wiki-discuss-answer")?.textContent).toContain("The summer route.");
    expect(turnEl.querySelector(".wiki-discuss-status")?.textContent).toContain("The agent is reading");
    applyDiscussFrame(t, "done", { answer: "It stops at Example Island." });
    patchDiscussTurns(list, d);
    // The whole turn now reads as its markup says, the chip kept.
    expect(list.querySelector('[data-turn-key="t1"]')!.outerHTML).toBe(discussTurnHtml(t));
    expect(list.querySelector('[data-discuss-chip="t1"]') === chip).toBe(true);
    expect(list.querySelector(".wiki-discuss-status")).toBeNull();
  });
});

describe("which copy of a repeated passage the chip finds (class check, fix round 3)", () => {
  // Every case: the turn's before/after are what `discussContext` read around
  // the copy the reader selected, and `findPassage` must find that copy.
  const dup = "The ferry leaves at nine on every weekday morning from the north pier.";
  const longText = (lead: string) => `${lead} ${Array.from({ length: 8 }, (_, k) => `word${k} of a long paragraph that runs well past the context bound`).join(", ")}.`;
  const contextOf = (a: Element, sel: string) => {
    const r = a.ownerDocument.createRange();
    r.selectNodeContents(a.querySelector(sel)!);
    const c = discussContext(a, r)!;
    return { before: c.before, after: c.after };
  };
  /** `n` copies, each between a lead and a note that name it. */
  const copies = (n: number) => Array.from({ length: n }, (_, k) => `<p>Lead ${k} before copy ${k}.</p><p id="c${k}">${dup}</p><p>Note ${k} after copy ${k}.</p>`).join("");
  /** Counts how many times the context reading's skip test runs: once per element per reading. */
  const countReadings = <T>(a: Element, run: () => T): { value: T; calls: number; elements: number } => {
    const proto = (a.ownerDocument.defaultView as unknown as { Element: { prototype: Element } }).Element.prototype;
    const orig = proto.matches;
    let calls = 0;
    proto.matches = function (this: Element, s: string) {
      if (s === DISCUSS_TEXT_SKIP) calls++;
      return orig.call(this, s);
    };
    try {
      return { value: run(), calls, elements: a.querySelectorAll("*").length };
    } finally {
      proto.matches = orig;
    }
  };

  test("one copy: found, and no context reading is built", () => {
    const a = article(copies(1));
    const ctx = contextOf(a, "#c0");
    const { value, calls } = countReadings(a, () => findPassage(a, dup, ctx));
    expect(value?.block?.id).toBe("c0");
    expect(calls).toBe(0);
  });
  for (const n of [2, 5, 500]) {
    for (const k of [...new Set([0, Math.floor(n / 2), n - 1])]) {
      test(`${n} copies: copy ${k} selected is the one found`, () => {
        const a = article(copies(n));
        expect(findPassage(a, dup, contextOf(a, `#c${k}`))?.block?.id).toBe(`c${k}`);
      });
    }
  }
  test("a heading next to the selected copy", () => {
    const a = article(`<h2>Pier</h2><p id="c0">${dup}</p><p>${longText("Shared")}</p><h2>Quay</h2><p id="c1">${dup}</p><p>${longText("Shared")}</p>`);
    expect(findPassage(a, dup, contextOf(a, "#c1"))?.block?.id).toBe("c1");
    expect(findPassage(a, dup, contextOf(a, "#c0"))?.block?.id).toBe("c0");
  });
  test("copies at the very start and the very end of the article", () => {
    const a = article(`<p id="c0">${dup}</p><p>Middle text between the two copies.</p><p id="c1">${dup}</p>`);
    expect(findPassage(a, dup, contextOf(a, "#c0"))?.block?.id).toBe("c0");
    expect(findPassage(a, dup, contextOf(a, "#c1"))?.block?.id).toBe("c1");
  });
  test("labels only the reader shows, right next to a copy at the article's edge", () => {
    const a = article(`<figure><figcaption>A map.</figcaption></figure><p id="c0">${dup}</p><p>${longText("Middle")}</p><p id="c1">${dup}</p><div class="code-tab-standalone"><div class="code-tab-label">shell</div></div>`);
    expect(findPassage(a, dup, contextOf(a, "#c0"))?.block?.id).toBe("c0");
    expect(findPassage(a, dup, contextOf(a, "#c1"))?.block?.id).toBe("c1");
  });
  test("a copy that ends in a reader-only label (a figcaption), told apart only by what follows", () => {
    const lead = longText("Same lead");
    const fig = (k: number) => `<p>${lead}</p><figure><p id="c${k}">${dup}</p><figcaption>A map.</figcaption></figure><p>Note ${k} after the map.</p>`;
    const a = article(fig(0) + fig(1));
    const r = a.ownerDocument.createRange();
    r.setStart(a.querySelector("#c1")!.firstChild!, 0);
    const cap = a.querySelectorAll("figcaption")[1]!.firstChild as Text;
    r.setEnd(cap, cap.data.length);
    const c = discussContext(a, r)!;
    const f = findPassage(a, `${dup} A map.`, { before: c.before, after: c.after });
    expect((f?.range.startContainer as Text).parentElement?.id).toBe("c1");
  });
  test("only `before` tells the copies apart (identical text after each)", () => {
    const tail = longText("Same tail");
    const a = article(`<p>Pier lead.</p><p id="c0">${dup}</p><p>${tail}</p><p>Quay lead.</p><p id="c1">${dup}</p><p>${tail}</p>`);
    const ctx = contextOf(a, "#c1");
    expect(findPassage(a, dup, ctx)?.block?.id).toBe("c1");
    expect(findPassage(a, dup, { before: ctx.before })?.block?.id).toBe("c1");
    expect(findPassage(a, dup, { before: contextOf(a, "#c0").before })?.block?.id).toBe("c0");
  });
  test("only `after` tells the copies apart (identical text before each)", () => {
    const lead = longText("Same lead");
    const a = article(`<p>${lead}</p><p id="c0">${dup}</p><p>Pier note.</p><p>${lead}</p><p id="c1">${dup}</p><p>Quay note.</p>`);
    const ctx = contextOf(a, "#c1");
    expect(findPassage(a, dup, ctx)?.block?.id).toBe("c1");
    expect(findPassage(a, dup, { after: ctx.after })?.block?.id).toBe("c1");
    expect(findPassage(a, dup, { after: contextOf(a, "#c0").after })?.block?.id).toBe("c0");
  });
  test("no context, empty context or a tie: the first copy", () => {
    const lead = longText("Same lead");
    const tail = longText("Same tail");
    const a = article(`<p>${lead}</p><p id="c0">${dup}</p><p>${tail}</p><p>${lead}</p><p id="c1">${dup}</p><p>${tail}</p><p>${lead}</p><p id="c2">${dup}</p><p>${tail}</p>`);
    expect(findPassage(a, dup)?.block?.id).toBe("c0");
    expect(findPassage(a, dup, null)?.block?.id).toBe("c0");
    expect(findPassage(a, dup, {})?.block?.id).toBe("c0");
    expect(findPassage(a, dup, { before: "", after: "" })?.block?.id).toBe("c0");
    // The middle copy selected: its surroundings read the same as the others'.
    expect(findPassage(a, dup, contextOf(a, "#c1"))?.block?.id).toBe("c0");
  });
  test("`before`/`after` longer than the page text", () => {
    const a = article(`<p>Pier.</p><p id="c0">${dup}</p><p>Quay.</p><p id="c1">${dup}</p><p>End.</p>`);
    const pad = "x".repeat(5000);
    const c1 = contextOf(a, "#c1");
    expect(findPassage(a, dup, { before: pad + c1.before, after: c1.after + pad })?.block?.id).toBe("c1");
    const c0 = contextOf(a, "#c0");
    expect(findPassage(a, dup, { before: pad + c0.before, after: c0.after + pad })?.block?.id).toBe("c0");
  });
  test("cost: 600 copies, the article's context reading is built once", () => {
    const paras = Array.from({ length: 600 }, (_, k) => `<p id="p${k}">Paragraph ${k} takes the route past berth ${k}.</p>`).join("");
    const a = article(`<h2>Routes</h2>${paras}`);
    const r = a.ownerDocument.createRange();
    const t = a.querySelector("#p300")!.firstChild as Text;
    const from = t.data.indexOf("the route");
    r.setStart(t, from);
    r.setEnd(t, from + "the route".length);
    const c = discussContext(a, r)!;
    const t0 = performance.now();
    const { value, calls, elements } = countReadings(a, () => findPassage(a, "the route", { before: c.before, after: c.after }));
    const ms = performance.now() - t0;
    expect(value?.block?.id).toBe("p300");
    expect(value?.range.toString()).toBe("the route");
    // One reading: the skip test runs at most once per element.
    expect(calls).toBeLessThanOrEqual(elements);
    expect(ms).toBeLessThan(1000);
  });
});

describe("the proposed edit's card (P4)", () => {
  const previewBody = {
    ok: true,
    before: "the date on the Status line.",
    after: "the Brief's Status line <b>.",
    beforeCtx: "compares it with ",
    afterCtx: "\n",
    fromLine: 21,
    toLine: 21,
    note: null,
    findings: [{ check: "chart-table", message: "holds no table", line: 30 }],
    pageChangedSinceTurn: false,
    logEntry: "## [2026-11-20] update | P\n- Discuss: …",
    baseHash: "b",
    previewHash: "p",
    markText: "the date on the Status line.",
  };
  const doneWithEdit = (key: string, seq: number) => {
    const t = newTurn(key, "q", null);
    applyDiscussFrame(t, "turn", { turnId: `id-${key}`, seq });
    applyDiscussFrame(t, "done", { answer: "a", proposedEdit: { edits: [{ old: "x", new: "y" }] } });
    return t;
  };

  test("a preview body is read; anything else is not one", () => {
    expect(discussState.readEditPreview(previewBody)).toMatchObject({ before: previewBody.before, after: previewBody.after, findings: previewBody.findings, previewHash: "p" });
    expect(discussState.readEditPreview({ ok: true, before: "x" })).toBeNull();
    expect(discussState.readEditPreview(null)).toBeNull();
  });

  test("ready: the diff escaped, the lines, the findings, and Apply, «Change the wording» and Discard", () => {
    const t = doneWithEdit("t1", 1);
    t.edit = { state: "ready", preview: discussState.readEditPreview(previewBody), message: null };
    const html = discussTurnHtml(t, true);
    expect(html).toContain("Proposed edit · line 21");
    expect(html).toContain("<del>the date on the Status line.</del>");
    expect(html).toContain("<ins>the Brief&#39;s Status line &lt;b&gt;.</ins>");
    expect(html).toContain("chart-table (line 30): holds no table");
    for (const attr of ["data-discuss-apply", "data-discuss-reword", "data-discuss-discard"]) expect(html).toContain(`${attr}="t1"`);
  });

  test("an older turn's edit is not offered once a newer turn follows; the list passes current by seq", () => {
    const older = doneWithEdit("t1", 1);
    older.edit = { state: "ready", preview: discussState.readEditPreview(previewBody), message: null };
    const newer = doneWithEdit("t2", 2);
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "d", turns: [older, newer] };
    const html = discussTurnsHtml(d);
    expect(html).toContain("A newer turn follows, so it is no longer offered.");
    expect(html).not.toContain('data-discuss-apply="t1"');
    expect(html).toContain("Previewing the proposed edit…");
  });

  test("refused: the reason and no Apply; discarded: one line; applied: the note and no buttons", () => {
    const t = doneWithEdit("t1", 1);
    t.edit = { state: "refused", preview: null, message: discussState.discussEditRefusalMessage(409, { refused: true, code: "fact-wrapper", error: "the edit's range is inside a fact wrapper" }) };
    let html = discussTurnHtml(t, true);
    expect(html).toContain("This edit cannot be applied: the edit&#39;s range is inside a fact wrapper.");
    expect(html).not.toContain("data-discuss-apply");
    t.edit = { state: "discarded", preview: null, message: null };
    expect(discussTurnHtml(t, true)).toContain("The proposed edit was discarded.");
    t.edit = { state: "applied", preview: discussState.readEditPreview(previewBody), message: "Applied." };
    html = discussTurnHtml(t, false);
    expect(html).toContain("Applied.");
    expect(html).not.toContain("<button type=\"button\" class=\"wiki-discuss-apply\"");
  });
});

describe("retrying the card after a refusal or a lost answer (fix round 1 batch 4)", () => {
  const preview = discussState.readEditPreview({
    ok: true,
    before: "old words.",
    after: "new words.",
    beforeCtx: "",
    afterCtx: "",
    fromLine: 3,
    toLine: 3,
    note: null,
    findings: [],
    pageChangedSinceTurn: false,
    logEntry: "",
    baseHash: "b1",
    previewHash: "p1",
    markText: "old words.",
  })!;
  const turnWith = (edit: discussState.DiscussEditView) => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "id-t1", seq: 1 });
    applyDiscussFrame(t, "done", { answer: "a", proposedEdit: { edits: [{ old: "x", new: "y" }] } });
    t.edit = edit;
    return discussTurnHtml(t, true);
  };

  test("a transient Apply refusal keeps the previewed card and its Apply, with the reason", () => {
    const cases: [number, Record<string, unknown>][] = [
      [409, { locked: true, error: "A session is writing to this wiki: x. Try again in a moment." }],
      [409, { dirty: true, error: "The page has uncommitted changes. Commit or discard them, then try again." }],
      [409, { held: true, error: "A Gardener card holds this page." }],
      [503, { error: "The Gardener's cards could not be read, so the page's claim is unknown." }],
      [500, { error: "write failed" }],
    ];
    for (const [status, body] of cases) {
      const e = discussState.editAfterApplyRefusal(preview, status, body);
      expect(e.state).toBe("ready");
      expect(e.preview).toBe(preview);
      expect(e.message).toContain(body.error as string);
      expect(turnWith(e)).toContain('data-discuss-apply="t1"');
    }
  });

  test("stale or changed: the hashes are dropped, no Apply, and «Preview again» instead", () => {
    for (const body of [{ stale: true, error: "The page changed since the edit was shown. Preview it again." }, { changed: true, error: "What Apply writes changed since the preview. Preview again." }]) {
      const e = discussState.editAfterApplyRefusal(preview, 409, body);
      expect(e.state).toBe("refused");
      expect(e.preview).toBeNull();
      expect(e.retry).toBe("preview");
      const html = turnWith(e);
      expect(html).not.toContain("data-discuss-apply");
      expect(html).toContain('data-discuss-repreview="t1"');
      expect(html).toContain(">Preview again</button>");
      expect(html).not.toContain("Discard this card, or ask again");
    }
  });

  test("a permanent Apply refusal stays final: no Apply, no «Preview again»", () => {
    const cases: [number, Record<string, unknown>][] = [
      [409, { reason: "superseded", error: "x" }],
      [409, { reason: "applied", error: "x" }],
      [409, { reason: "not-done", error: "the turn ended error, not done" }],
      [409, { refused: true, code: "fact-wrapper", error: "the edit's range is inside a fact wrapper" }],
      [409, { refused: true, code: "no-change", error: "the edit changes nothing" }],
      [403, { readonly: true, error: "This wiki is read-only here." }],
    ];
    for (const [status, body] of cases) {
      const e = discussState.editAfterApplyRefusal(preview, status, body);
      expect(e.state).toBe("refused");
      expect(e.retry ?? null).toBeNull();
      const html = turnWith(e);
      expect(html).not.toContain("data-discuss-apply");
      expect(html).not.toContain("data-discuss-repreview");
    }
  });

  test("a failed preview offers «Preview again» when it was transient, and nothing when it was final", () => {
    for (const [status, body] of [[0, null], [503, { error: "the rules file cannot be read", reason: "rules-unreadable" }], [500, null]] as [number, Record<string, unknown> | null][]) {
      const e = discussState.editAfterPreviewFailure(status, body);
      expect(e.retry).toBe("preview");
      expect(turnWith(e)).toContain('data-discuss-repreview="t1"');
    }
    for (const body of [{ reason: "superseded", error: "x" }, { refused: true, code: "ambiguous", error: "the old text is on the page twice" }]) {
      const e = discussState.editAfterPreviewFailure(409, body);
      expect(e.state).toBe("refused");
      expect(turnWith(e)).not.toContain("data-discuss-repreview");
    }
  });

  test("a lost Apply answer never claims nothing was written: the re-preview decides", () => {
    // The turn now reads as applied: the write landed; show it and render the page again.
    const applied = discussState.editAfterLostApply(preview, { ok: false, status: 409, body: { reason: "applied", error: "this edit is already applied" } });
    expect(applied.edit.state).toBe("applied");
    expect(applied.reload).toBe(true);
    // Still offered: the outcome is unknown, Apply is offered with the fresh hashes.
    const fresh = { ...preview, baseHash: "b2", previewHash: "p2" };
    const again = discussState.editAfterLostApply(preview, { ok: true, status: 200, body: { ...fresh, ok: true } });
    expect(again.edit.state).toBe("ready");
    expect(again.edit.preview?.baseHash).toBe("b2");
    expect(again.edit.message).toContain("unknown");
    // The server does not answer at all: unknown, and a way to find out.
    const down = discussState.editAfterLostApply(preview, { ok: false, status: 0, body: null });
    expect(down.edit.message).toContain("unknown");
    expect(down.edit.retry).toBe("lost");
    expect(down.edit.preview).toBeNull();
    for (const r of [applied, again, down]) expect(r.edit.message ?? "").not.toContain("nothing was written");
  });

  test("a lost Apply answer re-renders the page only when the edit reads as applied (fix round 2 batch 4)", () => {
    // Still offered: nothing reads as written, so the article and its scroll stay.
    const fresh = { ...preview, baseHash: "b2", previewHash: "p2" };
    expect(discussState.editAfterLostApply(preview, { ok: true, status: 200, body: { ...fresh, ok: true } }).reload).toBe(false);
    expect(discussState.editAfterLostApply(preview, { ok: false, status: 409, body: { reason: "applied", error: "x" } }).reload).toBe(true);
  });

  test("a re-preview refusal after a lost Apply answer leaves the article as it is (fix round 2 batch 4)", () => {
    // A refusal from the re-preview (the old text gone, another turn, a read-only wiki): nothing of this edit written either.
    for (const [status, body] of [
      [409, { refused: true, code: "not-found", error: "the old text is not in the page as it is now" }],
      [409, { reason: "superseded", error: "a newer turn exists" }],
      [403, { readonly: true, error: "This wiki is read-only here." }],
    ] as [number, Record<string, unknown>][]) {
      const out = discussState.editAfterLostApply(preview, { ok: false, status, body });
      expect(out.edit.state).toBe("refused");
      expect(out.reload).toBe(false);
    }
  });

  test("a 500 the route marks final (the turn stays claimed) offers no Apply (fix round 2 batch 3)", () => {
    const body = { error: "write failed; the turn is still marked applied, so it cannot be applied again", final: true };
    const e = discussState.editAfterApplyRefusal(preview, 500, body);
    expect(e.state).toBe("refused");
    expect(e.retry ?? null).toBeNull();
    expect(turnWith(e)).not.toContain("data-discuss-apply");
    expect(discussState.editAfterPreviewFailure(500, body).retry ?? null).toBeNull();
  });

  test("an answer that is not the route's is a lost answer; the route's own JSON 5xx is a refusal (fix round 2 batch 3)", () => {
    const lost: [boolean, number, Record<string, unknown> | null][] = [
      [false, 0, null],
      [true, 200, null], // a success whose body did not arrive
      [false, 502, null], // a proxy's HTML page
      [false, 504, null],
      [false, 503, null],
      [false, 502, { message: "Bad Gateway" }],
    ];
    for (const [ok, status, body] of lost) expect(discussState.applyAnswerLost({ ok, status, body })).toBe(true);
    const refused: [number, Record<string, unknown>][] = [
      [500, { error: "write failed" }],
      [503, { error: "The Gardener's cards could not be read, so the page's claim is unknown." }],
      [503, { error: "the rules file cannot be read", reason: "rules-unreadable" }],
      [409, { error: "x", stale: true }],
      [403, { error: "This wiki is read-only here.", readonly: true }],
    ];
    for (const [status, body] of refused) expect(discussState.applyAnswerLost({ ok: false, status, body })).toBe(false);
    // The re-preview after a lost answer gets a gateway page too: still unknown, nothing rendered again.
    const gw = discussState.editAfterLostApply(preview, { ok: false, status: 502, body: null });
    expect(gw.edit.state).toBe("failed");
    expect(gw.edit.retry).toBe("lost");
    expect(gw.reload).toBe(false);
  });

  test("the applied note can take focus, so the tab can move the reader to it", () => {
    expect(turnWith({ state: "applied", preview, message: "Applied." })).toMatch(/<div class="wiki-discuss-edit-done" role="status" tabindex="-1">Applied\.<\/div>/);
  });
});

describe("the article mark on the text a proposed edit replaces", () => {
  const MD = [
    "# Ferry plan",
    "",
    "## Status of the plan",
    "",
    "A plain paragraph says the ferry leaves at nine every day.",
    "",
    "[The timetable](https://example.invalid/t) lists every crossing of the week.",
    "",
    "- Intro: the Status line is checked.",
    "",
    "The rules follow.",
    "",
    "- R1: the berth list is current.",
    "- R2: the **Status** line is checked.",
    "",
    "- **R3, behind.** The check compares the date.",
    "",
    '<Fold title="The berths">',
    "",
    "The north pier takes the morning ferry.",
    "",
    "The south pier takes the evening ferry.",
    "",
    "</Fold>",
    "",
  ].join("\n");
  /** The page as `formatWebHtml` renders it, in a happy-dom article. */
  const rendered = () => article(formatWebHtml(MD));
  /** A preview of replacing `before` (as written in MD), its context read from MD as the route reads it. */
  const previewOf = (before: string, markText = "") => {
    const at = MD.indexOf(before);
    if (at === -1 || MD.indexOf(before, at + 1) !== -1) throw new Error(`not once in MD: ${before}`);
    return { before, beforeCtx: MD.slice(Math.max(0, at - 120), at), afterCtx: MD.slice(at + before.length, at + before.length + 120), markText };
  };
  /** The range the mark paints for that preview: its text, and the element holding its start. */
  const markIn = (a: Element, before: string, markText = "") => {
    const found = discussState.editMarkTarget(a, previewOf(before, markText));
    expect(found).not.toBeNull();
    return { range: found!.range, text: found!.range.toString(), node: found!.node, at: found!.range.startContainer.parentElement! };
  };

  test("a plain paragraph (no <p>): exactly that paragraph's text, not the article", () => {
    const a = rendered();
    const r = markIn(a, "A plain paragraph says the ferry leaves at nine every day.", "A plain paragraph says the ferry leaves at nine every day.");
    expect(r.text).toBe("A plain paragraph says the ferry leaves at nine every day.");
  });
  test("an edit that starts with a link: the link's text and the rest of the sentence", () => {
    const a = rendered();
    const r = markIn(a, "[The timetable](https://example.invalid/t) lists every crossing of the week.");
    expect(r.text).toBe("The timetable lists every crossing of the week.");
    expect(r.at.tagName).toBe("A");
  });
  test("an edit that starts inside bold: the whole replaced text, not only the bold run", () => {
    const a = rendered();
    const r = markIn(a, "**R3, behind.** The check compares the date.");
    expect(r.text).toBe("R3, behind. The check compares the date.");
  });
  test("inside a closed Fold: only that paragraph, and the fold is opened", () => {
    const a = rendered();
    const fold = a.querySelector("details")!;
    expect(fold.hasAttribute("open")).toBe(false);
    const r = markIn(a, "The north pier takes the morning ferry.");
    expect(r.text).toBe("The north pier takes the morning ferry.");
    expect(discussState.openFoldsAround(a, r.node)).toEqual([fold]);
    expect(fold.hasAttribute("open")).toBe(true);
  });
  test("text on the page twice: the copy the edit's context names, not the first", () => {
    const a = rendered();
    // The rendered words «the Status line is checked.» are in the intro bullet first.
    const r = markIn(a, "the **Status** line is checked.", "the Status line is checked.");
    expect(r.text).toBe("the Status line is checked.");
    expect(r.at.closest("li")!.textContent).toContain("R2:");
  });
  test("a heading edit: the route's markText is empty, the heading is still found", () => {
    const a = rendered();
    const r = markIn(a, "## Status of the plan", "");
    expect(r.text).toBe("Status of the plan");
    expect(r.at.tagName).toMatch(/^H\d$/);
  });
  test("finding the target changes nothing in the article (the chips' anchors hold its text nodes)", () => {
    const a = rendered();
    const nodes = (el: Element) => {
      const w = el.ownerDocument.createTreeWalker(el, 4);
      const out: Node[] = [];
      while (w.nextNode()) out.push(w.currentNode);
      return out;
    };
    const html = a.innerHTML;
    const before = nodes(a);
    for (const b of ["A plain paragraph says the ferry leaves at nine every day.", "the **Status** line is checked.", "**R3, behind.** The check compares the date."]) {
      expect(discussState.editMarkTarget(a, previewOf(b))).not.toBeNull();
    }
    expect(a.innerHTML).toBe(html);
    const after = nodes(a);
    expect(after.length).toBe(before.length);
    expect(after.every((n, k) => n === before[k])).toBe(true);
  });
  test("an edit across two bullets: one range over both items' text", () => {
    const a = article(formatWebHtml("- First item here.\n- Second item there.\n"));
    const found = discussState.editMarkTarget(a, { before: "First item here.\n- Second item there.", beforeCtx: "", afterCtx: "", markText: "" });
    expect(found!.range.toString().replace(/\s+/g, "")).toBe("Firstitemhere.Seconditemthere.");
  });
  test("after Apply, new text the page also shows above the edit: the edited copy, by the edit's surroundings (fix round 2 batch 4)", () => {
    const md = ["Summer: the last berth closes at dusk.", "", ...Array.from({ length: 20 }, (_, k) => `Filler ${k} about the harbour.\n`), "Winter: the last berth closes at dusk.", "", "The end."].join("\n");
    const a = article(formatWebHtml(md));
    const at = md.indexOf("the last berth closes at dusk.", md.indexOf("Winter"));
    const after = "the last berth closes at dusk.";
    const found = discussState.appliedEditTarget(a, { after, beforeCtx: md.slice(Math.max(0, at - 120), at), afterCtx: md.slice(at + after.length, at + after.length + 120) });
    expect(found!.range.toString()).toBe(after);
    // The words just before the found copy: the Winter line's, not the Summer line's.
    const lead = a.ownerDocument.createRange();
    lead.setStart(a, 0);
    lead.setEnd(found!.range.startContainer, found!.range.startOffset);
    expect(lead.toString().trimEnd().endsWith("Winter:")).toBe(true);
  });
  test("after Apply, new text with inline markdown: found by its rendered words (fix round 2 batch 4)", () => {
    const md = "First paragraph.\n\nThe last berth closes at `dusk` on **weekdays** and [the ferry](https://example.invalid/f) waits.\n\nLast paragraph.\n";
    const a = article(formatWebHtml(md));
    const after = "The last berth closes at `dusk` on **weekdays** and [the ferry](https://example.invalid/f) waits.";
    const found = discussState.appliedEditTarget(a, { after, beforeCtx: "First paragraph.\n\n", afterCtx: "\n\nLast paragraph.\n" });
    expect(found!.range.toString().replace(/\s+/g, " ")).toBe("The last berth closes at dusk on weekdays and the ferry waits.");
  });
  test("a 2,000-paragraph page: the target is found in well under a frame budget per paragraph", () => {
    const paras = Array.from({ length: 2000 }, (_, k) => `Paragraph ${k} of the long page says something about crossing ${k}.`);
    const a = article(formatWebHtml(paras.join("\n\n")));
    const t0 = performance.now();
    const found = discussState.editMarkTarget(a, { before: paras[1990]!, beforeCtx: "", afterCtx: "", markText: "" });
    const ms = performance.now() - t0;
    expect(found!.range.toString()).toBe(paras[1990]!);
    expect(ms).toBeLessThan(250);
  });
});

describe("the mark's words read from markdown, and a range a later enhancement broke (fix round 2 batch 5)", () => {
  /** The words with white space collapsed: the mark compares without it. */
  const words = (md: string) => discussState.markdownWords(md).replace(/\s+/g, " ").trim();
  /** The edit's target in an article rendered from `md`, `before` written once in it. */
  const target = (md: string, before: string, markText = "") => {
    const at = md.indexOf(before);
    const a = article(formatWebHtml(md));
    const found = discussState.editMarkTarget(a, { before, beforeCtx: md.slice(Math.max(0, at - 120), at), afterCtx: md.slice(at + before.length, at + before.length + 120), markText });
    return { a, found };
  };
  const spaced = (r: Range | undefined) => (r?.toString() ?? "").replace(/\s+/g, " ").trim();

  test("code spans are literal: markup inside them stays, so a paragraph with two `*` in code is marked whole", () => {
    const before = "Run `rm *.tmp` then `ls *.md` to list the berth files.";
    expect(words(before)).toBe("Run rm *.tmp then ls *.md to list the berth files.");
    expect(words("Use `**bold**` and `<Fold>` and `[[a|b]]` as written.")).toBe("Use **bold** and <Fold> and [[a|b]] as written.");
    const { found } = target(`First.\n\n${before}\n\nLast.\n`, before);
    expect(spaced(found?.range)).toBe("Run rm *.tmp then ls *.md to list the berth files.");
  });
  test("an autolink reads as its URL, as the reader renders it", () => {
    const before = "See <https://example.com/x> for the timetable.";
    expect(words(before)).toBe("See https://example.com/x for the timetable.");
    expect(words("See <https://example.com/x|the timetable> here.")).toBe("See the timetable here.");
    const { found } = target(`First.\n\n${before}\n\nLast.\n`, before);
    expect(spaced(found?.range)).toBe("See https://example.com/x for the timetable.");
  });
  test("a fenced block's lines are kept as written: a `# ` or `- ` inside it is not a heading or bullet", () => {
    const before = "```\n# start the ferry\n- check the berth\n```";
    expect(words(before)).toBe("# start the ferry - check the berth");
    // The fence closes: a heading after it is read as a heading again.
    expect(words("~~~~\n# kept\n~~~\n~~~~\n# Heading after")).toBe("# kept ~~~ Heading after");
    const { found } = target(`First.\n\n${before}\n\nLast.\n`, before);
    expect(spaced(found?.range)).toBe("# start the ferry - check the berth");
  });
  test("a 300-character passage starting with a code span is marked whole, not its first 200 characters", () => {
    const before = "`<Fold>` " + Array.from({ length: 30 }, (_, k) => `holds berth ${k}`).join(", ") + ".";
    const plain = before.replace(/`/g, "");
    expect(plain.length).toBeGreaterThan(300);
    // The route's markText as the route now computes it (never clipped).
    const { found } = target(`First.\n\n${before}\n\nLast.\n`, before, plainSnippet(before, Infinity));
    expect(spaced(found?.range)).toBe(plain);
  });
  test("after Apply, new text with markup inside a code span: revealed by its rendered words", () => {
    const md = "First paragraph.\n\nRun `rm *.tmp` then `ls *.md` on **every** berth.\n\nLast paragraph.\n";
    const a = article(formatWebHtml(md));
    const found = discussState.appliedEditTarget(a, { after: "Run `rm *.tmp` then `ls *.md` on **every** berth.", beforeCtx: "First paragraph.\n\n", afterCtx: "\n\nLast paragraph.\n" });
    expect(spaced(found?.range)).toBe("Run rm *.tmp then ls *.md on every berth.");
  });
  test("block markers: table pipes and separator rows, fences, quotes and callouts, headings, bullets and checkboxes", () => {
    expect(words("| Berth | Ferry |\n|---|:---:|\n| North | Morning |")).toBe("Berth Ferry North Morning");
    expect(words("~~~\nkept\n~~~")).toBe("kept");
    expect(words("> [!note] Heads up\n> the pier is closed.")).toBe("Heads up the pier is closed.");
    expect(words("> > Nested quote.")).toBe("Nested quote.");
    expect(words("## The berths\n- [ ] Check it\n1. First")).toBe("The berths Check it First");
  });
  test("inline: tags out, wiki links and links by label, images by alt, bold, strike and single emphasis out, snake_case kept", () => {
    expect(words('The check reads <Fact v="ok" n="1">the status date</Fact> only.')).toBe("The check reads the status date only.");
    expect(words("See [[plans/ferry|the ferry plan]] and [[berths]].")).toBe("See the ferry plan and berths.");
    expect(words("A [timetable](https://example.invalid/t) and ![the map](m.png).")).toBe("A timetable and the map.");
    expect(words("It is **due** and ~~late~~, *really* _soon_, in status_date.")).toBe("It is due and late, really soon, in status_date.");
  });
  test("nested closed Folds: both are opened around the marked text", () => {
    const a = article("<details><summary>Outer</summary><details><summary>Inner</summary>The inner berth.</details></details>");
    const [outer, inner] = Array.from(a.querySelectorAll("details"));
    const node = inner!.lastChild!;
    expect(discussState.openFoldsAround(a, node)).toEqual([inner!, outer!]);
    expect(outer!.hasAttribute("open") && inner!.hasAttribute("open")).toBe(true);
  });
  test("a mark's range holds while its words stand; a text node replaced under it (the ref links' replaceWith) breaks it (happy-dom leaves the range in the detached node; Chromium collapses it, the e2e's case)", () => {
    const md = 'First.\n\nThe "Brief" section names the owner.\n\nLast.\n';
    const { a, found } = target(md, 'The "Brief" section names the owner.');
    const range = found!.range;
    const w = discussState.editMarkWords(range);
    expect(discussState.editMarkHolds(a, range, w)).toBe(true);
    const node = range.startContainer as Text;
    node.replaceWith(a.ownerDocument.createTextNode(node.data));
    expect(discussState.editMarkHolds(a, range, w)).toBe(false);
    // Found again in the article as it now stands, the same words.
    const again = discussState.editMarkTarget(a, { before: 'The "Brief" section names the owner.', beforeCtx: "", afterCtx: "", markText: "" })!;
    expect(discussState.editMarkWords(again.range)).toBe(w);
    expect(discussState.editMarkHolds(a, again.range, w)).toBe(true);
  });
});

describe("«Change the wording» and the reader's draft", () => {
  test("an empty box gets the prompt; a draft is kept after it; the prompt is not added twice", () => {
    const P = discussState.DISCUSS_REWORD_PROMPT;
    expect(discussState.rewordDraft("")).toBe(P);
    expect(discussState.rewordDraft("   ")).toBe(P);
    expect(discussState.rewordDraft("shorter, please")).toBe(`${P}shorter, please`);
    expect(discussState.rewordDraft(`${P}shorter`)).toBe(`${P}shorter`);
  });
  test("the prompt with its trailing space deleted, or the box indented, is not added twice (fix round 2 batch 5)", () => {
    const P = discussState.DISCUSS_REWORD_PROMPT;
    expect(discussState.rewordDraft(P.trimEnd())).toBe(P.trimEnd());
    expect(discussState.rewordDraft(`${P.trimEnd()}shorter`)).toBe(`${P.trimEnd()}shorter`);
    expect(discussState.rewordDraft(`  ${P}shorter`)).toBe(`  ${P}shorter`);
  });
});

// ── Discuss v2 PR 4: the page's thread read back ─────────────────────────

const stored = (o: Partial<discussState.StoredDiscussTurn> & { id: string; seq: number }): discussState.StoredDiscussTurn => ({
  discussionId: "th-1",
  selection: null,
  question: `q${o.seq}`,
  answer: `a${o.seq}`,
  endState: "done",
  error: null,
  toolCalls: [],
  proposedEdit: null,
  editAppliedAt: null,
  createdAt: 1_700_000_000_000 + o.seq,
  ...o,
});
const pair = (t: discussState.StoredDiscussTurn): discussState.StoredThreadMessage[] => [
  { id: `u-${t.id}`, role: "user", content: t.question, createdAt: t.createdAt, turn: t },
  { id: `a-${t.id}`, role: "assistant", content: t.answer, createdAt: t.createdAt, turn: t },
];

describe("the page's thread read back (Discuss v2 PR 4)", () => {
  test("each turn once, in seq order, keyed by its turn id, with its tools, passage and edit", () => {
    const t2 = stored({ id: "r2", seq: 2, selection: "The pier.", toolCalls: [{ name: "Read", input: "notes/a.md" }], proposedEdit: { edits: [] } });
    const t1 = stored({ id: "r1", seq: 1 });
    const turns = discussState.turnsFromThread([...pair(t2), ...pair(t1), { id: "x", role: "assistant", content: "orphan", createdAt: 0, turn: null }]);
    expect(turns.map((t) => [t.key, t.turnId, t.seq, t.state])).toEqual([
      ["s:r1", "r1", 1, "done"],
      ["s:r2", "r2", 2, "done"],
    ]);
    expect(turns[1]!.passage?.selection).toBe("The pier.");
    expect(turns[1]!.tools).toEqual([{ name: "Read", input: "notes/a.md" }]);
    expect(turns[1]!.proposedEdit).toBe(true);
    expect(turns[0]!.proposedEdit).toBe(false);
  });

  test("an applied edit reads as applied; a running turn is not live here; a failed one says so", () => {
    const applied = discussState.turnFromStored(stored({ id: "r1", seq: 1, proposedEdit: { edits: [] }, editAppliedAt: 5 }));
    expect(applied.edit?.state).toBe("applied");
    const running = discussState.turnFromStored(stored({ id: "r2", seq: 2, endState: "running", answer: "" }));
    expect(running.state).toBe("dropped");
    expect(discussState.turnLive(running)).toBe(false);
    expect(running.message).toContain("still running");
    const failed = discussState.turnFromStored(stored({ id: "r3", seq: 3, endState: "timeout", error: "deadline" }));
    expect(failed.state).toBe("timeout");
    expect(failed.message).toContain("deadline");
  });

  test("merge adds the read's turns, keeps the tab's own copy of a turn, and never drops one", () => {
    const own = newTurn("t1", "q1", null);
    applyDiscussFrame(own, "turn", { turnId: "r1", seq: 1, discussionId: "th-1" });
    applyDiscussFrame(own, "done", { answer: "streamed" });
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: null, turns: [own] };
    discussState.mergeThreadTurns(d, "th-1", discussState.turnsFromThread([...pair(stored({ id: "r1", seq: 1 })), ...pair(stored({ id: "r2", seq: 2 }))]));
    expect(d.discussionId).toBe("th-1");
    expect(d.turns.map((t) => t.key)).toEqual(["t1", "s:r2"]);
    expect(d.turns[0]!.text).toBe("streamed");
  });

  test("while a turn is being sent, a running turn the read lists is left for the turn event; that event drops any read-back copy", () => {
    const sending = newTurn("t9", "q", null);
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "th-1", turns: [sending] };
    discussState.mergeThreadTurns(d, "th-1", discussState.turnsFromThread(pair(stored({ id: "r5", seq: 5, endState: "running", answer: "" }))));
    expect(d.turns.map((t) => t.key)).toEqual(["t9"]);
    // A read that landed after the turn event but listed it anyway (done meanwhile):
    d.turns.push(discussState.turnFromStored(stored({ id: "r5", seq: 5 })));
    applyDiscussFrame(sending, "turn", { turnId: "r5", seq: 5 });
    discussState.dropStoredCopy(d, sending);
    expect(d.turns.map((t) => t.key)).toEqual(["t9"]);
  });

  test("pop out names the bot, the thread and the user, with src=wiki; nothing until all three are known", () => {
    const d: DiscussionView = { wiki: "w", relPath: "p.md", discussionId: "th-1", turns: [], bot: "ivar", userId: "kari" };
    const href = discussState.discussPopOutHref(d)!;
    const q = new URL(href, "http://x").searchParams;
    expect(href.startsWith("/chat?")).toBe(true);
    expect([q.get("bot"), q.get("thread"), q.get("user"), q.get("src")]).toEqual(["ivar", "th-1", "kari", "wiki"]);
    expect(discussState.discussPopOutHref({ ...d, userId: null })).toBeNull();
    expect(discussState.discussPopOutHref({ ...d, discussionId: null })).toBeNull();
  });

  test("Earlier discussions: collapsed, a closed thread's exchanges with Delete, one-shot turns grouped by discussion, all escaped, no live-turn markup", () => {
    expect(discussState.discussEarlierHtml(null)).toBe("");
    expect(discussState.discussEarlierHtml({ closed: [], oneShot: [] })).toBe("");
    const html = discussState.discussEarlierHtml({
      closed: [{ id: "c1", name: "wiki: <harbour>", createdAt: 1, closedAt: 2, messages: pair(stored({ id: "r1", seq: 1, question: "Why <b>?" })) }],
      oneShot: [stored({ id: "o2", seq: 2, discussionId: "d-old" }), stored({ id: "o1", seq: 1, discussionId: "d-old", question: "First old?" })],
    });
    expect(html.startsWith("<details class=\"wiki-discuss-earlier\">")).toBe(true);
    expect(html).not.toContain("<details class=\"wiki-discuss-earlier\" open");
    expect(html).toContain("Earlier discussions (2)");
    expect(html).toContain('data-discuss-delete-thread="c1"');
    expect(html).toContain("wiki: &lt;harbour&gt;");
    expect(html).toContain("Why &lt;b&gt;?");
    expect(html).toContain('data-earlier-oneshot="d-old"');
    expect(html.indexOf("First old?")).toBeLessThan(html.indexOf(">q2<"));
    expect(html).not.toContain("wiki-discuss-turn\"");
    expect(html).not.toContain("data-discuss-continue");
  });

  test("Earlier discussions says what the read left out: closed threads past its bound, and a thread's later messages", () => {
    const msgs = pair(stored({ id: "r1", seq: 1 }));
    const html = discussState.discussEarlierHtml({
      closed: [
        { id: "c1", name: "one", createdAt: 1, closedAt: 2, messages: msgs, messageTotal: 5 },
        { id: "c2", name: "two", createdAt: 1, closedAt: 2, messages: msgs, messageTotal: 2 },
      ],
      closedTotal: 14,
      oneShot: [],
    });
    expect(html).toContain("Earlier discussions (14)");
    expect(html).toContain("Showing the 2 most recently closed of 14 discussions");
    expect(html).toContain("3 later messages not shown.");
    expect(html.match(/not shown/g)).toHaveLength(1);
    // Nothing left out: no hint.
    const all = discussState.discussEarlierHtml({ closed: [{ id: "c1", name: "one", createdAt: 1, closedAt: 2, messages: msgs, messageTotal: 2 }], closedTotal: 1, oneShot: [] });
    expect(all).toContain("Earlier discussions (1)");
    expect(all).not.toContain("Showing the");
    expect(all).not.toContain("not shown");
  });

  test("Earlier discussions: a turn that proposed an edit says so without sending the reader to an Apply it has not got", () => {
    // As each is stored: a closed thread's message carries the marker
    // (`stripProposedEdit`), an old one-shot turn the ledger's raw answer with
    // its fenced edit block.
    const edit = '{"edits": [{"old": "The harbour opens at six.", "new": "The harbour opens at seven.", "reason": "timetable"}]}';
    const raw = `The page says six.\n\n\`\`\`json\n${edit}\n\`\`\`\n\nRead: notes/a.md`;
    expect(stripProposedEdit(raw)).toContain(STORED_EDIT_MARKER);
    const html = discussState.discussEarlierHtml({
      closed: [{ id: "c1", name: "one", createdAt: 1, closedAt: 2, messages: pair(stored({ id: "r1", seq: 1, answer: stripProposedEdit(raw) })) }],
      oneShot: [stored({ id: "o1", seq: 1, discussionId: "d-old", answer: raw })],
    });
    expect(html).not.toContain("preview and apply");
    expect(html).not.toContain("Discuss tab");
    expect(html).not.toContain("edits");
    expect(html).not.toContain("opens at seven");
    expect(html.match(/This answer proposed an edit; an earlier discussion cannot apply it\./g)).toHaveLength(2);
    const oneShot = html.slice(html.indexOf('data-earlier-oneshot="d-old"'));
    expect(oneShot).toContain("This answer proposed an edit; an earlier discussion cannot apply it.");
    expect(oneShot).toContain("The page says six.");
    expect(oneShot).toContain("Read: notes/a.md");
    // The rest of the answer stays.
    expect(html).toContain("The page says six.");
    expect(html).toContain("Read: notes/a.md");
    // The server's own detection: a json block that is no edit list stays as it is.
    const notEdit = 'Here is the shape:\n\n```json\n{"edits": []}\n```';
    expect(extractProposedEdit(notEdit)).toBeNull();
    const kept = discussState.discussEarlierHtml({ closed: [], oneShot: [stored({ id: "o2", seq: 1, discussionId: "d-two", answer: notEdit })] });
    expect(kept).toContain("edits");
    expect(kept).not.toContain("earlier discussion cannot apply");
    // Matched exactly: a sentence that only resembles the marker is left alone.
    const near = discussState.discussEarlierHtml({
      closed: [{ id: "c2", name: "two", createdAt: 1, closedAt: 2, messages: pair(stored({ id: "r2", seq: 1, answer: "Proposed edit: preview and apply it in the page's Discuss tab." })) }],
      oneShot: [],
    });
    expect(near).toContain("Proposed edit: preview and apply it in the page");
    expect(near).not.toContain("earlier discussion cannot apply");
  });

  test("the user picker lists the users the route named, escaped; with none it says what to do", () => {
    const html = discussState.discussUserPickHtml({ users: [{ id: "kari", name: "Kari <K>" }], message: "Pick one." });
    expect(html).toContain('<option value="kari">Kari &lt;K&gt; (kari)</option>');
    expect(html).toContain("data-discuss-pick-user");
    expect(discussState.discussUserPickHtml({ users: [], message: "None." })).not.toContain("<select");
    expect(discussState.discussUserPickHtml(null)).toBe("");
  });

  test("a closed, another user's or another bot's thread, and a missing user, each name what to do", () => {
    for (const reason of ["closed", "other-user", "other-bot"]) expect(discussRefusalMessage(409, { error: "that discussion was closed", reason })).toContain("reload the page");
    expect(discussRefusalMessage(422, { error: "x", reason: "no-user" })).toContain("pick one");
  });
});

describe("the model a turn ran on", () => {
  test("the turn event's planned model and connector, then done's reported model and duration", () => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "id-1", discussionId: "d-1", seq: 1, model: "claude-sonnet-5-5", connector: "copilot-sdk" });
    expect(t).toMatchObject({ model: "claude-sonnet-5-5", connector: "copilot-sdk", durationMs: null });
    // While it runs: model and connector, no duration.
    expect(discussTurnBodyParts(t, true).join("")).toContain('<div class="wiki-discuss-model">claude-sonnet-5-5 · copilot-sdk</div>');
    applyDiscussFrame(t, "done", { answer: "A.", proposedEdit: null, model: "claude-sonnet-5-5-20261101", durationMs: 12_345 });
    expect(t.model).toBe("claude-sonnet-5-5-20261101");
    expect(discussTurnBodyParts(t, true).join("")).toContain("claude-sonnet-5-5-20261101 · copilot-sdk · 12.3 s");
  });
  test("no model: no line at all, never an «unknown» value", () => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "id-1", seq: 1, connector: "claude-cli" });
    applyDiscussFrame(t, "done", { answer: "A.", proposedEdit: null, durationMs: 10 });
    expect(discussState.discussTurnMetaText(t)).toBe("");
    expect(discussTurnBodyParts(t, true).join("")).not.toContain("wiki-discuss-model");
  });
  test("a turn read back carries the answer message's model over the ledger's planned one", () => {
    const row = { id: "r1", discussionId: "d", seq: 1, selection: null, question: "q", answer: "a", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1, model: "sonnet", connector: "claude-sdk", durationMs: 4_000, assistantMessageId: "a-r1" };
    const [t] = discussState.turnsFromThread([
      { id: "u-r1", role: "user", content: "q", createdAt: 1, model: null, turn: row },
      { id: "a-r1", role: "assistant", content: "a", createdAt: 2, model: "claude-sonnet-5-5", turn: null },
    ]);
    expect(t!.model).toBe("claude-sonnet-5-5");
    expect(discussState.discussTurnMetaText(t!)).toBe("claude-sonnet-5-5 · claude-sdk · 4.0 s");
    // Without the answer's model, the ledger's planned one.
    const [p] = discussState.turnsFromThread([{ id: "u-r1", role: "user", content: "q", createdAt: 1, turn: { ...row, assistantMessageId: null } }]);
    expect(p!.model).toBe("sonnet");
  });
});

describe("the tool group", () => {
  const withTools = (n: number) => {
    const t = newTurn("t1", "q", null);
    applyDiscussFrame(t, "turn", { turnId: "id-1", seq: 1 });
    for (let i = 0; i < n; i++) applyDiscussFrame(t, "tool", { name: "research-wiki_read", input: JSON.stringify({ wiki: "w", path: `plans/p${i}.mdx`, offset: 1, limit: 10 }) });
    return t;
  };
  test("«Using N tools…» while running, open, with human lines, not JSON", () => {
    const t = withTools(2);
    const html = discussState.discussToolsHtml(t);
    expect(html).toContain("Using 2 tools…");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<span class="wiki-discuss-tool-label">Reading: </span><span class="wiki-discuss-tool-detail">plans/p1.mdx, lines 1–10</span>');
    expect(html).not.toContain("{&quot;");
  });
  test("closed once the answer text starts, and «Used N tools» once done", () => {
    const t = withTools(1);
    applyDiscussFrame(t, "delta", { text: "So" });
    expect(discussState.discussToolsOpen(t)).toBe(false);
    expect(discussState.discussToolsHtml(t)).not.toContain("wiki-discuss-tools-body");
    applyDiscussFrame(t, "done", { answer: "So.", proposedEdit: null });
    expect(discussState.discussToolsHtml(t)).toContain("Used 1 tool<");
  });
  test("the reader's toggle sticks over the automatic rule", () => {
    const t = withTools(1);
    applyDiscussFrame(t, "done", { answer: "So.", proposedEdit: null });
    t.toolsOpen = true;
    expect(discussState.discussToolsHtml(t)).toContain("wiki-discuss-tools-body");
  });
  test("past the cap: the newest lines and «and K more», nothing dropped silently", () => {
    const t = withTools(discussState.DISCUSS_TOOLS_SHOWN + 3);
    const html = discussState.discussToolsHtml(t);
    expect(html).toContain("and 3 more");
    expect(html).not.toContain("plans/p2.mdx");
    expect(html).toContain(`plans/p${discussState.DISCUSS_TOOLS_SHOWN + 2}.mdx`);
    expect(html.match(/class="wiki-discuss-tool"/g)!.length).toBe(discussState.DISCUSS_TOOLS_SHOWN);
  });
});

describe("the thread's user («as <name> ▾»)", () => {
  const view = (o: Partial<DiscussionView> = {}): DiscussionView => ({ wiki: "w", relPath: "p.md", discussionId: "th-1", turns: [], ...o });
  test("the read's name and users; a picker button only when choosable", () => {
    const d = view({ userId: "u1" });
    discussState.applyThreadWho(d, { userName: "Popp", userChoosable: true, users: [{ id: "u1", name: "Popp" }, { id: "u2", name: "Rune" }] });
    expect(d.users).toEqual([{ id: "u1", name: "Popp" }, { id: "u2", name: "Rune" }]);
    expect(discussState.discussUserButtonHtml(d)).toContain("data-discuss-as");
    expect(discussState.discussUserButtonHtml(d)).toContain("as Popp ▾");
    d.userMenu = true;
    const pick = discussState.discussUserMenuPick(d)!;
    expect(discussState.discussUserPickHtml(pick)).toContain('<option value="u1" selected>Popp (u1) · current</option>');
    expect(discussState.discussUserPickHtml(pick)).toContain('<option value="u2">Rune (u2)</option>');
  });
  test("not choosable (an authenticating instance): the name alone, no list kept, no picker", () => {
    const d = view({ userId: "u1", userMenu: true });
    discussState.applyThreadWho(d, { userName: "Popp", userChoosable: false, users: [{ id: "u2", name: "Rune" }] });
    expect(d.users).toEqual([]);
    expect(discussState.discussUserButtonHtml(d)).toBe('<span class="wiki-discuss-as" title="Whose discussion this is">as Popp</span>');
    expect(discussState.discussUserMenuPick(d)).toBeNull();
  });
  test("no name known: nothing", () => {
    const d = view();
    discussState.applyThreadWho(d, { userChoosable: true, users: [] });
    expect(discussState.discussUserButtonHtml(d)).toBe("");
  });
  test("switching drops the other user's turns and thread, never while a turn runs, never to an unlisted id", () => {
    const t = newTurn("t1", "q", null);
    const d = view({ userId: "u1", userName: "Popp", userChoosable: true, users: [{ id: "u1", name: "Popp" }, { id: "u2", name: "Rune" }], turns: [t], userMenu: true });
    expect(discussState.switchDiscussUser(d, "u2")).toBe(false); // t is still sending
    t.state = "done";
    expect(discussState.switchDiscussUser(d, "nobody")).toBe(false);
    expect(discussState.switchDiscussUser(d, "u2")).toBe(true);
    expect(d).toMatchObject({ userId: "u2", userName: "Rune", turns: [], discussionId: null, earlier: null, userMenu: false });
  });
});

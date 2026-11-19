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
  discussRefusalMessage,
  discussTurnHtml,
  discussTurnsHtml,
  findPassage,
  newTurn,
  patchDiscussTurns,
  renderedPassageText,
  streamClosed,
  type DiscussionView,
} from "./wiki-discuss-state.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";

const passage = { selection: "The summer route adds a stop.", before: "", after: "", atStart: true, atEnd: true, heading: "Design" };

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
    expect(t.tools).toEqual(['Read {"file_path":"src/route.ts"}']);
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
  // The tab keeps discussions in memory only and no route lists a
  // discussion's turns back, so a reload shows an empty tab.
  test("never promise that a reload brings the turn back", () => {
    const withId = newTurn("t1", "q", null);
    applyDiscussFrame(withId, "turn", { turnId: "a", seq: 1 });
    streamClosed(withId);
    const noId = newTurn("t2", "q", null);
    streamClosed(noId);
    for (const t of [withId, noId]) {
      expect(t.message).not.toMatch(/reload the page later|reload the page to read/i);
      expect(t.message).toContain("this tab cannot show it");
    }
    // With a turn id the turn offers «Continue in Claude Code», which builds
    // its prompt from the stored turn once it has ended.
    expect(withId.message).toContain("«Continue in Claude Code»");
    expect(discussTurnHtml(withId)).toContain('data-discuss-continue="t1"');
    // Without one there is no such button, so the words do not name it.
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
});

describe("the tab's markup", () => {
  test("a streamed answer goes through the Ask tab's markdown function; user text is escaped", () => {
    const t = newTurn("t1", "Is <b>this</b> right?", { ...passage, selection: "a <script> passage" });
    applyDiscussFrame(t, "turn", { turnId: "id", seq: 1 });
    applyDiscussFrame(t, "delta", { text: "**Yes**, see `src/route.ts`." });
    const html = discussTurnHtml(t);
    expect(html).toContain(renderStreamingBody("**Yes**, see `src/route.ts`."));
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
    // The finished turn's own state changed: it is redrawn.
    t1.passageGone = true;
    patchDiscussTurns(list, d);
    expect(list.querySelector('[data-turn-key="t1"]')).not.toBe(first);
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

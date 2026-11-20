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
import * as discussState from "./wiki-discuss-state.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";
import { formatWebHtml } from "../../../web/web-format.ts";
import { DISCUSS_TEXT_SKIP, discussContext } from "./wiki-discuss-text.ts";

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
    expect(again.reload).toBe(true);
    // The server does not answer at all: unknown, and a way to find out.
    const down = discussState.editAfterLostApply(preview, { ok: false, status: 0, body: null });
    expect(down.edit.message).toContain("unknown");
    expect(down.edit.retry).toBe("lost");
    expect(down.edit.preview).toBeNull();
    for (const r of [applied, again, down]) expect(r.edit.message ?? "").not.toContain("nothing was written");
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

describe("«Change the wording» and the reader's draft", () => {
  test("an empty box gets the prompt; a draft is kept after it; the prompt is not added twice", () => {
    const P = discussState.DISCUSS_REWORD_PROMPT;
    expect(discussState.rewordDraft("")).toBe(P);
    expect(discussState.rewordDraft("   ")).toBe(P);
    expect(discussState.rewordDraft("shorter, please")).toBe(`${P}shorter, please`);
    expect(discussState.rewordDraft(`${P}shorter`)).toBe(`${P}shorter`);
  });
});

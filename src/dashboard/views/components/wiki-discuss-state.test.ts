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
  discussRefusalMessage,
  discussTurnHtml,
  discussTurnsHtml,
  findPassage,
  newTurn,
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
  test("both ends present but far apart is not the passage: the page grew text inside it", () => {
    const head = "The summer route adds a stop at Example Island on every weekday morning";
    const tail = "and the night ferry keeps its old timetable through the whole winter season";
    const filler = Array.from({ length: 20 }, (_, k) => `Inserted sentence ${k} about something else entirely.`).join(" ");
    const a = article(`<p>${head} ${filler} ${tail}</p>`);
    expect(findPassage(a, `${head} ${tail}`)).toBeNull();
    expect(findPassage(article(`<p>${head} ${tail}</p>`), `${head} ${tail}`)).not.toBeNull();
  });
});

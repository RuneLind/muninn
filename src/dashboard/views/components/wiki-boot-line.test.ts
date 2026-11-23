/**
 * The boot line's block markup (`wiki-boot-line.ts`): without peers the single
 * line it always was; with peers one escaped row per machine, this one first.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootLineChanged, bootLineHtml, bootLineView } from "./wiki-boot-line.ts";

const LOCAL = { row: "same", restart: false, text: "started from 409bfd1a (#864) on 14.11 20:58", start: { known: false, reason: "x", at: 0 }, unread: [], readAt: 0 };

describe("bootLineView / bootLineHtml", () => {
  test("no peers: the single line, unchanged markup", () => {
    const view = bootLineView(LOCAL)!;
    expect(view.rows).toBeNull();
    expect(bootLineHtml(view)).toBe(
      `<div class="wiki-boot-line" data-boot-row="same" title="What this muninn started from, and what moved in its checkout since">started from 409bfd1a (#864) on 14.11 20:58</div>`,
    );
    expect(bootLineHtml(bootLineView({ ...LOCAL, row: "newer", restart: true }))).toStartWith(`<div class="wiki-boot-line restart" data-boot-row="newer"`);
  });

  test("peers: this machine first with its prefix, then each peer; restart and no answer marked", () => {
    const view = bootLineView({
      ...LOCAL,
      machine: "laptop",
      peers: [
        { machine: "mini", answered: true, row: "newer", restart: true, text: "started from aaaaaaaa · the checkout holds 1 newer PR: #870: restart" },
        { machine: "old", answered: false, why: "the peer answered HTTP 404" },
      ],
    })!;
    expect(view.rows!.map((r) => r.text)).toEqual(["laptop: started from 409bfd1a (#864) on 14.11 20:58", "mini: started from aaaaaaaa · the checkout holds 1 newer PR: #870: restart", "old: no answer"]);
    const html = bootLineHtml(view);
    // The outer block never takes the restart colour when it holds rows: each row carries its own.
    expect(html).toStartWith(`<div class="wiki-boot-line" data-boot-row="same" data-boot-key="`);
    expect(html).toContain(`<div class="wiki-boot-row" data-boot-machine="laptop" data-boot-row="same" title="What this muninn started from, and what moved in its checkout since">laptop: `);
    expect(html).toContain(`<div class="wiki-boot-row restart" data-boot-machine="mini" data-boot-row="newer" title="What mini&#39;s muninn started from, as it answered just now">mini: `);
    expect(html).toContain(`<div class="wiki-boot-row muted" data-boot-machine="old" title="the peer answered HTTP 404">old: no answer</div>`);
    expect(html.indexOf("laptop: ")).toBeLessThan(html.indexOf("mini: "));
  });

  test("everything a peer sent is escaped: text, machine, row, why", () => {
    const html = bootLineHtml(
      bootLineView({
        ...LOCAL,
        machine: "laptop",
        peers: [
          { machine: 'm"><img src=x>', answered: true, row: '"><b>', restart: false, text: "/Users/x/<script>alert(1)</script>" },
          { machine: "z", answered: false, why: '"><img onerror=1>' },
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("/Users/x/&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a malformed peer entry: no machine is skipped, a half answer reads no answer", () => {
    const view = bootLineView({ ...LOCAL, machine: "laptop", peers: [null, { answered: true }, { machine: "half", answered: true, text: 5 }] })!;
    expect(view.rows!.map((r) => [r.text, r.muted])).toEqual([["laptop: started from 409bfd1a (#864) on 14.11 20:58", false], ["half: no answer", true]]);
  });

  test("not a line: null", () => {
    expect(bootLineView(null)).toBeNull();
    expect(bootLineView({ error: "x" })).toBeNull();
  });
});

describe("bootLineChanged", () => {
  const withPeers = (peers: unknown[]) => bootLineView({ ...LOCAL, machine: "laptop", peers })!;
  /** A card (a happy-dom `Window` of the test's own, no globals) whose last child is `view`'s block. */
  const cardWith = (html: string) => {
    const card = new Window().document.createElement("div");
    card.innerHTML = `<p>card</p>${html}`;
    return card as unknown as Element;
  };
  const down = (why: string) => ({ machine: "mini", answered: false, why });

  test("a changed reason alone leaves the block in place and updates its row's title", () => {
    const card = cardWith(bootLineHtml(withPeers([down("the peer timed out")])));
    const block = card.lastElementChild;
    const next = withPeers([down('the peer was unreachable a moment ago (timed out) "<b>"')]);
    expect(bootLineChanged(card, next)).toBe(false);
    expect(card.lastElementChild).toBe(block);
    const row = card.querySelector('[data-boot-machine="mini"]')!;
    expect(row.getAttribute("title")).toBe('the peer was unreachable a moment ago (timed out) "<b>"');
    expect(row.querySelector("b")).toBeNull();
    // A reason dropped: the title goes with it.
    expect(bootLineChanged(card, withPeers([{ machine: "mini", answered: false }]))).toBe(false);
    expect(row.hasAttribute("title")).toBe(false);
  });

  const LOCAL_TITLE = "What this muninn started from, and what moved in its checkout since";
  const titleOf = (card: Element, machine: string) => card.querySelector(`[data-boot-machine="${machine}"]`)!.getAttribute("title");
  /** What `placeBootLine` does with the current line, for a view the test holds. */
  const place = (card: Element, view: ReturnType<typeof withPeers>) => {
    card.querySelector(":scope > .wiki-boot-line")?.remove();
    card.insertAdjacentHTML("beforeend", bootLineHtml(view));
  };
  const answered = { machine: "mini", answered: true, row: "same", restart: false, text: "started from aaaaaaaa" };

  test("each row's tooltip is its own: the local row says this muninn, an answered peer names its machine", () => {
    const card = cardWith(bootLineHtml(withPeers([answered])));
    expect(titleOf(card, "laptop")).toBe(LOCAL_TITLE);
    expect(titleOf(card, "mini")).toBe("What mini's muninn started from, as it answered just now");
    // No row inherits the block's tooltip: the block carries none when it holds rows.
    expect(card.querySelector(":scope > .wiki-boot-line")!.hasAttribute("title")).toBe(false);
  });

  test("a peer going failed → answered → failed ends each step with the right title; an unchanged view keeps the block", () => {
    const card = cardWith(bootLineHtml(withPeers([down("the peer timed out")])));
    expect(titleOf(card, "mini")).toBe("the peer timed out");
    const up = withPeers([answered]);
    expect(bootLineChanged(card, up)).toBe(true);
    place(card, up);
    expect(titleOf(card, "mini")).toBe("What mini's muninn started from, as it answered just now");
    const block = card.lastElementChild;
    expect(bootLineChanged(card, up)).toBe(false);
    expect(card.lastElementChild).toBe(block);
    expect(titleOf(card, "mini")).toBe("What mini's muninn started from, as it answered just now");
    expect(titleOf(card, "laptop")).toBe(LOCAL_TITLE);
    const again = withPeers([down("the peer answered HTTP 500")]);
    expect(bootLineChanged(card, again)).toBe(true);
    place(card, again);
    expect(titleOf(card, "mini")).toBe("the peer answered HTTP 500");
    // A reason change alone syncs in place and never touches the local row's title.
    expect(bootLineChanged(card, withPeers([down("the peer was unreachable a moment ago (answered HTTP 500)")]))).toBe(false);
    expect(titleOf(card, "mini")).toBe("the peer was unreachable a moment ago (answered HTTP 500)");
    expect(titleOf(card, "laptop")).toBe(LOCAL_TITLE);
  });

  test('a machine name with "<>& stays text in the row and in its title', () => {
    const name = `m"<b>&amp;`;
    const card = cardWith(bootLineHtml(withPeers([{ ...answered, machine: name }])));
    const row = card.querySelectorAll(":scope > .wiki-boot-line > .wiki-boot-row")[1]!;
    expect(row.querySelector("b")).toBeNull();
    expect(row.getAttribute("data-boot-machine")).toBe(name);
    expect(row.getAttribute("title")).toBe(`What ${name}'s muninn started from, as it answered just now`);
    expect(row.textContent).toBe(`${name}: started from aaaaaaaa`);
  });

  test("a visible change replaces the block: a peer answering, a peer added", () => {
    const card = cardWith(bootLineHtml(withPeers([down("the peer timed out")])));
    expect(bootLineChanged(card, withPeers([{ machine: "mini", answered: true, row: "same", restart: false, text: "started from aaaaaaaa" }]))).toBe(true);
    expect(bootLineChanged(card, withPeers([down("the peer timed out"), down("x")]))).toBe(true);
    expect(bootLineChanged(card, withPeers([down("the peer timed out")]))).toBe(false);
  });
});

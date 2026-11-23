/**
 * The Stale check's edit placement (PR 3): every refusal the edit-validation
 * rule names, on synthetic pages only. Apply, Send's redraft and Accept's
 * preflight all place an edit through `placeStaleEdit`.
 */
import { describe, expect, test } from "bun:test";
import {
  applyStaleEdits,
  oldOnLineRefusal,
  placeStaleEdit,
  STALE_FIX_BAD_TEXT,
  STALE_FIX_CUTS_CODE,
  STALE_FIX_CUTS_LINK,
  STALE_FIX_HOME_DROPS_LINK,
  STALE_FIX_NOT_IN_PASSAGE,
  STALE_FIX_NOT_ON_LINE,
  staleFixRows,
  type StaleFixEdit,
} from "./stale-fix.ts";
import * as fix from "./stale-fix.ts";
import type { WikiPageMeta } from "./store.ts";

const PAGES: Record<string, string> = { hub: "hub.md", p: "plans/p.md", other: "notes/other.md" };
const index = { resolve: (t: string) => (PAGES[t] ? ({ relPath: PAGES[t] } as WikiPageMeta) : undefined) };
const page = (body: string) => `---\ntitle: Note\n---\n\n${body}\n`;
const passage = (old: string, text: string, over: Partial<StaleFixEdit> = {}): StaleFixEdit => ({ kind: "passage", page: "notes/a.md", link: "hub.md", old, text, variant: "new", ...over });

describe("placeStaleEdit — a passage edit", () => {
  test("replaces old once on the line the passage row names", () => {
    const content = page("Intro.\n\nThe pin in [[hub]] landed on 23.05.");
    const r = placeStaleEdit(content, passage("landed on 23.05", "landed on 18.06"), index);
    expect(r).toEqual({ ok: true, content: page("Intro.\n\nThe pin in [[hub]] landed on 18.06."), line: 7 });
  });

  test("a line shift between the draft and the apply still lands on the right line", () => {
    // The draft saw the claim on line 5; two lines were added above since.
    const shifted = page("New first line.\nAnother one.\n\nThe pin in [[hub]] landed on 23.05.");
    const r = placeStaleEdit(shifted, passage("landed on 23.05", "landed on 18.06"), index);
    expect(r.ok && r.line).toBe(8);
    expect(r.ok && r.content).toContain("[[hub]] landed on 18.06.");
    expect(r.ok && r.content).toContain("New first line.\nAnother one.");
  });

  test("an old that occurs twice across the passage is refused, even on two lines", () => {
    const content = page("The pin in [[hub]] is in-flight.\n\nThe lock in [[hub]] is in-flight.");
    expect(placeStaleEdit(content, passage("is in-flight", "shipped"), index)).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });

  test("an old no longer in the passage is refused", () => {
    const content = page("The pin in [[hub]] landed on 18.06.");
    expect(placeStaleEdit(content, passage("landed on 23.05", "x"), index)).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });

  test("an old that cuts a wikilink or a markdown link is refused", () => {
    const content = page("The pin in [[hub]] landed on 23.05. See [the hub](../hub.md) today.");
    expect(placeStaleEdit(content, passage("hub]] landed", "hub]] was landed"), index)).toEqual({ ok: false, reason: STALE_FIX_CUTS_LINK });
    expect(placeStaleEdit(content, passage("hub](../hub.md) today", "hub today"), index)).toEqual({ ok: false, reason: STALE_FIX_CUTS_LINK });
  });

  test("an old that cuts a code span is refused", () => {
    const content = page("The pin in [[hub]] landed on 23.05 behind `flag on` now.");
    expect(placeStaleEdit(content, passage("23.05 behind `flag", "18.06 behind `flag"), index)).toEqual({ ok: false, reason: STALE_FIX_CUTS_CODE });
  });

  test("two stray backticks in old cannot mask the live link it cuts: links come off the full line", () => {
    // Re-parsed alone, «a` [[hub]] `b … in-fli» masks the link as code; on the
    // full line the backticks pair differently and the link is live.
    const line = "x`a` [[hub]] `b c` is in-flight";
    const old = "` [[hub]] `b c` is in-fli";
    expect(oldOnLineRefusal(line, old)).not.toBeNull();
    const content = page(`See ${line}.`);
    const r = placeStaleEdit(content, passage(old, "shipped"), index);
    expect(r.ok).toBe(false);
  });

  test("an old twice on its full line is refused even when the window holds it once", () => {
    // A long line is a window: the second «landed on 23.05» lies outside it.
    const pad = "word ".repeat(90);
    const line = `The pin in [[hub]] landed on 23.05 and ${pad} later it landed on 23.05 again.`;
    const content = page(line);
    const r = placeStaleEdit(content, passage("landed on 23.05", "landed on 18.06"), index);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([STALE_FIX_NOT_IN_PASSAGE, STALE_FIX_NOT_ON_LINE]).toContain(r.reason);
  });

  test("a replacement over 400 characters, with a line break, or equal to old is refused", () => {
    const content = page("The pin in [[hub]] landed on 23.05.");
    expect(placeStaleEdit(content, passage("landed on 23.05", "x".repeat(401)), index)).toEqual({ ok: false, reason: STALE_FIX_BAD_TEXT });
    expect(placeStaleEdit(content, passage("landed on 23.05", "a\nb"), index)).toEqual({ ok: false, reason: STALE_FIX_BAD_TEXT });
    expect(placeStaleEdit(content, passage("landed on 23.05", "landed on 23.05"), index)).toEqual({ ok: false, reason: STALE_FIX_BAD_TEXT });
  });

  test("a point-to-the-home text must keep every link old holds, read off the full line", () => {
    const content = page("Status: [[hub]] landed on 23.05, see [[other]].");
    const old = "[[hub]] landed on 23.05";
    expect(placeStaleEdit(content, passage(old, "the hub", { variant: "home" }), index)).toEqual({ ok: false, reason: STALE_FIX_HOME_DROPS_LINK });
    const ok = placeStaleEdit(content, passage(old, "[[hub]]", { variant: "home" }), index);
    expect(ok.ok && ok.content).toContain("Status: [[hub]], see [[other]].");
    // The update variant may not drop the link either (fix round 1 batch 5).
    expect(placeStaleEdit(content, passage(old, "the hub landed on 18.06"), index)).toEqual({ ok: false, reason: fix.STALE_FIX_DROPS_LINK! });
  });

  test("CRLF stays on the line it writes", () => {
    const content = "---\r\ntitle: Note\r\n---\r\n\r\nThe pin in [[hub]] landed on 23.05.\r\n";
    const r = placeStaleEdit(content, passage("landed on 23.05", "landed on 18.06"), index);
    expect(r.ok && r.content).toBe("---\r\ntitle: Note\r\n---\r\n\r\nThe pin in [[hub]] landed on 18.06.\r\n");
  });
});

describe("placeStaleEdit — a status-line edit", () => {
  const status = (old: string, text: string): StaleFixEdit => ({ kind: "status-line", page: "hub.md", link: "plans/p.md", old, text, variant: "new" });

  test("places on the candidate line for its target", () => {
    const content = page("Intro.\n- [[p]] is in-flight, two PRs open\n- [[other]] is in-flight");
    const r = placeStaleEdit(content, status("is in-flight, two PRs open", "is shipped"), index);
    expect(r).toEqual({ ok: true, content: page("Intro.\n- [[p]] is shipped\n- [[other]] is in-flight"), line: 6 });
  });

  test("text on a line that is not a hit for the target does not place", () => {
    const content = page("- [[other]] is in-flight, two PRs open");
    expect(placeStaleEdit(content, status("is in-flight, two PRs open", "is shipped"), index)).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });
});

describe("applyStaleEdits", () => {
  test("places in order and drops what no longer places, with its reason", () => {
    const content = page("The pin in [[hub]] landed on 23.05.\n\nThe lock in [[hub]] is open PR.");
    const r = applyStaleEdits(content, [passage("landed on 23.05", "landed on 18.06"), passage("gone text", "x"), passage("is open PR", "is merged")], index);
    expect(r.applied.map((e) => e.old)).toEqual(["landed on 23.05", "is open PR"]);
    expect(r.dropped).toEqual([{ edit: passage("gone text", "x"), reason: STALE_FIX_NOT_IN_PASSAGE }]);
    expect(r.content).toBe(page("The pin in [[hub]] landed on 18.06.\n\nThe lock in [[hub]] is merged."));
  });
});

describe("placeStaleEdit — a blank old", () => {
  test("an empty old is refused, not counted forever", () => {
    // Unguarded, `indexOf("", len + 1)` returns `len` and the count loop never ends.
    expect(placeStaleEdit(page("The pin in [[hub]] landed on 23.05."), passage("", "x"), index)).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });

  test("a whitespace-only old is refused, even where it would place once", () => {
    expect(placeStaleEdit(page("[[hub]] landed"), passage(" ", "_"), index)).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });
});

// ── Fix round 1 batch 5: placement safety ───────────────────────────────────
// The new reason constants are read through the namespace so a missing one is
// `undefined`, not a link error: each test first asserts the edit does not
// place, which is the behaviour the finding claims.

describe("placeStaleEdit — only text the model was shown is replaced (the ` … ` join)", () => {
  test("old ending in the space the join adds does not place on a gap spot the window never showed", () => {
    // The left piece ends «…worzeta» + the join's « », so «zeta » occurs once
    // in the pieces, but on the line it occurs only inside the gap.
    const line = `${("The pin in [[hub]] " + "word ".repeat(40)).slice(0, 187)}zetaq ${"fill ".repeat(30)}zeta ${"more ".repeat(50)}and it landed on 23.05 now.`;
    const content = page(line);
    const [row] = staleFixRows(content, passage("x", "y"), index);
    expect(row!.text).toContain("zeta … ");
    const r = placeStaleEdit(content, passage("zeta ", "ZETA "), index);
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });

  test("old starting with the join's space does not place on a gap spot either", () => {
    const tail = ("more ".repeat(60) + "it landed on 23.05").slice(-175);
    const line = `The pin in [[hub]] ${"word ".repeat(40)}fill omega fill ${"fill ".repeat(30)}Xomega${tail} now.`;
    const content = page(line);
    const [row] = staleFixRows(content, passage("x", "y"), index);
    expect(row!.text).toContain(" … omega");
    const r = placeStaleEdit(content, passage(" omega", " OMEGA"), index);
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, reason: STALE_FIX_NOT_IN_PASSAGE });
  });

  test("text inside a piece of a gapped window still places", () => {
    const line = `The pin in [[hub]] ${"word ".repeat(40)}fill ${"fill ".repeat(30)}${"more ".repeat(50)}and it landed on 23.05 now.`;
    const r = placeStaleEdit(page(line), passage("landed on 23.05", "landed on 18.06"), index);
    expect(r.ok && r.content).toContain("it landed on 18.06 now.");
  });
});

describe("placeStaleEdit — the replacement text is checked", () => {
  const LINE = "The pin in [[hub]] landed on 23.05.";
  const refuse = (content: string, edit: StaleFixEdit, reason: string | undefined) => {
    const r = placeStaleEdit(content, edit, index);
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, reason: reason! });
  };

  test("a replacement that adds a link of any kind is refused", () => {
    for (const text of [
      "landed, see [[other]]",
      "landed [here](https://e.com)",
      "landed <https://e.com/x>",
      "landed, see https://e.com/x",
      "landed, see www.e.com",
      "landed per [the doc][ref]",
      "landed per [ref]",
      "landed per [ref][]",
    ]) refuse(page(LINE), passage("landed on 23.05", text), fix.STALE_FIX_ADDS_LINK);
    // A `[` that pairs with a `]` later on the line makes a link outside the text.
    refuse(page("The pin in [[hub]] landed on 23.05 and x] here."), passage("landed on 23.05", "landed [on 18.06"), fix.STALE_FIX_ADDS_LINK);
    // home too: it may keep the links old holds, never add one.
    refuse(page(LINE), passage("[[hub]] landed on 23.05", "[[hub]], see [[other]]", { variant: "home" }), fix.STALE_FIX_ADDS_LINK);
  });

  test("an update text that drops a link old holds is refused, like a home text", () => {
    const content = page("Status: [[hub]] landed on 23.05, see [[other]].");
    refuse(content, passage("[[hub]] landed on 23.05", "the hub landed on 18.06"), fix.STALE_FIX_DROPS_LINK);
    const ok = placeStaleEdit(content, passage("[[hub]] landed on 23.05", "[[hub]] landed on 18.06"), index);
    expect(ok.ok && ok.content).toContain("Status: [[hub]] landed on 18.06, see [[other]].");
  });

  test("a replacement that adds an HTML or JSX tag or an HTML comment is refused", () => {
    for (const text of ["landed <b>18.06</b>", "landed <Callout>", "landed </div>", "landed <!-- 18.06", "landed <br/>"]) {
      refuse(page(LINE), passage("landed on 23.05", text), fix.STALE_FIX_TEXT_TAG);
    }
  });

  test("an MDX expression brace is refused on an .mdx page, kept on a .md page", () => {
    refuse(page(LINE), passage("landed on 23.05", "landed on {date}", { page: "notes/a.mdx" }), fix.STALE_FIX_TEXT_MDX_EXPR);
    refuse(page(LINE), passage("landed on 23.05", "landed on 18.06 }", { page: "notes/a.mdx" }), fix.STALE_FIX_TEXT_MDX_EXPR);
    expect(placeStaleEdit(page(LINE), passage("landed on 23.05", "landed on {18.06}"), index).ok).toBe(true);
    // On an .mdx page any `<` may open JSX.
    refuse(page(LINE), passage("landed on 23.05", "landed in < 2 days", { page: "notes/a.mdx" }), fix.STALE_FIX_TEXT_TAG);
    expect(placeStaleEdit(page(LINE), passage("landed on 23.05", "landed in < 2 days"), index).ok).toBe(true);
    // Inside a code span the brace is not an expression.
    expect(placeStaleEdit(page(LINE), passage("landed on 23.05", "landed on `{x}`", { page: "notes/a.mdx" }), index).ok).toBe(true);
  });

  test("a replacement that changes how its line starts (a fence, heading, quote) is refused", () => {
    const content = page("Landed on 23.05 per [[hub]].");
    for (const text of ["```js", "~~~", "# Landed", "> Landed"]) refuse(content, passage("Landed on 23.05", text), fix.STALE_FIX_TEXT_BLOCK);
    // On a table row a `|` is a cell border.
    refuse(page("| [[hub]] | landed on 23.05 |"), passage("landed on 23.05", "landed | 18.06"), fix.STALE_FIX_TEXT_BLOCK);
    expect(placeStaleEdit(page("| [[hub]] | landed on 23.05 |"), passage("landed on 23.05", "landed on 18.06"), index).ok).toBe(true);
    expect(placeStaleEdit(content, passage("Landed on 23.05", "Landed on 18.06"), index).ok).toBe(true);
  });

  test("a stray backtick that would pair with one later on the line is refused", () => {
    const content = page("The pin in [[hub]] landed on 23.05, see [[other]] ` here.");
    refuse(content, passage("landed on 23.05", "landed `on 18.06"), fix.STALE_FIX_TEXT_CODE);
    // A whole code span swapped for a whole code span keeps the pairing.
    const code = page("The pin in [[hub]] is `v1.2` now.");
    expect(placeStaleEdit(code, passage("is `v1.2` now", "is `v1.3` now"), index).ok).toBe(true);
  });

  test("an edit on a front-matter line that breaks the YAML or adds a key is refused", () => {
    const fm = "---\ntitle: Note\nnote: see [[hub]] landed on 23.05\n---\n\nBody.\n";
    refuse(fm, passage("landed on 23.05", "landed: 18.06"), fix.STALE_FIX_FRONTMATTER);
    refuse(fm, passage("landed on 23.05", "landed on 18.06 # shipped"), fix.STALE_FIX_FRONTMATTER);
    // A value that now starts with `[` is a flow sequence: the YAML breaks.
    refuse(fm, passage("see [[hub]] landed on 23.05", "[[hub]] landed on 18.06"), fix.STALE_FIX_FRONTMATTER);
    // Front matter that does not parse already cannot be shown to stay whole.
    refuse(fm.replace("---\n\nBody", 'other: "unclosed\n---\n\nBody'), passage("landed on 23.05", "landed on 18.06"), fix.STALE_FIX_FRONTMATTER);
    const ok = placeStaleEdit(fm, passage("landed on 23.05", "landed on 18.06"), index);
    expect(ok.ok && ok.content).toBe("---\ntitle: Note\nnote: see [[hub]] landed on 18.06\n---\n\nBody.\n");
  });
});

describe("placeStaleEdit — old may not cut other inline constructs", () => {
  const refuse = (line: string, old: string, reason: string | undefined) => {
    const r = placeStaleEdit(page(line), passage(old, "X"), index);
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, reason: reason! });
  };

  test("an autolink or a bare URL", () => {
    refuse("The pin in [[hub]] landed on 23.05 at <https://e.com/a> today.", "e.com/a> today", STALE_FIX_CUTS_LINK);
    refuse("The pin in [[hub]] landed on 23.05 at <https://e.com/a> today.", "e.com/a", STALE_FIX_CUTS_LINK);
    refuse("The pin in [[hub]] landed on 23.05 at https://e.com/a/b today.", "a/b today", STALE_FIX_CUTS_LINK);
    // An email autolink: no bare URL, and a link rather than a tag.
    refuse("The pin in [[hub]] landed on 23.05 at <ops@e.com> today.", "e.com> today", STALE_FIX_CUTS_LINK);
  });

  test("a reference link or a reference definition", () => {
    refuse("The pin in [[hub]] landed on 23.05 per [the doc][ref] today.", "doc][ref] today", STALE_FIX_CUTS_LINK);
    refuse("The pin in [[hub]] landed on 23.05 per [the doc][ref] today.", "doc", STALE_FIX_CUTS_LINK);
    // Its first half alone would leave «X[ref]», a shortcut reference.
    refuse("The pin in [[hub]] landed on 23.05 per [the doc][ref] today.", "per [the doc]", STALE_FIX_CUTS_LINK);
    refuse("The pin in [[hub]] landed on 23.05 per [the doc] today.", "doc] today", STALE_FIX_CUTS_LINK);
    refuse('[ref]: https://e.com "[[hub]] landed on 23.05"', "landed on 23.05", STALE_FIX_CUTS_LINK);
  });

  test("an HTML or MDX tag", () => {
    refuse('The pin in [[hub]] <span title="landed on 23.05">x</span> now.', "landed on 23.05", fix.STALE_FIX_CUTS_TAG);
    refuse('The pin in [[hub]] <span title="x">landed on 23.05</span> now.', "23.05</span> now", fix.STALE_FIX_CUTS_TAG);
    refuse("The pin in [[hub]] <Pill tone=\"ok\" /> landed on 23.05.", "ok\" /> landed", fix.STALE_FIX_CUTS_TAG);
    // A comment runs to its `-->`, past a `>` inside it.
    refuse("The pin in [[hub]] <!-- landed > on 23.05 --> now.", "on 23.05", fix.STALE_FIX_CUTS_TAG);
  });

  test("emphasis: cutting a delimiter is refused, text inside or the whole span is not", () => {
    refuse("The pin in [[hub]] **landed on 23.05** now.", "23.05** now", fix.STALE_FIX_CUTS_EMPHASIS);
    refuse("The pin in [[hub]] *landed on 23.05* now.", "on 23.05* now", fix.STALE_FIX_CUTS_EMPHASIS);
    refuse("The pin in [[hub]] _landed on 23.05_ now.", "_landed on", fix.STALE_FIX_CUTS_EMPHASIS);
    refuse("The pin in [[hub]] __landed on 23.05__ now.", "23.05__ now", fix.STALE_FIX_CUTS_EMPHASIS);
    refuse("The pin in [[hub]] ~~landed on 23.05~~ now.", "landed on 23.05~~", fix.STALE_FIX_CUTS_EMPHASIS);
    const inside = placeStaleEdit(page("The pin in [[hub]] **landed on 23.05** now."), passage("landed on 23.05", "landed on 18.06"), index);
    expect(inside.ok && inside.content).toContain("**landed on 18.06** now.");
    const whole = placeStaleEdit(page("The pin in [[hub]] **landed on 23.05** now."), passage("**landed on 23.05**", "landed on 18.06"), index);
    expect(whole.ok && whole.content).toContain("[[hub]] landed on 18.06 now.");
    // snake_case is not emphasis.
    expect(placeStaleEdit(page("The pin in [[hub]] set my_flag_name on 23.05."), passage("flag_name on 23.05", "flag_name on 18.06"), index).ok).toBe(true);
  });
});

// Fix round 2 batch 2: placement is total — a check that fails to parse or
// convert refuses, never throws out of Apply, Send or Accept's preflight.
describe("placeStaleEdit — never throws (R2B2-1)", () => {
  const fm = '---\ntitle: Note\nrel: {a: "[[hub]]", b: landed on 23.05}\n---\n\nBody.\n';

  test("an unresolved YAML alias on a front-matter line is a front-matter refusal", () => {
    expect(placeStaleEdit(fm, passage("landed on 23.05", "*nope"), index)).toEqual({ ok: false, reason: fix.STALE_FIX_FRONTMATTER });
    const r = applyStaleEdits(fm, [passage("landed on 23.05", "*nope")], index);
    expect(r.dropped.map((d) => d.reason)).toEqual([fix.STALE_FIX_FRONTMATTER]);
    expect(r.content).toBe(fm);
  });

  test("a key added to a flow mapping is refused by the verbatim-value rule", () => {
    // `b: landed, c: 1}` parses: no YAML error, but no value holds the text.
    expect(placeStaleEdit(fm, passage("landed on 23.05", "landed, c: 1"), index)).toEqual({ ok: false, reason: fix.STALE_FIX_FRONTMATTER });
    const ok = placeStaleEdit(fm, passage("landed on 23.05", "landed on 18.06"), index);
    expect(ok.ok && ok.content).toContain("b: landed on 18.06}");
  });

  test("a malformed stored edit refuses as unchecked", () => {
    const content = page("The pin in [[hub]] landed on 23.05.");
    const bad = { ...passage("landed on 23.05", "x"), old: null } as unknown as StaleFixEdit;
    expect(placeStaleEdit(content, bad, index)).toEqual({ ok: false, reason: fix.STALE_FIX_UNCHECKED });
    const noText = { old: "landed on 23.05", text: null, variant: "new", page: "notes/a.md" } as unknown as StaleFixEdit;
    expect(fix.staleEditOnLine("The pin in [[hub]] landed on 23.05.", noText)).toEqual({ ok: false, reason: fix.STALE_FIX_UNCHECKED });
  });
});

// Fix round 2 batch 2: each rule below is pinned by a line where it alone
// decides the outcome.
describe("placeStaleEdit — the placement rules, one pin each (R2B2-3)", () => {
  const refuse = (content: string, edit: StaleFixEdit, reason: string) => expect(placeStaleEdit(content, edit, index)).toEqual({ ok: false, reason });
  const places = (content: string, edit: StaleFixEdit) => expect(placeStaleEdit(content, edit, index).ok).toBe(true);

  test("a URL inside a markdown link is that link, not a bare URL running past it", () => {
    places(page("The pin in [[hub]] per [doc](https://e.com/x),landed on 23.05."), passage("landed on 23.05", "landed on 18.06"));
  });

  test("an unclosed tag runs to the line's end", () => {
    refuse(page('The pin in [[hub]] <span title="landed on 23.05'), passage("landed on 23.05", "landed on 18.06"), fix.STALE_FIX_CUTS_TAG);
    refuse(page("The pin in [[hub]] <?x landed on 23.05"), passage("landed on 23.05", "landed on 18.06"), fix.STALE_FIX_CUTS_TAG);
  });

  test("a self-closing tag opens no element", () => {
    places(page("The pin in [[hub]] <Pill /> landed on 23.05 </Pill> now."), passage("<Pill /> landed on 23.05", "landed on 18.06"));
  });

  test("a link the replacement keeps is no tag or brace, even an autolink", () => {
    const line = "The pin in [[hub]] landed on 23.05 at <https://e.com/a>.";
    places(page(line), passage("landed on 23.05 at <https://e.com/a>", "landed on 18.06 at <https://e.com/a>"));
    places(page(line), passage("landed on 23.05 at <https://e.com/a>", "landed on 18.06 at <https://e.com/a>", { page: "notes/a.mdx" }));
  });

  test("a link next to the replacement keeps its place, not only the line's link count", () => {
    // `23.06https://…` is no URL (no word boundary), so `[x]` inside it
    // becomes a bracket link: one link before, one after, in another place.
    refuse(page("The pin in [[hub]] landed on 23.05 https://e.com/[x] now."), passage("on 23.05 ", "on 23.06"), fix.STALE_FIX_ADDS_LINK);
  });

  test("a `<` that opens a tag with the text after the replacement is refused", () => {
    refuse(page("The pin in [[hub]] landed on 23.05now here."), passage("landed on 23.05", "landed <"), fix.STALE_FIX_TEXT_TAG);
  });

  test("a list marker, an ordered marker or a tag at the line start stays", () => {
    refuse(page("- Landed on 23.05 per [[hub]]."), passage("- Landed on 23.05", "Landed on 18.06"), fix.STALE_FIX_TEXT_BLOCK);
    refuse(page("1. Landed on 23.05 per [[hub]]."), passage("1. Landed on 23.05", "Landed on 18.06"), fix.STALE_FIX_TEXT_BLOCK);
    refuse(page("<b>Landed</b> on 23.05 per [[hub]]."), passage("<b>Landed</b> on 23.05", "Landed on 18.06"), fix.STALE_FIX_TEXT_BLOCK);
  });

  test("front matter broken before the edit is refused, even when the edit would mend it", () => {
    const broken = "---\ntitle: Note\nnote: see [[hub]] landed: on 23.05\n---\n\nBody.\n";
    refuse(broken, passage("landed: on 23.05", "landed on 18.06"), fix.STALE_FIX_FRONTMATTER);
  });

  test("the closing fence line is front matter, the line after it is body", () => {
    const status = (old: string, text: string): StaleFixEdit => ({ kind: "status-line", page: "notes/a.md", link: "plans/p.md", old, text, variant: "new" });
    // `\n---foo …` closes the front matter; an edit there is no YAML value.
    refuse("---\ntitle: Note\n---foo [[p]] is shipped\n\nBody.\n", status("is shipped", "is in flight"), fix.STALE_FIX_FRONTMATTER);
    const body = placeStaleEdit("---\ntitle: Note\n---\n[[p]] is shipped\n", status("is shipped", "is in flight"), index);
    expect(body).toEqual({ ok: true, content: "---\ntitle: Note\n---\n[[p]] is in flight\n", line: 4 });
  });
});

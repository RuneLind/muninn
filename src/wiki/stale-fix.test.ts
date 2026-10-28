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
  type StaleFixEdit,
} from "./stale-fix.ts";
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
    // The update variant may restate the fact without the link.
    expect(placeStaleEdit(content, passage(old, "the hub landed on 18.06"), index).ok).toBe(true);
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

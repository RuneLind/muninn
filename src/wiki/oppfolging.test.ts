/**
 * The reader's «Oppfølging» block (wiki-reader-lenses PR 3, D13–D16, D30–D32):
 * role-named lanes, the compact `<details>` markup, the count line and peek,
 * and the `<Question>` cards a waiting lane holds. Chat keeps the grid.
 */
import { describe, expect, test } from "bun:test";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml, questionRenderOptionsFor } from "./render.ts";
import { laneFromAttrs, parseBlocks } from "../format/markdown-ast.ts";
import { parseRoleKeys, normalizeRoleKey, laneSumPhrase } from "../format/lane-roles.ts";
import { viewerGroupKeys } from "../format/question.ts";

const PAGE = [
  "<NextMoves>",
  "",
  '<Lane kind="you" role="utvikler">',
  "",
  "1. **Send melding 3 til fag.** Den retter en feil.",
  "2. **Opprett oppgave 2.**",
  "",
  "</Lane>",
  "",
  '<Lane kind="blocked" role="utvikler">',
  "",
  "- Person 1404 venter på oppgave 3.",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" role="fag" since="07.10.2026">',
  "",
  "- **S1** — alternativ A eller B for brevet?",
  "- **S6** — hvilket brev gjelder det egentlig nå?",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" who="Venter på jus">',
  "",
  "- Ingen svar ennå.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  '<Question id="S1" choices="A|B" to="fag">',
  "Alternativ A eller B?",
  "</Question>",
  "",
  '<Question id="S6" to="fag">',
  "Hvilket brev?",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **S1** — åpent.",
  "- **S6** — åpent.",
  "",
  "</DecisionLog>",
].join("\n");

const reader = (md: string, language: "no" | "en" = "no") =>
  renderWikiHtml(md, () => undefined, {
    question: questionRenderOptionsFor(md, { language } as never, true, "Eier (X111111)"),
    language,
  });

describe("lane labels (D15, D16)", () => {
  const lane = (attrs: Record<string, string>, lang?: "no" | "en") => laneFromAttrs(attrs, [], lang).label;
  test("a role lane's label comes from kind, role and language", () => {
    expect(lane({ kind: "waiting", role: "fag" }, "no")).toBe("Venter på fag");
    expect(lane({ kind: "you", role: "utvikler" }, "no")).toBe("Utvikler");
    expect(lane({ kind: "blocked", role: "fag" }, "no")).toBe("Blokkert");
    expect(lane({ kind: "waiting", role: "Fag" }, "en")).toBe("Waiting on fag");
    // A surface that knows no wiki (Slack, Telegram, email, chat) reads English.
    expect(lane({ kind: "you", role: "utvikler" })).toBe("Utvikler");
    expect(lane({ kind: "waiting", role: "fag" })).toBe("Waiting on fag");
  });
  test("role beats who; no role keeps who; neither keeps the default", () => {
    expect(lane({ kind: "waiting", role: "fag", who: "Venter på Kari" }, "no")).toBe("Venter på fag");
    expect(lane({ kind: "waiting", who: "Venter på fag" }, "no")).toBe("Venter på fag");
    expect(lane({ kind: "you" }, "no")).toBe("You");
    // A role= that is no key is ignored: the lane keeps its who.
    expect(laneFromAttrs({ kind: "you", role: "z990001", who: "Du" }, []).role).toBeNull();
    expect(lane({ kind: "you", role: "two words", who: "Du" })).toBe("Du");
  });
  test("roleKeys parse: keys lower-cased and deduplicated, a bad entry dropped with a warning", () => {
    expect(parseRoleKeys(["fag", "Utvikler", "fag"])).toEqual({ keys: ["fag", "utvikler"], warnings: [] });
    const bad = parseRoleKeys(["fag", "X111111", 7, "two words"]);
    expect(bad.keys).toEqual(["fag"]);
    expect(bad.warnings).toHaveLength(3);
    expect(parseRoleKeys("fag").keys).toEqual([]);
    expect(normalizeRoleKey(" Fag ")).toBe("fag");
  });
  test("the count line's phrases (D14)", () => {
    expect(laneSumPhrase({ kind: "waiting", role: "fag", label: "", count: 4, unit: "question" }, "no")).toBe("4 spørsmål til fag");
    expect(laneSumPhrase({ kind: "you", role: "utvikler", label: "", count: 5, unit: "task" }, "no")).toBe("5 oppgaver for utvikler");
    expect(laneSumPhrase({ kind: "blocked", role: null, label: "", count: 2, unit: "task" }, "no")).toBe("2 blokkert");
    expect(laneSumPhrase({ kind: "you", role: null, label: "Du", count: 1, unit: "task" }, "no")).toBe("Du: 1 oppgave");
  });
});

describe("the viewer's roles per auth mode (D30)", () => {
  const groups = new Map([
    ["fag", new Set(["X111111"])],
    ["utvikler", new Set(["X222222", "X111111"])],
  ]);
  test("a session: the groups holding its NAV ident", () => {
    expect(viewerGroupKeys({ navIdent: "x222222" }, "Eier (X111111)", groups)).toEqual(["utvikler"]);
  });
  test("auth off: the groups holding the owner's ident, only when written Name (IDENT)", () => {
    expect(viewerGroupKeys(null, "Eier (X111111)", groups)).toEqual(["fag", "utvikler"]);
    expect(viewerGroupKeys(null, "Eier", groups)).toEqual([]);
    expect(viewerGroupKeys(null, null, groups)).toEqual([]);
  });
  test("local: a session with no ident has no role", () => {
    expect(viewerGroupKeys({ navIdent: null }, "Eier (X111111)", groups)).toEqual([]);
  });
});

describe("the compact «Oppfølging» block on the reader (D13, D14)", () => {
  const html = reader(PAGE);

  test("title, count line and one <details> per lane, blocked last", () => {
    expect(html).toContain('<section class="next-moves nm-compact" data-lang="no">');
    expect(html).toContain('<div class="nm-title-row" data-reader-only><span class="nm-title" role="heading" aria-level="3">Oppfølging</span>');
    expect(html).toContain(
      '<span class="nm-sum">2 oppgaver for utvikler · 2 spørsmål til fag · Venter på jus: 1 oppgave · 1 blokkert</span>',
    );
    const kinds = [...html.matchAll(/<details class="nm-lane nm-(\w+)[^"]*" data-kind="\w+" data-count="(\d+)"/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(kinds).toEqual(["you:2", "waiting:2", "waiting:1", "blocked:1"]);
  });

  test("data-role, data-who as the role label, count with its unit, and a peek", () => {
    expect(html).toContain('data-who="Utvikler" data-role="utvikler"');
    expect(html).toContain('data-since="2026-10-07" data-who="Venter på fag" data-role="fag"');
    // A who-only lane keeps its label and has no data-role (D16).
    expect(html).toMatch(/data-count="1" data-who="Venter på jus"><summary/);
    expect(html).toContain('<span class="nm-count" data-reader-only>2 spørsmål</span>');
    expect(html).toContain('<span class="nm-count" data-reader-only>2 oppgaver</span>');
    expect(html).toContain('<span class="nm-peek" data-reader-only>S1: alternativ A eller B for brevet? · S6: hvilket brev gjelder det egentlig nå?</span>');
    expect(html).toContain('<span class="nm-peek" data-reader-only>Send melding 3 til fag.</span>');
  });

  test("a waiting lane holds the cards it names; the authored place keeps one link; one card per id", () => {
    for (const id of ["S1", "S6"]) {
      const cards = html.match(new RegExp(`<section class="question [^"]*" data-question-id="${id}"`, "g")) ?? [];
      expect(cards, id).toHaveLength(1);
      expect(html).toContain(`<div class="nm-qcard" id="nm-q-${id.toLowerCase()}"><section class="question q-open" data-question-id="${id}"`);
      expect(html).toContain(`<p class="q-moved" data-reader-only><a class="q-moved-link" href="#nm-q-${id.toLowerCase()}">Spørsmål ${id}: svar under Oppfølging</a></p>`);
    }
    // The cards sit inside the fag lane's body.
    const fagLane = html.slice(html.indexOf('data-role="fag"'), html.indexOf("</details>", html.indexOf('data-role="fag"')));
    expect(fagLane).toContain('class="nm-qcards"');
    expect(fagLane.match(/data-wiki-answerable="true"/g)).toHaveLength(2);
  });

  test("no question option (a gardener preview): the cards stay where they are written", () => {
    const plain = renderWikiHtml(PAGE, () => undefined);
    expect(plain).toContain("nm-compact");
    expect(plain).not.toContain("nm-qcard");
    expect(plain).not.toContain("q-moved");
  });

  test("a duplicated id stays in place, and only the first naming lane takes a card", () => {
    const dup = reader(`${PAGE}\n\n<Question id="S6">\nAgain\n</Question>`);
    expect(dup).not.toContain('id="nm-q-s6"');
    expect(dup).toContain('id="nm-q-s1"');
    const twice = reader(PAGE.replace("- Ingen svar ennå.", "- **S1** igjen."));
    expect(twice.match(/data-question-id="S1"/g)).toHaveLength(1);
  });

  test("English wiki: Follow-up and the English units", () => {
    const en = reader(PAGE, "en");
    expect(en).toContain(">Follow-up</span>");
    expect(en).toContain("2 tasks for utvikler · 2 questions for fag");
    expect(en).toContain(">Waiting on fag</span>");
  });
});

describe("chat keeps today's grid", () => {
  test("formatWebHtml without the reader option renders the grid, no compact block, cards in place", () => {
    const chat = formatWebHtml(PAGE);
    expect(chat).toContain('<section class="next-moves">');
    expect(chat).toContain('class="nm-grid');
    expect(chat).not.toContain("nm-compact");
    expect(chat).not.toContain("q-moved");
    // The role label reaches the grid too, in English.
    expect(chat).toContain('<span class="nm-who">Waiting on fag</span>');
  });
  test("parseBlocks keeps role= on a Lane", () => {
    const b = parseBlocks('<NextMoves>\n\n<Lane kind="you" role="fag">\n\n- x\n\n</Lane>\n\n</NextMoves>')[0]!;
    expect(b.type === "component" && b.children.find((c) => c.type === "component")?.type).toBe("component");
    const lane = b.type === "component" ? b.children.find((c) => c.type === "component") : undefined;
    expect(lane && lane.type === "component" ? lane.attrs.role : undefined).toBe("fag");
  });
});

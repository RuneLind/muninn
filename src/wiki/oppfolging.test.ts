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
    // Neither: the reader words the default in the wiki's language; elsewhere English.
    expect(lane({ kind: "you" }, "no")).toBe("Du");
    expect(lane({ kind: "you" }, "en")).toBe("You");
    expect(lane({ kind: "you" })).toBe("You");
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
    expect(laneSumPhrase({ kind: "waiting", role: "fag", label: "", counts: [{ n: 4, unit: "question" }] }, "no")).toBe("4 spørsmål til fag");
    expect(laneSumPhrase({ kind: "you", role: "utvikler", label: "", counts: [{ n: 5, unit: "task" }] }, "no")).toBe("5 oppgaver for utvikler");
    expect(laneSumPhrase({ kind: "blocked", role: null, label: "", counts: [{ n: 2, unit: "task" }] }, "no")).toBe("2 blokkert");
    expect(laneSumPhrase({ kind: "you", role: null, label: "Du", counts: [{ n: 1, unit: "task" }] }, "no")).toBe("Du: 1 oppgave");
  });
});

describe("the viewer's roles per auth mode (D30)", () => {
  const groups = new Map([
    ["fag", new Set(["X111111"])],
    ["utvikler", new Set(["X222222", "X111111"])],
  ]);
  test("a session: the groups holding its NAV ident", () => {
    expect(viewerGroupKeys("entra", { navIdent: "x222222" }, "Eier (X111111)", groups)).toEqual(["utvikler"]);
    // Authenticating with no session: nobody's roles, never the owner's.
    expect(viewerGroupKeys("entra", null, "Eier (X111111)", groups)).toEqual([]);
  });
  test("auth off: the groups holding the owner's ident, only when written Name (IDENT)", () => {
    expect(viewerGroupKeys("off", null, "Eier (X111111)", groups)).toEqual(["fag", "utvikler"]);
    expect(viewerGroupKeys("off", null, "Eier", groups)).toEqual([]);
    expect(viewerGroupKeys("off", null, null, groups)).toEqual([]);
  });
  test("local: a session with no ident has no role", () => {
    expect(viewerGroupKeys("local", { navIdent: null }, "Eier (X111111)", groups)).toEqual([]);
  });
});

/** Each waiting lane's peek chips (D38), in lane order. */
const chipsOf = (html: string) =>
  [...html.matchAll(/<span class="nm-peek nm-peek-q" data-reader-only>(.*?)<span class="nm-prog"/g)].map((m) =>
    [...m[1]!.matchAll(/<span class="nm-qid">([^<]*)<\/span>/g)].map((c) => c[1]),
  );

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
    // D38: a waiting lane naming cards peeks with their ids and a progress slot.
    expect(html).toContain(
      '<span class="nm-peek nm-peek-q" data-reader-only><span class="nm-qids"><span class="nm-qid">S1</span> <span class="nm-qid">S6</span></span>' +
        '<span class="nm-prog" data-nm-qids="[&quot;S1&quot;,&quot;S6&quot;]"></span></span>',
    );
    expect(html).toContain('<span class="nm-peek" data-reader-only>Send melding 3 til fag.</span>');
  });

  test("a waiting lane holds the cards it names; cards right after the block leave no stub; one card per id", () => {
    for (const id of ["S1", "S6"]) {
      const cards = html.match(new RegExp(`<section class="question [^"]*" data-question-id="${id}"`, "g")) ?? [];
      expect(cards, id).toHaveLength(1);
      expect(html).toContain(`<div class="nm-qcard" id="nm-q-${id.toLowerCase()}"><section class="question q-open" data-question-id="${id}"`);
    }
    // D39: only moved cards and blank lines between the block and them.
    expect(html).not.toContain("q-moved");
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

// ── Fix round 1 (#669 review) ───────────────────────────────────────────────

const nm = (lanes: string[][]) => ["<NextMoves>", "", ...lanes.flatMap((l) => [...l, ""]), "</NextMoves>"];
const lane = (attrs: string, items: string[], inner: string[] = []) => [`<Lane ${attrs}>`, "", ...items, "", ...inner, ...(inner.length ? [""] : []), "</Lane>"];
const question = (id: string) => [`<Question id="${id}" to="fag">`, "", `Spørsmål ${id}?`, "", "</Question>"];

describe("fix round 1: which lane holds a card", () => {
  for (const [name, open, close] of [
    ["Historic", '<Historic since="v1">', "</Historic>"],
    ["resolved Callout", '<Callout tone="info" title="Ferdig" resolved="2026-10-01">', "</Callout>"],
  ] as const) {
    test(`a lane inside a ${name} takes no card; the live lane does`, () => {
      const md = [
        open,
        "",
        ...nm([lane('kind="waiting" role="fag"', ["- **S1** gammelt"])]),
        "",
        close,
        "",
        ...nm([lane('kind="waiting" role="fag"', ["- **S1** nå"])]),
        "",
        ...question("S1"),
      ].join("\n");
      const html = reader(md);
      expect(html.match(/class="nm-qcard"/g)).toHaveLength(1);
      // The card sits in the second (live) block, after the settled one.
      const live = html.lastIndexOf('<section class="next-moves nm-compact"');
      expect(live).toBeGreaterThan(html.indexOf('<section class="next-moves nm-compact"'));
      expect(html.indexOf('class="nm-qcard"')).toBeGreaterThan(live);
    });
  }

  test("a card written inside the lane that names it stays there, even when a later lane names it too", () => {
    const md = nm([
      lane('kind="waiting" role="fag"', ["- **S1** her"], question("S1")),
      lane('kind="waiting" who="Venter på jus"', ["- **S1** også"]),
    ]).join("\n");
    const html = reader(md);
    expect(html).not.toContain("nm-qcard");
    expect(html).not.toContain("q-moved");
    expect(html.match(/data-question-id="S1"/g)).toHaveLength(1);
    const fag = html.slice(html.indexOf('data-role="fag"'), html.indexOf("</details>", html.indexOf('data-role="fag"')));
    expect(fag).toContain('data-question-id="S1"');
  });

  test("two ids whose anchors fold together get their own anchors, and each link points at its own card", () => {
    const md = [
      ...nm([lane('kind="waiting" role="fag"', ["- **Q.1** første", "- **Q-1** andre"])]),
      "",
      "Første tekst.",
      "",
      ...question("Q.1"),
      "",
      "Andre tekst.",
      "",
      ...question("Q-1"),
    ].join("\n");
    const html = reader(md);
    const ids = [...html.matchAll(/<div class="nm-qcard" id="([^"]+)"><section class="question [^"]*" data-question-id="([^"]+)"/g)].map((m) => `${m[2]}→${m[1]}`);
    expect(ids).toEqual(["Q.1→nm-q-q-1", "Q-1→nm-q-q-1-2"]);
    const links = [...html.matchAll(/<a class="q-moved-link" href="#([^"]+)">Spørsmål (\S+) står/g)].map((m) => `${m[2]}→${m[1]}`);
    expect(links).toEqual(["Q.1→nm-q-q-1", "Q-1→nm-q-q-1-2"]);
  });
});

describe("fix round 1: the peek", () => {
  const PAGE_META = { name: "Brevside", relPath: "concepts/Brevside.md" } as never;
  const linked = (md: string) =>
    renderWikiHtml(md, (t) => (t === "Brevside" ? PAGE_META : undefined), {
      question: questionRenderOptionsFor(md, { language: "no" } as never, true, "Eier (X111111)"),
      language: "no",
    });
  const peeks = (html: string) => [...html.matchAll(/<span class="nm-peek" data-reader-only>([^<]*)<\/span>/g)].map((m) => m[1]);

  test("a wikilink in a peek is its link text, never a link or a NUL", () => {
    const long = "x".repeat(150);
    const md = [
      ...nm([
        lane('kind="waiting" role="fag"', ["- **S1** — se [[Brevside]] for brevet?"]),
        lane('kind="you" role="utvikler"', ["- Les [[Brevside]] først."]),
        lane('kind="you" who="Du"', [`- ${long} [[Brevside]] og mer`]),
      ]),
      "",
      ...question("S1"),
    ].join("\n");
    const html = linked(md);
    expect(html).not.toContain("\x00");
    expect(html).not.toMatch(/<span class="nm-peek"[^>]*>[^<]*<a /);
    expect(chipsOf(html)).toEqual([["S1"]]);
    const p = peeks(html);
    expect(p[0]).toBe("Les Brevside først.");
    // Cut at the cap after the link text, not inside a sentinel.
    expect(p[1]).toBe(`${long} Brevside…`);
  });

  test("an id is named on its own boundary, and each id gets one chip", () => {
    const md = [
      ...nm([
        lane('kind="waiting" role="fag"', ["- **S10** — tiende? **S1** — første?", "- Sjekk PS2 og **S2** — hva gjelder?", "- **S3** og **S4** — begge?"]),
      ]),
      "",
      ...["S1", "S2", "S3", "S4", "S10"].flatMap((id) => [...question(id), ""]),
    ].join("\n");
    expect(chipsOf(reader(md))).toEqual([["S10", "S1", "S2", "S3", "S4"]]);
  });
});

describe("fix round 1: counts name their unit", () => {
  const md = [
    ...nm([lane('kind="waiting" role="fag"', ["- **S1** og **S2** — begge?", "- Purre fag på brevet."])]),
    "",
    ...question("S1"),
    "",
    ...question("S2"),
  ].join("\n");
  test("a mixed waiting lane counts questions and tasks apart", () => {
    const html = reader(md);
    expect(html).toContain('<span class="nm-count" data-reader-only>2 spørsmål og 1 oppgave</span>');
    expect(html).toContain('<span class="nm-sum">2 spørsmål og 1 oppgave til fag</span>');
    const en = reader(md, "en");
    expect(en).toContain('<span class="nm-count" data-reader-only>2 questions and 1 task</span>');
    expect(en).toContain('<span class="nm-sum">2 questions and 1 task for fag</span>');
  });
});

describe("fix round 1: a lane with no role and no who on a Norwegian wiki", () => {
  const md = nm([
    lane('kind="you"', ["- Gjør det."]),
    lane('kind="waiting" since="07.10.2026"', ["- Svar fra noen."]),
    lane('kind="blocked" since="2026-10-01"', ["- Står fast."]),
  ]).join("\n");
  test("the reader words the default label in the wiki's language, reader-only", () => {
    const html = reader(md);
    expect(html).toContain('<span class="nm-who" data-reader-only>Du</span>');
    expect(html).toContain('<span class="nm-who" data-reader-only>Venter</span>');
    expect(html).toContain('<span class="nm-sum">Du: 1 oppgave · Venter: 1 oppgave · 1 blokkert</span>');
    // The normalised date is not the source text; an ISO one is.
    expect(html).toContain('<span class="nm-since" data-since="2026-10-07" data-reader-only>2026-10-07</span>');
    expect(html).toContain('<span class="nm-since" data-since="2026-10-01">2026-10-01</span>');
    expect(reader(md, "en")).toContain('<span class="nm-who" data-reader-only>You</span>');
  });
  test("chat keeps the English default", () => {
    expect(formatWebHtml(md)).toContain('<span class="nm-who">You</span>');
  });
  test("a Lane outside NextMoves reads the wiki's language", () => {
    const html = reader(['<Lane kind="waiting" role="fag">', "", "- x", "", "</Lane>"].join("\n"));
    expect(html).toContain("<strong><span data-reader-only>Venter på fag</span></strong>");
  });
});

// ── Fix round 2 (#669 verify) ───────────────────────────────────────────────

const peeksOf = (html: string) => [...html.matchAll(/<span class="nm-peek" data-reader-only>([^<]*)<\/span>/g)].map((m) => m[1]);
const countsOf = (html: string) => [...html.matchAll(/<span class="nm-count" data-reader-only>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("fix round 2: an id inside a wikilink names no question", () => {
  for (const [name, item, peek] of [
    ["target", "- se [[S1 notat]] først", "se S1 notat først"],
    ["label", "- se [[Brevside|om S1]] først", "se om S1 først"],
  ] as const) {
    test(`in a link's ${name}: the peek, the count and the cards agree`, () => {
      const html = reader([...nm([lane('kind="waiting" role="fag"', [item])]), "", ...question("S1")].join("\n"));
      expect(countsOf(html)).toEqual(["1 oppgave"]);
      expect(peeksOf(html)).toEqual([peek]);
      expect(html).not.toContain('class="nm-qcard"');
    });
  }
  test("an id named beside a link to it is named once", () => {
    const html = reader([...nm([lane('kind="waiting" role="fag"', ["- **S1** — se [[S1 notat]] først"])]), "", ...question("S1")].join("\n"));
    expect(countsOf(html)).toEqual(["1 spørsmål"]);
    expect(chipsOf(html)).toEqual([["S1"]]);
    expect(html).toContain('<div class="nm-qcard" id="nm-q-s1">');
  });
  test("an id after a link that holds it is one chip", () => {
    const html = reader([...nm([lane('kind="waiting" role="fag"', ["- se [[S1 notat]] om **S1** først"])]), "", ...question("S1")].join("\n"));
    expect(chipsOf(html)).toEqual([["S1"]]);
  });
});

describe("fix round 2: an id is not the head of a longer one", () => {
  const page = (ids: string[], item: string) =>
    [...nm([lane('kind="waiting" role="fag"', [item])]), "", ...ids.flatMap((id) => [...question(id), ""])].join("\n");
  test("S1 is not named by S1.1", () => {
    const html = reader(page(["S1", "S1.1"], "- **S1.1** hva nå?"));
    expect(countsOf(html)).toEqual(["1 spørsmål"]);
    expect(chipsOf(html)).toEqual([["S1.1"]]);
    expect(html.match(/class="nm-qcard"/g)).toHaveLength(1);
  });
  test("S1 is not named by S1-2, nor 1 by Q-1", () => {
    for (const [ids, item, chip] of [
      [["S1", "S1-2"], "- **S1-2** hva nå?", "S1-2"],
      [["Q-1", "1"], "- **Q-1** hva nå?", "Q-1"],
    ] as const) {
      const html = reader(page([...ids], item));
      expect(countsOf(html), item).toEqual(["1 spørsmål"]);
      expect(chipsOf(html), item).toEqual([[chip]]);
      expect(html.match(/class="nm-qcard"/g), item).toHaveLength(1);
    }
  });
  test("a sentence-final id still counts", () => {
    const html = reader(page(["S1"], "- spør S1."));
    expect(countsOf(html)).toEqual(["1 spørsmål"]);
    expect(html).toContain('<div class="nm-qcard" id="nm-q-s1">');
  });
});

describe("fix round 2: a Lane outside NextMoves on the reader", () => {
  test("a derived label and a normalised since are reader-only; who= text is not", () => {
    const html = reader(['<Lane kind="waiting" role="fag" since="07.10.2026">', "", "- x", "", "</Lane>"].join("\n"));
    expect(html).toContain("<p><strong><span data-reader-only>Venter på fag</span><span data-reader-only> — since 2026-10-07</span></strong></p>");
    expect(reader(['<Lane kind="you">', "", "- x", "", "</Lane>"].join("\n"))).toContain("<strong><span data-reader-only>Du</span></strong>");
    expect(reader(['<Lane kind="you" who="Kari" since="2026-10-01">', "", "- x", "", "</Lane>"].join("\n"))).toContain(
      "<strong>Kari — since 2026-10-01</strong>",
    );
  });
  test("chat keeps the plain label line", () => {
    expect(formatWebHtml(['<Lane kind="waiting" who="Kari" since="07.10.2026">', "", "- x", "", "</Lane>"].join("\n"))).toContain(
      "<p><strong>Kari — since 2026-10-07</strong></p>",
    );
  });
});

describe("fix round 2: a NUL in a lane item", () => {
  test("never reaches the peek", () => {
    const html = reader(nm([lane('kind="you" role="utvikler"', ["- Les a\x00b først."])]).join("\n"));
    expect(peeksOf(html)).toEqual(["Les ab først."]);
  });
});

describe("fix round 2: an id inside a link's URL", () => {
  test("still gets a chip, so the peek names what the count counts", () => {
    const html = reader([...nm([lane('kind="waiting" role="fag"', ["- se [notat](https://example.com/S1) først"])]), "", ...question("S1")].join("\n"));
    expect(countsOf(html)).toEqual(["1 spørsmål"]);
    expect(chipsOf(html)).toEqual([["S1"]]);
  });
});

// ── D39: what a moved card leaves at its authored place ────────────────────

describe("D39: moved-card stubs", () => {
  const fag = (ids: string[]) => nm([lane('kind="waiting" role="fag"', ids.map((id) => `- **${id}** — hva nå?`))]);
  const stubs = (html: string) => [...html.matchAll(/<p class="q-moved" data-reader-only><a class="q-moved-link" href="#([^"]+)">([^<]*)<\/a><\/p>/g)].map((m) => `${m[1]}|${m[2]}`);
  const cards = (ids: string[]) => ids.flatMap((id) => [...question(id), ""]);

  test("four cards right after the block leave no stub, and the page keeps one card per id", () => {
    const html = reader([...fag(["S1", "S2", "S3", "S4"]), "", ...cards(["S1", "S2", "S3", "S4"])].join("\n"));
    expect(stubs(html)).toEqual([]);
    for (const id of ["S1", "S2", "S3", "S4"]) expect(html.match(new RegExp(`data-question-id="${id}"`, "g"))).toHaveLength(1);
  });

  test("a run further down leaves one line naming them all, linking to the first card", () => {
    const html = reader([...fag(["S2", "S6", "S7"]), "", "Bakgrunn.", "", ...cards(["S2", "S6", "S7"])].join("\n"));
    expect(stubs(html)).toEqual(["nm-q-s2|Spørsmål S2, S6 og S7 står under Oppfølging ↑"]);
  });

  test("a single moved card leaves a single-id line", () => {
    const html = reader([...fag(["S2"]), "", "Bakgrunn.", "", ...cards(["S2"])].join("\n"));
    expect(stubs(html)).toEqual(["nm-q-s2|Spørsmål S2 står under Oppfølging ↑"]);
  });

  test("a run interrupted by prose leaves two lines", () => {
    const md = [...fag(["S1", "S2", "S3"]), "", "Bakgrunn.", "", ...cards(["S1", "S2"]), "Mer tekst.", "", ...cards(["S3"])].join("\n");
    expect(stubs(reader(md))).toEqual([
      "nm-q-s1|Spørsmål S1 og S2 står under Oppfølging ↑",
      "nm-q-s3|Spørsmål S3 står under Oppfølging ↑",
    ]);
  });

  test("cards right after the block are silent; one past prose still leaves its line", () => {
    const md = [...fag(["S1", "S2", "S3"]), "", ...cards(["S1", "S2"]), "Tekst.", "", ...cards(["S3"])].join("\n");
    expect(stubs(reader(md))).toEqual(["nm-q-s3|Spørsmål S3 står under Oppfølging ↑"]);
  });

  test("a card written above the block points down", () => {
    const md = [...cards(["S1"]), ...fag(["S1"])].join("\n");
    expect(stubs(reader(md))).toEqual(["nm-q-s1|Spørsmål S1 står under Oppfølging ↓"]);
  });

  test("English wiki: Question … is / Questions … are under Follow-up", () => {
    const one = reader([...fag(["S2"]), "", "Text.", "", ...cards(["S2"])].join("\n"), "en");
    expect(stubs(one)).toEqual(["nm-q-s2|Question S2 is under Follow-up ↑"]);
    const many = reader([...fag(["S2", "S6", "S7"]), "", "Text.", "", ...cards(["S2", "S6", "S7"])].join("\n"), "en");
    expect(stubs(many)).toEqual(["nm-q-s2|Questions S2, S6 and S7 are under Follow-up ↑"]);
  });
});

// ── D36–D38: the compact head ──────────────────────────────────────────────

describe("D36–D38: the compact lane head", () => {
  const html = reader(PAGE);
  test("each lane carries its icon, reader-only and hidden from assistive tech", () => {
    const icons = [...html.matchAll(/<span class="nm-ico" aria-hidden="true" data-reader-only>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(icons).toEqual(["✋", "⏳", "⏳", "⛔"]);
  });
  test("each head ends with its action and the hide text", () => {
    const actions = [...html.matchAll(/<span class="nm-cta-open">([^<]*)<\/span><span class="nm-cta-close">([^<]*)<\/span>/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(actions).toEqual(["Se alle ▸/Skjul ▴", "Se spørsmålene ▸/Skjul ▴", "Se spørsmålene ▸/Skjul ▴", "Se ▸/Skjul ▴"]);
    const en = reader(PAGE, "en");
    expect(en).toContain('<span class="nm-cta-open">See questions ▸</span><span class="nm-cta-close">Hide ▴</span>');
  });
  test("a waiting lane naming no card keeps its lead-sentence peek", () => {
    expect(html).toContain('<span class="nm-peek" data-reader-only>Ingen svar ennå.</span>');
  });
});

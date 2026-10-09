import { describe, expect, test } from "bun:test";
import {
  FIRST_SENTENCE_MAX,
  SENTENCE_CANDIDATES_MAX,
  markStatePhrases,
  parseStatusRow,
  splitFirstSentence,
  statusSegments,
  visibleText,
} from "./report-top.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

// Reader lenses PR 2: `<More>`, `<StatusRows>` and a DecisionLog item's first
// sentence. Synthetic fixtures only.

describe("splitFirstSentence", () => {
  const cases: [string, string, string | null][] = [
    ["plain", "Vi velger alternativ A. Begrunnelsen følger.", "Vi velger alternativ A."],
    ["one sentence", "Vi velger A.", null],
    ["no mark at all", "Vi velger A", null],
    ["abbreviation f.eks.", "Bruk f.eks. Melosys her. Mer tekst.", "Bruk f.eks. Melosys her."],
    ["abbreviation dvs.", "Den gamle, dvs. Ny regel gjelder. Resten.", "Den gamle, dvs. Ny regel gjelder."],
    ["English e.g.", "Use a list, e.g. Foo and Bar. Then more.", "Use a list, e.g. Foo and Bar."],
    ["code span", "Sett `a. B` i config. Resten.", "Sett `a. B` i config."],
    ["link text and url", "Se [lenke. X](https://x.no/a. b) først. Resten.", "Se [lenke. X](https://x.no/a. b) først."],
    ["wikilink", "Se [[Side. Med punktum]] her. Resten.", "Se [[Side. Med punktum]] her."],
    ["bare url", "Kjør https://x.no/a. B senere. Resten.", "Kjør https://x.no/a."],
    ["bold closer", "**Beslutningen er tatt.** Begrunnelse følger.", "**Beslutningen er tatt.**"],
    ["open bold is not cut", "**Første. Andre** tredje. Fjerde.", "**Første. Andre** tredje."],
    ["ordinal", "Den 1. januar starter vi. Resten.", "Den 1. januar starter vi."],
    ["a sentence may start lower-case", "Agenten viser kortet. muninn kjører skriptet.", "Agenten viser kortet."],
    ["question mark", "Alternativ A eller B? Spurt Kari 30.09.", "Alternativ A eller B?"],
    ["ellipsis", "Vent... Så kommer det. Resten.", "Vent... Så kommer det."],
    ["date at the end", "Rune, 08.10.2026. Neste setning.", "Rune, 08.10.2026."],
    ["fact mark", '<Fact n="1" v="ok">Tallet er 41. Det stemmer</Fact> nå. Resten.', '<Fact n="1" v="ok">Tallet er 41. Det stemmer</Fact> nå.'],
    ["soft wrap", "Vi velger alternativ A.\nBegrunnelsen.", "Vi velger alternativ A."],
  ];
  for (const [name, text, first] of cases) {
    test(name, () => {
      const s = splitFirstSentence(text);
      expect(s?.first ?? null).toBe(first);
      if (s) expect(s.first + s.rest).toBe(text);
    });
  }

  test("visible text drops markup and keeps link text", () => {
    expect(visibleText("**Se** [lenke](https://x.no) og `kode` <Fact n=\"1\" v=\"ok\">her</Fact>.")).toBe("Se lenke og kode her.");
    expect(visibleText("Blokken `<RunChecklist>` her.")).toBe("Blokken <RunChecklist> her.");
  });
});

describe("StatusRows parts", () => {
  test("a row's label in either bold form, and no label", () => {
    expect(parseStatusRow("**Status:** Pågår")).toEqual({ label: "Status", value: "Pågår", text: "**Status:** Pågår" });
    expect(parseStatusRow("**Jira**: x")).toMatchObject({ label: "Jira", value: "x" });
    expect(parseStatusRow("Bare tekst")).toMatchObject({ label: null, value: "Bare tekst" });
  });

  test("segments split on ` · ` outside code spans", () => {
    expect(statusSegments("a · b · `c · d`")).toEqual(["a", "b", "`c · d`"]);
  });

  test("«ikke i prod», «merget, ikke i prod» and «i prod» get three tones, longest first", () => {
    expect(markStatePhrases("x ikke i prod", "no")).toBe('x <span class="sr-state sr-muted">ikke i prod</span>');
    expect(markStatePhrases("x merget, ikke i prod", "no")).toBe('x <span class="sr-state sr-warn">merget, ikke i prod</span>');
    expect(markStatePhrases("x i prod", "no")).toBe('x <span class="sr-state sr-good">i prod</span>');
    expect(markStatePhrases("x ikke opprettet", "no")).toBe('x <span class="sr-state sr-muted">ikke opprettet</span>');
    expect(markStatePhrases("x opprettet", "no")).toBe('x <span class="sr-state sr-info">opprettet</span>');
  });

  test("English phrases, and a phrase inside a word, code or a link is left alone", () => {
    expect(markStatePhrases("merged, not in prod", "en")).toContain("sr-warn");
    expect(markStatePhrases("not in prod", "en")).toContain("sr-muted");
    expect(markStatePhrases("ikke i prod", "en")).toBe("ikke i prod");
    expect(markStatePhrases("<code>i prod</code> <a href=\"#\">i prod</a> gi prodx", "no")).toBe(
      "<code>i prod</code> <a href=\"#\">i prod</a> gi prodx",
    );
  });
});

const PAGE = `<Tldr label="Kort fortalt">

Fag avklarte saken.

<More>

**Bakgrunnen.** Når et vedtak fattes.

</More>

</Tldr>

<StatusRows>

- **Status:** Pågår · fag svarte sist 07.10
- **Jira:** oppgave 3 merget, ikke i prod · oppgave 1 i prod

</StatusRows>
`;

describe("web render", () => {
  test("<More> is a closed part of the Tldr, labelled by the language", () => {
    const no = formatWebHtml(PAGE, { reader: true, language: "no" });
    expect(no).toContain('<details class="tldr-more"><summary>Mer om saken</summary><div class="tldr-more-body">');
    expect(no).not.toMatch(/<details class="tldr-more" open/);
    expect(formatWebHtml(PAGE)).toContain("<summary>More about this</summary>");
  });

  test("the question option's language labels it when no language is given", () => {
    const html = formatWebHtml(PAGE, { question: { questionsTo: [], language: "no", answerable: false } });
    expect(html).toContain("<summary>Mer om saken</summary>");
  });

  test("<More> outside a Tldr renders its body in place", () => {
    const html = formatWebHtml("<More>\n\nBare tekst.\n\n</More>");
    expect(html).toContain("Bare tekst.");
    expect(html).not.toContain("details");
  });

  test("<StatusRows> renders one row per item, label and value", () => {
    const html = formatWebHtml(PAGE, { language: "no" });
    expect(html.match(/class="sr-row"/g)).toHaveLength(2);
    expect(html).toContain('<span class="sr-label">Status</span><span class="sr-value">Pågår<span class="sr-sep"> · </span>fag svarte sist 07.10</span>');
    expect(html).toContain('<span class="sr-state sr-warn">merget, ikke i prod</span>');
    expect(html).toContain('<span class="sr-state sr-good">i prod</span>');
  });

  test("a DecisionLog item splits its first sentence and the rest; a one-sentence item does not", () => {
    const html = formatWebHtml("<DecisionLog>\n\n- **D1** — Vi velger alternativ A. Fordi B.\n- **D2** — Bare én.\n\n</DecisionLog>");
    expect(html).toContain('<span class="dl-text"><span class="dl-first">Vi velger alternativ A.</span><span class="dl-rest"> Fordi B.</span></span>');
    expect(html).toContain('<span class="dl-text">Bare én.</span>');
  });

  test("a split item keeps the anchor passes, the state stamp, the noun and the card links (D12)", () => {
    const md = [
      '<Question id="S1">',
      "",
      "Hva gjør vi?",
      "",
      "</Question>",
      "",
      '<Query id="s1" question="q" />',
      "",
      "<DecisionLog>",
      "",
      "- **S1** — Hva gjør vi med køen? Lukket 07.10 (D1).",
      "- **D1** — Vi velger A. Fordi B.",
      "",
      "</DecisionLog>",
    ].join("\n");
    const html = formatWebHtml(md, {
      reader: true,
      idLabels: { S: { one: "Spørsmål", other: "spørsmål" }, D: { one: "Beslutning", other: "beslutninger" } },
      question: { questionsTo: [], language: "no", answerable: false },
    });
    // The Query card holds `s1`, so the item is `s1-2` and the card's chip follows it.
    expect(html).toContain('<li class="dl-item" id="s1-2" data-q-state="decided"><span class="id-noun" data-reader-only>Spørsmål</span> <a class="dl-id" href="#s1-2">S1</a><span class="dl-text"><span class="dl-first">Hva gjør vi med køen?</span>');
    expect(html).toContain('<a class="q-id" href="#s1-2">S1</a>');
    expect(html).toContain('<li class="dl-item" id="d1" data-q-state="open"><span class="id-noun" data-reader-only>Beslutning</span> <a class="dl-id" href="#d1">D1</a>');
  });
});

describe("text surfaces", () => {
  test("Telegram prints the rows as plain lines and <More> in full", () => {
    const out = formatTelegramHtml(PAGE);
    expect(out).toContain("<b>Status:</b> Pågår · fag svarte sist 07.10\n<b>Jira:</b> oppgave 3 merget, ikke i prod · oppgave 1 i prod");
    expect(out).toContain("<b>Bakgrunnen.</b> Når et vedtak fattes.");
  });

  test("Slack prints the rows as plain lines and <More> in full", () => {
    const out = formatSlackMrkdwn(PAGE);
    expect(out).toContain("*Status:* Pågår · fag svarte sist 07.10\n*Jira:*");
    expect(out).toContain("*Bakgrunnen.* Når et vedtak fattes.");
  });

  test("email prints one line per row and <More> in full", () => {
    const out = formatEmailHtml(PAGE);
    expect(out.match(/<strong[^>]*>Status:<\/strong> Pågår/)).not.toBeNull();
    expect(out).toContain("Når et vedtak fattes.");
    expect(out).not.toContain("<details");
  });
});

test("FIRST_SENTENCE_MAX is D6's 160", () => {
  expect(FIRST_SENTENCE_MAX).toBe(160);
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────

/** The `<span class="dl-text">` of the first id-led item, its two halves unwrapped. */
function logText(md: string, opts?: Parameters<typeof formatWebHtml>[1]): { html: string; first: string | null } {
  const html = formatWebHtml(`<DecisionLog>\n\n- **D1** — ${md}\n\n</DecisionLog>`, opts);
  const m = /<span class="dl-text">([\s\S]*)<\/span><\/li>/.exec(html)!;
  const inner = m[1]!;
  const split = /^<span class="dl-first">([\s\S]*?)<\/span><span class="dl-rest">([\s\S]*)<\/span>$/.exec(inner);
  return { html: split ? split[1]! + split[2]! : inner, first: split ? split[1]! : null };
}

/** The same text as a plain list item: what the item renders as unsplit. */
function plainItem(md: string): string {
  return /<li>([\s\S]*)<\/li>/.exec(formatWebHtml(`- ${md}`))![1]!;
}

describe("first sentence: a split never changes the render (B)", () => {
  const breakers = [
    "_Vi velger alternativ A. Begrunnelsen_ følger her. Resten av teksten.",
    "__Vi velger alternativ A. Begrunnelsen__ følger her. Resten av teksten.",
    'Status er <Pill tone="good">ok. yes</Pill> i dag for alle. Resten av teksten.',
    'Se <FileRef path="a. b.ts">a. b</FileRef> i koden her. Resten av teksten.',
  ];
  for (const md of breakers) {
    test(`renders as the unsplit item: ${md.slice(0, 30)}`, () => {
      expect(logText(md).html).toBe(plainItem(md));
    });
  }

  test("an unpaired `*` no longer blocks every split", () => {
    expect(logText("Math 2*3 is six for everyone. Rest of the text.").first).toBe("Math 2*3 is six for everyone.");
    expect(logText("Glob src/*.ts matched all files. Rest of the text.").first).toBe("Glob src/*.ts matched all files.");
  });

  test("a `<Fact>` tag inside a code span does not block the split", () => {
    expect(logText('Bruk `<Fact n="1">` som merke her. Resten av teksten.').first).toBe(
      'Bruk <code>&lt;Fact n=&quot;1&quot;&gt;</code> som merke her.',
    );
  });
});

describe("first sentence: a fact mark moves no sentence end (A)", () => {
  test("a sentence end right before `</Fact>` is one", () => {
    expect(splitFirstSentence('<Fact n="1" v="ok">The cache holds ten entries.</Fact> It evicts the oldest first. More.')?.first).toBe(
      '<Fact n="1" v="ok">The cache holds ten entries.</Fact>',
    );
  });
  test("a sentence end inside a mark is none: the split moves past it", () => {
    expect(splitFirstSentence('The cache holds <Fact n="1" v="ok">ten entries. It evicts</Fact> the oldest first. More.')?.first).toBe(
      'The cache holds <Fact n="1" v="ok">ten entries. It evicts</Fact> the oldest first.',
    );
  });
});

describe("first sentence: abbreviations (C)", () => {
  // Each prefix before the abbreviation is over FIRST_SENTENCE_MIN, so the
  // short-sentence rule (D) cannot hide a wrong end.
  const cases: [string, string][] = [
    ["Dette står beskrevet i pkt. 3 i avtalen. Resten.", "Dette står beskrevet i pkt. 3 i avtalen."],
    ["Dette står beskrevet i kap. 3 i boken. Resten.", "Dette står beskrevet i kap. 3 i boken."],
    ["Vi tar lister, tabeller o.l. Senere i år. Resten.", "Vi tar lister, tabeller o.l. Senere i år."],
    ["Vi tar lister, tabeller m.m. Senere i år. Resten.", "Vi tar lister, tabeller m.m. Senere i år."],
    ["Vi tar lister, tabeller mv. Senere i år. Resten.", "Vi tar lister, tabeller mv. Senere i år."],
    ["Regelen gjelder t.o.m. Mars neste år. Resten.", "Regelen gjelder t.o.m. Mars neste år."],
    ["Regelen gjelder f.o.m. Mars neste år. Resten.", "Regelen gjelder f.o.m. Mars neste år."],
    ["Endringen er gjort i.h.t. Avtalen med fag. Resten.", "Endringen er gjort i.h.t. Avtalen med fag."],
    ["Vi ringer i morgen til Dr. Hansen om saken. Resten.", "Vi ringer i morgen til Dr. Hansen om saken."],
    ["Abonnementet koster kr. 50 per måned for alle. Resten.", "Abonnementet koster kr. 50 per måned for alle."],
    ["We will ask our Mr. Smith about the plan. Rest.", "We will ask our Mr. Smith about the plan."],
    ["It shipped first in the U.S. market for all. Rest.", "It shipped first in the U.S. market for all."],
    ["The fix finally landed on Oct. 5 after review. Rest.", "The fix finally landed on Oct. 5 after review."],
    ["Abonnementet koster 5 kroner pr. Dag for alle. Resten.", "Abonnementet koster 5 kroner pr. Dag for alle."],
  ];
  for (const [text, first] of cases) {
    test(first, () => expect(splitFirstSentence(text)?.first ?? null).toBe(first));
  }

  test("an upper-case `PR.` ends a sentence", () => {
    expect(splitFirstSentence("This needs a publish PR. Recommended next step is review.")?.first).toBe("This needs a publish PR.");
  });
});

describe("first sentence: a short first sentence joins the next (D)", () => {
  test("under 15 visible characters joins the next sentence, repeatedly", () => {
    expect(splitFirstSentence("High. Medium risk overall. Rest of it.")?.first).toBe("High. Medium risk overall.");
    expect(splitFirstSentence("High. Low. Medium risk overall. Rest.")?.first).toBe("High. Low. Medium risk overall.");
    expect(splitFirstSentence("High. Low risk.")).toBeNull();
  });
});

describe("StatusRows segments keep links and tag pairs whole (F)", () => {
  test("a ` · ` inside a link or a component does not split", () => {
    expect(statusSegments("[a · b](https://x) · i prod")).toEqual(["[a · b](https://x)", "i prod"]);
    expect(statusSegments('<Pill tone="good">x · y</Pill> · z')).toEqual(['<Pill tone="good">x · y</Pill>', "z"]);
    expect(statusSegments("[[A · B]] · z")).toEqual(["[[A · B]]", "z"]);
  });

  test("the rendered row keeps the link", () => {
    const html = formatWebHtml("<StatusRows>\n\n- **Link:** [a · b](https://x) · i prod\n\n</StatusRows>", { language: "no" });
    expect(html).toContain('<a href="https://x" target="_blank" rel="noopener">a · b</a>');
  });
});

describe("StatusRows nested lines on the text surfaces (G)", () => {
  const md = "<StatusRows>\n\n- **Status:** Pågår\n  - Første underpunkt\n  - Andre underpunkt\n- **Jira:** x\n\n</StatusRows>";
  test("Telegram", () => {
    const out = formatTelegramHtml(md);
    expect(out).toContain("Første underpunkt");
    expect(out).toContain("Andre underpunkt");
    expect(out.indexOf("Første underpunkt")).toBeLessThan(out.indexOf("Jira"));
  });
  test("Slack", () => {
    const out = formatSlackMrkdwn(md);
    expect(out).toContain("Første underpunkt");
    expect(out.indexOf("Andre underpunkt")).toBeLessThan(out.indexOf("Jira"));
  });
  test("email", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("Første underpunkt");
    expect(out.indexOf("Andre underpunkt")).toBeLessThan(out.indexOf("Jira"));
  });
});

describe("state phrases: negations and word ends (H)", () => {
  test("a negation earlier in the segment keeps «i prod» from reading good", () => {
    expect(markStatePhrases("ikke ennå i prod", "no")).not.toContain("sr-good");
    expect(markStatePhrases("ikke ennå i prod", "no")).toContain("sr-muted");
    expect(markStatePhrases("not yet in prod", "en")).not.toContain("sr-good");
    expect(markStatePhrases("<em>ikke</em> i prod", "no")).not.toContain("sr-good");
    expect(markStatePhrases("aldri i prod", "no")).not.toContain("sr-good");
    expect(markStatePhrases("never in prod", "en")).not.toContain("sr-good");
  });
  test("a hyphen after the phrase is part of a word", () => {
    expect(markStatePhrases("i prod-miljøet", "no")).toBe("i prod-miljøet");
    expect(markStatePhrases("in prod-like env", "en")).toBe("in prod-like env");
  });
  test("a plain «i prod» still reads good", () => {
    expect(markStatePhrases("oppgave 1 i prod", "no")).toContain("sr-good");
  });
});

describe("state phrases see through a fact mark and skip a pill (I)", () => {
  const row = (v: string) => formatWebHtml(`<StatusRows>\n\n- **Status:** ${v}\n\n</StatusRows>`, { language: "no", reader: true });
  test("a mark over «i prod» in «ikke i prod» does not turn it green", () => {
    const html = row('Endringen er ikke <Fact n="1" v="ok">i prod</Fact> · venter');
    expect(html).not.toContain("sr-good");
    expect(html).toContain("sr-muted");
  });
  test("a mark inside «merget, ikke i prod» keeps the warn colour of the whole phrase", () => {
    const html = row('oppgave 3 merget, ikke <Fact n="1" v="ok">i prod</Fact>');
    expect(html).toContain("sr-warn");
    expect(html).not.toContain("sr-muted");
  });
  test("a mark does not change the colour of a plain «i prod»", () => {
    expect(row('Endringen er <Fact n="1" v="ok">i prod</Fact>')).toContain("sr-good");
  });
  test("a phrase inside a Pill is not coloured", () => {
    expect(row('<Pill tone="warn">i prod</Pill> · venter')).not.toContain("sr-state");
  });
});

describe("visibleText counts what a reader sees", () => {
  test("single emphasis markers dropped, entities decoded", () => {
    expect(visibleText("*ikke* _nå_ A &amp; B &lt;x&gt;")).toBe("ikke nå A & B <x>");
    expect(visibleText("user_id and 2*3")).toBe("user_id and 2*3");
  });
});

// ── Fix round 2 ──────────────────────────────────────────────────────────────

describe("state phrases: a negation in an earlier clause does not mute (V1)", () => {
  const good = (phrase: string) => `<span class="sr-state sr-good">${phrase}</span>`;
  test("a negation a negative phrase used does not mute a later «i prod»", () => {
    expect(markStatePhrases("ikke opprettet, men i prod", "no")).toBe(
      `<span class="sr-state sr-muted">ikke opprettet</span>, men ${good("i prod")}`,
    );
    expect(markStatePhrases("ikke i prod for test, i prod for main", "no")).toBe(
      `<span class="sr-state sr-muted">ikke i prod</span> for test, ${good("i prod")} for main`,
    );
  });
  test("a negation further back in the segment does not mute", () => {
    expect(markStatePhrases("PR ikke nødvendig, i prod", "no")).toBe(`PR ikke nødvendig, ${good("i prod")}`);
    expect(markStatePhrases("No regressions, in prod", "en")).toBe(`No regressions, ${good("in prod")}`);
  });
  test("only the page's own language negates", () => {
    expect(markStatePhrases("Jobben er no i prod", "no")).toBe(`Jobben er no ${good("i prod")}`);
  });
  test("a negation in the same clause still mutes", () => {
    expect(markStatePhrases("ikke ennå i prod", "no")).toBe('ikke ennå <span class="sr-state sr-muted">i prod</span>');
    expect(markStatePhrases("not yet in prod", "en")).toBe('not yet <span class="sr-state sr-muted">in prod</span>');
    expect(markStatePhrases("<em>ikke</em> i prod", "no")).toBe('<em><span class="sr-state sr-muted">ikke</span></em><span class="sr-state sr-muted"> i prod</span>');
    expect(markStatePhrases("aldri i prod", "no")).toBe('aldri <span class="sr-state sr-muted">i prod</span>');
  });
});

test("a plain `<` and `>` in a row value is no tag: the row keeps its segments (V2)", () => {
  expect(statusSegments("p95 < 200 ms · feilrate > 1 % · i prod")).toEqual(["p95 < 200 ms", "feilrate > 1 %", "i prod"]);
  expect(splitFirstSentence("Svartiden er p95 < 200 ms. Feilraten > 1 % i dag. Resten.")?.first).toBe("Svartiden er p95 < 200 ms.");
});

test("a self-closing `<Fact/>` opens no mark (V3)", () => {
  expect(splitFirstSentence('We chose option A <Fact n="1" v="ok"/> for now. Then B follows. Rest.')?.first).toBe(
    'We chose option A <Fact n="1" v="ok"/> for now.',
  );
});

describe("first sentence: a word that is also an abbreviation still ends a sentence (V4)", () => {
  const splits: [string, string][] = [
    ["Vi feirer alltid i jul. Neste år blir annerledes.", "Vi feirer alltid i jul."],
    ["Vi snakket lenge med Jan. Han sa ja til planen.", "Vi snakket lenge med Jan."],
    ["Billetten kostet fem kr. Neste punkt er maten.", "Billetten kostet fem kr."],
    ["Dette er beskrevet ved kap. Ny setning starter her.", "Dette er beskrevet ved kap."],
    ["The product launched in the U.S. Then it spread.", "The product launched in the U.S."],
    ["See the footnote in the ref. Then read the rest.", "See the footnote in the ref."],
    ["We asked the team about mr. Then we waited.", "We asked the team about mr."],
    ["They phoned the Dr. after lunch today. Rest.", "They phoned the Dr."],
  ];
  for (const [text, first] of splits) {
    test(`splits: ${first}`, () => expect(splitFirstSentence(text)?.first ?? null).toBe(first));
  }
  const holds: [string, string][] = [
    ["Abonnementet koster kr. 500 per måned. Resten.", "Abonnementet koster kr. 500 per måned."],
    ["Vi møtes igjen den 5. jan. 2027 i Oslo. Resten.", "Vi møtes igjen den 5. jan. 2027 i Oslo."],
    ["We will ask our Dr. Smith about the plan. Rest.", "We will ask our Dr. Smith about the plan."],
    ["The fix finally landed on Oct. 9 after review. Rest.", "The fix finally landed on Oct. 9 after review."],
    ["It shipped first in the U.S. market this year. Rest.", "It shipped first in the U.S. market this year."],
    ["Se tabellen i ref. nedenfor for tallene. Resten.", "Se tabellen i ref. nedenfor for tallene."],
  ];
  for (const [text, first] of holds) {
    test(`holds: ${first}`, () => expect(splitFirstSentence(text)?.first ?? null).toBe(first));
  }
});

test("an item with a thousand sentence ends inside emphasis renders fast (V5)", () => {
  const md = "_" + "Dette er en setning. ".repeat(1000) + "Slutt_ her. Resten.";
  const t0 = performance.now();
  formatWebHtml(`<DecisionLog>\n\n- **D1** — ${md}\n\n</DecisionLog>`);
  expect(performance.now() - t0).toBeLessThan(200);
});

describe("state phrases: pins (V6, V9)", () => {
  test("a `<br>` separates words: «i prod» before it is a phrase (V9)", () => {
    expect(markStatePhrases("i prod<br>neste", "no")).toBe('<span class="sr-state sr-good">i prod</span><br>neste');
  });
  test("code between two words is a barrier, not a space (M30)", () => {
    expect(markStatePhrases("i<code>x</code> prod", "no")).toBe("i<code>x</code> prod");
  });
  test("a phrase across a fact mark is coloured piecewise, each run in the whole's tone (M19)", () => {
    const html = formatWebHtml('<StatusRows>\n\n- **Jira:** oppgave 3 merget, ikke <Fact n="1" v="ok">i prod</Fact>\n\n</StatusRows>', {
      language: "no",
      reader: true,
    });
    expect(html).toContain(
      '<span class="sr-value">oppgave 3 <span class="sr-state sr-warn">merget, ikke </span>' +
        '<span class="fc-mark fc-mark-ok" data-fact="1"><span class="sr-state sr-warn">i prod</span></span><button',
    );
  });
});

// ── Class check: clause scope ────────────────────────────────────────────────

describe("state phrases: a negation mutes a good phrase in its own clause (class check)", () => {
  const good = (p: string) => `<span class="sr-state sr-good">${p}</span>`;
  const muted = (p: string) => `<span class="sr-state sr-muted">${p}</span>`;
  // A clause starts at the segment start or after `,` `;` `:` or `men`/`but`.
  const table: [string, "no" | "en", string][] = [
    ["i prod", "no", good("i prod")],
    ["ikke i prod", "no", muted("ikke i prod")],
    ["ikke ennå i prod", "no", `ikke ennå ${muted("i prod")}`],
    ["not yet in prod", "en", `not yet ${muted("in prod")}`],
    ["ikke kjørt i prod", "no", `ikke kjørt ${muted("i prod")}`],
    ["ikke deployet i prod", "no", `ikke deployet ${muted("i prod")}`],
    ["ikke rullet ut i prod", "no", `ikke rullet ut ${muted("i prod")}`],
    ["ikke helt i prod", "no", `ikke helt ${muted("i prod")}`],
    ["Ikke sett i prod", "no", `Ikke sett ${muted("i prod")}`],
    ["ingen endring i prod", "no", `ingen endring ${muted("i prod")}`],
    ["never deployed in prod", "en", `never deployed ${muted("in prod")}`],
    ["not deployed in prod", "en", `not deployed ${muted("in prod")}`],
    ["wasn't deployed in prod", "en", `wasn't deployed ${muted("in prod")}`],
    ["no rollout in prod", "en", `no rollout ${muted("in prod")}`],
    // A negation is a whole word.
    ["nothing changed in prod", "en", `nothing changed ${good("in prod")}`],
    ["nano build in prod", "en", `nano build ${good("in prod")}`],
    ["ikke-overlapp i prod", "no", `ikke-overlapp ${good("i prod")}`],
    ["no-op in prod", "en", `no-op ${good("in prod")}`],
    ["cannot run in prod", "en", `cannot run ${muted("in prod")}`],
    ["<em>ikke</em> i prod", "no", `<em>${muted("ikke")}</em>${muted(" i prod")}`],
    ["<em>ikke</em> kjørt i prod", "no", `<em>ikke</em> kjørt ${muted("i prod")}`],
    ["ikke kjørt<br>i prod", "no", `ikke kjørt<br>${muted("i prod")}`],
    ["ikke <code>x</code> i prod", "no", `ikke <code>x</code> ${muted("i prod")}`],
    ["ikke opprettet, men i prod", "no", `${muted("ikke opprettet")}, men ${good("i prod")}`],
    ["ikke opprettet men i prod", "no", `${muted("ikke opprettet")} men ${good("i prod")}`],
    ["not merged but in prod", "en", `not merged but ${good("in prod")}`],
    ["ikke i prod for test, i prod for main", "no", `${muted("ikke i prod")} for test, ${good("i prod")} for main`],
    ["PR ikke nødvendig, i prod", "no", `PR ikke nødvendig, ${good("i prod")}`],
    ["ingen feil, i prod", "no", `ingen feil, ${good("i prod")}`],
    ["ikke merget; i prod", "no", `ikke merget; ${good("i prod")}`],
    ["ikke klart: i prod", "no", `ikke klart: ${good("i prod")}`],
    ["No regressions, in prod", "en", `No regressions, ${good("in prod")}`],
    ["deployet, ikke merget, i prod", "no", `deployet, ikke merget, ${good("i prod")}`],
    // Known limit: the comma ends the clause, so the list's negation is lost.
    ["Ikke pushet, deployet eller kjørt i prod", "no", `Ikke pushet, deployet eller kjørt ${good("i prod")}`],
    // A negation in the other language does not mute.
    ["ikke i prod", "en", "ikke i prod"],
    ["not in prod", "no", "not in prod"],
    ["ikke kjørt in prod", "en", `ikke kjørt ${good("in prod")}`],
    ["not deployed i prod", "no", `not deployed ${good("i prod")}`],
    ["i prod-miljøet", "no", "i prod-miljøet"],
  ];
  for (const [input, lang, expected] of table) {
    test(`${lang}: ${input}`, () => expect(markStatePhrases(input, lang)).toBe(expected));
  }
});

describe("first sentence: pins (class check round)", () => {
  const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
  const acceptAt = (n: number) => (first: string) => (first.match(/is here\./g) ?? []).length === n;
  test(`a split at end ${SENTENCE_CANDIDATES_MAX} is tried, one at end ${SENTENCE_CANDIDATES_MAX + 1} is not`, () => {
    expect(SENTENCE_CANDIDATES_MAX).toBe(20);
    expect(splitFirstSentence(sentences(25), acceptAt(20))?.first).toBe(sentences(20));
    expect(splitFirstSentence(sentences(25), acceptAt(21))).toBeNull();
  });
  const holds: [string, string][] = [
    ["Abonnementet koster kr. **500** per måned. Resten.", "Abonnementet koster kr. **500** per måned."],
    ["Vi ringer i morgen til Dr. _Hansen_ om saken. Resten.", "Vi ringer i morgen til Dr. _Hansen_ om saken."],
    ["It shipped first in the U.S. (mostly) this year. Rest.", "It shipped first in the U.S. (mostly) this year."],
  ];
  for (const [text, first] of holds) {
    test(`the gate reads the first letter or digit after the dot: ${first}`, () =>
      expect(splitFirstSentence(text)?.first ?? null).toBe(first));
  }
  test("the gate reads the first letter or digit after the dot: `U.S. (Then` splits", () => {
    expect(splitFirstSentence("The product launched in the U.S. (Then it spread.) Rest.")?.first).toBe("The product launched in the U.S.");
  });
});

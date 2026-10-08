import { describe, expect, test } from "bun:test";
import {
  FIRST_SENTENCE_MAX,
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
    ["plain", "Vi velger A. Begrunnelsen følger.", "Vi velger A."],
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
    ["soft wrap", "Vi velger A.\nBegrunnelsen.", "Vi velger A."],
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
    const html = formatWebHtml("<DecisionLog>\n\n- **D1** — Vi velger A. Fordi B.\n- **D2** — Bare én.\n\n</DecisionLog>");
    expect(html).toContain('<span class="dl-text"><span class="dl-first">Vi velger A.</span><span class="dl-rest"> Fordi B.</span></span>');
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
      "- **S1** — Hva gjør vi? Lukket 07.10 (D1).",
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
    expect(html).toContain('<li class="dl-item" id="s1-2" data-q-state="decided"><span class="id-noun" data-reader-only>Spørsmål</span> <a class="dl-id" href="#s1-2">S1</a><span class="dl-text"><span class="dl-first">Hva gjør vi?</span>');
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

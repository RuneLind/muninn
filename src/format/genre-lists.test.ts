import { test, expect, describe } from "bun:test";
import { laneFromAttrs, parseBlocks, type Block, type ChecklistRow } from "./markdown-ast.ts";
import { commandCode, decisionWhenLabel, parseDecisionWhen, parseLogItem, parseRunEntry, parseTimelineItem, runStepLine } from "./genre-lists.ts";
import { componentBlockCss } from "./component-styles.ts";
import { chatStyles } from "../chat/views/components/chat-styles.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

const block = (md: string) => parseBlocks(md)[0] as Extract<Block, { type: "component" }>;

describe("Timeline date grammar", () => {
  // [item, date, text]; a null date is undated and keeps the whole item.
  const rows: [string, string | null, string][] = [
    ["**2026-09-30** — Fag svarte", "2026-09-30", "Fag svarte"],
    ["2026-09-30 — Fag svarte", "2026-09-30", "Fag svarte"],
    ["**30.09.2026** — Fag svarte", "30.09.2026", "Fag svarte"],
    ["30.09.2026 — Fag svarte", "30.09.2026", "Fag svarte"],
    ["2026-09-30: kolon", "2026-09-30", "kolon"],
    ["**2026-09-30**: kolon", "2026-09-30", "kolon"],
    ["2026-09-30 : kolon med mellomrom", "2026-09-30", "kolon med mellomrom"],
    ["2026-09-30 – tankestrek", "2026-09-30", "tankestrek"],
    ["2026-09-30 - bindestrek", "2026-09-30", "bindestrek"],
    ["2026-09-30 uten skilletegn", "2026-09-30", "uten skilletegn"],
    // A separator may sit tight against the date or the text.
    ["2026-09-30 -x", "2026-09-30", "x"],
    ["2026-09-30—tett", "2026-09-30", "tett"],
    ["2026-09-30\u00a0—\u00a0hardt mellomrom", "2026-09-30", "hardt mellomrom"],
    ["2026-09-30\u00a0hardt mellomrom", "2026-09-30", "hardt mellomrom"],
    // The date alone on the item's first line.
    ["2026-09-30\nneste linje", "2026-09-30", "neste linje"],
    // A time belongs to the marker.
    ["**2026-09-28 20:50Z** — deploy", "2026-09-28 20:50Z", "deploy"],
    ["2026-09-28 20:50 deploy", "2026-09-28 20:50", "deploy"],
    ["2026-09-28 20:50Z: deploy", "2026-09-28 20:50Z", "deploy"],
    ["2026-09-28 25:00 ikke et klokkeslett", "2026-09-28", "25:00 ikke et klokkeslett"],
    // The shape table, longest first: a with-time row whose tail is refused
    // (a dash and a digit: a range) falls through to the date-only row, and
    // the range stays in the text, with or without a Z.
    ["2026-09-28 20:50–21:10: deploy", "2026-09-28", "20:50–21:10: deploy"],
    ["2026-09-28 20:50Z–21:10Z: deploy", "2026-09-28", "20:50Z–21:10Z: deploy"],
    ["2026-09-28 20:50Z-21:10 deploy", "2026-09-28", "20:50Z-21:10 deploy"],
    ["2026-09-28 20:50-21:10 deploy", "2026-09-28", "20:50-21:10 deploy"],
    ["2026-09-28 20:50—21:10 x", "2026-09-28", "20:50—21:10 x"],
    ["2026-09-28 20:50Z—21:10 x", "2026-09-28", "20:50Z—21:10 x"],
    ["2026-09-28 20:50Z deploy", "2026-09-28 20:50Z", "deploy"],
    ["**2026-09-28 20:50Z**", "2026-09-28 20:50Z", ""],
    ["**2026-09-28 20:50**", "2026-09-28 20:50", ""],
    ["**2026-09-28 20:50:** deploy", "2026-09-28 20:50", "deploy"],
    ["2026-09-28 20:50: x", "2026-09-28 20:50", "x"],
    ["2026-09-28 20:50Zx", "2026-09-28", "20:50Zx"],
    // A dash right before a digit is a minus sign, not a separator.
    ["2026-09-30 -5 grader", "2026-09-30", "-5 grader"],
    // The colon inside the bold, the house label style.
    ["**30.09.2026:** Fag svarte", "30.09.2026", "Fag svarte"],
    ["**2026-09-30:** kolon i fet", "2026-09-30", "kolon i fet"],
    // One-digit day and month.
    ["3.9.2026 kort", "3.9.2026", "kort"],
    ["**3.10.2026** kort", "3.10.2026", "kort"],
    // No year: bold, or a separator right after it.
    ["**27.09** Runde 2", "27.09", "Runde 2"],
    ["**29.09:** Runde 3", "29.09", "Runde 3"],
    ["**29.09**: Runde 3", "29.09", "Runde 3"],
    ["29.09: Runde 3", "29.09", "Runde 3"],
    ["29.09 — Runde 3", "29.09", "Runde 3"],
    ["2.10– kort", "2.10", "kort"],
    ["**29.02** skuddag uten år", "29.02", "skuddag uten år"],
    ["2026-09-30", "2026-09-30", ""],
    ["**2026-09-30**", "2026-09-30", ""],
    ["2024-02-29 skuddår", "2024-02-29", "skuddår"],
    // Undated: outside the four shapes, or not a calendar day.
    ["Uten dato", null, "Uten dato"],
    ["30.09 uten år", null, "30.09 uten år"],
    ["1.2 million", null, "1.2 million"],
    ["29.09 - bindestrek uten år", null, "29.09 - bindestrek uten år"],
    ["**27.–28.09** spenn", null, "**27.–28.09** spenn"],
    ["**31.04** finnes ikke", null, "**31.04** finnes ikke"],
    ["**32.01** finnes ikke", null, "**32.01** finnes ikke"],
    ["**30.13** finnes ikke", null, "**30.13** finnes ikke"],
    ["**30.09**x", null, "**30.09**x"],
    ["30.09.26 kort år", null, "30.09.26 kort år"],
    ["31.09.2026 finnes ikke", null, "31.09.2026 finnes ikke"],
    ["**2026-09-30:**x", null, "**2026-09-30:**x"],
    ["2026-9-3 kort", null, "2026-9-3 kort"],
    ["2026-02-30 finnes ikke", null, "2026-02-30 finnes ikke"],
    ["31.04.2026 finnes ikke", null, "31.04.2026 finnes ikke"],
    ["2025-02-29 ikke skuddår", null, "2025-02-29 ikke skuddår"],
    ["2026-09-30x", null, "2026-09-30x"],
    ["2026-09-301", null, "2026-09-301"],
    ["2026-09-30, komma", null, "2026-09-30, komma"],
    // A dash right before a digit is a range, never a separator.
    ["27.09–28.09: sprint", null, "27.09–28.09: sprint"],
    ["2026-09-28–30 sprint", null, "2026-09-28–30 sprint"],
    ["27.09-28.09", null, "27.09-28.09"],
    ["**2026-09-28**—30 sprint", null, "**2026-09-28**—30 sprint"],
    // A bold wrap closes the token, so no shorter bold row can take the
    // date alone: a range after a bold time stays undated.
    ["**2026-09-28 20:50**–21:10 x", null, "**2026-09-28 20:50**–21:10 x"],
    ["**2026-09-28 20:50Z**-21:10 x", null, "**2026-09-28 20:50Z**-21:10 x"],
    ["**2026-09-30 — inne i fet**", null, "**2026-09-30 — inne i fet**"],
    ["*2026-09-30* kursiv", null, "*2026-09-30* kursiv"],
    ["Fag svarte 2026-09-30", null, "Fag svarte 2026-09-30"],
    ["30/09/2026 skråstrek", null, "30/09/2026 skråstrek"],
  ];
  for (const [item, date, text] of rows) {
    test(`${JSON.stringify(item)} → ${date ?? "undated"}`, () => {
      expect(parseTimelineItem(item)).toEqual({ date, text });
    });
  }
});

describe("DecisionLog id grammar", () => {
  // [item, id, text, dim]
  const rows: [string, string | null, string, boolean][] = [
    ["**D1** — Ikke-yrkesaktive betaler ikke.", "D1", "Ikke-yrkesaktive betaler ikke.", false],
    ["**S3** - Spørsmål?", "S3", "Spørsmål?", false],
    ["**S3** – Spørsmål?", "S3", "Spørsmål?", false],
    ["**D12**: kolon", "D12", "kolon", false],
    ["**D1** uten skilletegn", "D1", "uten skilletegn", false],
    ["**D1**", "D1", "", false],
    ["**Q1** tre bokstaver tillatt? én", "Q1", "tre bokstaver tillatt? én", false],
    ["**ABC1234** grensen", "ABC1234", "grensen", false],
    ["**d4** liten bokstav", "d4", "liten bokstav", false],
    // Separators tight or with a hard space, and the id alone on its line.
    ["**D3**—tett", "D3", "tett", false],
    ["**D3**:tett kolon", "D3", "tett kolon", false],
    ["**D2**\u00a0—\u00a0hardt mellomrom", "D2", "hardt mellomrom", false],
    ["**D1**\nfortsetter", "D1", "fortsetter", false],
    // A dash right before a digit is a minus sign: it stays in the text.
    ["**D1** -1 stemme", "D1", "-1 stemme", false],
    ["**D1** —2 til", "D1", "—2 til", false],
    ["**D1**-1", null, "**D1**-1", false],
    ["**D3**—x", "D3", "x", false],
    ["**D2** — tekst", "D2", "tekst", false],
    // A struck id: the id, dimmed.
    ["~~**D1**~~ — flyttet", "D1", "flyttet", true],
    ["~~**D1**~~", "D1", "", true],
    // No id: the item stays as written.
    ["Uten id", null, "Uten id", false],
    ["D1 — uten fet", null, "D1 — uten fet", false],
    ["**Q-14** — bindestrek i id", null, "**Q-14** — bindestrek i id", false],
    ["**ABCD1** fire bokstaver", null, "**ABCD1** fire bokstaver", false],
    ["**D12345** fem sifre", null, "**D12345** fem sifre", false],
    ["**1D** siffer først", null, "**1D** siffer først", false],
    ["**D1**x ingen grense", null, "**D1**x ingen grense", false],
    ["**D1.** punktum i fet", null, "**D1.** punktum i fet", false],
    ["**D1:** kolon i fet", null, "**D1:** kolon i fet", false],
    // Struck or superseded: dimmed.
    ["~~**D2** — gammel~~", "D2", "~~gammel~~", true],
    ["**D2** — ~~gammel~~", "D2", "~~gammel~~", true],
    ["**D2** — ~~delvis~~ strøket", "D2", "~~delvis~~ strøket", false],
    ["~~Uten id strøket~~", null, "~~Uten id strøket~~", true],
    // Two strikes are not one whole-item strike.
    ["~~delvis~~ og ~~mer~~", null, "~~delvis~~ og ~~mer~~", false],
    ["**D2** — ~~delvis~~ og ~~mer~~", "D2", "~~delvis~~ og ~~mer~~", false],
    ["**D3** — Erstattet av D7.", "D3", "Erstattet av D7.", true],
    ["**D3** — superseded by S2", "D3", "superseded by S2", true],
    ["**D3** — Superseded by D10, se under", "D3", "Superseded by D10, se under", true],
    ["Uten id, erstattet av D4", null, "Uten id, erstattet av D4", true],
    ["**D3** — erstattet av fag", "D3", "erstattet av fag", false],
    ["**D3** — uerstattet av D4", "D3", "uerstattet av D4", false],
    ["**D3** — erstattet av D4x", "D3", "erstattet av D4x", false],
    // The phrase inside a code span is not the rule.
    ["**D4** — se `superseded by D3`", "D4", "se `superseded by D3`", false],
    ["**D4** — se ``erstattet av D3``", "D4", "se ``erstattet av D3``", false],
    ["**D4** — `kode`, superseded by D5", "D4", "`kode`, superseded by D5", true],
    // A self-reference has no rule of its own.
    ["**D2** superseded by D2", "D2", "superseded by D2", true],
    ["~~**D1**~~x", null, "~~**D1**~~x", false],
  ];
  for (const [item, id, text, dim] of rows) {
    test(`${JSON.stringify(item)} → ${id ?? "no id"}${dim ? ", dim" : ""}`, () => {
      expect(parseLogItem(item)).toEqual({ id, text, dim });
    });
  }
});

describe("RunChecklist label grammar", () => {
  const row = (text: string, plain = true): ChecklistRow => ({ checked: false, text, ...(plain ? { plain: true as const } : {}) });
  // [text, kind, label, value]
  const rows: [string, string | null, string?, string?][] = [
    ["Kommando: `POST /run`", "command", "Kommando", "`POST /run`"],
    ["Command: make deploy", "command", "Command", "make deploy"],
    ["Forventet: 0 feil", "expect", "Forventet", "0 feil"],
    ["Expect: 0 errors", "expect", "Expect", "0 errors"],
    ["Stopp hvis: feil > 0", "stop", "Stopp hvis", "feil > 0"],
    ["Stop if: errors > 0", "stop", "Stop if", "errors > 0"],
    ["Kommando:", "command", "Kommando", ""],
    ["Expected: 0 errors", "expect", "Expected", "0 errors"],
    // First letter in either case, the label as written.
    ["kommando: x", "command", "kommando", "x"],
    ["forventet: 0 feil", "expect", "forventet", "0 feil"],
    ["expected: 0", "expect", "expected", "0"],
    ["stopp hvis: feil", "stop", "stopp hvis", "feil"],
    ["stop if: x", "stop", "stop if", "x"],
    // In bold, the colon inside or after it.
    ["**Forventet:** 0 feil", "expect", "Forventet", "0 feil"],
    ["**Expected:** 0", "expect", "Expected", "0"],
    ["**Command:** `make`", "command", "Command", "`make`"],
    ["**Forventet**: 0 feil", "expect", "Forventet", "0 feil"],
    ["**forventet:**", "expect", "forventet", ""],
    // A hard space after the label counts as a space.
    ["Forventet:\u00a0x", "expect", "Forventet", "x"],
    ["**Kommando:**\u00a0`make`", "command", "Kommando", "`make`"],
    // Not a label: case past the first letter, a missing colon, no space after
    // it, a longer word, or a leading word.
    ["KOMMANDO: x", null],
    ["**KOMMANDO:** x", null],
    ["Kommandoer: x", null],
    ["Expect:no-space", null],
    ["**Kommando:**x", null],
    ["**Kommando** : x", null],
    ["*Kommando:* x", null],
    ["Kommando x", null],
    ["Kommando:x", null],
    ["Forventet:\u2003x", null],
    ["Stopp Hvis: x", null],
    ["Stop If: x", null],
    ["Kjør Kommando: x", null],
  ];
  for (const [text, kind, label, value] of rows) {
    test(`${JSON.stringify(text)} → ${kind ?? "plain entry"}`, () => {
      const got = parseRunEntry(row(text));
      if (kind) expect(got).toMatchObject({ kind, label: label!, value: value! });
      else expect(got).toBeNull();
    });
  }

  test("a task row is never a label", () => {
    expect(parseRunEntry(row("Kommando: x", false))).toBeNull();
  });

  test("a command is one single-backtick span, or prose", () => {
    expect(commandCode("`kubectl get pods`")).toBe("kubectl get pods");
    expect(commandCode("`a` og `b`")).toBeNull();
    expect(commandCode("``a`b``")).toBeNull();
    expect(commandCode("kjør `x`")).toBeNull();
    expect(commandCode("``")).toBeNull();
  });

  test("the count is over top-level rows, English unless a label is Norwegian", () => {
    const r = (checked: boolean, label?: string): ChecklistRow => ({
      checked,
      text: "x",
      ...(label
        ? { children: [{ type: "checklist" as const, ordered: false, start: 1, rows: [{ checked: false, text: `${label} y`, plain: true as const }] }] }
        : {}),
    });
    expect(runStepLine([r(true), r(true), r(true), r(false), r(false), r(false), r(false)])).toBe("3 of 7 steps");
    expect(runStepLine([r(false)])).toBe("0 of 1 step");
    expect(runStepLine([r(true, "Command:"), r(false, "Expected:")])).toBe("1 of 2 steps");
    expect(runStepLine([r(true, "Kommando:"), r(true), r(true), r(false), r(false), r(false), r(false)])).toBe("3 av 7 steg");
    expect(runStepLine([r(true, "**Forventet:**")])).toBe("1 av 1 steg");
    expect(runStepLine([r(true, "Command:"), r(false, "stopp hvis:")])).toBe("1 av 2 steg");
    // An unlabelled nested row with a Norwegian word is not a label.
    expect(runStepLine([r(true, "Kommandoer:")])).toBe("1 of 1 step");
  });
});

describe("parse: the four blocks", () => {
  test("Tldr keeps label, drops other attributes; the rest take none", () => {
    expect(block('<Tldr label="Kort fortalt" x="y">\n\nTekst.\n\n</Tldr>')).toMatchObject({ name: "Tldr", attrs: { label: "Kort fortalt" } });
    expect(block('<Timeline x="y">\n\n- a\n\n</Timeline>')).toMatchObject({ name: "Timeline", attrs: {} });
    expect(block("<DecisionLog>\n\n- a\n\n</DecisionLog>")).toMatchObject({ name: "DecisionLog", attrs: {} });
    expect(block("<RunChecklist>\n\n- [ ] a\n\n</RunChecklist>")).toMatchObject({ name: "RunChecklist", attrs: {} });
  });
});

describe("web: Tldr", () => {
  test("a lead box with the label, TL;DR by default", () => {
    expect(formatWebHtml('<Tldr label="Kort fortalt">\n\nFag har **svart**.\n\n</Tldr>')).toContain(
      '<section class="tldr"><div class="tldr-label">Kort fortalt</div><div class="tldr-body">',
    );
    const html = formatWebHtml("<Tldr>\n\n- en\n- to\n\n</Tldr>");
    expect(html).toContain('<div class="tldr-label">TL;DR</div>');
    expect(html).toContain("<li>en</li><li>to</li>");
  });

  test("the label is escaped", () => {
    expect(formatWebHtml('<Tldr label="a <b>">\n\nx\n\n</Tldr>')).toContain('<div class="tldr-label">a &lt;b&gt;</div>');
  });
});

describe("web: Timeline", () => {
  const md = [
    "<Timeline>",
    "",
    "Innledning.",
    "",
    "- **2026-09-30** — Fag svarte *skriftlig*",
    "- Uten dato",
    "  - under",
    "- 28.09.2026: Runde 1",
    "",
    "</Timeline>",
  ].join("\n");

  test("dated items get the date as marker; undated ones none; author's order", () => {
    const html = formatWebHtml(md);
    expect(html).toContain(
      '<ul class="gtl-list"><li class="gtl-item gtl-dated"><span class="gtl-date">2026-09-30</span><span class="gtl-text">Fag svarte <em>skriftlig</em></span></li>' +
        '<li class="gtl-item gtl-undated">Uten dato<ul><li>under</li></ul></li>' +
        '<li class="gtl-item gtl-dated"><span class="gtl-date">28.09.2026</span><span class="gtl-text">Runde 1</span></li></ul>',
    );
  });

  test("other body content renders in place", () => {
    const html = formatWebHtml(md);
    expect(html.indexOf("Innledning.")).toBeGreaterThan(-1);
    expect(html.indexOf("Innledning.")).toBeLessThan(html.indexOf("gtl-list"));
    expect(html).toStartWith('<section class="gtl">');
  });

  test("an ordered list keeps its numbers", () => {
    expect(formatWebHtml("<Timeline>\n\n3. 2026-01-02 a\n4. b\n\n</Timeline>")).toContain('<ol class="gtl-list" start="3">');
  });
});

describe("web: DecisionLog", () => {
  const md = [
    "<DecisionLog>",
    "",
    "**Avgjort av fag** (Slack):",
    "",
    "- **D1** — Ikke-yrkesaktive betaler ikke.",
    "- ~~**D2** — gammel~~",
    "- Uten id",
    "",
    "**Åpent:**",
    "",
    "- **S1** — Henlegge?",
    "",
    "</DecisionLog>",
  ].join("\n");

  test("each item with an id gets an anchor and a chip; an item without one is plain", () => {
    const html = formatWebHtml(md);
    expect(html).toContain('<li class="dl-item" id="d1"><a class="dl-id" href="#d1">D1</a><span class="dl-text">Ikke-yrkesaktive betaler ikke.</span></li>');
    expect(html).toContain('<li class="dl-item dl-dim" id="d2"><a class="dl-id" href="#d2">D2</a><span class="dl-text"><s>gammel</s></span></li>');
    expect(html).toContain('<li class="dl-item dl-noid">Uten id</li>');
    expect(html).toContain('<li class="dl-item" id="s1"><a class="dl-id" href="#s1">S1</a>');
  });

  test("labels between the lists render in place, in order", () => {
    const html = formatWebHtml(md);
    const at = (s: string) => html.indexOf(s);
    expect(at("<strong>Avgjort av fag</strong>")).toBeLessThan(at('id="d1"'));
    expect(at('id="d1"')).toBeLessThan(at("<strong>Åpent:</strong>"));
    expect(at("<strong>Åpent:</strong>")).toBeLessThan(at('id="s1"'));
  });

  test("a second log repeating an id gets -2; a Query card holding the slug keeps it", () => {
    const html = formatWebHtml(
      [
        "<DecisionLog>\n\n- **D1** — første\n\n</DecisionLog>",
        "<DecisionLog>\n\n- **D1** — andre\n- **D1** — tredje\n\n</DecisionLog>",
        '<Query id="S1" question="q" />',
        "<DecisionLog>\n\n- **S1** — etter kortet\n\n</DecisionLog>",
      ].join("\n\n"),
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["d1", "d1-2", "d1-3", "s1", "s1-2"]);
    expect(html).toContain('id="d1-2"><a class="dl-id" href="#d1-2">D1</a>');
    expect(html).toContain('id="s1-2"><a class="dl-id" href="#s1-2">S1</a>');
  });

  test("an ordered log keeps its item numbers", () => {
    expect(formatWebHtml("<DecisionLog>\n\n1. **D1** a\n\n3. **D2** b\n\n</DecisionLog>")).toContain('<li class="dl-item" value="3" id="d2">');
  });
});

describe("web: RunChecklist", () => {
  const md = [
    "<RunChecklist>",
    "",
    "- [x] Simuler",
    "  - Kommando: `POST /run`",
    "  - Forventet: `antallVilleOppdatertStatus` er 0",
    "  - en vanlig note",
    "  - Stopp hvis: feil > 0",
    "- [ ] Skarp kjøring",
    "  - Command: se under",
    "",
    "  ```bash",
    "  jq . run.json",
    "  ```",
    "",
    "- [x] Uten underliste",
    "",
    "</RunChecklist>",
  ].join("\n");

  test("the header counts done of all top-level steps, in Norwegian when a label is", () => {
    expect(formatWebHtml(md)).toContain('<div class="rc-head"><span class="rc-count">2 av 3 steg</span></div>');
    expect(formatWebHtml("<RunChecklist>\n\n- [x] a\n  - Command: `x`\n- [ ] b\n\n</RunChecklist>")).toContain(
      '<span class="rc-count">1 of 2 steps</span>',
    );
  });

  test("an empty step row is neither a step nor a row", () => {
    const html = formatWebHtml("<RunChecklist>\n\n- [x] a\n- [ ]\n- [ ] b\n\n</RunChecklist>");
    expect(html).toContain('<span class="rc-count">1 of 2 steps</span>');
    expect(html.match(/class="check-item/g)).toHaveLength(2);
  });

  test("an empty step with entries under it is a step and a row", () => {
    const html = formatWebHtml("<RunChecklist>\n\n- [ ]\n  - Kommando: `x`\n- [x] b\n\n</RunChecklist>");
    expect(html).toContain('<span class="rc-count">1 av 2 steg</span>');
    expect(html.match(/class="check-item/g)).toHaveLength(2);
    expect(html).toContain('<div class="rc-row rc-command">');
  });

  test("an ordered step list shows its numbers, from its start and its per-item values", () => {
    const html = formatWebHtml("<RunChecklist>\n\n3. [x] a\n4. [ ] b\n\n</RunChecklist>");
    expect(html).toContain('<ol class="checklist check-ol" start="3">');
    expect(html).toContain('<span class="rc-num">3.</span><span class="check-mark">✓</span> <span class="check-text">a</span></li>');
    expect(html).toContain('<span class="rc-num">4.</span><span class="check-mark">✗</span> <span class="check-text">b</span></li>');
    const jump = formatWebHtml("<RunChecklist>\n\n1. [x] a\n\n7. [ ] b\n\n</RunChecklist>");
    expect(jump).toContain('<span class="rc-num">1.</span>');
    expect(jump).toContain('<span class="rc-num">7.</span>');
    // A dropped empty row keeps the numbers of the rows after it.
    const gap = formatWebHtml("<RunChecklist>\n\n1. [x] a\n2. [ ]\n3. [ ] c\n\n</RunChecklist>");
    expect(gap).toContain('<span class="rc-num">3.</span><span class="check-mark">✗</span> <span class="check-text">c</span>');
    expect(gap).not.toContain('<span class="rc-num">2.</span>');
  });

  test("an unordered step list and a plain Checklist carry no numbers", () => {
    expect(formatWebHtml("<RunChecklist>\n\n- [x] a\n\n</RunChecklist>")).not.toContain("rc-num");
    expect(formatWebHtml("<Checklist>\n\n- [x] a\n  1. [ ] b\n\n</Checklist>")).not.toContain("rc-num");
  });

  test("every direct-child list is a step list; prose between renders in place; the count runs over all", () => {
    const html = formatWebHtml(
      "<RunChecklist>\n\nInnledning.\n\n- [x] Simuler\n  - Kommando: `POST /run`\n\nMellom stegene.\n\n- [ ] Skarp\n- [ ] Rydd\n\n</RunChecklist>",
    );
    expect(html).toContain('<span class="rc-count">1 av 3 steg</span>');
    const at = (s: string) => html.indexOf(s);
    expect(at("rc-head")).toBeLessThan(at("Innledning."));
    expect(at("Innledning.")).toBeLessThan(at("Simuler"));
    expect(at("Simuler")).toBeLessThan(at("Mellom stegene."));
    expect(at("Mellom stegene.")).toBeLessThan(at("Skarp"));
    expect(html).toContain("Rydd");
    expect(html).toContain('<div class="rc-row rc-command"><span class="rc-label">Kommando</span>');
  });

  test("an ordered runbook keeps its numbers and its labelled rows", () => {
    const html = formatWebHtml(
      "<RunChecklist>\n\n1. [x] Simuler\n   - Kommando: `POST /run`\n   - Forventet: 0 feil\n2. [ ] Skarp\n   - Kommando: `POST /run?dry=false`\n\n</RunChecklist>",
    );
    expect(html).toContain('<span class="rc-count">1 av 2 steg</span>');
    expect(html).toMatch(/<ol class="checklist[^"]*"><li class="check-item check-done check-parent" value="1">/);
    expect(html).toContain('value="2"');
    expect(html.match(/rc-row rc-command/g)).toHaveLength(2);
    expect(html).toContain('<div class="rc-row rc-expect"><span class="rc-label">Forventet</span>');
  });

  test("labelled entries are rows; an unlabelled entry stays a nested list item", () => {
    const html = formatWebHtml(md);
    expect(html).toContain('<div class="rc-row rc-command"><span class="rc-label">Kommando</span><div class="rc-value"><pre><code>POST /run</code></pre></div></div>');
    expect(html).toContain('<div class="rc-row rc-expect"><span class="rc-label">Forventet</span><div class="rc-value"><code>antallVilleOppdatertStatus</code> er 0</div></div>');
    expect(html).toContain('<ul class="checklist"><li class="check-plain">en vanlig note</li></ul><div class="rc-row rc-stop">');
  });

  test("a fenced command under the step stays a fence beside the rows", () => {
    expect(formatWebHtml(md)).toContain(
      '<div class="rc-row rc-command"><span class="rc-label">Command</span><div class="rc-value">se under</div></div><pre><code class="language-bash">',
    );
  });

  test("a step with no nested list is an ordinary checklist row", () => {
    expect(formatWebHtml(md)).toContain('<li class="check-item check-done"><span class="check-mark">✓</span> <span class="check-text">Uten underliste</span></li>');
  });

  test("an ordered nested list split by a label keeps its numbers", () => {
    const html = formatWebHtml("<RunChecklist>\n\n- [ ] a\n  1. først\n  2. Kommando: `x`\n  3. sist\n\n</RunChecklist>");
    expect(html).toContain('<li class="check-plain" value="1">først</li>');
    expect(html).toContain('<li class="check-plain" value="3">sist</li>');
    // A source number that does not count on survives the split, in a run
    // that starts after a label.
    expect(formatWebHtml("<RunChecklist>\n\n- [ ] a\n  1. Kommando: `x`\n  2. først\n\n  7. andre\n\n</RunChecklist>")).toContain(
      '<ol class="checklist check-ol" start="2"><li class="check-plain" value="2">først</li><li class="check-plain" value="7">andre</li></ol>',
    );
    expect(formatWebHtml("<RunChecklist>\n\n- [ ] a\n  1. først\n\n  7. andre\n  8. Kommando: `x`\n\n</RunChecklist>")).toContain(
      '<li class="check-plain" value="1">først</li><li class="check-plain" value="7">andre</li></ol><div class="rc-row rc-command">',
    );
  });

  test("no task list: the body renders as is", () => {
    expect(formatWebHtml("<RunChecklist>\n\nBare tekst.\n\n</RunChecklist>")).not.toContain("run-checklist");
  });
});

describe("NextMoves lane: a RunChecklist's open steps", () => {
  const lane = (md: string) => laneFromAttrs({ kind: "you" }, parseBlocks(md)).items;

  test("counts the unchecked steps of every step list, as the header does", () => {
    const md = "<RunChecklist>\n\n- [x] a\n- [ ] b\n  - Kommando: `x`\n- [ ]\n\nMellom.\n\n1. [ ] c\n\n</RunChecklist>";
    expect(lane(md)).toEqual(["b", "c"]);
    expect(formatWebHtml(md)).toContain('<span class="rc-count">1 av 3 steg</span>');
  });

  test("an empty step counts only with entries under it, as the header does", () => {
    const md = "<RunChecklist>\n\n- [ ]\n- [ ]\n  - Kommando: `x`\n- [ ] b\n\n</RunChecklist>";
    expect(lane(md)).toEqual(["", "b"]);
    expect(formatWebHtml(md)).toContain('<span class="rc-count">0 av 2 steg</span>');
  });

  test("a step of only spaces or U+00A0 is empty: dropped from the render and the count", () => {
    for (const blank of ["   ", "\u00a0", " \u00a0 "]) {
      const md = `<RunChecklist>\n\n- [x] a\n- [ ] ${blank}\n- [ ] b\n\n</RunChecklist>`;
      expect(lane(md)).toEqual(["b"]);
      expect(formatWebHtml(md)).toContain('<span class="rc-count">1 of 2 steps</span>');
      expect(formatSlackMrkdwn(md)).toBe("☑ a\n☐ b");
    }
  });

  test("an empty plain item in a lane list is no step", () => {
    expect(lane("- a\n- \n- b")).toEqual(["a", "b"]);
    expect(lane("- a\n- \u00a0\n- b")).toEqual(["a", "b"]);
  });

  test("a plain Checklist still counts its first list only", () => {
    expect(lane("<Checklist>\n\n- [x] a\n- [ ] b\n- [ ]\n\nMellom.\n\n- [ ] c\n\n</Checklist>")).toEqual(["b"]);
  });
});

describe("chat: no stylesheet rule outside the block CSS reaches the four blocks", () => {
  const md = [
    '<Tldr label="L">\n\nx\n\n</Tldr>',
    "<Timeline>\n\n- 2026-09-30 a\n- b\n\n</Timeline>",
    "<DecisionLog>\n\n- **D1** a\n- ~~**D2** b~~\n- c\n\n</DecisionLog>",
    "<RunChecklist>\n\n- [x] a\n  - Kommando: `x`\n  - Forventet: y\n  - Stopp hvis: z\n  - note\n\n</RunChecklist>",
  ].join("\n\n");
  const classes = (html: string) => new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)));

  test("every class the blocks add is free in chat's own rules", () => {
    const unwrapped = md.replace(/^<\/?(?:Tldr|Timeline|DecisionLog|RunChecklist)[^>]*>$/gm, "");
    const plain = classes(formatWebHtml(unwrapped));
    const own = [...classes(formatWebHtml(md))].filter((c) => !plain.has(c));
    // The fixture reaches every block's classes.
    for (const c of ["tldr", "gtl-dated", "gtl-undated", "dl-dim", "dl-noid", "rc-command", "rc-expect", "rc-stop"]) expect(own).toContain(c);
    const chatOwn = chatStyles().replace(componentBlockCss(".web-content"), "");
    const hits = own.filter((c) => new RegExp(`\\.${c.replace(/-/g, "\\-")}(?![\\w-])`).test(chatOwn));
    expect(hits).toEqual([]);
  });
});

describe("plain-text fallbacks", () => {
  const md = [
    '<Tldr label="Kort fortalt">',
    "",
    "Fag har svart.",
    "",
    "</Tldr>",
    "",
    "<Timeline>",
    "",
    "- **2026-09-30** — Fag svarte",
    "- Uten dato",
    "",
    "</Timeline>",
    "",
    "<DecisionLog>",
    "",
    "- **D1** — Ja.",
    "",
    "</DecisionLog>",
    "",
    "<RunChecklist>",
    "",
    "- [x] Simuler",
    "  - Kommando: `POST /run`",
    "- [ ] Skarp",
    "",
    "</RunChecklist>",
  ].join("\n");

  test("Slack: label line, lists as written, the checklist with its labelled rows", () => {
    expect(formatSlackMrkdwn(md)).toBe(
      [
        "*Kort fortalt:*",
        "",
        "Fag har svart.",
        "",
        "- *2026-09-30* — Fag svarte",
        "- Uten dato",
        "",
        "- *D1* — Ja.",
        "",
        "☑ Simuler",
        "  ◦ Kommando: `POST /run`",
        "☐ Skarp",
      ].join("\n"),
    );
  });

  test("Telegram: the same shape in its HTML subset", () => {
    const out = formatTelegramHtml(md);
    expect(out).toContain("<b>Kort fortalt:</b>\n");
    expect(out).toContain("- <b>2026-09-30</b> — Fag svarte\n- Uten dato");
    expect(out).toContain("- <b>D1</b> — Ja.");
    expect(out).toContain("☑ Simuler\n  ◦ Kommando: <code>POST /run</code>\n☐ Skarp");
  });

  test("email: a bold label line, the lists, the styled checklist", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain(">Kort fortalt:</div>");
    expect(out).toContain("<strong>2026-09-30</strong> — Fag svarte");
    expect(out).toContain("<strong>D1</strong> — Ja.");
    expect(out).toContain("☑</span> Simuler");
    expect(out).toContain("Kommando: <code");
  });

  test("Tldr without a label says TL;DR", () => {
    expect(formatSlackMrkdwn("<Tldr>\n\nx\n\n</Tldr>")).toStartWith("*TL;DR:*");
  });

  test("a label ending in a colon gets no second one", () => {
    const md = '<Tldr label="Kort sagt: ">\n\nx\n\n</Tldr>';
    expect(formatSlackMrkdwn(md)).toStartWith("*Kort sagt:*\n");
    expect(formatTelegramHtml(md)).toStartWith("<b>Kort sagt:</b>\n");
    expect(formatEmailHtml(md)).toContain(">Kort sagt:</div>");
  });

  test("RunChecklist: every step list and the prose between them", () => {
    const md = "<RunChecklist>\n\nInnledning.\n\n- [x] a\n\nMellom.\n\n- [ ] b\n\n</RunChecklist>";
    expect(formatSlackMrkdwn(md)).toBe("Innledning.\n\n☑ a\n\nMellom.\n\n☐ b");
    expect(formatTelegramHtml(md)).toBe("Innledning.\n\n☑ a\n\nMellom.\n\n☐ b");
    const email = formatEmailHtml(md);
    expect(email.indexOf("Innledning.")).toBeLessThan(email.indexOf("☑</span> a"));
    expect(email.indexOf("☑</span> a")).toBeLessThan(email.indexOf("Mellom."));
    expect(email.indexOf("Mellom.")).toBeLessThan(email.indexOf("☐</span> b"));
  });

  test("RunChecklist: an ordered step list keeps its numbers, from its start", () => {
    const md = "<RunChecklist>\n\n3. [x] a\n4. [ ] b\n\n</RunChecklist>";
    expect(formatSlackMrkdwn(md)).toBe("3. ☑ a\n4. ☐ b");
    expect(formatTelegramHtml(md)).toBe("3. ☑ a\n4. ☐ b");
    const email = formatEmailHtml(md);
    expect(email).toMatch(/>3\.<\/span> <span[^>]*>☑<\/span> a/);
    expect(email).toMatch(/>4\.<\/span> <span[^>]*>☐<\/span> b/);
    const jump = "<RunChecklist>\n\n1. [x] a\n\n7. [ ] b\n\n</RunChecklist>";
    expect(formatSlackMrkdwn(jump)).toContain("7. ☐ b");
    expect(formatTelegramHtml(jump)).toContain("7. ☐ b");
    expect(formatEmailHtml(jump)).toMatch(/>7\.<\/span> <span[^>]*>☐<\/span> b/);
  });

  test("a plain Checklist's ordered task list carries no numbers in any fallback", () => {
    const md = "<Checklist>\n\n- [x] a\n  1. [ ] b\n  2. [x] c\n\n</Checklist>";
    expect(formatSlackMrkdwn(md)).toBe("☑ a\n  ☐ b\n  ☑ c");
    expect(formatTelegramHtml(md)).toBe("☑ a\n  ☐ b\n  ☑ c");
    const email = formatEmailHtml(md);
    expect(email).toContain("☐</span> b");
    expect(email).not.toMatch(/>[12]\.<\/span>/);
  });

  test("RunChecklist: an empty step is dropped, one with entries kept", () => {
    const md = "<RunChecklist>\n\n- [x] a\n- [ ]\n- [ ] b\n\n</RunChecklist>";
    expect(formatSlackMrkdwn(md)).toBe("☑ a\n☐ b");
    expect(formatTelegramHtml(md)).toBe("☑ a\n☐ b");
    expect(formatEmailHtml(md).match(/[☐☑]<\/span>/g)).toHaveLength(2);
    const kept = "<RunChecklist>\n\n- [ ]\n  - Kommando: x\n- [ ] b\n\n</RunChecklist>";
    expect(formatSlackMrkdwn(kept)).toBe("☐ \n  ◦ Kommando: x\n☐ b");
    expect(formatEmailHtml(kept).match(/[☐☑]<\/span>/g)).toHaveLength(2);
  });
});

describe("DecisionLog date tail (D41)", () => {
  // [item text, label or null, the text the tail leaves]
  const rows: [string, string | null, string][] = [
    ["Regelen gjelder alle. Fag, 28.09 (runde 1).", "Fag, 28.09 · runde 1", "Regelen gjelder alle."],
    ["Regelen gjelder alle. Fag, 28.09.2026 (runde 12).", "Fag, 28.09.2026 · runde 12", "Regelen gjelder alle."],
    ["Regelen gjelder alle. Rune Lind, 07.10.", "Rune Lind, 07.10", "Regelen gjelder alle."],
    ["Regelen gjelder alle. Fag, 7.10.2026.", "Fag, 7.10.2026", "Regelen gjelder alle."],
    ["To oppgaver. Fag, 28.09 (runde 1) → oppgave 1 og 2.", "Fag, 28.09 · runde 1", "To oppgaver."],
    // A struck first claim, snudd later, two rounds (fagavklaring's D9).
    [
      "~~MEL-1 skal ha en årsavregning.~~ Snudd i runde 6: MEL-1 skal **ikke** ha det ([PR #3](https://x.io/3); i prod). Fag, 07.10 (runde 5 og 6).",
      "Fag, 07.10 · runde 5 og 6",
      "~~MEL-1 skal ha en årsavregning.~~ Snudd i runde 6: MEL-1 skal **ikke** ha det ([PR #3](https://x.io/3); i prod).",
    ],
    ["Ingen dato her.", null, ""],
    ["Feil dag. Fag, 31.02 (runde 1).", null, ""],
    ["Midt i: Fag, 28.09 (runde 1). Så mer tekst.", null, ""],
    ["fag, 28.09 (runde 1).", null, ""],
    ["Komma, 28.09 i setningen uten punktum", null, ""],
  ];
  test.each(rows)("%s", (text, label, rest) => {
    const w = parseDecisionWhen(text);
    expect(w ? decisionWhenLabel(w) : null).toBe(label);
    if (w) expect(text.slice(0, w.start).trim()).toBe(rest);
  });

  test("the label keeps the round word as written", () => {
    expect(decisionWhenLabel(parseDecisionWhen("X. Fag, 01.02 (runde 3).")!)).toBe("Fag, 01.02 · runde 3");
  });

  test("a pointer after the tail stays in the text", () => {
    const text = "To oppgaver. Fag, 28.09 (runde 1) → oppgave 1 og 2.";
    const w = parseDecisionWhen(text)!;
    expect(text.slice(w.start, w.end).trim()).toBe("Fag, 28.09 (runde 1)");
    expect(text.slice(w.end).trim()).toBe("→ oppgave 1 og 2.");
  });

  const log = (items: string[]) => ["<DecisionLog>", "", ...items, "", "</DecisionLog>"].join("\n");

  test("the reader marks decisions and splits the tail out; chat renders as before", () => {
    const md = log(["- **D1** — Første beslutning gjelder. Fag, 28.09 (runde 1).", "- **S1** — Et spørsmål? Fag, 28.09 (runde 1)."]);
    const reader = formatWebHtml(md, { reader: true, language: "no" });
    expect(reader).toContain('<li class="dl-item dl-decision" id="d1"');
    expect(reader).toContain('<span class="dl-when" data-reader-only>Fag, 28.09 · runde 1</span>');
    expect(reader).toContain('<span class="dl-tail">Fag, 28.09 (runde 1).</span>');
    // A question item keeps today's rendering.
    expect(reader).toMatch(/<li class="dl-item" id="s1"[^>]*><a class="dl-id" href="#s1">S1<\/a><span class="dl-text">/);
    const chat = formatWebHtml(md);
    expect(chat).not.toContain("dl-decision");
    expect(chat).not.toContain("dl-when");
    expect(chat).not.toContain("dl-tail");
  });

  test("the tail split leaves the item's text unchanged", () => {
    const md = log(["- **D2** — Vedtak fattet i flyten skal ha metadata. Fag ba om to oppgaver. Fag, 28.09 (runde 1) → oppgave 1 og 2."]);
    const text = (html: string) =>
      html
        .replace(/<span class="dl-when"[^>]*>[^<]*<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    expect(text(formatWebHtml(md, { reader: true }))).toBe(text(formatWebHtml(md)));
    const html = formatWebHtml(md, { reader: true });
    expect(html).toContain('<span class="dl-first">Vedtak fattet i flyten skal ha metadata.</span>');
    expect(html).toContain('<span class="dl-tail">Fag, 28.09 (runde 1)</span> → oppgave 1 og 2.</span>');
  });

  test("an item with no tail gets an empty date cell (none rendered)", () => {
    const html = formatWebHtml(log(["- **D3** — Ingen dato her."]), { reader: true });
    expect(html).toContain('class="dl-item dl-decision"');
    expect(html).not.toContain("dl-when");
  });
});

describe("fix round 1: the D41 date tail and an overturned first sentence", () => {
  const log = (items: string[]) => ["<DecisionLog>", "", ...items, "", "</DecisionLog>"].join("\n");

  test("item 15: «Satsen er 3. Se kapittel 4, 3.2.» is no date tail: who carries no digit", () => {
    expect(parseDecisionWhen("Satsen er 3. Se kapittel 4, 3.2.")).toBeNull();
    // who is one to three words.
    expect(parseDecisionWhen("Regel. En to tre fire, 01.02.")).toBeNull();
    expect(decisionWhenLabel(parseDecisionWhen("Regel. Fag og jus, 01.02.")!)).toBe("Fag og jus, 01.02");
  });

  test("item 15: the round word is case-insensitive", () => {
    expect(decisionWhenLabel(parseDecisionWhen("Regelen gjelder alle. Fag, 07.10 (Runde 6).")!)).toBe("Fag, 07.10 · Runde 6");
    expect(decisionWhenLabel(parseDecisionWhen("The rule holds for all. Team, 07.10 (ROUND 2).")!)).toBe("Team, 07.10 · ROUND 2");
  });

  test("item 16: the date cell keeps the authored round word", () => {
    expect(decisionWhenLabel(parseDecisionWhen("The rule holds for all. Team, 07.10 (round 3).")!)).toBe("Team, 07.10 · round 3");
    const html = formatWebHtml(log(["- **D1** — The rule holds for all cases. Team, 07.10 (round 3)."]), { reader: true, language: "no" });
    expect(html).toContain('<span class="dl-when" data-reader-only>Team, 07.10 · round 3</span>');
  });

  test("item 17: a yearless 29.02 is a calendar day (checked against a leap year)", () => {
    expect(decisionWhenLabel(parseDecisionWhen("Regelen gjelder alle. Fag, 29.02 (runde 1).")!)).toBe("Fag, 29.02 · runde 1");
    expect(parseDecisionWhen("Regelen gjelder alle. Fag, 29.02.2025 (runde 1).")).toBeNull();
  });

  test("item 1: the date cell follows the text in the DOM", () => {
    const html = formatWebHtml(log(["- **D1** — Regelen gjelder alle saker. Fag, 28.09 (runde 1)."]), { reader: true });
    expect(html.indexOf('class="dl-when"')).toBeGreaterThan(html.indexOf('class="dl-text"'));
  });

  // Fagavklaring's D9, as written: the first claim struck, the ruling after it.
  const D9 =
    "- **D9** — ~~MEL-600070 skal ha en årsavregning for 2024.~~ Snudd i runde 6: MEL-600070 skal **ikke** ha årsavregning, " +
    "fordi personen er skattepliktig uten andre inntekter, og avgiften ikke skal betales til Nav. Står fast: Melosys skal se bort " +
    "fra åpne årsavregninger uten år. Fag, 07.10 (runde 5 og 6).";

  test("item 2: a struck first sentence leaves the first sentence of what follows as the row's text", () => {
    const html = formatWebHtml(log([D9]), { reader: true, language: "no" });
    expect(html).toContain(
      '<span class="dl-first">Snudd i runde 6: MEL-600070 skal <strong>ikke</strong> ha årsavregning, fordi personen er skattepliktig uten andre inntekter, og avgiften ikke skal betales til Nav.</span>',
    );
    // The struck claim is in the rest, before the first sentence, so All reads the item as written.
    expect(html).toMatch(/<span class="dl-text"><span class="dl-rest"><s>MEL-600070 skal ha en årsavregning for 2024\.<\/s> ?<\/span><span class="dl-first">/);
    const text = (h: string) =>
      h
        .replace(/<span class="dl-when"[^>]*>[^<]*<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    expect(text(html)).toBe(text(formatWebHtml(log([D9]))));
  });

  test("item 2: the same rule without a date tail, and a struck item stays as it was", () => {
    const html = formatWebHtml(log(["- **D4** — ~~Gammel regel gjelder her.~~ Ny regel gjelder fra nå av. Begrunnelse følger."]), { reader: true });
    expect(html).toContain('<span class="dl-first">Ny regel gjelder fra nå av.</span>');
    const struck = formatWebHtml(log(["- **D5** — ~~Gammel regel gjelder her. Og mer gammelt.~~"]), { reader: true });
    expect(struck).not.toMatch(/<span class="dl-rest"><s>/);
  });
});

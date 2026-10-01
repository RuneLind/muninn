import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block, type ChecklistRow } from "./markdown-ast.ts";
import { commandCode, parseLogItem, parseRunEntry, parseTimelineItem, runStepLine } from "./genre-lists.ts";
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
    // A dash with no space after it is not the separator: the text keeps it.
    ["2026-09-30 -x", "2026-09-30", "-x"],
    ["2026-09-30", "2026-09-30", ""],
    ["**2026-09-30**", "2026-09-30", ""],
    ["2024-02-29 skuddår", "2024-02-29", "skuddår"],
    // Undated: outside the four shapes, or not a calendar day.
    ["Uten dato", null, "Uten dato"],
    ["30.09 uten år", null, "30.09 uten år"],
    ["2026-9-3 kort", null, "2026-9-3 kort"],
    ["2026-02-30 finnes ikke", null, "2026-02-30 finnes ikke"],
    ["31.04.2026 finnes ikke", null, "31.04.2026 finnes ikke"],
    ["2025-02-29 ikke skuddår", null, "2025-02-29 ikke skuddår"],
    ["2026-09-30x", null, "2026-09-30x"],
    ["2026-09-301", null, "2026-09-301"],
    ["2026-09-30, komma", null, "2026-09-30, komma"],
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
    // Not a label: case, a missing colon, no space after it, or a leading word.
    ["kommando: x", null],
    ["KOMMANDO: x", null],
    ["Kommando x", null],
    ["Kommando:x", null],
    ["Stopp Hvis: x", null],
    ["Stop If: x", null],
    ["Kjør Kommando: x", null],
    ["**Kommando:** x", null],
  ];
  for (const [text, kind, label, value] of rows) {
    test(`${JSON.stringify(text)} → ${kind ?? "plain entry"}`, () => {
      expect(parseRunEntry(row(text))).toEqual(kind ? { kind: kind as "command", label: label!, value: value! } : null);
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

  test("the count is over top-level rows", () => {
    const r = (checked: boolean): ChecklistRow => ({ checked, text: "x" });
    expect(runStepLine([r(true), r(true), r(true), r(false), r(false), r(false), r(false)])).toBe("3 of 7 steps");
    expect(runStepLine([r(false)])).toBe("0 of 1 step");
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
      '<ul class="tl-list"><li class="tl-item tl-dated"><span class="tl-date">2026-09-30</span><span class="tl-text">Fag svarte <em>skriftlig</em></span></li>' +
        '<li class="tl-item tl-undated">Uten dato<ul><li>under</li></ul></li>' +
        '<li class="tl-item tl-dated"><span class="tl-date">28.09.2026</span><span class="tl-text">Runde 1</span></li></ul>',
    );
  });

  test("other body content renders in place", () => {
    const html = formatWebHtml(md);
    expect(html.indexOf("Innledning.")).toBeGreaterThan(-1);
    expect(html.indexOf("Innledning.")).toBeLessThan(html.indexOf("tl-list"));
  });

  test("an ordered list keeps its numbers", () => {
    expect(formatWebHtml("<Timeline>\n\n3. 2026-01-02 a\n4. b\n\n</Timeline>")).toContain('<ol class="tl-list" start="3">');
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

  test("the header counts done of all top-level steps", () => {
    expect(formatWebHtml(md)).toContain('<div class="rc-head"><span class="rc-count">2 of 3 steps</span></div>');
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
    expect(formatWebHtml(md)).toContain('<li class="check-item check-done"><span class="check-mark">✓</span> Uten underliste</li>');
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
});

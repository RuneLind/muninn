import { describe, expect, test } from "bun:test";
import { CHECK_PROBES, checkSlotHtml, parseCheckAttrs, stepCheck } from "./check-tag.ts";
import { leadSentence } from "./lead-sentence.ts";
import { listYouSteps, stepDoneEdit, stepDoneLogLine } from "./step-done.ts";
import { formatEmailHtml } from "./email-format.ts";
import { COMPONENT_NAMES } from "./component-spec.ts";
import { lineCodeSpanRanges } from "./code-spans.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { extractNextMoves } from "../wiki/next-moves.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkComponents } from "../wiki/lint-components.ts";

const ENV = `<Check env="WIKI_STALE_CONFIRM_WIKIS" restart="3010" />`;
const MIG = `<Check migration="086" on="Laptop,mini,laptop" />`;
const page = (body: string) => `---\ntitle: Fixture\n---\n\n${body}`;
const moves = (lane: string) => `<NextMoves>\n\n<Lane kind="you">\n\n${lane}\n\n</Lane>\n\n</NextMoves>\n`;
const SLOT = /<span class="step-check" data-reader-only[^>]*><\/span>/g;

/** The four surfaces that print nothing for a trailing tag. */
const textSurfaces: [string, (md: string) => string][] = [
  ["slack", formatSlackMrkdwn],
  ["telegram", formatTelegramHtml],
  ["email", formatEmailHtml],
  ["chat", (md) => formatWebHtml(md)],
];
const reader = (md: string) => renderWikiHtml(md, () => undefined);

describe("parseCheckAttrs", () => {
  test("reads every probe and the machines, lower-cased and deduped", () => {
    expect(parseCheckAttrs({ env: "WIKI_STALE_CONFIRM_WIKIS", restart: "3010" })).toEqual({
      probes: [{ kind: "env", value: "WIKI_STALE_CONFIRM_WIKIS" }, { kind: "restart", value: "3010" }],
      on: null,
      problems: [],
    });
    expect(parseCheckAttrs({ migration: "086", checkout: "muninn", pushed: "claude-skills", on: "Laptop, mini,LAPTOP" })).toEqual({
      probes: [{ kind: "migration", value: "086" }, { kind: "checkout", value: "muninn" }, { kind: "pushed", value: "claude-skills" }],
      on: ["laptop", "mini"],
      problems: [],
    });
  });

  test("a malformed value drops that probe with exactly one problem, and no «names no probe»", () => {
    for (const [attrs, kind] of [
      [{ migration: "86" }, "migration"],
      [{ env: "1A" }, "env"],
      [{ restart: "123456" }, "restart"],
      [{ checkout: "-x" }, "checkout"],
      [{ pushed: "a b" }, "pushed"],
    ] as const) {
      const r = parseCheckAttrs(attrs);
      expect(r.probes).toEqual([]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toStartWith(`${kind}=`);
    }
    expect(parseCheckAttrs({ migration: "086" }).problems).toEqual([]);
  });

  test("a malformed `on` keeps the good names with one problem", () => {
    expect(parseCheckAttrs({ env: "X", on: "laptop,,mini" })).toMatchObject({ on: ["laptop", "mini"], problems: [expect.any(String)] });
    expect(parseCheckAttrs({ env: "X", on: "lap top" })).toMatchObject({ on: null, problems: [expect.any(String)] });
  });

  test("no probe attribute at all is the one problem, `on` alone included", () => {
    expect(parseCheckAttrs({}).problems).toEqual([`names no probe: give one of ${CHECK_PROBES.join(", ")}`]);
    expect(parseCheckAttrs({ on: "mini" }).problems).toHaveLength(1);
  });
});

describe("stepCheck", () => {
  test("the trailing tag only", () => {
    expect(stepCheck(`**Do it.** ${ENV}`)?.probes.map((p) => p.kind)).toEqual(["env", "restart"]);
    expect(stepCheck(`Do ${MIG} then ${ENV}`)?.probes.map((p) => p.kind)).toEqual(["env", "restart"]);
    expect(stepCheck(`Do ${ENV} then.`)).toBeNull();
    expect(stepCheck(`Do \`${ENV}\``)).toBeNull();
    expect(stepCheck(`Do it\n${ENV}`)).toBeNull();
    expect(stepCheck(ENV)).toBeNull();
  });
});

describe("checkSlotHtml", () => {
  test("escapes & < > \" and emits only the six spec attributes", () => {
    expect(checkSlotHtml(` env="A&B<c>" foo="1" on="x'y"`)).toBe(
      `<span class="step-check" data-reader-only data-check-env="A&amp;B&lt;c&gt;" data-check-on="x'y"></span>`,
    );
    expect(reader(`- x <Check pushed="a&quot;b" />`)).toContain(`data-check-pushed="a&amp;quot;b"`);
  });
});

describe("a step line carrying <Check>", () => {
  const before = page(moves("1. **Add the key and restart** to 3010\n2. Run the migration on both machines\n3. Read the result."));
  const after = page(moves(`1. **Add the key and restart** to 3010 ${ENV}\n2. Run the migration on both machines ${MIG}\n3. Read the result.`));

  test("is one step: the same count and the same keys", () => {
    const a = listYouSteps(before)!;
    const b = listYouSteps(after)!;
    expect(b.length).toBe(3);
    expect(b.map((s) => s.refusal)).toEqual([null, null, null]);
    expect(b.map((s) => s.key.split(".")[1])).toEqual(a.map((s) => s.key.split(".")[1]));
  });

  test("Done removes the raw line whole and renumbers", () => {
    const r = stepDoneEdit(after, listYouSteps(after)![0]!.key);
    if (!r.ok) throw new Error(r.reason);
    expect(r.content).toBe(page(moves(`1. Run the migration on both machines ${MIG}\n2. Read the result.`)));
    expect(r.removed).toEqual([{ line: 9, text: `1. **Add the key and restart** to 3010 ${ENV}` }]);
    const second = stepDoneEdit(r.content, listYouSteps(r.content)![0]!.key);
    if (!second.ok) throw new Error(second.reason);
    expect(second.content).toBe(page(moves("1. Read the result.")));
  });

  test("the Done log line, commit subject, /plans steps and lane peek equal the untagged page's", () => {
    const logs = (p: string) =>
      listYouSteps(p)!.map((s) => {
        const r = stepDoneEdit(p, s.key);
        if (!r.ok) throw new Error(r.reason);
        return stepDoneLogLine(r);
      });
    expect(logs(after)).toEqual(logs(before));
    expect(logs(after)[1]).toBe("Step done: Run the migration on both machines");
    expect(extractNextMoves(after)!.youSteps).toEqual(extractNextMoves(before)!.youSteps);
    const peek = (p: string) => /<span class="nm-peek"[^>]*>([^<]*)<\/span>/.exec(reader(p))?.[1];
    expect(peek(after)).toBe(peek(before));
  });
});

describe("leadSentence", () => {
  test("reads the step as if the trailing tag were absent", () => {
    expect(leadSentence(`**Restart.** ${ENV}`)).toBe("Restart.");
    expect(leadSentence(`Restart the server ${ENV}`)).toBe("Restart the server");
    expect(leadSentence(`Restart the server${ENV}`)).toBe("Restart the server");
    expect(leadSentence(`Run \`x\`. ${ENV}  `)).toBe("Run x.");
    expect(leadSentence(`Restart ${ENV}\nmore`)).toBe("Restart");
  });

  test("a <Check> in a code span survives as on main", () => {
    expect(leadSentence("Quote `<Check env=\"X\" />` here")).toBe('Quote <Check env="X" /> here');
    expect(leadSentence('Use `<Check restart="3010" />` on the line.')).toBe('Use <Check restart="3010" /> on the line.');
    // One in code, a real one outside it: only the real one goes.
    expect(leadSentence(`Use \`<Check restart="3010" />\` and ${ENV} here.`)).toBe('Use <Check restart="3010" /> and  here.');
    expect(leadSentence(`Use \`<Check restart="3010" />\` here ${ENV}`)).toBe('Use <Check restart="3010" /> here');
  });

  test("every <Check> outside code is stripped, misplaced or valid", () => {
    expect(leadSentence(`Do ${ENV} then go.`)).toBe("Do  then go.");
    expect(leadSentence(`Do ${ENV}.`)).toBe("Do .");
    expect(leadSentence(`**Do ${ENV}**`)).toBe("Do");
    expect(leadSentence(`Do ${ENV} and ${ENV}`)).toBe("Do  and");
    expect(leadSentence(ENV)).toBe("");
    expect(leadSentence('Restart <Check env="X">muninn now</Check> please.')).toBe("Restart muninn now please.");
    // A match that starts right where a code span closes is outside it.
    expect(leadSentence('Run `a`<Check env="X" /> now.')).toBe("Run a now.");
  });

  test("every other component name reads as on main: stripped in and out of code (and with a Check beside it)", () => {
    for (const name of COMPONENT_NAMES.filter((n) => n !== "Check")) {
      expect(leadSentence(`Ship \`<${name} value="x" />\` and \`<Check env="X" />\` now`)).toBe('Ship  and <Check env="X" /> now');
      expect(leadSentence(`Run \`a\`<${name} /> now.`)).toBe("Run a now.");
    }
    for (const name of COMPONENT_NAMES.filter((n) => n !== "Check")) {
      expect(leadSentence(`Ship <${name} value="x" /> now. More.`)).toBe("Ship  now.");
      expect(leadSentence(`Ship \`<${name} value="x" />\` now`)).toBe("Ship  now");
      expect(leadSentence(`**Ship <${name}>x</${name}>.** ${ENV}`)).toBe("Ship x.");
    }
  });

  // Every name (plus `Checklist` and an unknown one) × five tag forms × in,
  // out of, right before and right after a code span × three prefixes ×
  // keepLabel. A line with no `<Check`/`</Check>` outside code must read as on
  // main. Expected: Bun.hash of main's outputs per name, joined by NUL, from
  // `git archive origin/main` (8d437ca3's base); every name not listed hashes
  // to DEFAULT, because main strips each one the same way.
  const leadGrid = (names: readonly string[]) =>
    [...names, "Checklist", "Zork"].flatMap((name) =>
      [`<${name} a="1" />`, `<${name} a="1">`, `</${name}>`, `<${name} a="1">x</${name}>`, `<${name} a="<Pill />" />`].flatMap((tag) =>
        [`Do \`${tag}\` now`, `Do ${tag} now`, `Do ${tag}\`x\` now`, `Do \`x\`${tag} now`].flatMap((shape) =>
          ["", "1. ", "**Rune:** "].flatMap((prefix) => [false, true].map((keepLabel) => ({ name, input: prefix + shape, keepLabel }))),
        ),
      ),
    );
  const bareCheck = (line: string) => {
    const code = lineCodeSpanRanges(line);
    return [...line.matchAll(/<\/?Check(?![\w-])/g)].some((m) => !code.some((r) => m.index >= r.start && m.index < r.end));
  };
  const DEFAULT = "1xojtqby6bvf8";
  const MAIN_HASH: Record<string, string> = { Check: "30193oix1ynrw", Checklist: "328xfj2ah447", Zork: "1vj9d04ihw9zo" };

  test("a line with no <Check> outside code reads as on main (4,590 grid cases)", () => {
    const scoped = leadGrid(COMPONENT_NAMES).filter((c) => !bareCheck(c.input));
    expect(scoped.length).toBe(4590);
    const by = new Map<string, string[]>();
    for (const c of scoped) (by.get(c.name) ?? by.set(c.name, []).get(c.name)!).push(leadSentence(c.input, { keepLabel: c.keepLabel }));
    for (const [name, outs] of by) expect({ name, hash: Bun.hash(outs.join("\u0000")).toString(36) }).toEqual({ name, hash: MAIN_HASH[name] ?? DEFAULT });
  });

  test("a quoted </Check>, and a tag inside a quoted Check's value, read as on main", () => {
    for (const keepLabel of [false, true]) {
      expect(leadSentence("Do `</Check>` now", { keepLabel })).toBe("Do </Check> now");
      expect(leadSentence('Do `<Check a="<Pill />" />` now', { keepLabel })).toBe('Do <Check a="" /> now');
    }
    expect(leadSentence("**Rune:** Do `</Check>` now", { keepLabel: true })).toBe("Rune: Do </Check> now");
    expect(extractNextMoves(page(moves("1. Do `</Check>` now")))!.youSteps).toEqual(["Do </Check> now"]);
    // Outside code a closer is a tag, alone or not.
    expect(leadSentence("Do </Check> now")).toBe("Do  now");
  });
});

describe("rendering a valid trailing tag", () => {
  const shapes: [string, string][] = [
    ["plain sentence", "Restart the server."],
    ["bold", "**Restart.**"],
    ["code span", "Run `bun run db:migrate`"],
    ["link", "Read [the plan](https://example.com/plan)"],
    ["pill", "Ship it <Pill>today</Pill>"],
    ["verdict", 'Decide <Verdict value="yes" />'],
    ["no sentence end", "restart 3010"],
  ];
  const variants = (text: string): [string, string, string][] => [
    ["numbered", `1. ${text} ${ENV}\n2. Next`, `1. ${text}\n2. Next`],
    ["bulleted", `- ${text} ${ENV}\n- Next`, `- ${text}\n- Next`],
    ["no space", `- ${text}${ENV}`, `- ${text}`],
    ["trailing whitespace", `- ${text} ${ENV}  \t`, `- ${text}  \t`],
    ["tabs before", `- ${text}\t \t${ENV}`, `- ${text}`],
  ];

  test("Slack, Telegram, email and chat equal the line without the tag", () => {
    for (const [shape, text] of shapes) {
      for (const [variant, tagged, plain] of variants(text)) {
        for (const [surface, fmt] of textSurfaces) {
          expect({ shape, variant, surface, out: fmt(tagged) }).toEqual({ shape, variant, surface, out: fmt(plain) });
        }
      }
    }
  });

  test("the reader equals the untagged render plus one slot after the item's text", () => {
    for (const [shape, text] of shapes) {
      for (const [variant, tagged, plain] of variants(text)) {
        const out = reader(tagged);
        expect({ shape, variant, slots: out.match(SLOT)?.length }).toEqual({ shape, variant, slots: 1 });
        expect({ shape, variant, out: out.replace(SLOT, "") }).toEqual({ shape, variant, out: reader(plain) });
      }
    }
    expect(reader(`1. **Restart.** ${ENV}`)).toContain(
      `<li><strong>Restart.</strong><span class="step-check" data-reader-only data-check-env="WIKI_STALE_CONFIRM_WIKIS" data-check-restart="3010"></span></li>`,
    );
  });

  test("the chat path of formatWebHtml emits no slot, even with reader on", () => {
    expect(formatWebHtml(`1. Restart ${ENV}`)).not.toContain("step-check");
    expect(formatWebHtml(`1. Restart ${ENV}`, { reader: true })).not.toContain("step-check");
  });
});

describe("misplaced parsed tags", () => {
  const misplaced = [
    `- Restart ${ENV} then go.`,
    `- Restart ${ENV}.`,
    `- **Restart ${ENV}**`,
    `- [Restart ${ENV}](https://x)`,
    // Not here: `<Pill>x <Check …/></Pill>`. Telegram and Slack print a
    // Pill's body as literal text, so the tag there is never parsed.
    `Text.\n\n${ENV}\n\nMore.`,
    `- Restart\n  more ${ENV}`,
    `- Restart\n  - sub ${ENV}`,
    `## Heading ${ENV}`,
    `| a | b |\n|---|---|\n| x ${ENV} | y |`,
    `- Restart <Check env="X">body</Check>`,
  ];
  test("render no slot and no visible <Check on all five surfaces", () => {
    for (const md of misplaced) {
      for (const [surface, out] of [...textSurfaces.map(([s, f]) => [s, f(md)] as const), ["reader", reader(md)] as const]) {
        expect({ md, surface, slot: out.includes("step-check"), visible: /Check|WIKI_STALE/.test(out) }).toEqual({ md, surface, slot: false, visible: false });
      }
    }
  });

  test("a <Check> in a code span or fence is never a check", () => {
    const md = "- Quote `<Check env=\"X\" />`\n\n```\n<Check env=\"X\" />\n```";
    for (const out of [...textSurfaces.map(([, f]) => f(md)), reader(md)]) {
      expect(out).not.toContain("step-check");
      expect(out).toMatch(/&lt;Check env=(&quot;|")X(&quot;|") \/&gt;|<Check env="X" \/>/);
    }
  });
});

describe("a misplaced tag on a you step leaks into no step text", () => {
  const C = '<Check env="X" />';
  const steps = [`Do ${C} then go`, `${C} alone`, `**Do ${C}**`, `Do ${C} and ${C}`];
  const before = page(moves(steps.map((s, k) => `${k + 1}. ${s.replaceAll(C, "").replace(/\s+/g, " ").trim()}`).join("\n")));
  const after = page(moves(steps.map((s, k) => `${k + 1}. ${s}`).join("\n")));
  const peek = (p: string) => /<span class="nm-peek"[^>]*>([^<]*)<\/span>/.exec(reader(p))?.[1];

  test("the lane peek, /plans youSteps and the Done log line carry no <Check", () => {
    expect(peek(after)).toBeDefined();
    expect(peek(after)).not.toContain("Check");
    for (const s of extractNextMoves(after)!.youSteps) expect(s).not.toContain("Check");
    for (const s of listYouSteps(after)!) {
      const r = stepDoneEdit(after, s.key);
      if (!r.ok) throw new Error(r.reason);
      expect(stepDoneLogLine(r)).not.toContain("Check");
    }
    // Stripped like any other component tag: the spaces around it stay.
    expect(extractNextMoves(after)!.youSteps).toEqual(["Do  then go", "alone", "Do", "Do  and"]);
    expect(listYouSteps(before)!.length).toBe(listYouSteps(after)!.length);
  });
});

describe("the paired form renders its body as if the tag were absent", () => {
  const surfaces: [string, (md: string) => string][] = [...textSurfaces, ["reader", (md) => reader(md)]];
  const cases: [string, string, string][] = [
    ["inline", 'Restart <Check env="X">muninn **now**</Check> please.', "Restart muninn **now** please."],
    ["block", 'Before.\n\n<Check env="X">\n\nThe body with **bold**.\n\n</Check>\n\nAfter.', "Before.\n\nThe body with **bold**.\n\nAfter."],
    ["one-line block", '<Check env="X">just this</Check>', "just this"],
  ];
  test("on all five surfaces, with no slot", () => {
    for (const [shape, tagged, plain] of cases) {
      for (const [surface, fmt] of surfaces) {
        const out = fmt(tagged);
        expect({ shape, surface, slot: out.includes("step-check"), body: out.includes("muninn") || out.includes("body") || out.includes("just this") }).toEqual({ shape, surface, slot: false, body: true });
        // Email joins a component's blocks to its neighbours with a newline
        // between the tags, where one paragraph run has none: no rendered change.
        const norm = (h: string) => (surface === "email" ? h.replace(/>\n</g, "><") : h);
        expect({ shape, surface, out: norm(out) }).toEqual({ shape, surface, out: norm(fmt(plain)) });
      }
    }
  });

  test("the self-closing form still prints nothing", () => {
    for (const [surface, fmt] of surfaces) {
      expect({ surface, out: fmt('Restart <Check env="X" /> please.') }).toEqual({ surface, out: fmt("Restart  please.") });
    }
  });
});

describe("no backtracking blow-up", () => {
  const big = (ch: string) => [
    ch.repeat(50_000),
    `- a${ch.repeat(50_000)}${ENV}`,
    `- a${ch.repeat(50_000)}<Check`,
    `- a <Check${ch.repeat(50_000)}`,
    `- ${`a${ch}`.repeat(25_000)}<Check env="x"`,
  ];
  test("50,000 spaces or tabs format in under 50 ms on every surface", () => {
    const surfaces: [string, (s: string) => unknown][] = [
      ...textSurfaces,
      ["reader", reader],
      ["leadSentence", leadSentence],
      ["stepCheck", stepCheck],
      ["lint", (s) => checkComponents("plans/x.mdx", page(moves(s)))],
    ];
    for (const ch of [" ", "\t"]) {
      for (const [k, line] of big(ch).entries()) {
        for (const [surface, fmt] of surfaces) {
          fmt(line.slice(0, 200)); // warm the JIT on the shape
          const t0 = performance.now();
          fmt(line);
          const ms = performance.now() - t0;
          expect({ ch, k, surface, slow: ms >= 50 ? ms : false }).toEqual({ ch, k, surface, slow: false });
        }
      }
    }
  });
});

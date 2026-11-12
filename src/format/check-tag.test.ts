import { describe, expect, test } from "bun:test";
import { CHECK_PROBES, parseCheckAttrs, stepChecks, withoutChecks } from "./check-tag.ts";
import { scanInlineComponents } from "./markdown-ast.ts";
import { leadSentence } from "./lead-sentence.ts";
import { listYouSteps, stepDoneEdit, stepDoneLogLine } from "./step-done.ts";
import { formatEmailHtml } from "./email-format.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { extractNextMoves } from "../wiki/next-moves.ts";

const ENV = `<Check env="WIKI_STALE_CONFIRM_WIKIS" restart="3010" />`;
const MIG = `<Check migration="086" on="laptop,mini" />`;
const page = (body: string) => `---\ntitle: Fixture\n---\n\n${body}`;
const moves = (lane: string) => `<NextMoves>\n\n<Lane kind="you">\n\n${lane}\n\n</Lane>\n\n</NextMoves>\n`;

describe("parseCheckAttrs", () => {
  test("reads every probe and the machines", () => {
    expect(parseCheckAttrs({ env: "WIKI_STALE_CONFIRM_WIKIS", restart: "3010" })).toEqual({
      probes: [{ kind: "env", value: "WIKI_STALE_CONFIRM_WIKIS" }, { kind: "restart", value: "3010" }],
      on: null,
      problems: [],
    });
    expect(parseCheckAttrs({ migration: "086", checkout: "muninn", pushed: "claude-skills", on: "laptop, mini,laptop" })).toEqual({
      probes: [{ kind: "migration", value: "086" }, { kind: "checkout", value: "muninn" }, { kind: "pushed", value: "claude-skills" }],
      on: ["laptop", "mini"],
      problems: [],
    });
  });

  test("a value of the wrong shape is dropped with a problem; a blank one is missing", () => {
    const r = parseCheckAttrs({ migration: "86a", restart: "  ", env: "X" });
    expect(r.probes).toEqual([{ kind: "env", value: "X" }]);
    expect(r.problems).toEqual(['migration="86a" is not a schema_migrations version (digits); the probe is dropped']);
    expect(parseCheckAttrs({ env: "A B" }).probes).toEqual([]);
    expect(parseCheckAttrs({ env: "X", on: "laptop,,mini" }).on).toBeNull();
  });

  test("no probe at all is a problem, `on` alone included", () => {
    expect(parseCheckAttrs({}).problems).toEqual([`names no probe: give one of ${CHECK_PROBES.join(", ")}`]);
    expect(parseCheckAttrs({ on: "mini" }).problems).toHaveLength(1);
  });
});

describe("stepChecks", () => {
  test("every tag on a step, a code span's text excluded", () => {
    const checks = stepChecks(`**Do it.** ${ENV} and ${MIG} but not \`<Check env="NOPE" />\``);
    expect(checks.map((c) => c.probes.map((p) => `${p.kind}=${p.value}`))).toEqual([["env=WIKI_STALE_CONFIRM_WIKIS", "restart=3010"], ["migration=086"]]);
    expect(checks[1]!.on).toEqual(["laptop", "mini"]);
  });
});

describe("withoutChecks", () => {
  const text = (s: string) => withoutChecks(scanInlineComponents(s)).map((g) => (g.kind === "text" ? g.text : `[${g.name}]`)).join("");
  test("the tag and the spaces before it go; no doubled or leading space is left", () => {
    expect(text(`Restart. ${ENV}`)).toBe("Restart.");
    expect(text(`Restart ${ENV} then rest`)).toBe("Restart then rest");
    expect(text(`${ENV} Restart`)).toBe("Restart");
    expect(text(`a ${ENV} ${MIG} b`)).toBe("a b");
    expect(text(`a <Pill>x</Pill> ${ENV}`)).toBe("a [Pill]");
  });
});

describe("a step line carrying <Check>", () => {
  const before = page(moves("1. **Add the key and restart** to 3010\n2. Run the migration on both machines\n3. Read the result."));
  const after = page(moves(`1. **Add the key and restart** to 3010 ${ENV}\n2. Run the migration on both machines ${MIG}\n3. Read the result.`));

  test("is one step: the same count, and the same key for every untouched step", () => {
    const a = listYouSteps(before)!;
    const b = listYouSteps(after)!;
    expect(b.length).toBe(a.length);
    expect(b.map((s) => s.refusal)).toEqual([null, null, null]);
    // A key carries the page hash, so only the step index part compares across texts.
    expect(b.map((s) => s.key.split(".")[1])).toEqual(a.map((s) => s.key.split(".")[1]));
    expect(b[2]!.text).toBe(a[2]!.text);
  });

  test("Done removes the tag with its step, renumbers, and leaves no fragment", () => {
    const step = listYouSteps(after)![0]!;
    const r = stepDoneEdit(after, step.key);
    if (!r.ok) throw new Error(r.reason);
    expect(r.content).toBe(page(moves(`1. Run the migration on both machines ${MIG}\n2. Read the result.`)));
    expect(r.content).not.toContain("WIKI_STALE_CONFIRM_WIKIS");
    expect(r.removed).toEqual([{ line: 9, text: `1. **Add the key and restart** to 3010 ${ENV}` }]);
    const second = stepDoneEdit(r.content, listYouSteps(r.content)![0]!.key);
    if (!second.ok) throw new Error(second.reason);
    expect(second.content).toBe(page(moves("1. Read the result.")));
  });

  test("the Done log line and commit subject say no tag", () => {
    for (const step of listYouSteps(after)!.slice(0, 2)) {
      const r = stepDoneEdit(after, step.key);
      if (!r.ok) throw new Error(r.reason);
      const line = stepDoneLogLine(r);
      expect(line).not.toContain("<Check");
      expect(line).not.toMatch(/ {2}|\s$/);
    }
    const second = stepDoneEdit(after, listYouSteps(after)![1]!.key);
    expect(second.ok && stepDoneLogLine(second)).toBe("Step done: Run the migration on both machines");
  });

  test("the /plans step text, the lane peek and leadSentence say no tag", () => {
    expect(extractNextMoves(after)!.youSteps).toEqual(["Add the key and restart", "Run the migration on both machines", "Read the result."]);
    expect(leadSentence(`Restart ${ENV} then go`)).toBe("Restart then go");
    const html = formatWebHtml(after.split("\n").slice(4).join("\n"), { reader: true });
    const peek = /<span class="nm-peek"[^>]*>([^<]*)<\/span>/.exec(html);
    expect(peek?.[1]).toBe("Add the key and restart");
  });
});

describe("renderers", () => {
  const line = `1. **Add the key** and restart ${ENV}\n2. Run it ${MIG} today`;

  test("the reader gets an empty reader-only slot with the attributes; chat gets nothing", () => {
    const html = formatWebHtml(line, { reader: true });
    expect(html).toContain(`<span class="step-check" data-reader-only data-check-env="WIKI_STALE_CONFIRM_WIKIS" data-check-restart="3010"></span>`);
    expect(html).toContain(`<span class="step-check" data-reader-only data-check-migration="086" data-check-on="laptop,mini"></span>`);
    expect(html).not.toContain("&lt;Check");
    const chat = formatWebHtml(line);
    expect(chat).not.toContain("step-check");
    expect(chat).not.toContain("Check");
  });

  test("an attribute value is escaped in the slot", () => {
    expect(formatWebHtml(`x <Check env="A&B" />`, { reader: true })).toContain(`data-check-env="A&amp;B"`);
  });

  test("Slack, Telegram and email print nothing for it, with no doubled space", () => {
    for (const [name, out] of [
      ["slack", formatSlackMrkdwn(line)],
      ["telegram", formatTelegramHtml(line)],
      ["email", formatEmailHtml(line)],
    ] as const) {
      expect({ name, check: out.includes("Check") }).toEqual({ name, check: false });
      expect({ name, doubled: / {2}/.test(out.replace(/<[^>]*>/g, "")) }).toEqual({ name, doubled: false });
    }
    expect(formatSlackMrkdwn(line)).toContain("Run it today");
    expect(formatTelegramHtml(line)).toContain("Run it today");
    expect(formatEmailHtml(line)).toContain("Run it today");
  });

  test("on a line of its own it renders nothing anywhere", () => {
    const own = `Text above.\n\n${ENV}\n\nText below.`;
    for (const out of [formatWebHtml(own, { reader: true }), formatWebHtml(own), formatSlackMrkdwn(own), formatTelegramHtml(own), formatEmailHtml(own)]) {
      expect(out).not.toContain("Check");
      expect(out).not.toContain("WIKI_STALE");
    }
  });
});

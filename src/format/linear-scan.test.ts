import { describe, expect, test } from "bun:test";
import {
  replaceAngleLinks,
  replaceAnglePipeLinks,
  replaceDelimitedOnLine,
  replaceHtmlAnchors,
  replaceMarkdownLinks,
  replaceTagShapes,
  stripTagShapesNoNul,
} from "./linear-scan.ts";

/** A seeded PRNG, so a failure names a reproducible input. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random strings over the delimiters each matcher reads, plus filler. */
function randomInputs(alphabet: readonly string[], count: number, seed: number): string[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const n = Math.floor(r() * 24);
    let s = "";
    for (let k = 0; k < n; k++) s += alphabet[Math.floor(r() * alphabet.length)];
    return s;
  });
}

const show = (...parts: string[]) => `{${parts.join("|")}}`;

const CASES: { name: string; alphabet: string[]; regex: RegExp; linear: (s: string) => string; strip?: boolean }[] = [
  {
    name: "markdown link",
    alphabet: ["[", "]", "(", ")", "a", " ", "\n", "]("],
    regex: /\[([^\]]+)\]\(([^)]+)\)/g,
    linear: (s) => replaceMarkdownLinks(s, (_w, a, b) => show(a, b)),
  },
  {
    name: "angle pipe link",
    alphabet: ["<", ">", "|", "http://", "https://", "x", " ", "https:/", "\n"],
    regex: /<(https?:\/\/[^|>]+)\|([^>]+)>/g,
    linear: (s) => replaceAnglePipeLinks(s, (_w, a, b) => show(a, b)),
  },
  {
    name: "angle link",
    alphabet: ["<", ">", "|", "http://", "https://", "x", " ", "\n"],
    regex: /<(https?:\/\/[^>]+)>/g,
    linear: (s) => replaceAngleLinks(s, (_w, a) => show(a)),
  },
  {
    name: "tag shape",
    alphabet: ["<", ">", "a", "/", " ", "\n"],
    regex: /<([^>]+)>/g,
    linear: (s) => replaceTagShapes(s, (_w, a) => show(a)),
  },
  {
    name: "tag strip without NUL",
    alphabet: ["<", ">", "a", "/", "\x00", " "],
    regex: /<\/?[^>\x00]+>/g,
    linear: (s) => stripTagShapesNoNul(s),
    strip: true,
  },
  {
    name: "delimited on one line",
    alphabet: ["<b>", "</b>", "<", "b", ">", "x", "\n", "\r", " "],
    regex: /<b>(.*?)<\/b>/g,
    linear: (s) => replaceDelimitedOnLine(s, "<b>", "</b>", (_w, a) => show(a)),
  },
  {
    name: "html anchor",
    alphabet: ['<a href="', '"', ">", '">', "</a>", "x", "\n", "<"],
    regex: /<a href="([^"]+)">(.*?)<\/a>/g,
    linear: (s) => replaceHtmlAnchors(s, (_w, a, b) => show(a, b)),
  },
];

describe("linear matchers answer exactly what their regex answered", () => {
  for (const c of CASES) {
    test(c.name, () => {
      for (const input of randomInputs(c.alphabet, 4000, c.name.length * 7919)) {
        const expected = c.strip
          ? input.replace(c.regex, "")
          : input.replace(c.regex, (_w: string, ...rest: unknown[]) =>
              show(...(rest.filter((x) => typeof x === "string").slice(0, -1) as string[])),
            );
        expect({ input, out: c.linear(input) }).toEqual({ input, out: expected });
      }
    });
  }
});

describe("linear matchers stay linear on unclosed openers", () => {
  // Each regex these replace took seconds on 16k unclosed openers (the review's
  // shape); the bound is ~10x the measured linear time on a slow CI runner.
  const SHAPES: [string, () => void][] = [
    ["[ without ]", () => replaceMarkdownLinks("[a ".repeat(50_000), (w) => w)],
    ["[x]( without )", () => replaceMarkdownLinks("[x](a ".repeat(50_000), (w) => w)],
    ["<http without |", () => replaceAnglePipeLinks("<http://a ".repeat(50_000), (w) => w)],
    ["<http without >", () => replaceAngleLinks("<http://a ".repeat(50_000), (w) => w)],
    ["< without >", () => replaceTagShapes("<a ".repeat(50_000), (w) => w)],
    ["< without > (strip)", () => stripTagShapesNoNul("<a ".repeat(50_000))],
    ["<b> without </b>", () => replaceDelimitedOnLine("<b>a ".repeat(50_000), "<b>", "</b>", (w) => w)],
    ["<b> with </b> on the next line", () => replaceDelimitedOnLine(`${"<b>a ".repeat(50_000)}\n</b>`, "<b>", "</b>", (w) => w)],
    ['<a href=" without </a>', () => replaceHtmlAnchors('<a href="x">a '.repeat(50_000), (w) => w)],
  ];
  for (const [name, run] of SHAPES) {
    test(name, () => {
      const t = performance.now();
      run();
      expect(performance.now() - t).toBeLessThan(250);
    });
  }
});

describe("the three formatters on one long line of unclosed inline openers (F30)", async () => {
  const { formatWebHtml } = await import("../web/web-format.ts");
  const { formatTelegramHtml } = await import("../bot/telegram-format.ts");
  const { formatSlackMrkdwn } = await import("../slack/slack-format.ts");
  const formatters: [string, (s: string) => string][] = [
    ["web", (s) => formatWebHtml(s)],
    ["telegram", formatTelegramHtml],
    ["slack", formatSlackMrkdwn],
  ];
  // Token counts sized so the replaced regexes took seconds (16k `<http://a|b `
  // tokens: 3.6 s in formatWebHtml, 5.6 s in Slack); the linear matchers take
  // tens of ms, and the bound leaves a slow CI runner ~10x headroom.
  const SHAPES: [string, string, number][] = [
    ["unclosed [", "[a ", 64_000],
    ["unclosed ](", "[x](a ", 32_000],
    ["<http without >", "<http://a ", 16_000],
    ["<http| without >", "<http://a|b ", 16_000],
    ["unclosed <Fact>", "<Fact>a ", 32_000],
    ["unclosed <Pill", "<Pill ", 32_000],
    ["unclosed <b>", "<b>a ", 32_000],
    ['unclosed <a href="', '<a href="x">a ', 32_000],
  ];
  for (const [name, token, n] of SHAPES) {
    for (const [fmt, f] of formatters) {
      test(`${fmt}: ${name} x${n}`, () => {
        const line = token.repeat(n);
        const t = performance.now();
        f(line);
        expect(performance.now() - t).toBeLessThan(400);
      });
    }
  }
});

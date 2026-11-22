import { describe, expect, test } from "bun:test";
import { firstElementText, ldJsonBodies, openTags, tagsToSpaces, withoutBlocks, withoutComments, withoutLinkTargets } from "./html-scan.ts";

/** A seeded PRNG, so a failure names a reproducible input. */
function randomInputs(alphabet: readonly string[], count: number, seed: number): string[] {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: count }, () => {
    let out = "";
    const n = Math.floor(r() * 20);
    for (let k = 0; k < n; k++) out += alphabet[Math.floor(r() * alphabet.length)];
    return out;
  });
}

const MARKUP = ["<", ">", "/", "a", " ", "\n", "<style", "</style>", "</STYLE >", "<SCRIPT", "</script>", "<svg", "</svg>", "<styles", "<!--", "-->", "-", "<meta", "<title", "</title>", "<TITLE>"];

/** The regexes the readers replaced, as the oracle. */
const ORACLE = {
  tagsToSpaces: (h: string) => h.replace(/<[^>]*>/g, " "),
  withoutNonContent: (h: string) => h.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " "),
  withoutComments: (h: string) => h.replace(/<!--[\s\S]*?-->/g, " "),
  metaTags: (h: string) => [...h.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]),
  title: (h: string) => /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1],
  ldJson: (h: string) =>
    [...h.matchAll(/<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]!),
  linkTargets: (t: string) => t.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1"),
};

describe("each reader answers what its regex answered (random markup)", () => {
  const inputs = randomInputs(MARKUP, 5000, 1116);
  test("tagsToSpaces", () => {
    for (const h of inputs) expect({ h, o: tagsToSpaces(h) }).toEqual({ h, o: ORACLE.tagsToSpaces(h) });
  });
  test("withoutBlocks", () => {
    for (const h of inputs) {
      expect({ h, o: withoutBlocks(h, ["script", "style", "noscript", "template", "svg"]) }).toEqual({ h, o: ORACLE.withoutNonContent(h) });
    }
  });
  test("withoutComments", () => {
    for (const h of inputs) expect({ h, o: withoutComments(h) }).toEqual({ h, o: ORACLE.withoutComments(h) });
  });
  test("openTags", () => {
    for (const h of inputs) {
      expect({ h, o: [...openTags(h, /<meta\b/gi)].map((t) => h.slice(t.index, t.end)) }).toEqual({ h, o: ORACLE.metaTags(h) });
    }
  });
  test("firstElementText", () => {
    for (const h of inputs) expect({ h, o: firstElementText(h, "title") }).toEqual({ h, o: ORACLE.title(h) });
  });
  test("ldJsonBodies", () => {
    const ld = ["<script", " type=", '"application/ld+json"', "application/ld+json", "'", ">", "</script>", "</script >", "x", " ", "<", "{}"];
    for (const h of randomInputs(ld, 5000, 42)) expect({ h, o: ldJsonBodies(h) }).toEqual({ h, o: ORACLE.ldJson(h) });
  });
  test("ldJsonBodies, several openers inside one tag", () => {
    const ld = ["<script", "<script ", " type=", '"application/ld+json"', "application/ld+json", ">", "</script>", "x", " "];
    for (const h of randomInputs(ld, 5000, 1117)) expect({ h, o: ldJsonBodies(h) }).toEqual({ h, o: ORACLE.ldJson(h) });
  });
  test("withoutLinkTargets", () => {
    const md = ["[", "]", "(", ")", "a", " ", " ", "\n", "]("];
    for (const t of randomInputs(md, 5000, 7)) expect({ t, o: withoutLinkTargets(t) }).toEqual({ t, o: ORACLE.linkTargets(t) });
  });
});

describe("F59: each reader is linear on unclosed openers", () => {
  // 256 KB per shape; the replaced regexes took 1-2 s on 64 KB (quadratic, so
  // ~16-30 s here), the readers take a few ms. The bound leaves CI headroom.
  const KB256 = (token: string) => token.repeat(Math.ceil(262_144 / token.length));
  const SHAPES: [string, () => unknown][] = [
    ["<style without </style>", () => withoutBlocks(KB256("<style "), ["script", "style", "noscript", "template", "svg"])],
    ["<script without </script>", () => withoutBlocks(KB256("<script "), ["script", "style"])],
    ["<!-- without -->", () => withoutComments(KB256("<!--"))],
    ["< without >", () => tagsToSpaces(KB256("< "))],
    ["<meta without >", () => [...openTags(KB256("<meta "), /<meta\b/gi)]],
    ["<title> without </title>", () => firstElementText(KB256("<title>"), "title")],
    ["JSON-LD <script> without </script>", () => ldJsonBodies(KB256('<script type="application/ld+json">'))],
    // Fix round 1: each `<script ` opener before the one `>` re-read the whole
    // tag. 1 MB, since 256 KB took 347 ms: under the bound, quadratic or not.
    ["<script openers sharing one >", () => ldJsonBodies(`${"<script ".repeat(131_072)}>`)],
    ["[ without ]( ", () => withoutLinkTargets(KB256("[a "))],
    ["[x]( without )", () => withoutLinkTargets(KB256("[x](a"))],
  ];
  for (const [name, run] of SHAPES) {
    test(name, () => {
      const t = performance.now();
      run();
      expect(performance.now() - t).toBeLessThan(400);
    });
  }
});

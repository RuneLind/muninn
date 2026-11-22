import { describe, expect, test } from "bun:test";
import { scanWikilink, wikilinkRegExp } from "./wikilink-scan.ts";

const OLD_LABEL = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/g;
const OLD_PLAIN = /\[\[([^\]|\n]+?)(?:\|[^\]\n]*?)?\]\]/g;

/** A deterministic PRNG, so a failure names a reproducible case. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ALPHABET = ["[", "[", "[[", "]", "]]", "|", "\n", "a", "b", " ", "#", "é", "😀"];
function randomText(next: () => number): string {
  const n = Math.floor(next() * 40);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

const shape = (m: RegExpMatchArray) => JSON.stringify([m.index, ...m]);

describe("wikilinkRegExp matches as the regex it replaces", () => {
  test("20 000 random wikilink-ish texts: matchAll, replace and a sticky exec agree, both kinds", () => {
    const next = rng(1116);
    const diffs: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const s = randomText(next);
      for (const [kind, old] of [["label", OLD_LABEL], ["plain", OLD_PLAIN]] as const) {
        const linear = wikilinkRegExp(kind);
        const a = [...s.matchAll(old)].map(shape).join();
        const b = [...s.matchAll(linear)].map(shape).join();
        if (a !== b) diffs.push(`${kind} matchAll ${JSON.stringify(s)}`);
        const fn = (...args: unknown[]) => JSON.stringify(args);
        if (s.replace(old, fn) !== s.replace(linear, fn)) diffs.push(`${kind} replace ${JSON.stringify(s)}`);
        if (new RegExp(old.source).test(s) !== wikilinkRegExp(kind, "").test(s)) diffs.push(`${kind} test ${JSON.stringify(s)}`);
        const oldY = new RegExp(old.source, "y");
        const newY = wikilinkRegExp(kind, "y");
        for (let at = 0; at <= s.length; at++) {
          oldY.lastIndex = newY.lastIndex = at;
          const x = oldY.exec(s);
          const y = newY.exec(s);
          if ((x && shape(x)) !== (y && shape(y)) || oldY.lastIndex !== newY.lastIndex) diffs.push(`${kind} sticky@${at} ${JSON.stringify(s)}`);
        }
      }
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });

  test("ordinary links", () => {
    const s = "See [[Page]], [[Other|the other]] and [[x|]] but not [[|y]], [[a\nb]] or [[a]x]].";
    expect([...s.matchAll(wikilinkRegExp("label"))].map((m) => [m[1], m[2]])).toEqual([
      ["Page", undefined],
      ["Other", "the other"],
      ["x", ""],
    ]);
    expect(scanWikilink("[[[a]]", 0)).toEqual({ index: 0, end: 6, target: "[a", label: undefined });
  });

  test("a foreign pattern is refused", () => {
    const Ctor = wikilinkRegExp("label").constructor as RegExpConstructor;
    expect(() => new Ctor("x", "g")).toThrow("not a wikilink pattern");
    expect(new Ctor(wikilinkRegExp("plain"), "y").sticky).toBe(true);
  });
});

describe("linear time on the shapes that were quadratic", () => {
  const time = (s: string) => {
    const t0 = performance.now();
    s.replace(wikilinkRegExp("label"), "x");
    [...s.matchAll(wikilinkRegExp("plain"))];
    return performance.now() - t0;
  };
  // Measured on the regex (renderWikiHtml): 3,475 ms for 64k `[`, 816 ms for `[[a ` × 16k.
  test("64k `[`, `[[a ` and `[[a|` repeated each scan in well under 100 ms", () => {
    for (const s of ["[".repeat(65_536), "[[a ".repeat(16_384), "[[a|".repeat(16_384), "[[a|b]".repeat(11_000)]) expect(time(s)).toBeLessThan(100);
  });
});

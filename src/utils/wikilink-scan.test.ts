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

  // A sticky call at every start (`collapseForLocate`, and `split`, which runs
  // a sticky copy at every position): 2,617 ms for `split` on 64k `[` at ae0772b1.
  test("sticky exec at every start and split, on 64k `[`, `[[a|` and `a` and 256k `[a`, each in well under 300 ms", () => {
    for (const s of ["[".repeat(65_536), "[[a|".repeat(16_384), "[[a ".repeat(16_384), "a".repeat(65_536), `${"[a".repeat(131_072)}[[x]]`]) {
      const t0 = performance.now();
      const y = wikilinkRegExp("label", "y");
      for (let at = 0; at < s.length; at++) {
        y.lastIndex = at;
        y.exec(s);
      }
      s.split(wikilinkRegExp("plain"));
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });

  test("one sticky instance alternating between texts and positions agrees with the regex", () => {
    const next = rng(1123);
    const oldY = new RegExp(OLD_LABEL.source, "y");
    const newY = wikilinkRegExp("label", "y");
    const diffs: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const texts = [randomText(next), randomText(next)];
      for (let n = 0; n < 40; n++) {
        const s = texts[Math.floor(next() * 2)]!;
        const at = Math.floor(next() * (s.length + 1));
        oldY.lastIndex = newY.lastIndex = at;
        const x = oldY.exec(s);
        const y = newY.exec(s);
        if ((x && shape(x)) !== (y && shape(y))) diffs.push(`@${at} ${JSON.stringify(s)}`);
      }
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });

  test("split agrees with the regex on 5 000 random texts, both kinds", () => {
    const next = rng(1122);
    const diffs: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      const s = randomText(next);
      for (const [kind, old] of [["label", OLD_LABEL], ["plain", OLD_PLAIN]] as const) {
        if (JSON.stringify(s.split(old)) !== JSON.stringify(s.split(wikilinkRegExp(kind)))) diffs.push(`${kind} ${JSON.stringify(s)}`);
      }
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });
});

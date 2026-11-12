/** The `.env` key-name parser: which keys are set, which blank, and that no value can leave it. */
import { describe, expect, test } from "bun:test";
import { envFileKeyNames } from "./env-names.ts";

const names = (text: string) => {
  const r = envFileKeyNames(text);
  return { set: [...r.set].sort(), blank: [...r.blank].sort() };
};

describe("envFileKeyNames", () => {
  test("plain, exported, spaced and indented keys with values are set", () => {
    expect(names("A=1\nexport B=two\nC = three\n  D=4\n")).toEqual({ set: ["A", "B", "C", "D"], blank: [] });
  });

  test("comment lines and commented-out keys are no keys", () => {
    expect(names("# A=1\n  # B=2\n#C=3\nD=4")).toEqual({ set: ["D"], blank: [] });
  });

  test("an empty value, empty quotes and a comment-only value are blank", () => {
    expect(names('A=\nB=""\nC=\'\'\nD= # nothing\nE=   \nF=``')).toEqual({ set: [], blank: ["A", "B", "C", "D", "E", "F"] });
  });

  test("KEY= with a value on a later line is blank: an unquoted value never runs on", () => {
    expect(names("A=\nsecret-on-its-own-line\nB=x")).toEqual({ set: ["B"], blank: ["A"] });
  });

  test("CRLF and a lone CR end lines", () => {
    expect(names("A=1\r\nB=\r\nC=3\rD=4")).toEqual({ set: ["A", "C", "D"], blank: ["B"] });
  });

  test("a value holding = and quotes counts once, for its own key", () => {
    expect(names('A=postgres://u:p@h/db?x=1&y=2\nB="k=v"\nC=\'a=b\'')).toEqual({ set: ["A", "B", "C"], blank: [] });
  });

  test("a later line for the same key wins", () => {
    expect(names("A=1\nA=\nB=\nB=2")).toEqual({ set: ["B"], blank: ["A"] });
  });

  test("a quoted value spanning lines hides the KEY= lines inside it", () => {
    expect(names('A="line one\nB=inside\nlast"\nC=1')).toEqual({ set: ["A", "C"], blank: [] });
    expect(names("A='\n'\nC=1")).toEqual({ set: ["C"], blank: ["A"] });
    // Never closed: blank, and the rest of the file is inside it.
    expect(names('A="open\nB=2')).toEqual({ set: [], blank: ["A"] });
  });

  test("lines that are not assignments are skipped", () => {
    expect(names("just text\n1A=no\nA-B=no\n=x\nOK=1")).toEqual({ set: ["OK"], blank: [] });
  });

  test("no value substring appears anywhere in the result", () => {
    const values = ["s3cr3t-value", "postgres://user:pa55@host/db", "multi\nline-val", "k=v"];
    const text = `A=${values[0]}\nexport B="${values[1]}"\nC="${values[2]}"\nD='${values[3]}'\n`;
    const out = JSON.stringify(names(text));
    for (const v of values) for (const part of v.split(/\n/)) expect(out).not.toContain(part);
    expect(out).toBe(JSON.stringify({ set: ["A", "B", "C", "D"], blank: [] }));
  });
});

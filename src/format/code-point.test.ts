import { describe, expect, test } from "bun:test";
import { codePointText } from "./code-point.ts";

describe("codePointText reads a numeric reference as the HTML parser does", () => {
  test("U+0080–U+009F read as windows-1252; its five holes stay as they are", () => {
    expect(codePointText(128)).toBe("€");
    expect(codePointText(0x96)).toBe("–");
    expect(codePointText(0x92)).toBe("’");
    expect(codePointText(0x9f)).toBe("Ÿ");
    expect(codePointText(0x81)).toBe("\u0081");
    expect(codePointText(0x9d)).toBe("\u009d");
  });

  test("no scalar value reads U+FFFD; the rest are themselves", () => {
    for (const n of [0, 0xd800, 0xdfff, 0x110000]) expect(codePointText(n)).toBe("�");
    expect(codePointText(0x7f)).toBe("\u007f");
    expect(codePointText(0xa0)).toBe(" ");
    expect(codePointText(0x1f4c4)).toBe("📄");
  });
});

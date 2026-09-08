/**
 * The font-free label renderer, over the bytes it actually produces.
 *
 * There is no image library and no ffmpeg here on purpose: the whole point of
 * `label.ts` is that a cell caption is arithmetic over a glyph table, so the
 * test is arithmetic too — an inked pixel is 255, a background pixel is 0, and
 * the PGM header is three lines of ASCII.
 */
import { test, expect, describe } from "bun:test";
import {
  GLYPHS,
  GLYPH_GAP,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  assertGlyphTable,
  renderLabelStrip,
  renderTextBitmap,
  textBitmapWidth,
  toPgm,
} from "./label.ts";

/** The bitmap as `#`/`.` rows, which is the shape the glyph table is written in. */
function rowsOf(bitmap: { width: number; height: number; pixels: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < bitmap.height; y++) {
    let row = "";
    for (let x = 0; x < bitmap.width; x++) row += bitmap.pixels[y * bitmap.width + x] === 255 ? "#" : ".";
    out.push(row);
  }
  return out;
}

describe("renderTextBitmap", () => {
  test("a digit renders as its own glyph, pixel for pixel", () => {
    // At scale 1 the plane IS the table entry, so a transposed or shifted blit
    // is visible rather than inferred. The expected rows are SPELLED OUT rather
    // than read back out of `GLYPHS`: comparing the render against the table it
    // rendered from is a tautology that a garbled glyph passes — and a garbled
    // digit is a wrong second under a cell, which is the whole failure here.
    const bitmap = renderTextBitmap("7", 1);
    expect(bitmap.width).toBe(GLYPH_WIDTH);
    expect(bitmap.height).toBe(GLYPH_HEIGHT);
    expect(rowsOf(bitmap)).toEqual([
      "#####",
      "....#",
      "...#.",
      "..#..",
      ".#...",
      ".#...",
      ".#...",
    ]);
    // …and that IS the shipped glyph, so the table and the renderer agree too.
    expect([...GLYPHS["7"]!]).toEqual(rowsOf(bitmap));
  });

  test("scaling squares every pixel rather than resampling", () => {
    const bitmap = renderTextBitmap("1", 3);
    expect(bitmap.width).toBe(GLYPH_WIDTH * 3);
    expect(bitmap.height).toBe(GLYPH_HEIGHT * 3);
    const rows = rowsOf(bitmap);
    // The glyph's first row, `..#..`, becomes three identical rows of `......###......`.
    expect(rows[0]).toBe("......###......");
    expect(rows[1]).toBe(rows[0]);
    expect(rows[2]).toBe(rows[0]);
    // Every value is ink or background — an interpolated edge would be neither.
    expect(new Set(bitmap.pixels).size).toBeLessThanOrEqual(2);
    for (const v of bitmap.pixels) expect(v === 0 || v === 255).toBe(true);
  });

  test("glyphs are laid out left to right with one gap between them", () => {
    const bitmap = renderTextBitmap("11", 1);
    expect(bitmap.width).toBe(GLYPH_WIDTH * 2 + GLYPH_GAP);
    expect(textBitmapWidth("11", 1)).toBe(bitmap.width);
    // `..#..` `.` `..#..` — the gap column is background, and the second glyph
    // starts after it rather than on top of the first.
    expect(rowsOf(bitmap)[0]).toBe("..#.....#..");
  });

  test("a character with no glyph throws rather than rendering a hole", () => {
    // A blank where a digit should be is a cell whose second the model reads
    // wrong and confidently — the failure the labels exist to remove.
    expect(() => renderTextBitmap("#1 x", 3)).toThrow(/No glyph for "x"/);
  });

  test("a non-integer scale is refused", () => {
    expect(() => renderTextBitmap("1", 1.5)).toThrow(/positive integer/);
    expect(() => renderTextBitmap("1", 0)).toThrow(/positive integer/);
  });
});

describe("the glyph table", () => {
  test("every glyph is exactly one 5x7 cell", () => {
    // The module runs this at load; running it here is what makes the assertion
    // a test rather than a comment.
    expect(() => assertGlyphTable(GLYPHS)).not.toThrow();
  });

  test("a short row is refused rather than read as `undefined`", () => {
    expect(() => assertGlyphTable({ "0": ["####", ".....", ".....", ".....", ".....", ".....", "....."] })).toThrow(
      /4 columns, not 5/,
    );
    expect(() => assertGlyphTable({ "0": ["....."] })).toThrow(/1 rows, not 7/);
  });

  test("it covers exactly what a cell label can contain", () => {
    // `cellLabelText` produces `#<n> HH:MM:SS` and nothing else; a missing entry
    // would be a throw on a real capture, i.e. a `sheets_failed` fallback.
    for (const ch of "0123456789:# ") expect(GLYPHS[ch]).toBeDefined();
  });
});

describe("renderLabelStrip", () => {
  test("the text sits at the left inset, vertically centred, on black", () => {
    const strip = renderLabelStrip({ text: "1", width: 40, height: 20, scale: 2, padX: 4 });
    expect(strip.width).toBe(40);
    expect(strip.height).toBe(20);
    expect(strip.pixels).toHaveLength(40 * 20);
    const rows = rowsOf(strip);
    // 7 rows at scale 2 is 14 px in a 20 px strip: 3 blank rows above and below.
    expect(rows.slice(0, 3).every((r) => !r.includes("#"))).toBe(true);
    expect(rows.slice(17).every((r) => !r.includes("#"))).toBe(true);
    // The first inked row is the glyph's own first row (`..#..`, each pixel
    // doubled), offset from the left edge by padX and background either side.
    expect(rows[3]).toBe(".".repeat(4) + "....##...." + ".".repeat(26));
  });

  test("a run that does not fit throws rather than clipping the second", () => {
    expect(() => renderLabelStrip({ text: "#12 00:02:10", width: 60, height: 30, scale: 3, padX: 6 })).toThrow(
      /does not fit/,
    );
    expect(() => renderLabelStrip({ text: "1", width: 40, height: 10, scale: 3, padX: 4 })).toThrow(
      /does not fit/,
    );
  });
});

describe("toPgm", () => {
  test("a binary P5 header followed by the plane verbatim", () => {
    const bitmap = renderTextBitmap("1", 1);
    const pgm = toPgm(bitmap);
    const header = `P5\n${GLYPH_WIDTH} ${GLYPH_HEIGHT}\n255\n`;
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header);
    expect(pgm).toHaveLength(header.length + GLYPH_WIDTH * GLYPH_HEIGHT);
    expect([...pgm.subarray(header.length)]).toEqual([...bitmap.pixels]);
  });

  test("a plane whose byte count disagrees with its size is refused", () => {
    expect(() => toPgm({ width: 4, height: 4, pixels: new Uint8Array(15) })).toThrow(/16 bytes; got 15/);
  });
});

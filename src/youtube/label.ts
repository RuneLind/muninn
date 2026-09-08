/**
 * A font-free bitmap label — the glyphs burned under each contact-sheet cell.
 *
 * **Why this exists at all.** The selection pass reads a 4×3 grid of frames and
 * answers with a second per frame, and the mapping from a grid position to a
 * second used to live only in the PROSE beside the sheet ("9. t=00:02:10 (130)",
 * row-major). Measured on the reference video, the model could not apply it:
 * on both `detailed` runs of fix round 1 the manifest called second 170 "the
 * coding-agent usage chart" when 170 is the experiment-velocity chart, 175 and
 * 180 "charts" when both are plain article text, and 130 a text excerpt when it
 * is the usage-growth chart. The sheet image and the prose list were each
 * verified correct; what failed was counting cells.
 *
 * **Why a hand-coded font.** ffmpeg's `drawtext` needs a build with libfreetype,
 * and this machine's ffmpeg and the container images have none
 * (`ffmpeg -filters | grep drawtext` finds nothing), so a sheet drawn with it is
 * a sheet that fails to build on exactly the hosts that matter. A 5×7 glyph
 * table scaled by an integer factor needs no font, no image library and no
 * dependency: it renders to a raw grayscale plane that ffmpeg reads as an
 * ordinary input.
 *
 * The output is a **binary PGM** (`P5`) because it is the smallest raster format
 * ffmpeg reads with no options: a three-line ASCII header and one byte per
 * pixel. White text on black, which is what survives being scaled and JPEG'd
 * into a sheet.
 *
 * Nothing here does I/O and nothing here knows what a label SAYS — the text is
 * `cellLabelText` in `scan.ts`, beside the prompt that describes it.
 */

/** Glyph cell width, in unscaled pixels. */
export const GLYPH_WIDTH = 5;
/** Glyph cell height, in unscaled pixels. */
export const GLYPH_HEIGHT = 7;
/** Unscaled pixels between two glyphs; not added after the last one. */
export const GLYPH_GAP = 1;

/**
 * The 5×7 glyph table — `#` is an inked pixel, `.` is background.
 *
 * Exactly the characters {@link cellLabelText}'s output can contain: the digits,
 * the `:` of `HH:MM:SS`, the `#` that opens the label and the space between the
 * two halves. An unrendered character THROWS ({@link renderTextBitmap}) rather
 * than rendering blank — a label with a hole in it is a cell the model would
 * read the wrong second off, which is the failure this whole module is for.
 */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", ".#.#.", "#####", ".#.#."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

/**
 * Refuse a glyph table whose rows are not {@link GLYPH_HEIGHT} strings of
 * {@link GLYPH_WIDTH} characters.
 *
 * {@link renderTextBitmap} walks a glyph at `row[x]`, so a short row reads
 * `undefined`, inks nothing, and produces a label that is silently missing part
 * of a digit — a wrong second under a cell, which is worse than no label.
 * Called at module load, so a typo in the table above cannot ship.
 */
export function assertGlyphTable(table: Readonly<Record<string, readonly string[]>>): void {
  for (const [ch, rows] of Object.entries(table)) {
    if (rows.length !== GLYPH_HEIGHT) {
      throw new Error(`Glyph ${JSON.stringify(ch)} has ${rows.length} rows, not ${GLYPH_HEIGHT}`);
    }
    for (const row of rows) {
      if (row.length !== GLYPH_WIDTH) {
        throw new Error(
          `Glyph ${JSON.stringify(ch)} has a row of ${row.length} columns, not ${GLYPH_WIDTH}`,
        );
      }
    }
  }
}

assertGlyphTable(GLYPHS);

/** A rendered run of text: a grayscale plane and the size it was drawn at. */
export interface TextBitmap {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, row-major — 255 where the glyph is inked, 0 elsewhere. */
  readonly pixels: Uint8Array;
}

/**
 * The width a run of text occupies at `scale`, in pixels.
 *
 * `n` glyphs of `GLYPH_WIDTH` with a gap BETWEEN them and none after the last,
 * so a one-character label is exactly one glyph wide. Exported because the strip
 * builder centres nothing and the caller may want to know before it commits to a
 * cell width.
 */
export function textBitmapWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * (GLYPH_WIDTH + GLYPH_GAP) - GLYPH_GAP) * scale;
}

/**
 * Draw `text` as a grayscale plane, each glyph pixel a `scale`×`scale` square.
 *
 * Integer scaling only — there is no filtering here and none is wanted: a hard
 * blocky glyph is what survives being tiled into a sheet and re-encoded as JPEG,
 * while an interpolated one turns to mush at the sizes involved.
 */
export function renderTextBitmap(text: string, scale: number): TextBitmap {
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error(`The label scale must be a positive integer, got ${scale}`);
  }
  const width = textBitmapWidth(text, scale);
  const height = GLYPH_HEIGHT * scale;
  const pixels = new Uint8Array(Math.max(0, width) * height);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const glyph = GLYPHS[ch];
    if (glyph === undefined) {
      throw new Error(`No glyph for ${JSON.stringify(ch)} in a contact-sheet label`);
    }
    const originX = i * (GLYPH_WIDTH + GLYPH_GAP) * scale;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      const row = glyph[gy]!;
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (row[gx] !== "#") continue;
        for (let sy = 0; sy < scale; sy++) {
          const y = gy * scale + sy;
          for (let sx = 0; sx < scale; sx++) {
            pixels[y * width + originX + gx * scale + sx] = 255;
          }
        }
      }
    }
  }
  return { width, height, pixels };
}

/**
 * Wrap a grayscale plane in a binary PGM (`P5`) header.
 *
 * The header is `P5\n<w> <h>\n255\n` and the body is the plane verbatim — one
 * byte per pixel, no padding, no rows in reverse. ffmpeg reads it through the
 * ordinary `image2` demuxer, so a strip is just another `-i`.
 */
export function toPgm(bitmap: TextBitmap): Uint8Array {
  const expected = bitmap.width * bitmap.height;
  if (bitmap.pixels.length !== expected) {
    throw new Error(
      `A ${bitmap.width}x${bitmap.height} plane is ${expected} bytes; got ${bitmap.pixels.length}`,
    );
  }
  const header = new TextEncoder().encode(`P5\n${bitmap.width} ${bitmap.height}\n255\n`);
  const out = new Uint8Array(header.length + bitmap.pixels.length);
  out.set(header, 0);
  out.set(bitmap.pixels, header.length);
  return out;
}

/**
 * Draw `text` left-aligned into a `width`×`height` black strip.
 *
 * The text is placed at `padX` from the left and centred vertically. A run that
 * does not FIT throws rather than clipping: a label reading `#1 00:02:1` is a
 * cell whose second the model would answer with, wrong, and confidently.
 */
export function renderLabelStrip(input: {
  text: string;
  width: number;
  height: number;
  scale: number;
  padX: number;
}): TextBitmap {
  const { text, width, height, scale, padX } = input;
  const glyphs = renderTextBitmap(text, scale);
  if (glyphs.width + 2 * padX > width || glyphs.height > height) {
    throw new Error(
      `A ${glyphs.width}x${glyphs.height} label does not fit a ${width}x${height} strip ` +
        `with ${padX}px of padding: ${JSON.stringify(text)}`,
    );
  }
  const pixels = new Uint8Array(width * height);
  const originY = Math.floor((height - glyphs.height) / 2);
  for (let y = 0; y < glyphs.height; y++) {
    pixels.set(glyphs.pixels.subarray(y * glyphs.width, (y + 1) * glyphs.width), (originY + y) * width + padX);
  }
  return { width, height, pixels };
}

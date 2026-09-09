/**
 * `src/summaries/transcript-split.ts` — the two things a capture RE-RUN has to
 * get right before it can send a stored document back to the model.
 *
 * The split is the export's own rule, moved; `export.test.ts` still pins it
 * against the client copy's fixtures, so what THIS file adds is the two
 * properties only the re-run depends on: a `## Transcript` line inside a fenced
 * code block is not a boundary, and a frontmatter value survives a round trip
 * BYTE for byte — including huginn's bare `duration_sec: 3180`, which the wiki
 * store's own parser cannot tell from a quoted `"3180"`.
 *
 * Every fixture here is invented. This repo is public.
 */

import { test, expect, describe } from "bun:test";
import {
  splitTranscript,
  transcriptIsWindowed,
  parseCaptureFrontmatter,
  decodeFrontmatterScalar,
  encodeFrontmatterScalar,
} from "./transcript-split.ts";

describe("splitTranscript", () => {
  test("splits at the first level-2 heading and hands back what follows it", () => {
    const doc = "Body line.\n\n## Transcript\n\n### [00:00:00]\n\nHello.\n";
    const { body, transcript } = splitTranscript(doc);
    expect(body).toBe("Body line.\n");
    expect(transcript).toBe("\n### [00:00:00]\n\nHello.\n");
  });

  test("a document with no such heading has no transcript", () => {
    const { body, transcript } = splitTranscript("Just a summary.\n");
    expect(transcript).toBeNull();
    expect(body).toBe("Just a summary.\n");
  });

  test("a `## Transcript` line INSIDE a fenced block is not the boundary", () => {
    // The naive `indexOf("\n## Transcript")` this replaced took the quoted line,
    // which would have re-summarized a document from a code sample and then
    // re-ingested the real transcript as if it were the summary.
    const doc = [
      "Body.",
      "",
      "```markdown",
      "## Transcript",
      "```",
      "",
      "## Transcript",
      "",
      "the real one",
      "",
    ].join("\n");
    const { body, transcript } = splitTranscript(doc);
    expect(body).toContain("```markdown");
    expect(body).not.toContain("the real one");
    expect(transcript).toBe("\nthe real one\n");
  });

  test("a tilde fence is closed only by tildes", () => {
    const doc = ["~~~", "```", "## Transcript", "~~~", "", "## Transcript", "", "real", ""].join("\n");
    expect(splitTranscript(doc).transcript).toBe("\nreal\n");
  });

  test("a heading with trailing spaces still splits; a deeper one does not", () => {
    expect(splitTranscript("a\n## Transcript  \nb").transcript).toBe("b");
    expect(splitTranscript("a\n### Transcript\nb").transcript).toBeNull();
  });
});

describe("transcriptIsWindowed", () => {
  test("`### [HH:MM:SS]` headings make it windowed", () => {
    expect(transcriptIsWindowed("### [00:02:00]\n\nspeech")).toBe(true);
  });

  test("a flat wall of text is not", () => {
    expect(transcriptIsWindowed("speech speech speech")).toBe(false);
  });

  test("a window heading quoted inside a fence does not count", () => {
    // Deriving `windowed` from a fenced example would put the "the headings are
    // positions" rider on a prompt whose transcript has none.
    expect(transcriptIsWindowed("```\n### [00:02:00]\n```\n\nflat text")).toBe(false);
  });

  test("a bare `[MM:SS]` cue is not a window heading", () => {
    expect(transcriptIsWindowed("### [02:00]\n\nspeech")).toBe(false);
  });
});

describe("parseCaptureFrontmatter", () => {
  const DOC = [
    "---",
    'date: "2026-09-01"',
    'url: "https://example.invalid/talk/1"',
    'vimeo_video_id: "1"',
    'caption_lang: "no-x-autogen"',
    'caption_kind: "auto"',
    'summary_kind: "standard"',
    'summary_lang: "nb"',
    'author: "Example Conf"',
    'upload_date: "2026-08-01T09:00:00+00:00"',
    'speaker: "A Speaker"',
    'thumbnail_url: "https://example.invalid/p.jpg"',
    "duration_sec: 3180",
    'category: "ai/general"',
    'tags: "ai, general"',
    "---",
    "",
    "Summary body.",
    "",
    "## Transcript",
    "",
    "### [00:00:00]",
    "",
    "Hello.",
    "",
  ].join("\n");

  test("every key is read in FILE order with its raw text intact", () => {
    const fm = parseCaptureFrontmatter(DOC);
    expect(fm.present).toBe(true);
    expect(fm.entries.map((e) => e.key)).toEqual([
      "date", "url", "vimeo_video_id", "caption_lang", "caption_kind",
      "summary_kind", "summary_lang", "author", "upload_date", "speaker",
      "thumbnail_url", "duration_sec", "category", "tags",
    ]);
    expect(fm.byKey.duration_sec).toBe("3180");
    expect(fm.byKey.url).toBe('"https://example.invalid/talk/1"');
  });

  test("the body starts at the summary, not at the closing marker", () => {
    expect(parseCaptureFrontmatter(DOC).body.startsWith("Summary body.")).toBe(true);
  });

  test("EVERY value round-trips BYTE for byte, the bare integer included", () => {
    // The property the re-run's ingest rests on: `encode(decode(raw)) === raw`
    // for every value huginn's own writer emits. Without the bare-integer half,
    // a re-run would write `duration_sec: "3180"` and the frontmatter would
    // differ on a run that is supposed to change one field.
    const fm = parseCaptureFrontmatter(DOC);
    expect(fm.entries.length).toBe(14);
    for (const { key, raw } of fm.entries) {
      expect({ key, out: encodeFrontmatterScalar(decodeFrontmatterScalar(raw)) }).toEqual({ key, out: raw });
    }
  });

  test("the bare integer decodes to a NUMBER and a quoted one to a string", () => {
    expect(decodeFrontmatterScalar("3180")).toBe(3180);
    expect(decodeFrontmatterScalar('"3180"')).toBe("3180");
    expect(encodeFrontmatterScalar("3180")).toBe('"3180"');
    expect(encodeFrontmatterScalar(3180)).toBe("3180");
  });

  test("an escaped quote and an escaped backslash round-trip", () => {
    const raw = '"He said \\"hi\\" and a \\\\ slash"';
    expect(decodeFrontmatterScalar(raw)).toBe('He said "hi" and a \\ slash');
    expect(encodeFrontmatterScalar(decodeFrontmatterScalar(raw))).toBe(raw);
  });

  test("an integer past 2^53 stays a STRING rather than becoming another number", () => {
    const raw = "9007199254740993";
    expect(decodeFrontmatterScalar(raw)).toBe(raw);
    // …and therefore re-encodes as a quoted value rather than as a wrong number.
    expect(encodeFrontmatterScalar(decodeFrontmatterScalar(raw))).toBe(`"${raw}"`);
  });

  test("a text with no block, or an unterminated one, parses to nothing", () => {
    expect(parseCaptureFrontmatter("no block here").present).toBe(false);
    expect(parseCaptureFrontmatter("---\ndate: \"x\"\nstill open").present).toBe(false);
    expect(parseCaptureFrontmatter("no block here").body).toBe("no block here");
  });
});

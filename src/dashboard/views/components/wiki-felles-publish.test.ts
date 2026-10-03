import { describe, expect, test } from "bun:test";
import {
  fellesBtnHtml,
  fellesOutcomeLine,
  fellesOutputHtml,
  fellesPublishCommand,
  shellQuote,
} from "./wiki-felles-publish.ts";

describe("fellesPublishCommand", () => {
  test("reproduces the manual command", () => {
    expect(
      fellesPublishCommand({
        bin: "/n/muninn-nais/scripts/publiser-felles-wiki.ts",
        root: "/Users/rune/source/nav/melosys-kode-wiki",
        relPath: "plans/2026-09-29-vedtaksmetadata-fagavklaring.mdx",
        allowIdent: true,
      }),
    ).toBe(
      "bun /n/muninn-nais/scripts/publiser-felles-wiki.ts --tillat-ident /Users/rune/source/nav/melosys-kode-wiki plans/2026-09-29-vedtaksmetadata-fagavklaring.mdx",
    );
  });

  test("quotes what a shell would split", () => {
    expect(fellesPublishCommand({ bin: "/b.ts", root: "/w w", relPath: "x/it's.md", allowIdent: false, dryRun: true })).toBe(
      "bun /b.ts --dry-run '/w w' 'x/it'\\''s.md'",
    );
  });
});

test("shellQuote leaves plain tokens bare", () => {
  expect(shellQuote("plans/a-b_c.mdx")).toBe("plans/a-b_c.mdx");
  expect(shellQuote("a$b")).toBe("'a$b'");
});

test("each exit code has its own line", () => {
  expect(fellesOutcomeLine(0, true).ok).toBe(true);
  expect(fellesOutcomeLine(0, false).text).toMatch(/^Published/);
  for (const code of [1, 2, 3, 9]) expect(fellesOutcomeLine(code, false).ok).toBe(false);
});

test("exit 1 claims nothing the code cannot know", () => {
  // Exit 1 is the scanner's refusal AND any crash of the script (an uncaught
  // exception, a missing module), which can land after an upload succeeded.
  const line = fellesOutcomeLine(1, false).text;
  expect(line).not.toMatch(/nothing was uploaded/);
  expect(line).toMatch(/failed/);
});

test("the copied command carries the bucket the button would use", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: true, bucket: "b-1" })).toBe(
    "FELLES_WIKI_BUCKET=b-1 bun /b.ts --tillat-ident /w a.md",
  );
});

test("the bucket prefix is shell-quoted", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: false, bucket: "x;rm -rf ~" })).toBe(
    "FELLES_WIKI_BUCKET='x;rm -rf ~' bun /b.ts /w a.md",
  );
});

test("a dash-led relPath is copied as a path", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "-x.md", allowIdent: false })).toBe(
    "bun /b.ts /w ./-x.md",
  );
});

test("output is escaped, and https addresses become links", () => {
  expect(fellesOutputHtml("<b> https://x.nav.no/wiki?wiki=a&relPath=b")).toBe(
    '&lt;b&gt; <a href="https://x.nav.no/wiki?wiki=a&amp;relPath=b" target="_blank" rel="noopener">https://x.nav.no/wiki?wiki=a&amp;relPath=b</a>',
  );
});

test("the button carries its page's relPath, escaped", () => {
  expect(fellesBtnHtml('a"b.md')).toContain('data-felles-relpath="a&quot;b.md"');
});

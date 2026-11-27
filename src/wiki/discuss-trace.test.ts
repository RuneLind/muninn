import { describe, expect, test } from "bun:test";
import { PACK_SECTION_MAX } from "./discuss-pack.ts";
import { KEY_MENTIONS_MAX, keyMentionsSection, renderTraceTurnPrompt, traceContextPack } from "./discuss-trace.ts";
import type { MentionsBody } from "./mentions.ts";

const body = (over: Partial<MentionsBody> = {}): MentionsBody => ({
  key: "MEL-77",
  kind: "case",
  files: [{ relPath: "plans/ferry.mdx", title: "Ferry plan", lines: [{ n: 12, text: "The ferry case MEL-77 is open." }] }],
  commits: [{ sha: "abcdef0123456789", date: "2026-11-20T10:00:00+01:00", subject: "Ferry plan names MEL-77", files: ["plans/ferry.mdx"] }],
  log: [{ date: "2026-11-20", kind: "plan", line: "- MEL-77 was filed.", n: 40 }],
  prs: [
    { repo: "acme/acme-api", number: 3, state: "merged", mergedAt: "2026-11-21T08:00:00Z", url: "https://github.com/acme/acme-api/pull/3", stale: false },
    { repo: "acme/acme-web", number: 4, state: "not-checked", mergedAt: null, url: "https://github.com/acme/acme-web/pull/4", stale: false, reason: "sso" },
  ],
  totalLines: 3,
  totalFiles: 2,
  logTotalLines: 1,
  totalsAtLeast: false,
  truncated: true,
  ...over,
});

describe("traceContextPack", () => {
  test("the key, the totals from the route's counts, each file's lines, commits, log lines and PR states", () => {
    const pack = traceContextPack("kode", body()).join("\n");
    expect(pack).toContain("Key: MEL-77 (kind: case)");
    expect(pack).toContain("Mentioned on 3 lines in 2 files git tracks; not all of them are listed below.");
    expect(pack).toContain("- plans/ferry.mdx «Ferry plan»\n  12: The ferry case MEL-77 is open.");
    expect(pack).toContain("- 2026-11-20 abcdef0123 Ferry plan names MEL-77 (plans/ferry.mdx)");
    expect(pack).toContain("- log.md:40 [2026-11-20 plan] - MEL-77 was filed.");
    expect(pack).toContain("- acme/acme-api#3: merged 2026-11-21");
    expect(pack).toContain("- acme/acme-web#4: not checked (sso)");
  });

  test("a key no file names, with no kind and lower-bound totals", () => {
    const pack = traceContextPack("mimir", body({ kind: null, files: [], commits: [], log: [], prs: [], totalLines: 0, totalFiles: 0, logTotalLines: 0, totalsAtLeast: true, truncated: false })).join("\n");
    expect(pack).toContain("Key: MEL-77\n");
    expect(pack).toContain("at least 0 lines in at least 0 files");
    expect(pack).toContain("(no tracked file names it)");
  });

  test("a section is cut at the pack bound with a note of what was left out", () => {
    const lines = Array.from({ length: 400 }, (_, i) => ({ n: i + 1, text: `MEL-77 ${"x".repeat(200)}` }));
    const pack = traceContextPack("kode", body({ files: [{ relPath: "a.md", title: null, lines }], totalLines: 401, totalFiles: 2 }));
    const files = section(pack, "## Where it is mentioned");
    expect(files.join("\n").length).toBeLessThanOrEqual(PACK_SECTION_MAX + 80);
    expect(files.at(-1)).toMatch(/^- … \d+ more mention lines? not listed in this pack$/);
  });

  // Fix round 1 (H3): the note counts the mention lines the pack leaves out, from
  // the payload's totals, and never counts a file's header line as a line.
  test("the cut note is the payload's total less the mention lines the pack shows, headers not counted", () => {
    const files = Array.from({ length: 37 }, (_, f) => ({ relPath: `notes/f${f}.md`, title: `File ${f}`, lines: Array.from({ length: 13 }, (_, i) => ({ n: i + 1, text: `MEL-1 ${"y".repeat(120)}` })) }));
    const b = body({ key: "MEL-1", files, log: [{ date: "2026-11-20", kind: "note", line: "- MEL-1 was filed.", n: 9 }], totalLines: 482, totalFiles: 38, truncated: false });
    const pack = traceContextPack("kode", b);
    const where = section(pack, "## Where it is mentioned");
    const shown = where.filter((l) => /^  \d+: /.test(l)).length + section(pack, "## Its log.md lines").filter((l) => l.startsWith("- log.md:")).length;
    expect(shown).toBeLessThan(482);
    expect(where.at(-1)).toBe(`- … ${482 - shown} more mention lines not listed in this pack`);
  });

  test("lines the route did not list are counted though the section was not cut; lower-bound totals say «at least»", () => {
    const listed = body({ totalLines: 40, totalFiles: 9, truncated: true });
    // Shown: the one file line and the one log line.
    expect(section(traceContextPack("kode", listed), "## Where it is mentioned").at(-1)).toBe("- … 38 more mention lines not listed in this pack");
    const atLeast = body({ totalLines: 40, totalFiles: 9, totalsAtLeast: true, truncated: true });
    expect(section(traceContextPack("kode", atLeast), "## Where it is mentioned").at(-1)).toBe("- … at least 38 more mention lines not listed in this pack");
    const all = body({ totalLines: 2, totalFiles: 2, truncated: false });
    expect(traceContextPack("kode", all).join("\n")).not.toContain("not listed in this pack");
  });

  // Fix round 2 batch 3 (finding 9): on melosys-kode-wiki, MELOSYS's where note
  // counted the 324 log.md lines the log section had already reported as cut.
  test("each mention line is reported once: shown, cut from the log section or cut from the where section, summing to totalLines", () => {
    const files = Array.from({ length: 30 }, (_, f) => ({ relPath: `notes/f${f}.md`, title: null, lines: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, text: `MELOSYS ${"y".repeat(120)}` })) }));
    const logOf = (n: number) => Array.from({ length: n }, (_, i) => ({ date: "2026-11-20", kind: "note", line: `- MELOSYS ${"z".repeat(150)} ${i}`, n: i + 10 }));
    const note = (lines: string[], re: RegExp) => Number(lines.find((l) => re.test(l))?.match(re)?.[1] ?? 0);
    // The second: the log list stopped at its bound (500) with 650 log.md lines in the wiki.
    for (const [listed, logTotalLines, totalLines] of [[395, 395, 2812], [500, 650, 3100]] as const) {
      const pack = traceContextPack("kode", body({ key: "MELOSYS", kind: null, files, log: logOf(listed), logTotalLines, totalLines, totalFiles: 31, truncated: true }));
      const where = section(pack, "## Where it is mentioned");
      const logSection = section(pack, "## Its log.md lines");
      const shown = where.filter((l) => /^  \d+: /.test(l)).length + logSection.filter((l) => l.startsWith("- log.md:")).length;
      const whereCut = note(where, /^- … (?:at least )?(\d+) more mention lines? not listed in this pack$/);
      const logCut = note(logSection, /^- … (?:at least )?(\d+) more log\.md lines? cut$/);
      expect(logCut).toBeGreaterThan(0);
      expect({ listed, sum: shown + whereCut + logCut }).toEqual({ listed, sum: totalLines });
    }
  });

  test("past the payload's 500 listed log lines each note has its own number: the log note counts logTotalLines, the where note the rest (fix round 2 batch 4)", () => {
    const files = Array.from({ length: 30 }, (_, f) => ({ relPath: `notes/f${f}.md`, title: null, lines: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, text: `MELOSYS ${"y".repeat(120)}` })) }));
    const log = Array.from({ length: 500 }, (_, i) => ({ date: "2026-11-20", kind: "note", line: `- MELOSYS ${"z".repeat(150)} ${i}`, n: i + 10 }));
    const pack = traceContextPack("kode", body({ key: "MELOSYS", kind: null, files, log, logTotalLines: 650, totalLines: 3100, totalFiles: 31, truncated: true }));
    const where = section(pack, "## Where it is mentioned");
    const logSection = section(pack, "## Its log.md lines");
    const whereShown = where.filter((l) => /^  \d+: /.test(l)).length;
    const logShown = logSection.filter((l) => l.startsWith("- log.md:")).length;
    expect(where.at(-1)).toBe(`- … ${3100 - 650 - whereShown} more mention lines not listed in this pack`);
    expect(logSection.at(-1)).toBe(`- … ${650 - logShown} more log.md lines cut`);
  });

  test("each log.md line appears once: under «Its log.md lines», not again under «Where it is mentioned»", () => {
    const b = body({
      files: [
        { relPath: "plans/ferry.mdx", title: "Ferry plan", lines: [{ n: 12, text: "The ferry case MEL-77 is open." }] },
        { relPath: "log.md", title: null, lines: [{ n: 40, text: "- MEL-77 was filed." }] },
      ],
      totalLines: 2,
      totalFiles: 2,
      truncated: false,
    });
    const pack = traceContextPack("kode", b);
    const text = pack.join("\n");
    expect(text.split("MEL-77 was filed.").length - 1).toBe(1);
    expect(section(pack, "## Where it is mentioned").some((l) => l.startsWith("- log.md"))).toBe(false);
    expect(section(pack, "## Its log.md lines")).toContain("- log.md:40 [2026-11-20 plan] - MEL-77 was filed.");
    expect(text).not.toContain("not listed in this pack");
  });
});

/** A pack section's lines: after its heading, up to the blank line before the next. */
function section(pack: string[], heading: string): string[] {
  const from = pack.indexOf(heading) + 1;
  const next = pack.findIndex((l, i) => i >= from && l.startsWith("## "));
  return pack.slice(from, next < 0 ? undefined : next - 1);
}

test("renderTraceTurnPrompt: pack, reach with citations on the first file, the discussion so far, the question last", () => {
  const prompt = renderTraceTurnPrompt({
    wiki: "kode",
    mentions: body(),
    reach: { kind: "readSearch", wikiSnapshot: "/snap/w1", repos: [], missed: [], own: [] },
    earlier: [{ question: "Summarize", selection: null, answer: "It is a ferry case.", endState: "done" }],
    question: "Where else?",
  });
  expect(prompt.indexOf("## The key")).toBe(0);
  expect(prompt).toContain("e.g. `plans/ferry.mdx:12`");
  expect(prompt).toContain("## The discussion so far\nQuestion: Summarize\nAnswer: It is a ferry case.");
  expect(prompt.endsWith("## Question\nWhere else?")).toBe(true);
  expect(prompt).not.toContain("## The page");
  // Fix round 1 (H1): the subject is the key, not a page or a file.
  expect(prompt).not.toContain("for this page");
  expect(prompt).toContain("No repo in reach: no code repo's snapshot is given for a trace.");
});

test("renderTraceTurnPrompt with MCP tools: a wiki file's line is cited by its path, no file is called the page", () => {
  const prompt = renderTraceTurnPrompt({
    wiki: "kode",
    mentions: body(),
    reach: { kind: "mcpTools", tools: { knowledge: ["search_knowledge"] } },
    earlier: [],
    question: "Where else?",
  });
  expect(prompt).not.toContain("a page line");
  expect(prompt).toContain("a wiki file's line as `<path in the wiki>:LINE`, e.g. `plans/ferry.mdx:12`");
});

test("renderTraceTurnPrompt with MCP tools: the reach section places the pack above it, where it is (fix round 2 batch 4)", () => {
  const prompt = renderTraceTurnPrompt({ wiki: "kode", mentions: body(), reach: { kind: "mcpTools", tools: { knowledge: ["search_knowledge"] } }, earlier: [], question: "Where else?" });
  const reach = prompt.slice(prompt.indexOf("## What you can read"), prompt.indexOf("## Question"));
  expect(prompt.indexOf("## The key")).toBeLessThan(prompt.indexOf("## What you can read"));
  expect(reach).toContain("The context pack above, and these tools only: knowledge-search_knowledge.");
  expect(reach).not.toContain("below");
});

describe("keyMentionsSection (pane room PR 2)", () => {
  test("a page turn's key block: says it is already read, and its pack's headings sit one level down", () => {
    const out = keyMentionsSection("kode", body());
    expect(out[0]).toBe("## The key this question names: MEL-77");
    expect(out[1]).toContain("do not search the wiki for MEL-77 again");
    expect(out[1]).not.toContain("it was cut");
    expect(out).toContain("### Where it is mentioned");
    expect(out.filter((l) => l.startsWith("## "))).toHaveLength(1);
    expect(out.join("\n")).toContain("12: The ferry case MEL-77 is open.");
  });

  test("a key on many long lines is cut at KEY_MENTIONS_MAX on a line boundary, and says so", () => {
    const files = Array.from({ length: 30 }, (_, f) => ({
      relPath: `plans/p${f}.mdx`,
      title: `Plan ${f}`,
      lines: Array.from({ length: 20 }, (_, n) => ({ n: n + 1, text: `MEL-77 ${"x".repeat(280)} ${f}-${n}` })),
    }));
    const out = keyMentionsSection("kode", body({ files, totalLines: 600, totalFiles: 30 }));
    const packed = out.slice(3, out.at(-1) === "- … the rest of the key's mentions cut" ? -1 : undefined);
    expect(out.at(-1)).toBe("- … the rest of the key's mentions cut");
    expect(out[1]).toContain("it was cut");
    expect(packed.join("\n").length).toBeLessThanOrEqual(KEY_MENTIONS_MAX);
    expect(packed.join("\n").length).toBeGreaterThan(KEY_MENTIONS_MAX - 400);
  });
});

describe("readSection with a key in the pack (pane room PR 2)", () => {
  test("the Copilot wiki tools line says the key's mentions are in the pack, and points the grep at other keys", async () => {
    const { readSection } = await import("./discuss-agent.ts");
    const reach = { kind: "mcpTools" as const, tools: { research: ["wiki_grep", "wiki_read", "wiki_history"] }, wikiToolsWiki: "kode" };
    const packed = readSection(reach, { wiki: "kode", relPath: "plans/ferry.mdx" }, "page", "MEL-77").join("\n");
    expect(packed).toContain("MEL-77's mentions are already in the context pack below, so do not grep for it.");
    expect(packed).not.toContain('"where else" question');
    const plain = readSection(reach, { wiki: "kode", relPath: "plans/ferry.mdx" }).join("\n");
    expect(plain).toContain('research-wiki_grep for an exact key, id or a "where else" question');
    expect(plain).not.toContain("already in the context pack");
  });
});

import { describe, expect, test } from "bun:test";
import {
  linkYouTubeTimestamps,
  readerAge,
  readerFormatDuration,
  readerHeadings,
  readerIsTranscriptHeading,
  readerLede,
  readerNeighbours,
  readerOutline,
  readerPills,
  readerPlainText,
  readerReadMinutes,
  readerSimilarWhy,
  readerSourceLinkLabel,
  readerTakeaways,
  readerThumbnail,
  readerTranscriptEnd,
  readerWordCount,
  readerYouTubeId,
} from "./reader-article.ts";
import { splitTranscript } from "./transcript-split.ts";

/** A new-shape YouTube summary: italic lede, `## Key takeaways`, `##`
 *  sections, a closing 💬 Takeaway, a windowed transcript. */
const NEW_SHAPE = [
  "",
  "*A short talk arguing that AI already beats humans at every task.*",
  "",
  "## Key takeaways",
  "- 🧠 One.",
  "- 🏆 Two.",
  "",
  "## From instructions to **learned** intelligence",
  "Some prose here.",
  "### Collective learning",
  "More prose.",
  "```",
  "## not a heading",
  "```",
  "## Why `it` doesn't matter",
  "Text.",
  "",
  "## 💬 Takeaway",
  "The closer.",
  "",
  "## Transcript",
  "",
  "### [00:00:00]",
  "hello there",
  "### [00:02:00]",
  "and goodbye",
].join("\n");

/** An old-shape summary: `###` sections, no lede, no transcript. */
const OLD_SHAPE = [
  "### 🎯 Main Thesis",
  "- **Claude Code** is great.",
  "### 🏗️ The Four Zones",
  "Zones.",
  "### 💡 Key Takeaways",
  "- Keep it.",
].join("\n");

/** A frames-off capture: a flat transcript under a bare `## Transcript`. */
const FLAT = "## Summary\nWords here.\n\n## Transcript\n\nsome flat words [00:01:00] in the text\n";

describe("readerOutline", () => {
  test("new shape: the ## headings, fenced code skipped, inline marks removed", () => {
    const { body } = splitTranscript(NEW_SHAPE);
    expect(readerOutline(body).map((h) => h.text)).toEqual([
      "Key takeaways",
      "From instructions to learned intelligence",
      "Why it doesn't matter",
      "💬 Takeaway",
    ]);
  });
  test("old shape: the ### headings when the body has no ##", () => {
    expect(readerOutline(OLD_SHAPE).map((h) => [h.level, h.text])).toEqual([
      [3, "🎯 Main Thesis"],
      [3, "🏗️ The Four Zones"],
      [3, "💡 Key Takeaways"],
    ]);
  });
  test("no headings: an empty outline", () => {
    expect(readerOutline("Just prose.\n\nMore.")).toEqual([]);
  });
  test("a quoted or indented heading is not the document's", () => {
    expect(readerHeadings("> ## quoted\n    ## code\n## real")).toEqual([{ level: 2, text: "real" }]);
  });
  test("readerPlainText drops links, code marks, emphasis and a closing # run", () => {
    expect(readerPlainText("[Link](http://x) and `code` and *em* and __b__ ##")).toBe("Link and code and em and b");
  });
});

describe("readerLede and readerTakeaways", () => {
  test("new shape: the italic first line is the lede, and the takeaways section runs to the next ##", () => {
    const { body } = splitTranscript(NEW_SHAPE);
    const lede = readerLede(body)!;
    expect(lede.text).toBe("A short talk arguing that AI already beats humans at every task.");
    expect(lede.rest).not.toContain("A short talk");
    const tk = readerTakeaways(lede.rest)!;
    expect(tk.section.split("\n")[0]).toBe("## Key takeaways");
    expect(tk.section).toContain("- 🏆 Two.");
    expect(tk.section).not.toContain("From instructions");
    expect(tk.after.split("\n")[0]).toBe("## From instructions to **learned** intelligence");
    expect(tk.before + "\n" + tk.section + "\n" + tk.after).toBe(lede.rest);
  });
  test("old shape: no lede, and a ### takeaways heading is not a card", () => {
    expect(readerLede(OLD_SHAPE)).toBeNull();
    expect(readerTakeaways(OLD_SHAPE)).toBeNull();
  });
  test("the 💡 Key Takeaway spelling is a card; the closing 💬 Takeaway is not", () => {
    expect(readerTakeaways("## 💡 Key Takeaway\n- a\n## Next")!.section).toBe("## 💡 Key Takeaway\n- a");
    expect(readerTakeaways("## 💬 Takeaway\nclose")).toBeNull();
    expect(readerTakeaways("```\n## Key takeaways\n```")).toBeNull();
  });
  test("bold, two italic runs, or prose first is not a lede", () => {
    expect(readerLede("**Bold line**\n\ntext")).toBeNull();
    expect(readerLede("*a* and *b*")).toBeNull();
    expect(readerLede("Plain first.\n*later*")).toBeNull();
    expect(readerLede("_Underscore lede._\nrest")!.text).toBe("Underscore lede.");
  });
});

describe("readerPills", () => {
  const TODAY = "2026-09-29";
  const keys = (p: ReturnType<typeof readerPills>) => p.map((x) => x.key);

  test("new shape YouTube: kind, category, estimated length and read time; no author, no published", () => {
    const { body, transcript } = splitTranscript(NEW_SHAPE);
    const pills = readerPills({
      sourceLabel: "YouTube",
      date: "2026-09-27",
      today: TODAY,
      kind: "deep",
      category: "ai/general",
      body,
      transcript,
    });
    expect(keys(pills)).toEqual(["source", "captured", "kind", "category", "length", "read"]);
    expect(pills.find((p) => p.key === "captured")!.value).toBe("2026-09-27 · 2 days ago");
    const length = pills.find((p) => p.key === "length")!;
    expect(length.value).toBe("~2 min");
    expect(length.estimated).toBe(true);
    expect(pills.find((p) => p.key === "read")!.value).toBe("1 min read");
  });

  test("old shape: no kind, no length, no empty pill", () => {
    const pills = readerPills({ sourceLabel: "YouTube", date: "2026-03-18", today: TODAY, category: "ai/claude-code", body: OLD_SHAPE, transcript: null });
    expect(keys(pills)).toEqual(["source", "captured", "category", "read"]);
    expect(pills.every((p) => p.value.trim() !== "")).toBe(true);
  });

  test("Vimeo shape: author, published from the first 10 characters, a measured length", () => {
    const pills = readerPills({
      sourceLabel: "Vimeo",
      date: "2026-09-06",
      today: TODAY,
      kind: "deep",
      category: "ai/claude-code",
      author: "JavaZone",
      uploadDate: "2026-09-03 06:49:18",
      durationSec: 3220,
      body: "Words ".repeat(700),
      transcript: "### [00:00:00]\nx\n### [00:52:00]\ny",
    });
    expect(keys(pills)).toEqual(["source", "captured", "kind", "category", "author", "published", "length", "read"]);
    expect(pills.find((p) => p.key === "published")!.value).toBe("2026-09-03");
    const length = pills.find((p) => p.key === "length")!;
    expect(length.value).toBe("54 min");
    expect(length.estimated).toBeUndefined();
    expect(pills.find((p) => p.key === "read")!.value).toBe("3 min read");
  });

  test("YouTube's YYYY-MM-DD upload_date reads the same as Vimeo's", () => {
    const pills = readerPills({ today: TODAY, uploadDate: "2026-09-03", body: "", transcript: null });
    expect(pills).toEqual([{ key: "published", label: "Published", value: "2026-09-03" }]);
  });

  test("a flat transcript gives no length; read time counts only the words before ## Transcript", () => {
    const { body, transcript } = splitTranscript(FLAT);
    const pills = readerPills({ today: TODAY, body, transcript });
    expect(keys(pills)).toEqual(["read"]);
    expect(readerWordCount(body)).toBe(3); // "Summary Words here." — the ## mark is not a word
    expect(readerTranscriptEnd(transcript)).toBeNull();
  });

  test("blank or malformed values give no pill", () => {
    expect(readerPills({ sourceLabel: " ", date: "not a date", today: TODAY, kind: "", author: 3, uploadDate: "soon", durationSec: 0, body: "", transcript: null })).toEqual([]);
  });

  test("the helpers", () => {
    expect(readerFormatDuration(59)).toBe("1 min");
    expect(readerFormatDuration(3600)).toBe("1 h");
    expect(readerFormatDuration(4320)).toBe("1 h 12 min");
    expect(readerReadMinutes(0)).toBe(0);
    expect(readerReadMinutes(1)).toBe(1);
    expect(readerAge("2026-09-29", TODAY)).toBe("today");
    expect(readerAge("2026-09-28", TODAY)).toBe("yesterday");
    expect(readerAge("2026-06-01", TODAY)).toBe("4 months ago");
    expect(readerAge("2026-07-31", TODAY)).toBe("60 days ago");
    expect(readerAge("2026-07-30", TODAY)).toBe("2 months ago");
    expect(readerAge("2026-10-01", TODAY)).toBeNull();
    expect(readerWordCount("[a link](https://x.y/z) ![img alt](p.jpg) - | --- |")).toBe(4);
  });
});

describe("Similar why line", () => {
  test("the first chunk with a heading wins; a lede chunk carries none", () => {
    expect(readerSimilarWhy([{ heading: null }, { heading: "Key takeaways" }, { heading: "[00:06:00]" }])).toEqual({
      heading: "Key takeaways",
      transcript: false,
    });
    expect(readerSimilarWhy([{ heading: "[00:06:00]" }])).toEqual({ heading: "[00:06:00]", transcript: true });
    expect(readerSimilarWhy([{ heading: "Transcript" }])).toEqual({ heading: "Transcript", transcript: true });
    expect(readerSimilarWhy([{ heading: null }])).toBeNull();
    expect(readerSimilarWhy(undefined)).toBeNull();
  });
  test("readerIsTranscriptHeading", () => {
    for (const h of ["[00:06:00]", "[1:02:03]", "[12:30]", "Transcript", " transcript "]) expect(readerIsTranscriptHeading(h)).toBe(true);
    for (const h of ["Transcript notes", "1. Money", "", null, "[00:06]x"]) expect(readerIsTranscriptHeading(h)).toBe(false);
  });
});

describe("thumbnails, timestamps, labels, neighbours", () => {
  test("readerYouTubeId follows extractYouTubeVideoId's host rule", () => {
    expect(readerYouTubeId("https://www.youtube.com/watch?v=rmr-LdARqHE")).toBe("rmr-LdARqHE");
    expect(readerYouTubeId("https://youtu.be/rmr-LdARqHE")).toBe("rmr-LdARqHE");
    expect(readerYouTubeId("https://evilyoutube.com/watch?v=rmr-LdARqHE")).toBeNull();
    expect(readerYouTubeId("https://www.youtube.com/watch?v=bad\"id")).toBeNull();
  });
  test("readerThumbnail: YouTube by id, Vimeo by the stored url, none for text sources", () => {
    expect(readerThumbnail("youtube", "https://youtu.be/rmr-LdARqHE", null)).toBe("https://i.ytimg.com/vi/rmr-LdARqHE/mqdefault.jpg");
    expect(readerThumbnail("vimeo", "https://vimeo.com/1", "https://i.vimeocdn.com/x.jpg")).toBe("https://i.vimeocdn.com/x.jpg");
    expect(readerThumbnail("vimeo", "https://vimeo.com/1", "javascript:alert(1)")).toBeNull();
    expect(readerThumbnail("article", "https://youtu.be/rmr-LdARqHE", null)).toBeNull();
    expect(readerThumbnail("x-article", "https://x.com/a", "https://x/y.jpg")).toBeNull();
  });
  test("linkYouTubeTimestamps links window headings and citations, not fenced code or an existing link", () => {
    const md = "### [00:02:00]\nsee [12:30]\n```\n[00:01:00]\n```\n[00:03:00](http://x)";
    expect(linkYouTubeTimestamps(md, "https://www.youtube.com/watch?v=rmr-LdARqHE")).toBe(
      "### [\\[00:02:00\\]](https://www.youtube.com/watch?v=rmr-LdARqHE&t=120s)\n" +
        "see [\\[12:30\\]](https://www.youtube.com/watch?v=rmr-LdARqHE&t=750s)\n```\n[00:01:00]\n```\n[00:03:00](http://x)",
    );
    expect(linkYouTubeTimestamps(md, "https://vimeo.com/1")).toBe(md);
  });
  test("readerSourceLinkLabel labels x-article by transcript presence", () => {
    expect(readerSourceLinkLabel("x-article", "View on X ↗", true)).toBe("Watch on X ↗");
    expect(readerSourceLinkLabel("x-article", "View on X ↗", false)).toBe("Read on X ↗");
    expect(readerSourceLinkLabel("youtube", "YouTube ↗", true)).toBe("YouTube ↗");
  });
  test("readerNeighbours", () => {
    expect(readerNeighbours(["a", "b", "c"], "b")).toEqual({ newer: 0, older: 2 });
    expect(readerNeighbours(["a", "b", "c"], "a")).toEqual({ newer: -1, older: 1 });
    expect(readerNeighbours(["a"], "z")).toEqual({ newer: -1, older: -1 });
  });
});

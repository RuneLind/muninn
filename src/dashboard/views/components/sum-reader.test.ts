/**
 * The reader's pure functions reach the page as `.toString()` source, which
 * serializes a body and NOT its dependencies. This evaluates the block the
 * page ships, so a helper added to src/summaries/reader-article.ts without
 * joining READER_FUNCTIONS fails here instead of in a browser.
 */
import { describe, expect, test } from "bun:test";
import * as reader from "../../../summaries/reader-article.ts";
import { splitTranscript } from "../../../summaries/transcript-split.ts";
import { RAIL_FUNCTIONS } from "../../../summaries/latest-rail.ts";
import { sumReaderScript } from "./sum-reader.ts";
import { sumArticleLibraryScript } from "./sum-article-library.ts";

/** The page's one `mapProseLines`: the summaries library's, which the
 *  reader's injected functions call by name. */
function pageMapProseLines(): (markdown: string, fn: (line: string, i: number) => string) => string {
  const doc = { addEventListener() {}, getElementById: () => null };
  return new Function("document", sumArticleLibraryScript() + "\nreturn mapProseLines;")(doc);
}

function injectedBlock(): string {
  const script = sumReaderScript();
  const start = script.indexOf("// --- reader-fns:start ---");
  const end = script.indexOf("// --- reader-fns:end ---");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("sum-reader: the injected functions", () => {
  test("every exported function is injected, with the imports it calls, and nothing else is", () => {
    const injected = [...injectedBlock().matchAll(/^\s{4}var (\w+) = function\b/gm)].map((m) => m[1]);
    const exported = Object.entries(reader)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    const imported = reader.READER_IMPORTS.map((f) => f.name);
    expect(imported.sort()).toEqual(["extractYouTubeVideoId"]);
    expect(injected.slice().sort()).toEqual([...exported, ...imported].sort());
  });

  test("the injected In your wiki rows dedupe and link by relPath as the module does", () => {
    const injected = new Function(injectedBlock() + "\nreturn readerWikiContext;")() as typeof reader.readerWikiContext;
    const rows = [
      { bot: "jarvis", status: "draft", targetPath: "sources/x.mdx" },
      { bot: "jarvis", status: "applied", targetPath: "sources/x.mdx" },
    ];
    expect(injected(rows)).toEqual(reader.readerWikiContext(rows));
    expect(injected(rows).map((i) => i.href)).toEqual(["/wiki?wiki=jarvis&relPath=sources%2Fx.mdx"]);
  });

  test("the injected copies run standalone and agree with the module", () => {
    const names = reader.READER_FUNCTIONS.map((f) => f.name);
    // The rail's date helpers (sum-latest-rail.ts) and mapProseLines
    // (sum-article-library.ts) are on the page already; here they are
    // prepended by hand, mapProseLines as the library declares it.
    const railDeps = RAIL_FUNCTIONS.filter((f) => f.name === "railDate" || f.name === "railValidDay")
      .map((f) => `var ${f.name} = ${f.toString()};`).join("\n") +
      `\nvar mapProseLines = ${pageMapProseLines().toString()};`;
    const api = new Function(railDeps + "\n" + injectedBlock() + "\nreturn {" + names.map((n) => n + ": " + n).join(",") + "};")() as typeof reader;
    const md = "\n*Lede.*\n\n## Key takeaways\n- a\n## Two\ntext [00:01:00]\n\n## Transcript\n### [00:00:00]\nx\n### [00:04:00]\ny";
    const { body, transcript } = splitTranscript(md);
    const input = { sourceLabel: "YouTube", date: "2026-09-27", today: "2026-09-29", kind: "deep", body, transcript };
    expect(api.readerPills(input)).toEqual(reader.readerPills(input));
    expect(api.readerOutline(body)).toEqual(reader.readerOutline(body));
    expect(api.readerLede(body)).toEqual(reader.readerLede(body));
    expect(api.readerTakeaways(body)).toEqual(reader.readerTakeaways(body));
    const url = "https://www.youtube.com/watch?v=rmr-LdARqHE";
    expect(api.linkYouTubeTimestamps(md, url)).toBe(reader.linkYouTubeTimestamps(md, url));
    expect(api.readerSimilarWhy([{ heading: null }, { heading: "[00:06:00]" }])).toEqual({ heading: "[00:06:00]", transcript: true });
    expect(api.readerThumbnail("youtube", url, null)).toBe("https://i.ytimg.com/vi/rmr-LdARqHE/mqdefault.jpg");
    expect(api.readerNeighbours(["a", "b"], "b")).toEqual({ newer: 0, older: -1 });
    expect(api.readerAge("2024-09-29", "2026-09-29")).toBe(reader.readerAge("2024-09-29", "2026-09-29"));
    expect(api.readerAge("2026-02-30", "2026-09-29")).toBeNull();
    expect(api.readerYouTubeId("https://youtu.be/rmr-LdARqHE")).toBe("rmr-LdARqHE");
    const hits = [{ source: "anthropic", id: "a.md", relevance: 0.5, metadata: { date: "2026-09-27" } }, { source: "youtube", id: "b.md", relevance: 0.2, metadata: { date: "2026-09-27" } }];
    const open = { source: "youtube", docId: "o.md" };
    expect(api.readerSameStory(hits, open, [], "2026-09-29")).toEqual(reader.readerSameStory(hits, open, [], "2026-09-29"));
    expect(api.readerSameStory(hits, open, [], "2026-09-29")).toHaveLength(1);
    const rows = [{ bot: "jarvis", status: "applied", targetPath: "sources/x.mdx" }];
    expect(api.readerWikiContext(rows)).toEqual(reader.readerWikiContext(rows));
    const long = md + "🧠".repeat(3000);
    expect(api.readerSimilarQuery(long)).toBe(reader.readerSimilarQuery(long));
    expect(api.readerSimilarQuery("🧠".repeat(3000)).length).toBeGreaterThan(0);
  });
});

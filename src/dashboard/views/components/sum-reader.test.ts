/**
 * The reader's pure functions reach the page as `.toString()` source, which
 * serializes a body and NOT its dependencies. This evaluates the block the
 * page ships, so a helper added to src/summaries/reader-article.ts without
 * joining READER_FUNCTIONS fails here instead of in a browser.
 */
import { describe, expect, test } from "bun:test";
import * as reader from "../../../summaries/reader-article.ts";
import { splitTranscript } from "../../../summaries/transcript-split.ts";
import { sumReaderScript } from "./sum-reader.ts";

function injectedBlock(): string {
  const script = sumReaderScript();
  const start = script.indexOf("// --- reader-fns:start ---");
  const end = script.indexOf("// --- reader-fns:end ---");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("sum-reader: the injected functions", () => {
  test("every exported function is injected, and nothing else is", () => {
    const injected = [...injectedBlock().matchAll(/^\s{4}var (\w+) = function\b/gm)].map((m) => m[1]);
    const exported = Object.entries(reader)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(injected.slice().sort()).toEqual(exported);
  });

  test("the injected copies run standalone and agree with the module", () => {
    const names = reader.READER_FUNCTIONS.map((f) => f.name);
    const api = new Function(injectedBlock() + "\nreturn {" + names.map((n) => n + ": " + n).join(",") + "};")() as typeof reader;
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
  });
});

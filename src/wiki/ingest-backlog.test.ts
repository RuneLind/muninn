import { test, expect, describe } from "bun:test";
import {
  normalizeUrl,
  extractUrls,
  docIdFromUrl,
  computeIngestBacklog,
  type ListedDoc,
  type WikiRefs,
} from "./ingest-backlog.ts";

/** Build a WikiRefs from bare url + id-token lists (tests only). */
function refs(urls: string[] = [], idTokens: string[] = []): WikiRefs {
  return { urls: new Set(urls), idTokens: new Set(idTokens) };
}

describe("normalizeUrl — each rule pinned", () => {
  test("http → https", () => {
    expect(normalizeUrl("http://youtu.be/abc")).toBe("https://youtu.be/abc");
  });

  test("strips a single trailing slash", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  test("strips a YouTube &t=NNNs timestamp param, keeping the video id", () => {
    expect(normalizeUrl("https://www.youtube.com/watch?v=ID&t=45s")).toBe(
      "https://www.youtube.com/watch?v=ID",
    );
    expect(normalizeUrl("https://www.youtube.com/watch?v=ID&t=90")).toBe(
      "https://www.youtube.com/watch?v=ID",
    );
  });

  test("strips a ?t=NNNs timestamp when it's the only param", () => {
    expect(normalizeUrl("https://youtu.be/ID?t=120s")).toBe("https://youtu.be/ID");
    expect(normalizeUrl("https://youtu.be/ID?t=120")).toBe("https://youtu.be/ID");
  });

  test("strips a ?si= share param (youtu.be / x share links)", () => {
    expect(normalizeUrl("https://youtu.be/ID?si=abcDEF123")).toBe("https://youtu.be/ID");
    expect(normalizeUrl("https://x.com/user/status/1?si=xyz")).toBe(
      "https://x.com/user/status/1",
    );
  });

  test("strips share params regardless of position, keeping real params", () => {
    expect(normalizeUrl("https://www.youtube.com/watch?v=ID&si=abc&t=30s")).toBe(
      "https://www.youtube.com/watch?v=ID",
    );
    expect(normalizeUrl("https://youtu.be/ID?si=abc&t=30s")).toBe("https://youtu.be/ID");
  });

  test("keeps a non-timestamp t= param (only NNN / NNNs is a timestamp)", () => {
    expect(normalizeUrl("https://example.com/x?t=hello")).toBe("https://example.com/x?t=hello");
  });

  test("strips trailing .,; punctuation caught by the wiki regex sweep", () => {
    expect(normalizeUrl("https://example.com/page.")).toBe("https://example.com/page");
    expect(normalizeUrl("https://example.com/page,")).toBe("https://example.com/page");
    expect(normalizeUrl("https://example.com/page;")).toBe("https://example.com/page");
    expect(normalizeUrl("https://example.com/page...")).toBe("https://example.com/page");
  });

  test("rules compose: http + trailing dot + timestamp + trailing slash", () => {
    expect(normalizeUrl("http://youtu.be/ID/?t=45s.")).toBe("https://youtu.be/ID");
  });
});

describe("extractUrls — regex sweep over body + frontmatter", () => {
  test("finds urls in prose and trims the wrapping punctuation/brackets", () => {
    const text = [
      "See (https://youtu.be/ONE?t=10s) and also https://youtu.be/TWO.",
      "A markdown [link](https://example.com/three/) here.",
      'And a quoted "https://example.com/four" too.',
    ].join("\n");
    const urls = extractUrls(text);
    expect(urls).toContain("https://youtu.be/ONE");
    expect(urls).toContain("https://youtu.be/TWO");
    expect(urls).toContain("https://example.com/three");
    expect(urls).toContain("https://example.com/four");
  });

  test("normalizes so two references to the same video collapse", () => {
    const text = "https://youtu.be/ID?t=10s\nhttp://youtu.be/ID/";
    const set = new Set(extractUrls(text));
    expect(set.size).toBe(1);
    expect([...set][0]).toBe("https://youtu.be/ID");
  });
});

describe("docIdFromUrl — platform-native id extraction", () => {
  test("YouTube watch?v=<11>", () => {
    expect(docIdFromUrl("https://www.youtube.com/watch?v=deFvnmibzow")).toBe("deFvnmibzow");
    expect(docIdFromUrl("https://www.youtube.com/watch?v=deFvnmibzow&t=30s")).toBe("deFvnmibzow");
  });

  test("youtu.be/<11> and shorts/<11>", () => {
    expect(docIdFromUrl("https://youtu.be/b3jlsjOIOzs")).toBe("b3jlsjOIOzs");
    expect(docIdFromUrl("https://www.youtube.com/shorts/b3jlsjOIOzs")).toBe("b3jlsjOIOzs");
  });

  test("X/Twitter /status/<15-20 digits>", () => {
    expect(docIdFromUrl("https://x.com/user/status/1839283746152839471")).toBe("1839283746152839471");
    expect(docIdFromUrl("https://twitter.com/user/status/1839283746152839471")).toBe(
      "1839283746152839471",
    );
  });

  test("TikTok /video/<digits>", () => {
    expect(docIdFromUrl("https://www.tiktok.com/@user/video/7412345678901234567")).toBe(
      "7412345678901234567",
    );
  });

  test("anthropic-summaries and unknown shapes → null (URL-only crediting)", () => {
    expect(docIdFromUrl("https://www.anthropic.com/news/some-post")).toBeNull();
    expect(docIdFromUrl("https://example.com/whatever")).toBeNull();
  });
});

function doc(collection: string, id: string, url?: string, date?: string): ListedDoc {
  return { collection, id, ...(url ? { url } : {}), ...(date ? { date } : {}) };
}

describe("computeIngestBacklog — credit rules + partition math", () => {
  test("URL-referenced-wins: a doc only cited by url in a wiki page is ingested, not queued", () => {
    const listed = { "youtube-summaries": [doc("youtube-summaries", "a", "https://youtu.be/a")] };
    const wikiRefs = refs(["https://youtu.be/a"]);
    const res = computeIngestBacklog(listed, wikiRefs, new Set(), new Set());
    const c = res.byCollection[0]!;
    expect(c.ingested).toBe(1);
    expect(c.queued).toBe(0);
    expect(c.queuedDocs).toHaveLength(0);
  });

  test("URL match uses normalization (a timestamped wiki link still credits)", () => {
    const listed = { "youtube-summaries": [doc("youtube-summaries", "a", "https://youtu.be/a")] };
    // Wiki cites it with a timestamp + trailing slash — normalization must collapse it.
    const wikiRefs = refs([normalizeUrl("http://youtu.be/a/?t=30s")]);
    const res = computeIngestBacklog(listed, wikiRefs, new Set(), new Set());
    expect(res.byCollection[0]!.queued).toBe(0);
  });

  test("consumed-wins: a consumed doc whose url is NOT in the wiki still counts ingested", () => {
    const listed = { "youtube-summaries": [doc("youtube-summaries", "b", "https://youtu.be/b")] };
    const res = computeIngestBacklog(
      listed,
      refs(), // url not referenced anywhere
      new Set(["youtube-summaries/b"]), // but consumed by an applied proposal
      new Set(),
    );
    const c = res.byCollection[0]!;
    expect(c.ingested).toBe(1);
    expect(c.queued).toBe(0);
  });

  test("pending (draft/approved) doc counts ingested", () => {
    const listed = { "x-articles": [doc("x-articles", "p", "https://x.com/p")] };
    const res = computeIngestBacklog(listed, refs(), new Set(), new Set(["x-articles/p"]));
    expect(res.byCollection[0]!.queued).toBe(0);
    expect(res.byCollection[0]!.ingested).toBe(1);
  });

  test("a doc that is neither consumed, pending, nor url-referenced is queued", () => {
    const listed = { "anthropic-summaries": [doc("anthropic-summaries", "q", "https://a/q", "2026-07-01")] };
    const res = computeIngestBacklog(listed, refs(), new Set(), new Set());
    const c = res.byCollection[0]!;
    expect(c.queued).toBe(1);
    expect(c.ingested).toBe(0);
    expect(c.queuedDocs[0]).toEqual({
      collection: "anthropic-summaries",
      id: "q",
      url: "https://a/q",
      date: "2026-07-01",
    });
  });

  test("per-collection + overall partition: total === ingested + queued everywhere", () => {
    const listed: Record<string, ListedDoc[]> = {
      "youtube-summaries": [
        doc("youtube-summaries", "y1", "https://youtu.be/y1"), // url-referenced
        doc("youtube-summaries", "y2", "https://youtu.be/y2"), // consumed
        doc("youtube-summaries", "y3", "https://youtu.be/y3"), // queued
        doc("youtube-summaries", "y4", "https://youtu.be/y4"), // queued
      ],
      "x-articles": [
        doc("x-articles", "x1", "https://x.com/x1"), // pending
        doc("x-articles", "x2", "https://x.com/x2"), // queued
      ],
    };
    const wikiRefs = refs(["https://youtu.be/y1"]);
    const consumed = new Set(["youtube-summaries/y2"]);
    const pending = new Set(["x-articles/x1"]);
    const res = computeIngestBacklog(listed, wikiRefs, consumed, pending);

    const yt = res.byCollection.find((c) => c.collection === "youtube-summaries")!;
    expect(yt.total).toBe(4);
    expect(yt.ingested).toBe(2);
    expect(yt.queued).toBe(2);
    expect(yt.total).toBe(yt.ingested + yt.queued);

    const x = res.byCollection.find((c) => c.collection === "x-articles")!;
    expect(x.total).toBe(2);
    expect(x.ingested).toBe(1);
    expect(x.queued).toBe(1);

    expect(res.total).toBe(6);
    expect(res.ingested).toBe(3);
    expect(res.queued).toBe(3);
    expect(res.total).toBe(res.ingested + res.queued);
  });

  test("id-referenced-wins: a backticked bare id credits a listed YouTube doc", () => {
    // The manual-ingest convention cites videos as backticked ids, not full URLs.
    // A wiki page body containing `deFvnmibzow` must credit this listed doc.
    const listed = {
      "youtube-summaries": [
        doc("youtube-summaries", "vid1", "https://www.youtube.com/watch?v=deFvnmibzow"),
      ],
    };
    const wikiRefs = refs([], ["deFvnmibzow"]);
    const res = computeIngestBacklog(listed, wikiRefs, new Set(), new Set());
    const c = res.byCollection[0]!;
    expect(c.ingested).toBe(1);
    expect(c.queued).toBe(0);
  });

  test("id-referenced-wins: an id derived from a full-URL citation credits too", () => {
    // collectWikiRefs also feeds docIdFromUrl(swept url) into idTokens, so a
    // full-URL citation credits by id even when the stored url shape differs.
    const listed = {
      "youtube-summaries": [doc("youtube-summaries", "vid2", "https://youtu.be/b3jlsjOIOzs")],
    };
    const wikiRefs = refs([], ["b3jlsjOIOzs"]);
    const res = computeIngestBacklog(listed, wikiRefs, new Set(), new Set());
    expect(res.byCollection[0]!.queued).toBe(0);
  });

  test("no-URL doc is unaffected by id tokens (still queued)", () => {
    const listed = { "anthropic-summaries": [doc("anthropic-summaries", "noUrl")] };
    const wikiRefs = refs([], ["deFvnmibzow", "123456789012345678"]);
    const res = computeIngestBacklog(listed, wikiRefs, new Set(), new Set());
    expect(res.byCollection[0]!.queued).toBe(1);
    expect(res.byCollection[0]!.ingested).toBe(0);
  });

  test("preserves collection insertion order in byCollection", () => {
    const listed: Record<string, ListedDoc[]> = {
      "youtube-summaries": [],
      "x-articles": [],
      "anthropic-summaries": [],
      "tiktok-summaries": [],
    };
    const res = computeIngestBacklog(listed, refs(), new Set(), new Set());
    expect(res.byCollection.map((c) => c.collection)).toEqual([
      "youtube-summaries",
      "x-articles",
      "anthropic-summaries",
      "tiktok-summaries",
    ]);
  });
});

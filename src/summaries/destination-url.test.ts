import { test, expect, describe } from "bun:test";
import {
  normalizeDestinationUrl,
  isDestinationUrl,
  isPdfUrl,
  destinationGroupKey,
} from "./destination-url.ts";

describe("normalizeDestinationUrl", () => {
  test("KEEPS the identifying query — two YouTube videos never collapse", () => {
    // The whole reason this isn't `normalizeArticleUrl` (which strips the query and
    // would make every watch?v=… one key).
    const a = normalizeDestinationUrl("https://www.youtube.com/watch?v=AAAAAAAAAAA");
    const b = normalizeDestinationUrl("https://www.youtube.com/watch?v=BBBBBBBBBBB");
    expect(a).toBe("https://youtube.com/watch?v=AAAAAAAAAAA");
    expect(b).toBe("https://youtube.com/watch?v=BBBBBBBBBBB");
    expect(a).not.toBe(b);
  });

  test("every YouTube URL shape canonicalizes onto ONE key per video", () => {
    const key = "https://youtube.com/watch?v=AAAAAAAAAAA";
    expect(normalizeDestinationUrl("https://youtu.be/AAAAAAAAAAA?si=Xy_1")).toBe(key);
    expect(normalizeDestinationUrl("https://www.youtube.com/watch?v=AAAAAAAAAAA&t=42")).toBe(key);
    expect(normalizeDestinationUrl("https://m.youtube.com/shorts/AAAAAAAAAAA")).toBe(key);
    // Host-gated: a non-YouTube URL carrying `?v=<11 chars>` is untouched.
    expect(normalizeDestinationUrl("https://ex.test/p?v=AAAAAAAAAAA")).toBe(
      "https://ex.test/p?v=AAAAAAAAAAA",
    );
  });

  test("strips tracking params (utm_*, si, ref) but keeps the rest", () => {
    expect(
      normalizeDestinationUrl("https://ex.test/vid?si=Xy_1&utm_source=twitter&t=42"),
    ).toBe("https://ex.test/vid?t=42");
    expect(normalizeDestinationUrl("https://ex.test/p?ref=x&UTM_Campaign=y&id=7")).toBe(
      "https://ex.test/p?id=7",
    );
    // Every param was tracking ⇒ no `?` at all.
    expect(normalizeDestinationUrl("https://ex.test/p?utm_medium=social")).toBe("https://ex.test/p");
  });

  test("drops the fragment and trailing slashes", () => {
    expect(normalizeDestinationUrl("https://ex.test/post/#section-2")).toBe("https://ex.test/post");
    expect(normalizeDestinationUrl("https://ex.test/post///")).toBe("https://ex.test/post");
    expect(normalizeDestinationUrl("https://ex.test/")).toBe("https://ex.test");
  });

  test("KEEPS a hash ROUTE (SPA) when the path is empty — that's the whole address", () => {
    expect(normalizeDestinationUrl("https://site.example/#/post/123")).toBe(
      "https://site.example#/post/123",
    );
    // Two routes on the same host stay distinct…
    expect(normalizeDestinationUrl("https://site.example/#/post/123")).not.toBe(
      normalizeDestinationUrl("https://site.example/#/post/456"),
    );
    // …but a plain anchor on a real path is still dropped.
    expect(normalizeDestinationUrl("https://site.example/blog/x#/nope")).toBe(
      "https://site.example/blog/x",
    );
    expect(normalizeDestinationUrl("https://site.example/#section-2")).toBe("https://site.example");
  });

  test("upgrades http→https, strips a leading www., lowercases the HOST only", () => {
    expect(normalizeDestinationUrl("http://Example.COM/Deep/Path?V=AbC")).toBe(
      "https://example.com/Deep/Path?V=AbC",
    );
    // …so the two schemes of the same destination land on ONE key.
    expect(normalizeDestinationUrl("http://example.com/announce/")).toBe(
      normalizeDestinationUrl("https://example.com/announce"),
    );
    // Real x-feed data carries both `anthropic.com` and `www.anthropic.com`.
    expect(normalizeDestinationUrl("https://www.anthropic.com/news/x")).toBe(
      normalizeDestinationUrl("https://anthropic.com/news/x"),
    );
    // Only a LEADING `www.` — a `www.` deeper in the host is identity.
    expect(normalizeDestinationUrl("https://ex.test/www.foo")).toBe("https://ex.test/www.foo");
  });

  test("returns null for unparseable or non-http(s) input", () => {
    expect(normalizeDestinationUrl("not a url")).toBeNull();
    expect(normalizeDestinationUrl("ftp://ex.test/file")).toBeNull();
    expect(normalizeDestinationUrl("")).toBeNull();
  });
});

describe("isDestinationUrl / isPdfUrl", () => {
  test("x.com / twitter.com / t.co are never external destinations", () => {
    expect(isDestinationUrl("https://x.com/a/status/1")).toBe(false);
    expect(isDestinationUrl("https://mobile.twitter.com/a")).toBe(false);
    expect(isDestinationUrl("https://t.co/abc")).toBe(false);
    expect(isDestinationUrl("https://example.com/p")).toBe(true);
    expect(isDestinationUrl("mailto:a@b.test")).toBe(false);
  });

  test("isPdfUrl matches the path extension OR a /pdf/ segment, case-insensitively", () => {
    expect(isPdfUrl("https://arxiv.org/pdf/2401.00001v1.pdf")).toBe(true);
    expect(isPdfUrl("https://ex.test/Paper.PDF?download=1")).toBe(true);
    // Extension-less arxiv form — the fence would otherwise leak it past the carve-out.
    expect(isPdfUrl("https://arxiv.org/pdf/2401.00001v1")).toBe(true);
    expect(isPdfUrl("https://arxiv.org/PDF/2401.00001")).toBe(true);
    expect(isPdfUrl("https://ex.test/pdf-explainer")).toBe(false);
    expect(isPdfUrl("https://ex.test/papers/pdfs/x")).toBe(false);
  });
});

describe("destinationGroupKey", () => {
  test("keys on links[0] only (multi-link docs never merge on a later link)", () => {
    expect(destinationGroupKey(["https://a.test/one", "https://b.test/two"])).toBe(
      "https://a.test/one",
    );
    // Same pair, other order ⇒ a different key. Accepted by design.
    expect(destinationGroupKey(["https://b.test/two", "https://a.test/one"])).toBe(
      "https://b.test/two",
    );
  });

  test("null (⇒ tweet-URL keying) for no link, a self-link, a PDF, or garbage", () => {
    expect(destinationGroupKey([])).toBeNull();
    expect(destinationGroupKey(["https://x.com/a/status/1"])).toBeNull();
    expect(destinationGroupKey(["https://arxiv.org/pdf/2401.00001v1.pdf"])).toBeNull();
    expect(destinationGroupKey(["https://arxiv.org/pdf/2401.00001v1"])).toBeNull();
    expect(destinationGroupKey(["javascript:alert(1)"])).toBeNull();
  });
});

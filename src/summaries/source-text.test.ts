import { afterEach, expect, test } from "bun:test";
import { documentTextImage, filterDocumentText, readSummarySourceText } from "./source-text.ts";
import huginnAnswers from "./__fixtures__/huginn-document-text.json";

// The filter is NARROWER than huginn by construction, so the contract checked
// against huginn's own answers is one-directional: an image the port keeps is
// huginn's answer (or that answer with its alt cleared), never one huginn drops.
const withoutAlt = (image: string) => image.replace(/^!\[[^\]]*\]/, "![]");
const IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;

test("no image huginn drops is kept, and a kept image is huginn's own answer", () => {
  const widening = huginnAnswers.images
    .map(({ input, expected }) => ({ input, expected, actual: documentTextImage(input) }))
    .filter(
      (c) =>
        c.actual !== null && (c.expected === null || (c.actual !== c.expected && c.actual !== withoutAlt(c.expected))),
    );
  expect(widening).toEqual([]);
});

test("whole bodies keep no image or S3 link huginn removes, backticks included", () => {
  const widening = huginnAnswers.texts
    .map(({ input, expected }) => ({ input, expected, actual: filterDocumentText(input) }))
    .filter((c) => {
      const allowed = new Set((c.expected.match(IMAGE_RE) ?? []).flatMap((i) => [i, withoutAlt(i)]));
      const extraImage = (c.actual.match(IMAGE_RE) ?? []).some((i) => !allowed.has(i));
      // Images aside, the prose must be huginn's to the byte — that is what
      // pins the S3 rewrite, whose leftovers need not contain "amazonaws.com".
      const prose = (s: string) => s.replace(IMAGE_RE, "");
      return extraImage || prose(c.actual) !== prose(c.expected);
    });
  expect(widening).toEqual([]);
});

test("the corpus's own image shapes are kept exactly as huginn keeps them", () => {
  for (const image of [
    "![Slide at 00:01:33](/api/frames/vimeo/1/93.jpg)",
    "![Slide at 00:12:30](/api/frames/youtube/abc_DEF-1/750.jpg)",
    "![chart](https://example.com/c.png)",
    "![diagram](http://example.com:8080/a/b-c_d.png?w=1&h=2)",
  ]) {
    expect(documentTextImage(image)).toBe(image);
  }
});

test("alt text survives only as ASCII caption words, narrower than huginn by design", () => {
  expect(documentTextImage("![Slide at 00:01:33](/x.png)")).toBe("![Slide at 00:01:33](/x.png)");
  expect(documentTextImage("![æøå bilde](/x.png)")).toBe("![](/x.png)");
});

test("the default budget reads a real server's source file", async () => {
  // A short delay, so a zero or near-zero default aborts where a real budget
  // does not: a loopback answer otherwise lands before a 0 ms timer fires.
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(50);
      return new Response("---\nx: 1\n---\n# Whole\n", { headers: { "content-type": "text/markdown" } });
    },
  });
  try {
    expect(await readSummarySourceText(`http://127.0.0.1:${server.port}`, "c", "d.md")).toBe("# Whole\n");
  } finally {
    server.stop(true);
  }
});

test("a source body that stalls after its headers is abandoned within the budget", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("---\nx: 1\n---\n# partial"));
          },
        }),
        { headers: { "content-type": "text/markdown" } },
      ),
  });
  try {
    const started = Date.now();
    const result = await Promise.race([
      readSummarySourceText(`http://127.0.0.1:${server.port}`, "c", "d.md", 200),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 1_500)),
    ]);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // Abandoned is not enough: the request itself must be aborted, or every
    // stalled read leaves a connection open.
    await Bun.sleep(150);
    expect(server.pendingRequests).toBe(0);
  } finally {
    server.stop(true);
  }
});

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function answer(res: () => Response, seen?: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen?.push(String(input));
    return res();
  }) as typeof fetch;
}

test("reads ?raw=1 for the encoded path and strips the frontmatter", async () => {
  const seen: string[] = [];
  answer(
    () => new Response('---\ndate: "2026-09-15"\n---\n# T\n\n```\ncode\n```\n', { headers: { "content-type": "text/markdown" } }),
    seen,
  );
  expect(await readSummarySourceText("http://kb.test", "youtube-summaries", "ai/T%20x.md")).toBe("# T\n\n```\ncode\n```\n");
  expect(seen).toEqual(["http://kb.test/api/document/youtube-summaries/ai/T%20x.md?raw=1"]);
});

test("applies huginn's document-text image rules to the whole body, code included", async () => {
  const body = [
    "# T",
    "![Slide at 00:01:33](/api/frames/vimeo/1/93.jpg)",
    "![chart](https://example.com/c.png \"a title\")",
    "![signed](https://cdn.example.com/k.png?X-Amz-Signature=abc)",
    "![bucket](https://b.s3.eu-west-1.amazonaws.com/k.png)",
    "![blob](data:image/png;base64,AAAA)",
    "![user](https://me:pw@example.com/k.png)",
    "See https://b.s3.eu-west-1.amazonaws.com/report.pdf for the file.",
    "```",
    "![filtered too](data:image/png;base64,AAAA)",
    "```",
  ].join("\n");
  answer(() => new Response(`---\nx: 1\n---\n${body}`, { headers: { "content-type": "text/markdown" } }));
  expect(await readSummarySourceText("http://kb.test", "c", "d.md")).toBe(
    [
      "# T",
      "![Slide at 00:01:33](/api/frames/vimeo/1/93.jpg)",
      "![chart](https://example.com/c.png)",
      "",
      "",
      "",
      "",
      "See [file] for the file.",
      "```",
      "",
      "```",
    ].join("\n"),
  );
});

test("answers null for a JSON body, an error status and an unreachable huginn", async () => {
  answer(() => new Response("{}", { headers: { "content-type": "application/json" } }));
  expect(await readSummarySourceText("http://kb.test", "c", "d.md")).toBeNull();

  answer(() => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }));
  expect(await readSummarySourceText("http://kb.test", "c", "d.md")).toBeNull();

  globalThis.fetch = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;
  expect(await readSummarySourceText("http://kb.test", "c", "d.md")).toBeNull();
});

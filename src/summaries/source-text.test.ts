import { afterEach, expect, test } from "bun:test";
import { readSummarySourceText } from "./source-text.ts";

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

test("applies huginn's document-text image rules outside fenced code", async () => {
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
    "![kept verbatim](data:image/png;base64,AAAA)",
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
      "![kept verbatim](data:image/png;base64,AAAA)",
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

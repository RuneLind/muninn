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

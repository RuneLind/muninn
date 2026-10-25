import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safeFetchPage, safeFetchText, type SafeFetchOptions } from "./safe-fetch.ts";

/**
 * `safeFetchPage` — `safeFetchText`'s guards with the landing URL and the
 * content type kept, and a non-text answer reported (`text: null`) instead of
 * refused. Same two seams as `safe-fetch.test.ts`: a stub `lookup` resolving
 * `pub.test` to a public address, and a `fetchImpl` that sends the request to
 * the loopback server below.
 */

let server: ReturnType<typeof Bun.serve>;
let port = 0;
const PUBLIC_ADDR = "93.184.216.34";

function opts(): SafeFetchOptions {
  return {
    lookup: async (h) => (h === "pub.test" ? [PUBLIC_ADDR] : []),
    fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      u.hostname = "127.0.0.1";
      u.port = String(port);
      return fetch(u.toString(), init);
    }) as unknown as typeof fetch,
  };
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/moved") return new Response(null, { status: 301, headers: { location: "http://pub.test/page" } });
      if (p === "/page") return new Response("<title>T</title>", { headers: { "content-type": "text/html" } });
      if (p === "/paper.pdf") return new Response("%PDF-1.7 binary", { headers: { "content-type": "application/pdf" } });
      if (p === "/private") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } });
      return new Response("gone", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  port = server.port as number;
});

afterAll(() => server.stop(true));

describe("safeFetchPage", () => {
  test("follows redirects and reports where it landed, with the type and the text", async () => {
    expect(await safeFetchPage("http://pub.test/moved", opts())).toEqual({
      finalUrl: "http://pub.test/page",
      contentType: "text/html",
      text: "<title>T</title>",
    });
  });

  test("a PDF that resolves is answered unread (text null), where safeFetchText refuses it", async () => {
    expect(await safeFetchPage("http://pub.test/paper.pdf", opts())).toEqual({
      finalUrl: "http://pub.test/paper.pdf",
      contentType: "application/pdf",
      text: null,
    });
    expect(await safeFetchText("http://pub.test/paper.pdf", opts())).toBeNull();
  });

  test("a 404 and a redirect onto a private address are refused (null)", async () => {
    expect(await safeFetchPage("http://pub.test/missing", opts())).toBeNull();
    expect(await safeFetchPage("http://pub.test/private", opts())).toBeNull();
  });
});

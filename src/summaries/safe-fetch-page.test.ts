import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeBody, safeFetchPage, safeFetchText, type SafeFetchOptions } from "./safe-fetch.ts";

/**
 * `safeFetchPage` — `safeFetchText`'s guards with the landing URL and the
 * content type kept, and a non-text answer reported (`text: null`) instead of
 * refused. Same two seams as `safe-fetch.test.ts`: a stub `lookup` resolving
 * `pub.test` to a public address, and a `fetchImpl` that sends the request to
 * the loopback server below.
 */

const LATIN1_PAGE = "<title>Blåbær på Øya - «café»</title><p>Smørbrød</p>";
/** `text` as ISO-8859-1 bytes (every character here is in its range). */
const latin1 = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

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
      if (p === "/blob") return new Response("bytes", { headers: { "content-type": "application/octet-stream" } });
      if (p === "/archive.zip") return new Response("PK", { headers: { "content-type": "application/zip" } });
      if (p === "/untyped") return new Response(new Uint8Array([1, 2, 3]));
      if (p === "/private") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } });
      // F61: the same Latin-1 page, its charset declared three ways.
      if (p === "/latin1-header") return new Response(latin1(LATIN1_PAGE), { headers: { "content-type": "text/html; charset=ISO-8859-1" } });
      if (p === "/latin1-meta") return new Response(latin1(`<meta charset="iso-8859-1">${LATIN1_PAGE}`), { headers: { "content-type": "text/html" } });
      if (p === "/latin1-equiv") {
        const head = `<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">`;
        return new Response(latin1(head + LATIN1_PAGE), { headers: { "content-type": "text/html" } });
      }
      if (p === "/utf8-unknown-label") return new Response(`<title>Blåbær</title>`, { headers: { "content-type": "text/html; charset=x-no-such-charset" } });
      if (p === "/utf8-plain") return new Response(`<title>Blåbær</title>`, { headers: { "content-type": "text/plain" } });
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

  test("only a PDF is reported unread: octet-stream, a zip and an untyped answer are refused (L6)", async () => {
    expect(await safeFetchPage("http://pub.test/blob", opts())).toBeNull();
    expect(await safeFetchPage("http://pub.test/archive.zip", opts())).toBeNull();
    expect(await safeFetchPage("http://pub.test/untyped", opts())).toBeNull();
  });

  test("a 404 and a redirect onto a private address are refused (null)", async () => {
    expect(await safeFetchPage("http://pub.test/missing", opts())).toBeNull();
    expect(await safeFetchPage("http://pub.test/private", opts())).toBeNull();
  });
});

describe("F61: the body is decoded in the charset the answer declares", () => {
  test("a Latin-1 page declared in the content-type header", async () => {
    expect((await safeFetchPage("http://pub.test/latin1-header", opts()))?.text).toBe(LATIN1_PAGE);
  });

  test("a Latin-1 page declared only by <meta charset>", async () => {
    expect((await safeFetchPage("http://pub.test/latin1-meta", opts()))?.text).toBe(`<meta charset="iso-8859-1">${LATIN1_PAGE}`);
  });

  test("a Latin-1 page declared only by an http-equiv content-type", async () => {
    const text = (await safeFetchPage("http://pub.test/latin1-equiv", opts()))?.text ?? "";
    expect(text.endsWith(LATIN1_PAGE)).toBe(true);
    expect(text).not.toContain("�");
  });

  test("a byte-order mark wins over the declarations; a meta tag naming UTF-16 reads as UTF-8", () => {
    const utf16le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe5, 0x00]);
    expect(decodeBody(utf16le, "text/html; charset=iso-8859-1")).toBe("hå");
    const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("blå")]);
    expect(decodeBody(utf8bom, "text/html; charset=iso-8859-1")).toBe("blå");
    const metaUtf16 = new TextEncoder().encode('<meta charset="utf-16"><p>blå</p>');
    expect(decodeBody(metaUtf16, "text/html")).toBe('<meta charset="utf-16"><p>blå</p>');
  });

  test("a <meta charset> on a non-HTML answer is not read", () => {
    expect(decodeBody(latin1('<meta charset="iso-8859-1">å'), "text/plain")).toBe('<meta charset="iso-8859-1">�');
  });

  describe("only what the HTML prescan counts declares a charset (fix round 1)", () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const html = "text/html";
    test("`charset=` inside a description's content is no declaration", () => {
      const doc = '<meta name="description" content="How to set charset=iso-8859-1 in Apache"><p>Blåbær</p>';
      expect(decodeBody(utf8(doc), html)).toBe(doc);
    });
    test("a commented-out <meta charset> is no declaration; the one after it is", () => {
      // The `>` inside the comment ends no tag: only `-->` ends it.
      const doc = '<!-- a > b <meta charset="iso-8859-1"> --><meta charset="utf-8"><p>Blåbær</p>';
      expect(decodeBody(utf8(doc), html)).toBe(doc);
      expect(decodeBody(latin1('<!-- x --><meta charset="iso-8859-1"><p>Blåbær</p>'), html)).toBe('<!-- x --><meta charset="iso-8859-1"><p>Blåbær</p>');
    });
    test("`data-charset=` is not the charset attribute", () => {
      const doc = '<meta data-charset="iso-8859-1"><p>Blåbær</p>';
      expect(decodeBody(utf8(doc), html)).toBe(doc);
    });
    test("a content charset counts only beside http-equiv=content-type", () => {
      const doc = '<meta property="og:x" content="text/html; charset=iso-8859-1"><p>Blåbær</p>';
      expect(decodeBody(utf8(doc), html)).toBe(doc);
      const refresh = '<meta http-equiv="refresh" content="text/html; charset=iso-8859-1"><p>Blåbær</p>';
      expect(decodeBody(utf8(refresh), html)).toBe(refresh);
      const equiv ="<meta content='text/html; charset=iso-8859-1' http-equiv=CONTENT-TYPE><p>Blåbær</p>";
      expect(decodeBody(latin1(equiv), html)).toBe(equiv);
    });
    test("a tag's attribute that spells a meta tag is no declaration", () => {
      const doc = '<div title="<meta charset=iso-8859-1>"></div><p>Blåbær</p>';
      expect(decodeBody(utf8(doc), html)).toBe(doc);
    });
    test("`charset=` inside a quoted content-type parameter is no charset", () => {
      expect(decodeBody(utf8("<p>Blåbær</p>"), 'text/html; foo="a;charset=latin1"')).toBe("<p>Blåbær</p>");
      expect(decodeBody(latin1("<p>Blåbær</p>"), 'text/html; foo="a;b"; Charset="ISO-8859-1"')).toBe("<p>Blåbær</p>");
      expect(decodeBody(latin1("<p>Blåbær</p>"), "text/html;charset=iso-8859-1;charset=utf-8")).toBe("<p>Blåbær</p>");
    });
  });

  test("an unknown label and an undeclared body stay UTF-8", async () => {
    expect((await safeFetchPage("http://pub.test/utf8-unknown-label", opts()))?.text).toBe("<title>Blåbær</title>");
    expect(await safeFetchText("http://pub.test/utf8-plain", opts())).toBe("<title>Blåbær</title>");
  });
});

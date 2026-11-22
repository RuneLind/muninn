import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeBody, safeFetchPage, safeFetchText, type SafeFetchOptions } from "./safe-fetch.ts";
import { ENCODING_LABELS, SINGLE_BYTE_ENCODINGS } from "./whatwg-encodings.ts";

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
    test("an attribute the 1024-byte head cuts off ends the prescan; its text is never read as markup (fix round 2)", () => {
      // The description crosses byte 1024: at ae0772b1 its quoted `<meta charset=…>` was rescanned and won.
      const pad = "x".repeat(950);
      const crossing = `<meta name="description" content="${pad} put <meta charset=iso-8859-1> in the head of every page"><meta charset="utf-8"><p>Blåbær</p>`;
      expect(crossing.indexOf("iso-8859-1>") + 11).toBeLessThan(1024);
      expect(crossing.indexOf('page"')).toBeGreaterThan(1024);
      expect(decodeBody(utf8(crossing), html)).toBe(crossing);
      // The same through another tag, and a quote never closed inside the head.
      const div = `<div title="${pad} <meta charset=iso-8859-1> and so on, past the end of the first kilobyte"></div><p>Blåbær</p>`;
      expect(div.indexOf('kilobyte"')).toBeGreaterThan(1024);
      expect(decodeBody(utf8(div), html)).toBe(div);
      const unclosed = `<div title="<meta charset=iso-8859-1>${pad}<p>Blåbær</p>`;
      expect(decodeBody(utf8(unclosed), html)).toBe(unclosed);
      // A <meta> the head cuts off still counts with what it gathered.
      const cut = `<meta charset="iso-8859-1" content="${pad}${pad}"><p>Blåbær</p>`;
      expect(decodeBody(latin1(cut), html)).toBe(cut);
    });
    test("a meta naming x-user-defined reads as windows-1252; a content-type naming it keeps its own decoder", () => {
      const meta = new Uint8Array([...new TextEncoder().encode('<meta charset="x-user-defined">'), 0xe5]);
      expect(decodeBody(meta, html)).toBe('<meta charset="x-user-defined">å');
      expect(decodeBody(new Uint8Array([0xe5]), "text/html; charset=x-user-defined")).toBe("");
    });
    test("`charset=` inside a quoted content-type parameter is no charset", () => {
      expect(decodeBody(utf8("<p>Blåbær</p>"), 'text/html; foo="a;charset=latin1"')).toBe("<p>Blåbær</p>");
      expect(decodeBody(latin1("<p>Blåbær</p>"), 'text/html; foo="a;b"; Charset="ISO-8859-1"')).toBe("<p>Blåbær</p>");
      expect(decodeBody(latin1("<p>Blåbær</p>"), "text/html;charset=iso-8859-1;charset=utf-8")).toBe("<p>Blåbær</p>");
    });
  });

  describe("labels Bun's TextDecoder refuses (fix round 1, batch 2)", () => {
    const bytes = (...b: number[]) => new Uint8Array(b);
    test("the refused single-byte charsets decode by the WHATWG tables", () => {
      expect(decodeBody(bytes(0x42, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x20, 0xa4), "text/html; charset=iso-8859-15")).toBe("Blåbær €");
      expect(decodeBody(bytes(0xb1, 0xe6), "text/plain; charset=iso-8859-2")).toBe("ąć");
      expect(decodeBody(bytes(0xe0, 0xe1), "text/plain; charset=windows-1251")).toBe("аб");
      expect(decodeBody(bytes(0xc1, 0xc2), "text/plain; charset=koi8-r")).toBe("аб");
      expect(decodeBody(bytes(0xfe, 0xf0), "text/plain; charset=windows-1254")).toBe("şğ");
      expect(decodeBody(bytes(0x9a, 0x9e), "text/plain; charset=windows-1250")).toBe("šž");
    });
    test("a label is matched as the standard matches it: ASCII white space stripped, any case", () => {
      expect(decodeBody(bytes(0xe5), 'text/html; charset="\tISO-8859-15 "')).toBe("å");
      // Bun refuses this label of an encoding it decodes by its name.
      expect(decodeBody(bytes(0xe5), "text/html; charset=iso88593")).toBe("ċ");
    });
    test("every label of every single-byte encoding decodes a high byte", () => {
      const missed: string[] = [];
      for (const name of SINGLE_BYTE_ENCODINGS)
        for (const label of ENCODING_LABELS[name]!) if (decodeBody(bytes(0x61, 0xe5), `text/plain; charset=${label}`) === "a�") missed.push(label);
      expect(missed).toEqual([]);
    });
    test("a meta label Bun refuses ends the prescan, as the standard's does", () => {
      const doc = '<meta charset="iso-8859-15"><meta charset="utf-8"><p>Blåbær</p>';
      expect(decodeBody(latin1(doc), "text/html")).toBe(doc);
    });
    test("a label naming the replacement encoding is no declaration", () => {
      const utf8 = new TextEncoder().encode("<p>Blåbær</p>");
      for (const label of ENCODING_LABELS["replacement"]!) expect(decodeBody(utf8, `text/html; charset=${label}`)).toBe("<p>Blåbær</p>");
      const doc = '<meta charset="replacement"><meta charset="iso-8859-1"><p>Blåbær</p>';
      expect(decodeBody(latin1(doc), "text/html")).toBe(doc);
    });
  });

  test("an unknown label and an undeclared body stay UTF-8", async () => {
    expect((await safeFetchPage("http://pub.test/utf8-unknown-label", opts()))?.text).toBe("<title>Blåbær</title>");
    expect(await safeFetchText("http://pub.test/utf8-plain", opts())).toBe("<title>Blåbær</title>");
  });
});

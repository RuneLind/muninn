/**
 * The shared host gate, host-agnostic: every refusal here holds for any host
 * set, so the TikTok and X routes inherit it rather than restating it.
 * Mock-free; runs in the main `bun test` batch.
 */

import { test, expect } from "bun:test";
import { parseAllowedHttpsUrl } from "./url-gate.ts";

const HOSTS = new Set(["example.com", "www.example.com"]);

const REFUSED: Array<[string, string]> = [
  ["backslash before @ (WHATWG: path, Python: userinfo)", "https://example.com\\@127.0.0.1/p"],
  ["backslash as the scheme slashes", "https:\\\\example.com/p"],
  ["backslash in the path", "https://example.com/a\\b"],
  ["userinfo", "https://user@example.com/p"],
  ["empty userinfo", "https://:@example.com/p"],
  ["allowed host as userinfo", "https://example.com@127.0.0.1/p"],
  ["explicit port", "https://example.com:8443/p"],
  ["explicit default port", "https://example.com:443/p"],
  ["percent-escaped host", "https://%65xample.com/p"],
  ["fullwidth host", "https://ｅxample.com/p"],
  ["trailing-dot host", "https://example.com./p"],
  ["leading space", " https://example.com/p"],
  ["trailing space", "https://example.com/p "],
  ["trailing newline", "https://example.com/p\n"],
  ["tab in host", "https://exam\tple.com/p"],
  ["newline in path", "https://example.com/a\nb"],
  ["NUL", "https://example.com/\x00"],
  ["DEL", "https://example.com/\x7f"],
  ["non-breaking space", "https://example.com/a b"],
  ["http", "http://example.com/p"],
  // Pins the prefix and protocol clauses as a pair: any 5-letter scheme lines
  // `slice(8)` up with the authority, and WHATWG still reports the host.
  ["5-letter non-https scheme", "wxyzs://example.com/p"],
  ["no slashes", "https:example.com/p"],
  ["one slash", "https:/example.com/p"],
  ["three slashes", "https:///example.com/p"],
  ["other host", "https://127.0.0.1/p"],
  ["suffix host", "https://example.com.evil.test/p"],
  ["allowed host in the query only", "https://evil.test/?u=https://example.com/p"],
  ["file scheme", "file:///etc/passwd"],
  ["not a url", "not a url"],
  ["empty", ""],
];

for (const [why, raw] of REFUSED) {
  test(`refuses ${why}: ${JSON.stringify(raw)}`, () => {
    expect(parseAllowedHttpsUrl(raw, HOSTS)).toBeNull();
  });
}

test("accepts an allowed host and returns the parsed URL", () => {
  expect(parseAllowedHttpsUrl("https://www.example.com/a?b=1#c", HOSTS)?.href).toBe(
    "https://www.example.com/a?b=1#c",
  );
});

test("normalises case in scheme and host rather than refusing it", () => {
  expect(parseAllowedHttpsUrl("HTTPS://EXAMPLE.COM/A", HOSTS)?.href).toBe("https://example.com/A");
});

test("the host set is the caller's, not a built-in", () => {
  expect(parseAllowedHttpsUrl("https://example.com/p", new Set(["other.test"]))).toBeNull();
});

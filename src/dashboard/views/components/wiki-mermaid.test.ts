import { test, expect } from "bun:test";
import {
  MERMAID_CDN_URL,
  MERMAID_SRI,
  mermaidThemeFor,
  hasMermaid,
} from "./wiki-mermaid.ts";

/**
 * The client-side mermaid enhancer is DOM-driven and the repo has no browser
 * test env (no happy-dom/jsdom) — client code is otherwise exercised only by
 * building the bundle (wiki-render.test.ts). So here we test the pure,
 * browser-free parts: the pinned CDN URL, the theme mapping, and the
 * "no fence → no work" gate. The DOM render path is left to the orchestrator's
 * headless-Chromium smoke.
 */

test("MERMAID_CDN_URL is a pinned https mermaid@11 UMD build", () => {
  expect(MERMAID_CDN_URL).toBe(
    "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js",
  );
  expect(MERMAID_CDN_URL.startsWith("https://")).toBe(true);
  // Full version pinned (not a floating @11 / @latest tag).
  expect(MERMAID_CDN_URL).toContain("mermaid@11.16.0");
});

test("MERMAID_SRI is a well-formed sha384 subresource-integrity value", () => {
  // `sha384-` prefix + base64 of a 48-byte (384-bit) digest. Base64 of 48
  // bytes is 64 chars ending in a single `=`-free group (48 % 3 === 0).
  expect(MERMAID_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  // Verified against what jsdelivr serves for MERMAID_CDN_URL:
  //   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
  expect(MERMAID_SRI).toBe(
    "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E",
  );
});

test("mermaidThemeFor: explicit data-theme wins over OS preference", () => {
  // data-theme present → OS preference ignored.
  expect(mermaidThemeFor("dark", false)).toBe("dark");
  expect(mermaidThemeFor("light", true)).toBe("default");
  expect(mermaidThemeFor("dark", true)).toBe("dark");
  expect(mermaidThemeFor("light", false)).toBe("default");
});

test("mermaidThemeFor: absent data-theme falls back to OS preference", () => {
  expect(mermaidThemeFor(undefined, true)).toBe("dark");
  expect(mermaidThemeFor(undefined, false)).toBe("default");
  // An unrecognised token is treated as not-dark.
  expect(mermaidThemeFor("sepia", true)).toBe("default");
});

test("hasMermaid gates on a language-mermaid code element", () => {
  const withFence = {
    querySelector: (sel: string) => (sel === "code.language-mermaid" ? {} : null),
  } as unknown as ParentNode;
  const withoutFence = {
    querySelector: () => null,
  } as unknown as ParentNode;
  expect(hasMermaid(withFence)).toBe(true);
  expect(hasMermaid(withoutFence)).toBe(false);
});

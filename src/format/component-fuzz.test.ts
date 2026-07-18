import { test, expect, describe } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";

/**
 * Hostile-input fuzz set for component blocks. The contract: the parser never
 * throws or hangs, and no platform renderer ever emits an executable `<script>`
 * from attacker-controlled attrs or bodies.
 */

const format = (md: string) => ({
  web: formatWebHtml(md),
  telegram: formatTelegramHtml(md),
  slack: formatSlackMrkdwn(md),
});

describe("component fuzz — never throws, never injects", () => {
  test("unclosed tags degrade to text on every platform", () => {
    const md = "<Callout tone=\"info\">\nleft open forever\nmore lines";
    const out = format(md);
    // Web escapes the raw tag rather than opening a callout div.
    expect(out.web).toContain("&lt;Callout");
    expect(out.web).not.toContain('<div class="callout');
    expect(() => format(md)).not.toThrow();
  });

  test("attr injection cannot escape into markup", () => {
    const md = '<Callout title=""><script>alert(1)</script>">\nbody\n</Callout>';
    const out = format(md);
    expect(out.web).not.toContain("<script>");
    expect(out.telegram).not.toContain("<script>");
    // Slack has no HTML surface, but must not carry a live tag either.
    expect(out.slack).not.toContain("<script>");
  });

  test("attr value with quote-and-tag injection is neutralized", () => {
    const md = '<Pill tone="rec\"><img src=x onerror=alert(1)>">payload</Pill>';
    expect(() => format(md)).not.toThrow();
    const out = format(md);
    // The payload survives only as inert escaped text — no live tag reaches the DOM.
    expect(out.web).not.toContain("<img");
    expect(out.web).toContain("&lt;img");
  });

  test("10k inline-closed tag bomb parses in a single pass without hanging", () => {
    const md = Array.from({ length: 10_000 }, () => "<Pill>x</Pill>").join("\n");
    const start = Date.now();
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(10_000);
    expect(blocks.every((b) => b.type === "component")).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("10k unclosed-tag bomb terminates and degrades to text", () => {
    const md = Array.from({ length: 10_000 }, () => "<Callout>").join("\n");
    const start = Date.now();
    const blocks = parseBlocks(md);
    // All unclosed → every line falls through to a single text block.
    expect(blocks).toEqual([{ type: "text", lines: Array(10_000).fill("<Callout>") }]);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("5k unclosed-open bomb parses linearly (no O(n²) EOF re-scan)", () => {
    // Regression guard: before the futility memo, each bare `<Callout>` open
    // re-scanned the whole tail looking for a close that never comes — O(n²),
    // ~3.3s at 10k, and re-run on every streaming delta. The memo makes it
    // linear. Assert generously (< 2s) to avoid CI flake; locally this is tens
    // of ms.
    const md = Array.from({ length: 5_000 }, () => "<Callout>").join("\n");
    const start = Date.now();
    const blocks = parseBlocks(md);
    // Semantics unchanged: all unclosed → one text block of every raw line.
    expect(blocks).toEqual([{ type: "text", lines: Array(5_000).fill("<Callout>") }]);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("code fence inside a Callout is preserved verbatim, no premature close", () => {
    const md = "<Callout tone=\"info\">\n```ts\n// </Callout> inside a fence must not close\nconst x = 1;\n```\n</Callout>";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "component", name: "Callout" });
    const kids = (blocks[0] as any).children;
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ type: "code_block", lang: "ts" });
    expect(kids[0].code).toContain("</Callout> inside a fence");
    // Web output escapes the fence body and keeps the callout wrapper intact.
    const web = formatWebHtml(md);
    expect(web).toContain('<div class="callout callout-info">');
    expect(web).toContain("&lt;/Callout&gt; inside a fence");
  });

  test("plain-prose line starting with a whitelisted tag now parses as a component (accepted edge)", () => {
    // Locks in the intended behavior: a line-anchored whitelisted tag that used
    // to be inert prose is newly a component. Only whitelisted names qualify.
    const componentised = parseBlocks("<Pill>existing prose token</Pill>");
    expect(componentised[0]).toMatchObject({ type: "component", name: "Pill" });

    // A non-whitelisted look-alike stays plain text (today's behavior).
    const inert = parseBlocks("<Sidebar>still just prose</Sidebar>");
    expect(inert).toEqual([{ type: "text", lines: ["<Sidebar>still just prose</Sidebar>"] }]);
  });

  test("Meter with missing/non-numeric value degrades IDENTICALLY to plain label on all platforms", () => {
    // The identical-degrade contract: a Meter whose value is missing or
    // non-numeric renders its children (the label) as plain text everywhere.
    for (const md of [
      "<Meter max=\"5\">Autonomy</Meter>", // missing value
      "<Meter value=\"abc\" max=\"5\">Autonomy</Meter>", // non-numeric value
      "<Meter value=\"\" max=\"5\">Autonomy</Meter>", // empty value
    ]) {
      const out = format(md);
      expect(out.web).toBe("Autonomy");
      expect(out.telegram).toBe("Autonomy");
      expect(out.slack).toBe("Autonomy");
    }
  });

  test("Meter attr injection through value/tone cannot escape into markup", () => {
    const md = '<Meter value="4\"><script>alert(1)</script>" tone="good\"><img src=x onerror=alert(1)>">Autonomy</Meter>';
    expect(() => format(md)).not.toThrow();
    const out = format(md);
    expect(out.web).not.toContain("<script>");
    expect(out.web).not.toContain("<img");
    expect(out.telegram).not.toContain("<script>");
    expect(out.slack).not.toContain("<script>");
  });

  test("10k inline-closed Meter bomb parses in a single pass without hanging", () => {
    const md = Array.from({ length: 10_000 }, () => "<Meter value=\"4\" max=\"5\">L</Meter>").join("\n");
    const start = Date.now();
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(10_000);
    expect(blocks.every((b) => b.type === "component")).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("10k unclosed Meter bomb terminates and degrades to text", () => {
    const md = Array.from({ length: 10_000 }, () => "<Meter value=\"4\">").join("\n");
    const start = Date.now();
    const blocks = parseBlocks(md);
    // Meter is not self-closing, so a bare open never closes → one text block.
    expect(blocks).toEqual([{ type: "text", lines: Array(10_000).fill("<Meter value=\"4\">") }]);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("unclosed Meter renders as escaped text on every platform (not a meter div)", () => {
    // Mirrors the Callout unclosed-degrade pin at the RENDERED-output level: an
    // open Meter with no close must escape rather than emit meter markup.
    const md = "<Meter value=\"4\" max=\"5\">\nleft open forever\nmore lines";
    const out = format(md);
    expect(out.web).toContain("&lt;Meter");
    expect(out.web).not.toContain('<div class="meter"');
    expect(out.telegram).toContain("&lt;Meter");
    // Slack's catch-all strips the angle-bracket tag; the body survives as text,
    // and crucially no `label: value/max` meter render is emitted.
    expect(out.slack).toContain("left open forever");
    expect(out.slack).not.toContain(": 4/5");
    expect(() => format(md)).not.toThrow();
  });

  test("Diff fence injection cannot escape into markup on any platform", () => {
    const md = "<Diff>\n```diff\n+<img src=x onerror=alert(1)>\n```\n</Diff>";
    expect(() => format(md)).not.toThrow();
    const out = format(md);
    expect(out.web).not.toContain("<img");
    expect(out.web).toContain("&lt;img");
    expect(out.telegram).not.toContain("<img");
    // Slack has no HTML surface; the payload is inert text inside a code fence.
    expect(out.slack.startsWith("```")).toBe(true);
  });

  test("FileTree fence content cannot inject markup on web/telegram", () => {
    const md = "<FileTree>\n```\n<img src=x onerror=alert(1)>\n```\n</FileTree>";
    expect(() => format(md)).not.toThrow();
    const out = format(md);
    expect(out.web).not.toContain("<img");
    expect(out.web).toContain("&lt;img");
    expect(out.telegram).not.toContain("<img");
  });

  test("deeply nested same-name tags do not blow the stack or mis-nest", () => {
    const depth = 50;
    const md = `${"<Callout>\n".repeat(depth)}core${"\n</Callout>".repeat(depth)}`;
    expect(() => parseBlocks(md)).not.toThrow();
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "component", name: "Callout" });
  });
});

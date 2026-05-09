import { test, expect, describe } from "bun:test";
import { webFormatClientScript } from "./web-format-client.ts";

describe("webFormatClientScript", () => {
  test("bundles browser entrypoint into a self-contained IIFE", async () => {
    const script = await webFormatClientScript();
    // IIFE wrapper
    expect(script.startsWith("(() => {")).toBe(true);
    // Globals attached for the surrounding chat-page IIFE to call by name
    expect(script).toContain("g.formatWebHtml = formatWebHtml");
    expect(script).toContain("g.renderSlackMrkdwn = renderSlackMrkdwn");
    expect(script).toContain("g.sanitizeHtml = sanitizeHtml");
  });

  test("memoizes the bundle (second call returns the same string)", async () => {
    const a = await webFormatClientScript();
    const b = await webFormatClientScript();
    expect(a).toBe(b);
  });
});

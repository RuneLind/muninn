import { test, expect, describe } from "bun:test";
import { webFormatClientScript } from "./web-format-client.ts";

describe("webFormatClientScript", () => {
  test("bundle attaches the three formatters as functions on globalThis", async () => {
    const script = await webFormatClientScript();
    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", script)(sandbox);
    expect(typeof sandbox.formatWebHtml).toBe("function");
    expect(typeof sandbox.renderSlackMrkdwn).toBe("function");
    expect(typeof sandbox.sanitizeHtml).toBe("function");
  });

  test("bundled formatWebHtml matches the server implementation", async () => {
    const script = await webFormatClientScript();
    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", script)(sandbox);
    const bundled = sandbox.formatWebHtml as (s: string) => string;
    const { formatWebHtml: server } = await import("../../../web/web-format.ts");
    const input = "**bold** and *italic* with [link](https://x.com) and `code`";
    expect(bundled(input)).toBe(server(input));
  });
});

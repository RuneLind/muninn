import { describe, expect, test } from "bun:test";
import { agentBodyHtml, agentCardUrl, agentCutText, agentMetaText } from "./wiki-agent-pane.ts";

describe("Agent pane, the pure half", () => {
  test("the route URL leaves blank inputs out", () => {
    expect(agentCardUrl("mimir", "plans/a b.mdx", "", " ")).toBe("/api/wiki/plan-card?wiki=mimir&relPath=plans%2Fa+b.mdx");
    expect(agentCardUrl("", "p.mdx", "2026-10-07", "D7")).toBe("/api/wiki/plan-card?relPath=p.mdx&since=2026-10-07&id=D7");
  });
  test("chars against the 12k cap", () => {
    expect(agentMetaText({ text: "", chars: 8321, cuts: [], ms: 1234 })).toBe("8,321 / 12,000 chars · 1.2 s");
    expect(agentMetaText({ text: "", chars: 12001, cuts: [], ms: 0 })).toBe("12,001 / 12,000 chars (over the cap) · 0.0 s");
  });
  test("a cut row names the section, the range and the pointer", () => {
    expect(agentCutText({ section: "brief", pointer: "Brief continues, sed -n 9,20p /w/p.mdx", start: 9, end: 20, file: "/w/p.mdx" })).toBe(
      "brief L9-20 p.mdx — Brief continues, sed -n 9,20p /w/p.mdx",
    );
    expect(agentCutText({ section: "sessions", pointer: "rerun with --full" })).toBe("sessions — rerun with --full");
  });
  test("the card is escaped text in a <pre>, word for word", () => {
    const html = agentBodyHtml({ kind: "ok", card: { text: "# T\n<Fold> & \"x\"", chars: 1, cuts: [], ms: 0 } });
    expect(html).toContain('<pre class="wiki-agent-text"># T\n&#60;Fold&#62; &#38; &#34;x&#34;</pre>');
    expect(agentBodyHtml({ kind: "error", status: 501, message: "<b>" })).toContain("plan-card failed (501): &#60;b&#62;");
  });
});

import { describe, expect, test } from "bun:test";
import { extractRules } from "../../scripts/gen-diagram-styles.ts";

const TEMPLATE = `<style>
  svg .c-backend { fill: var(--backend-fill); stroke: var(--backend-stroke); }
  svg .t-backend { fill: var(--backend-stroke); }
  svg .t-dim { fill: var(--text-dim); }
  svg .t-primary { fill: var(--text); }
  svg .s-backend { color: var(--backend-stroke); }
</style>`;

describe("gen-diagram-styles", () => {
  const body = (sel: string) => extractRules(TEMPLATE).rules.find((r) => r.selector === sel)!.body;

  test("a coloured label is inked toward the text colour, so it reads on its own fill", () => {
    expect(body(".t-backend")).toBe("fill: color-mix(in srgb, var(--status-success) 55%, var(--text-primary))");
    expect(body(".t-dim")).toBe("fill: color-mix(in srgb, var(--text-muted) 55%, var(--text-primary))");
  });

  test("body text, shapes and sigils keep their token", () => {
    expect(body(".t-primary")).toBe("fill: var(--text-primary)");
    expect(body(".c-backend")).toBe("fill: color-mix(in srgb, var(--status-success) 14%, var(--bg-surface)); stroke: var(--status-success)");
    expect(body(".s-backend")).toBe("color: var(--status-success)");
  });
});

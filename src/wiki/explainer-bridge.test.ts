import { test, expect, describe } from "bun:test";
import { EXPLAINER_BRIDGE_SCRIPT, EXPLAINER_BRIDGE_MARKER } from "./explainer-bridge.ts";

/**
 * The forwarder is a string constant (not module code), so it's asserted at the
 * string level: the parent-guard bail, the two message type strings, the marker,
 * and the `<script>` wrapping. Runtime behavior is exercised by the Playwright
 * iframe smoke (orchestrator), not here.
 */
describe("EXPLAINER_BRIDGE_SCRIPT", () => {
  test("bails when not framed (parent === window guard)", () => {
    expect(EXPLAINER_BRIDGE_SCRIPT).toContain("window.parent === window");
  });

  test("posts both selection message types", () => {
    expect(EXPLAINER_BRIDGE_SCRIPT).toContain("wiki-explain-sel");
    expect(EXPLAINER_BRIDGE_SCRIPT).toContain("wiki-explain-clear");
  });

  test("carries the route-test marker and is a <script> block", () => {
    expect(EXPLAINER_BRIDGE_SCRIPT).toContain(EXPLAINER_BRIDGE_MARKER);
    expect(EXPLAINER_BRIDGE_SCRIPT.startsWith("<script>")).toBe(true);
    expect(EXPLAINER_BRIDGE_SCRIPT.trimEnd().endsWith("</script>")).toBe(true);
  });

  test("uses opaque-origin-safe targetOrigin and no console.*", () => {
    expect(EXPLAINER_BRIDGE_SCRIPT).toContain('"*"');
    expect(EXPLAINER_BRIDGE_SCRIPT).not.toContain("console.");
  });
});

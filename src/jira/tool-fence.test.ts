import { test, expect, describe } from "bun:test";
import { fullDepthUnavailableMessage } from "./tool-fence.ts";

/**
 * The `Full` pre-flight refusal has to distinguish two states the probe already
 * tells apart but the message used to collapse: a server the bot is not
 * CONFIGURED with (absent from `.mcp.json` — the nais pod, where the overlay
 * carries only `research`) and one that is configured but DOWN (a laptop with
 * the Serena listeners stopped). Only the second has a remedy, and offering it
 * in a pod sends the reader to a dashboard page that cannot help them.
 */
describe("fullDepthUnavailableMessage", () => {
  test("unconfigured servers are reported as absent from this instance, with no start-them remedy", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: ["code", "yggdrasil"], down: [] });
    expect(msg).toContain("code");
    expect(msg).toContain("yggdrasil");
    // The remedy must NOT be offered: there is nothing to start in this instance.
    expect(msg).not.toContain("Start dem");
    expect(msg).toMatch(/denne installasjonen/i);
    // The reader still needs a way forward.
    expect(msg).toContain("Skisse");
  });

  test("down servers keep the start-them remedy", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: [], down: ["code"] });
    expect(msg).toContain("code");
    expect(msg).toContain("Start dem");
    expect(msg).toContain("Skisse");
  });

  test("a mixed gap names both states separately", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: ["yggdrasil"], down: ["code"] });
    expect(msg).toMatch(/denne installasjonen/i);
    expect(msg).toContain("Start dem");
    // Each server appears under the state it is actually in.
    const absentIdx = msg.indexOf("yggdrasil");
    const downIdx = msg.indexOf("code");
    expect(absentIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(absentIdx).not.toBe(downIdx);
  });
});

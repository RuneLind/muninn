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
    // The remedy must NOT be offered: there is nothing to start here.
    expect(msg).not.toMatch(/\bStart\b/);
    expect(msg).toMatch(/denne installasjonen/i);
    // The reader still needs a way forward.
    expect(msg).toContain("Skisse");
  });

  test("down servers keep the start-them remedy", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: [], down: ["code"] });
    expect(msg).toMatch(/Start\s+code\s+fra dashbordet \(\/serena\)/);
    expect(msg).toContain("Skisse");
  });

  test("a mixed gap names each server under the state it is actually in", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: ["yggdrasil"], down: ["code"] });
    // Pin the CLAUSES, not two substring positions: comparing indexOf("yggdrasil")
    // against indexOf("code") holds for any wording, including one that merges
    // both servers into a single clause.
    expect(msg).toMatch(/ikke tilgjengelige i denne installasjonen: yggdrasil/);
    expect(msg).toMatch(/nede: code/);
  });

  test("the remedy names only the servers that can actually be started", () => {
    const msg = fullDepthUnavailableMessage({ unconfigured: ["yggdrasil"], down: ["code"] });
    const remedy = msg.slice(msg.indexOf("Start"));
    expect(remedy).toContain("code");
    // Offering to start the server the same sentence just called absent undoes
    // the whole point of splitting the two states.
    expect(remedy).not.toContain("yggdrasil");
  });

  test("an empty gap is refused, not composed into a sentence", () => {
    // Neither "og ." nor an invented "er ikke tilgjengelig": an empty gap means
    // Full IS available, so there is no honest refusal to render.
    expect(() => fullDepthUnavailableMessage({ unconfigured: [], down: [] })).toThrow(/empty gap/);
  });
});
